import { cls, h, on, raf } from "@/view/widgets/dom";
import { icon, type IconName } from "@/view/icons";
import { NumberField } from "@/view/widgets/NumberField";
import { onAccelChange, withAccel } from "@/view/widgets/accel";
import type { Store, ToolId } from "@/app/Store";
import { availableTools } from "@/app/toolModes";
import { applyEdit } from "@/app/TimelineOps";
import type { Pose } from "@/core/doc/pose";
import type { NodeId } from "@/core/doc/ids";
import type { GizmoPrefs } from "@/core/prefs/prefs";
import type { Transform } from "@/core/math/Transform";
import {
  type Axes, rotationFromShown, shownRotation, shownTranslation, translationFromShown,
} from "@/core/math/axes";
import { type EditBase, captureEditBase, finishEdit } from "@/view/tools/axisEdit";
import { selectionSnapshots } from "@/view/tools/SelectTool";
import type { NodeSnapshot } from "@/view/tools/transformOps";
import { clampToolbarOffset, type Offset, toolbarInset } from "./toolbarPlace";

interface ToolDef { id: ToolId; label: string; icon: IconName; hint?: string }

/** Spine's mode card, with this editor's own tools beside it. */
const MODE_TOOLS: ToolDef[] = [
  { id: "select", label: "Pose", icon: "select" },
  { id: "freeTransform", label: "Free", icon: "freeTransform" },
  { id: "pivot", label: "Pivot", icon: "pivot" },
  { id: "bone", label: "Create", icon: "bone",
    hint: "Drag to draw a bone. Drag from the end of a bone to add the next one. Alt-drag an end to point it elsewhere." },
  { id: "ik", label: "IK", icon: "ik",
    hint: "Click the last bone of a chain to give it a target. Drag the target and the chain follows. "
      + "In Animate mode, drag targets with Pose: the drag sets a keyframe." },
  { id: "mesh", label: "Mesh", icon: "outlineSq",
    hint: "On a mesh (Modify ▸ Mesh ▸ Make Mesh): drag points; in Setup, click inside to add one and Delete removes the picked ones; "
      + "in Animate, dragging points keys a deform. Properties ▸ Mesh paints weights." },
];
const VIEW_TOOLS: ToolDef[] = [
  { id: "hand", label: "Hand", icon: "hand" },
  { id: "zoom", label: "Zoom", icon: "zoom" },
];

type Row = "rotate" | "translate" | "scale" | "shear";
const ROWS: Array<{ id: Row; label: string; icon: IconName }> = [
  { id: "rotate", label: "Rotate", icon: "rotate" },
  { id: "translate", label: "Translate", icon: "translate" },
  { id: "scale", label: "Scale", icon: "scale" },
  { id: "shear", label: "Shear", icon: "shear" },
];

type FieldKey = "rotate" | "tx" | "ty" | "sx" | "sy" | "shear";

type Flag = keyof Pick<GizmoPrefs,
  "compensateBones" | "compensateImages" | "snapPixels"
  | "selectBones" | "nameBones" | "showImages" | "selectImages" | "nameImages"
  | "showIk" | "selectIk" | "nameIk" | "showPrimary" | "selectPrimary" | "namePrimary">;

/**
 * Spine's toolbar, at the foot of the stage: the tools; Rotate / Translate /
 * Scale / Shear with the selection's values, editable; the axes those values
 * are read in; compensation. What the stage shows and lets you pick (Bones,
 * Images, IK, Primary) is its own card, `corner`, in the stage's top-left
 * corner, over the rulers.
 *
 * Its settings are preferences (`gizmos`), so they persist. Built once: state
 * only toggles classes and values (the DOM trap in ARCHITECTURE.md). Pointer
 * and wheel events stop here, or a click on a button would also start a drag
 * on the stage under it.
 */
export class StageToolbar {
  readonly el: HTMLElement;
  /** The visibility table, mounted by the caller in the stage's top-left corner. */
  readonly corner: HTMLElement;
  private toolButtons = new Map<ToolId, HTMLElement>();
  private fields = {} as Record<FieldKey, NumberField>;
  private axisButtons = new Map<Axes, HTMLElement>();
  private flagButtons = new Map<Flag, HTMLElement>();
  private bonesShown!: HTMLElement;
  private base: EditBase | null = null;
  private scrubbing = false;

  constructor(private readonly store: Store, private readonly pose: () => Pose | null) {
    this.el = h("div", { class: "sbar" },
      this.buildTools(), this.buildTransform(), this.buildAxes(), this.buildCompensation());
    this.corner = h("div", { class: "sbar sbar-corner" }, this.buildVisibility());
    for (const el of [this.el, this.corner]) {
      for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) {
        on(el, ev, (e) => e.stopPropagation());
      }
    }
    // The stage resizes, or the bar does (a mode hides tools, cards wrap):
    // it stays on the stage.
    new ResizeObserver(() => this.place()).observe(this.el);
    // After the stage's own render, which is also on the next frame: World
    // values come from the pose it draws.
    const later = raf(() => this.syncValues());
    store.subscribe((t) => {
      if (t === "tool" || t === "doc" || t === "playback") this.syncTools();
      if (t !== "library") later();
    });
    store.prefs.subscribe(() => { this.syncFlags(); this.place(); later(); });
    this.syncTools();
    this.syncFlags();
    this.syncValues();
  }

  // ── Cards ──────────────────────────────────────────────────────────────

  private buildTools(): HTMLElement {
    const titles: Array<() => void> = [];
    const button = (t: ToolDef, labelled: boolean) => {
      const b = h("button", { class: labelled ? "sbar-btn" : "sbar-btn icon-only" },
        icon(t.icon, 14), labelled ? h("span", null, t.label) : null);
      const title = () => { b.title = withAccel(t.label, `tool.${t.id}`) + (t.hint ? `\n${t.hint}` : ""); };
      title();
      titles.push(title);
      on(b, "click", () => this.store.setTool(t.id));
      this.toolButtons.set(t.id, b);
      return b;
    };
    onAccelChange(() => titles.forEach((f) => f()));
    return h("div", { class: "sbar-card sbar-tools" },
      h("div", { class: "sbar-grid" }, ...MODE_TOOLS.map((t) => button(t, true))),
      h("div", { class: "sbar-col" }, ...VIEW_TOOLS.map((t) => button(t, false))));
  }

  private buildTransform(): HTMLElement {
    // The glyph is what scrubs, as in Properties.
    const field = (key: FieldKey, glyph: string, unit?: string, decimals = 2, step = 1) => {
      const f = new NumberField({
        glyph, unit, decimals, step,
        onInput: (v, committing) => this.write(key, v, committing),
      });
      this.fields[key] = f;
      return f.el;
    };
    const buttons = ROWS.map((r) => {
      const b = h("button", { class: "sbar-btn" }, icon(r.icon, 14), h("span", null, r.label));
      b.title = withAccel(`${r.label} tool: drag anywhere on the stage to ${r.label.toLowerCase()} the selection`, `tool.${r.id}`);
      on(b, "click", () => this.store.setTool(r.id));
      this.toolButtons.set(r.id, b);
      return b;
    });
    // One grid, its cells parted by single lines, rather than a box per field.
    const fields = h("div", { class: "sbar-fields" },
      field("rotate", "∠", "°"), this.buildGrip(),
      field("tx", "x"), field("ty", "y"),
      field("sx", "x", undefined, 3, 0.01), field("sy", "y", undefined, 3, 0.01),
      field("shear", "x", "°"), h("div", { class: "sbar-gap", title: "This editor's transform has one shear angle; Spine's shear Y stays 0." }));
    return h("div", { class: "sbar-card sbar-transform" }, h("div", { class: "sbar-col" }, ...buttons), fields);
  }

  /** Drags the whole bar about the stage; a double-click sends it home. */
  private buildGrip(): HTMLElement {
    const grip = h("div", { class: "sbar-grip", title: "Drag to move the toolbar. Double-click: back to the bottom left." }, icon("grip", 14));
    let from: { x: number; y: number; off: Offset } | null = null;
    on(grip, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      from = { x: e.clientX, y: e.clientY, off: this.offset() };
      grip.classList.add("dragging");
    });
    on(grip, "pointermove", (e: PointerEvent) => {
      if (!from) return;
      this.place({ dx: from.off.dx + e.clientX - from.x, dy: from.off.dy + e.clientY - from.y });
    });
    const end = (e: PointerEvent) => {
      if (!from) return;
      from = null;
      grip.classList.remove("dragging");
      grip.releasePointerCapture?.(e.pointerId);
      // Saved once, at the end: a preference write per pointer move is wasted.
      const off = this.offset();
      this.store.prefs.set("gizmos", { toolbarX: off.dx, toolbarY: off.dy });
    };
    on(grip, "pointerup", end);
    on(grip, "pointercancel", end);
    on(grip, "dblclick", () => this.store.prefs.set("gizmos", { toolbarX: 0, toolbarY: 0 }));
    return grip;
  }

  /** Where the bar is drawn now: the saved offset, or the drag's. */
  private shown: Offset = { dx: 0, dy: 0 };

  private offset(): Offset { return { ...this.shown }; }

  /** Put the bar at `want` (default: the saved offset), kept on the stage. */
  private place(want?: Offset): void {
    const host = this.el.parentElement;
    if (!host) return;
    const g = this.store.prefs.value.gizmos;
    const off = clampToolbarOffset(want ?? { dx: g.toolbarX, dy: g.toolbarY },
      { w: this.el.offsetWidth, h: this.el.offsetHeight }, { w: host.clientWidth, h: host.clientHeight });
    this.shown = off;
    this.el.style.transform = off.dx || off.dy ? `translate(${off.dx}px, ${off.dy}px)` : "";
  }

  /** Pixels the bar covers at the stage's foot, for Fit to Stage. */
  coveredBottom(): number {
    return this.el.hidden ? 0 : toolbarInset(this.shown, { w: this.el.offsetWidth, h: this.el.offsetHeight });
  }

  /** The stage it sits on, to keep it on as that resizes. */
  observeHost(host: HTMLElement): void {
    new ResizeObserver(() => this.place()).observe(host);
  }

  private buildAxes(): HTMLElement {
    const AXES: Array<{ id: Axes; label: string; hint: string }> = [
      { id: "local", label: "Local", hint: "Translate along the node's own turned axes" },
      { id: "parent", label: "Parent", hint: "The stored values: x/y in the parent's space" },
      { id: "world", label: "World", hint: "Where the node sits on the stage, and its turn there" },
    ];
    const card = h("div", { class: "sbar-card sbar-col" }, ...AXES.map((a) => {
      const b = h("button", { class: "sbar-btn", title: a.hint }, h("span", null, a.label));
      on(b, "click", () => this.store.prefs.set("gizmos", { axes: a.id }));
      this.axisButtons.set(a.id, b);
      return b;
    }));
    return card;
  }

  private buildCompensation(): HTMLElement {
    const items: Array<{ flag: Flag; label: string; icon: IconName; hint: string }> = [
      { flag: "compensateBones", label: "Bones", icon: "bone", hint: "Transforming a node leaves its child bones where they are" },
      { flag: "compensateImages", label: "Images", icon: "imageItem", hint: "Transforming a node leaves its images where they are" },
      { flag: "snapPixels", label: "Pixels", icon: "grid", hint: "Translate in whole pixels" },
    ];
    const card = h("div", { class: "sbar-card sbar-col" }, ...items.map((it) => {
      const b = h("button", { class: "sbar-btn", title: it.hint }, icon(it.icon, 14), h("span", null, it.label));
      on(b, "click", () => this.toggle(it.flag));
      this.flagButtons.set(it.flag, b);
      return b;
    }));
    return card;
  }

  private buildVisibility(): HTMLElement {
    const dot = (flag: Flag | "showBones", hint: string) => {
      const b = h("button", { class: "sbar-dot", title: hint });
      if (flag === "showBones") {
        on(b, "click", () => this.store.setViewFlag("showBones", !this.store.ui.showBones));
        this.bonesShown = b;
      } else {
        on(b, "click", () => this.toggle(flag));
        this.flagButtons.set(flag, b);
      }
      return b;
    };
    const head = (name: IconName, hint: string) => h("span", { class: "sbar-head", title: hint }, icon(name, 13));
    return h("div", { class: "sbar-card sbar-vis" },
      h("span", null), head("select", "Can be picked on the stage"), head("eye", "Shown on the stage"), head("tag", "Name written on the stage"),
      h("span", { class: "sbar-label" }, "Bones"), dot("selectBones", "Pick bones"), dot("showBones", "Show bones"), dot("nameBones", "Bone names"),
      h("span", { class: "sbar-label" }, "Images"), dot("selectImages", "Pick images"), dot("showImages", "Show images"), dot("nameImages", "Image names"),
      h("span", { class: "sbar-label" }, "IK"), dot("selectIk", "Pick IK targets"), dot("showIk", "Show IK targets"), dot("nameIk", "Every IK constraint's name"),
      h("span", { class: "sbar-label", title: "Bones marked Primary (Properties ▸ Bone): they follow this row instead of Bones" }, "Primary"),
      dot("selectPrimary", "Pick primary bones"), dot("showPrimary", "Show primary bones"), dot("namePrimary", "Primary bone names"));
  }

  private toggle(flag: Flag): void {
    const g = this.store.prefs.value.gizmos;
    this.store.prefs.set("gizmos", { [flag]: !g[flag] } as Partial<GizmoPrefs>);
  }

  // ── State ──────────────────────────────────────────────────────────────

  private syncTools(): void {
    const { tool, mode } = this.store.ui;
    const shown = new Set(availableTools(mode));
    // A tool the mode hides keeps its slot, so nothing on the bar moves
    // when the mode changes.
    for (const [id, b] of this.toolButtons) {
      cls(b, "unavail", !shown.has(id));
      cls(b, "on", tool === id);
    }
  }

  private syncFlags(): void {
    const g = this.store.prefs.value.gizmos;
    this.el.hidden = !g.showToolbar;
    this.corner.hidden = !g.showToolbar;
    for (const [a, b] of this.axisButtons) cls(b, "on", g.axes === a);
    for (const [flag, b] of this.flagButtons) cls(b, "on", g[flag]);
    cls(this.bonesShown, "on", this.store.ui.showBones);
  }

  /** The selection's values in the current axes; a field the selection
   *  disagrees on shows as mixed. Skipped while that field is being typed in. */
  private syncValues(): void {
    cls(this.bonesShown, "on", this.store.ui.showBones);
    if (this.scrubbing) return;
    const snaps = selectionSnapshots(this.ctx());
    const axes = this.store.prefs.value.gizmos.axes;
    const values = snaps.map((s) => valuesOf(axes, s));
    for (const key of Object.keys(this.fields) as FieldKey[]) {
      const f = this.fields[key];
      f.setDisabled(values.length === 0);
      if (f.focused || values.length === 0) continue;
      const v = values[0]![key];
      if (values.every((x) => Math.abs(x[key] - v) < 1e-6)) f.set(v);
      else f.setMixed();
    }
  }

  private ctx() { return { store: this.store, pose: this.pose }; }

  /** A field edit: the value is set on every selected node, then compensation
   *  and Pixels apply (`finishEdit`), and it is written like a drag — Setup
   *  edits the rest pose, Animate keys. A scrub is one undo step. */
  private write(key: FieldKey, value: number, committing: boolean): void {
    if (!this.base) this.base = captureEditBase(this.ctx());
    const base = this.base;
    if (base.snaps.length === 0) { this.base = null; return; }
    const axes = this.store.prefs.value.gizmos.axes;
    const next = new Map<NodeId, Transform>();
    for (const s of base.snaps) next.set(s.id, edited(axes, s, key, value));

    if (!committing && !this.scrubbing) {
      this.store.history.beginInteraction("node.transform");
      this.scrubbing = true;
    }
    applyEdit(this.store, finishEdit(this.store, base, next), this.scrubbing);
    if (committing) {
      if (this.scrubbing) this.store.history.endInteraction();
      this.scrubbing = false;
      this.base = null;
      this.syncValues();
    }
  }
}

function valuesOf(axes: Axes, s: NodeSnapshot): Record<FieldKey, number> {
  const t = shownTranslation(axes, s.local, s.world);
  return {
    rotate: shownRotation(axes, s.local, s.world),
    tx: t.x, ty: t.y,
    sx: s.local.scaleX, sy: s.local.scaleY,
    shear: s.local.skewX - s.local.skewY,
  };
}

function edited(axes: Axes, s: NodeSnapshot, key: FieldKey, value: number): Transform {
  switch (key) {
    case "rotate": return rotationFromShown(axes, value, s.local, s.world, s.parent);
    case "tx":
    case "ty": {
      const t = shownTranslation(axes, s.local, s.world);
      return translationFromShown(axes, key === "tx" ? { x: value, y: t.y } : { x: t.x, y: value }, s.local, s.parent);
    }
    case "sx": return { ...s.local, scaleX: nonZero(value) };
    case "sy": return { ...s.local, scaleY: nonZero(value) };
    case "shear": return { ...s.local, skewX: s.local.skewY + value };
  }
}

function nonZero(v: number): number {
  return Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v;
}
