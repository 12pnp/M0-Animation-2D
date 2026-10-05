import { constraintEntries } from "@/core/doc/constraintOrder";
import { clear, cls, h, on } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import { NumberField } from "@/view/widgets/NumberField";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import { SetPivot } from "@/core/history/hierarchyCommands";
import {
  applyEdit, displayAtFrame, editsMultipleFrames,
  transformAtFrame
} from "@/app/TimelineOps";
import { usedMixes } from "@/core/doc/transformKeys";
import type { Transform } from "@/core/math/Transform";
import type { NodeId } from "@/core/doc/ids";
import type { Rect } from "@/core/math/geom";
import { instancesOf, type PoseAt, selectionBounds } from "@/view/tools/gizmo";
import {
  editTargets,
  type FieldKey,
  fieldTransform,
  groupFieldWrite,
  type GroupSnapshot,
  type NodeSnapshot,
  snapshotOf,
} from "@/core/doc/transformOps";
import { displaySize, type Pose } from "@/core/doc/pose";
import type { Node } from "@/core/doc/types";
import { editedSkin, stageSkinOf } from "@/core/doc/skins";
import { skinnedOutline, withPointOffset } from "@/core/doc/boxes";
import { editShownOutline } from "@/app/AttachmentOps";
import { displaysOf } from "@/core/doc/displays";
import type { ColorMode } from "@/core/doc/colorEffect";
import { colorSection } from "./props/colorSection";
import { boneSection, ikSection } from "./props/boneSection";
import { transformSection } from "./props/transformSection";
import { meshSection, sequenceSection } from "./props/meshSection";
import { physicsSection, sliderSection, pathSection, constraintOrderSection } from "./props/constraintSections";
import { skinSection } from "./props/skinSection";
import { documentSection, instanceSection, makeFrameNote, syncFrameNote } from "./props/documentSection";

export class PropertiesPanel implements Panel {
  readonly id = "properties";
  readonly title = "Properties";
  readonly icon = "properties" as const;
  readonly el: HTMLElement;

  private body: HTMLElement;
  private fields = new Map<FieldKey, NumberField>();
  nameInput: HTMLInputElement | null = null;
  /** The "this frame is turned" badge, refreshed on every sync: the pose it
   *  reads is the RENDERED one, which does not exist yet at layout time and
   *  changes under the playhead anyway. */
  frameNote: HTMLElement | null = null;
  private suppress = false;
  /** With nothing selected: refreshes the document fields in place. The
   *  section used to be rebuilt on every "frame" event, which during playback
   *  destroyed the field under the cursor sixty times a second. */
  docSync: Array<() => void> = [];
  /** The IK section's values at the playhead in Animate mode, refreshed on
   *  every sync. */
  ikSync: Array<() => void> = [];
  private rebuilding = false;
  /** A field scrub in progress: one interaction from the first step to the
   *  commit, so Edit Multiple Frames edits the keys as they were when it
   *  began. */
  private scrubbing = false;
  /** The virtual group being edited, captured at the first step of a scrub
   *  (or for one typed value). Every step is computed from it, not from the
   *  last rendered pose, which lags a step behind a fast scrub. */
  private group: GroupSnapshot | null = null;
  /** Chain toggles: keep the paired fields proportional. Remembered across
   *  selections and sessions, the way Animate's link button behaves. */
  private linked: Record<"size" | "scale" | "stage", boolean> = {
    size: loadLinked("size"),
    scale: loadLinked("scale"),
    stage: loadLinked("stage"),
  };

  /** Identity of what is currently laid out. A change here means the panel's
   *  STRUCTURE is stale (different item, different node kind), not just its
   *  numbers, so it must be rebuilt rather than merely re-synced. */
  private signature = "";

  /** Chosen colour-effect mode per node. Not in the document: it is a view of
   *  one ColorTransform, so it is re-derived when a node is first shown and
   *  then remembered while the selection lasts. */
  colorModes = new Map<NodeId, ColorMode>();

  /**
   * The panel needs the RENDERED pose, not a freshly composed one: a bone
   * driven by IK is rotated by the solver at display time, and the note below
   * would otherwise name the frame the file describes rather than the one the
   * user is looking at.
   */
  constructor(
    readonly store: Store,
    readonly poseOf: () => Pose | null = () => null,
    /** Every pose on stage the selection can be edited in: the playhead's,
     *  plus each frame Edit Multiple Frames shows. */
    private readonly posesOf: () => PoseAt[] = () => [],
    /** Runs an app command by id (the mesh commands need the image store). */
    readonly run: (command: string) => void = () => {},
  ) {
    this.body = h("div", { class: "props" });
    this.el = this.body;
    store.subscribe((t) => {
      if (t === "selection" || t === "doc" || t === "frame" || t === "stage") this.sync();
    });
    this.rebuild();
  }

  // ── Structure ──────────────────────────────────────────────────────────

  private signatureOf(): string {
    const nodes = this.store.selectedNodes;
    if (nodes.length === 0) {
      const order = constraintEntries(this.store.currentSymbol).map((e) => e.name).join("\n");
      return `doc:${this.store.currentSymbolId}:${order}`;
    }
    // The display shown decides the type line and the Colour section, and
    // changes under the playhead on a layer that switches artwork.
    // Animate mode keys the IK section's mix and bend, Setup edits the constraint.
    const anim = this.store.ui.mode === "animate" ? this.store.currentAnimation?.id ?? "" : "setup";
    // Which transform constraints exist and what they connect: the section's
    // structure. Their values are synced, not rebuilt.
    const tcs = (this.store.currentSymbol.transforms ?? [])
      .map((k) => [k.id, k.name, k.sourceId, k.boneIds.join(","), !!k.localSource, !!k.localTarget, !!k.additive, !!k.clamp, usedMixes(k).join(""),
        k.properties.map((p) => `${p.from}>${p.to.map((t) => t.to).join("+")}`).join(",")].join(":")).join(";");
    // Skins are replaced as values: their identity says when they changed.
    const sym = this.store.currentSymbol;
    const skins = `${valueId(sym.skins)}:${stageSkinOf(sym).join(",")}:${editedSkin(sym, this.store.ui.editSkin) ?? ""}`
      // Physics, sliders and paths: which there are, not their values (synced).
      + [...(sym.physics ?? []), ...(sym.sliders ?? []), ...(sym.paths ?? [])].map((k) => `${k.id}:${k.name}:${"boneId" in k ? k.boneId : ""}:${"boneIds" in k ? k.boneIds.join(",") : ""}:${"animId" in k ? k.animId : ""}`).join(";");
    return `${anim}|${tcs}|${skins}|` + nodes.map((n) => `${n.id}:${n.kind}:${displaysOf(n).map((d) => (d.skinOnly ? "s" : "d") + (d.linked ? `l${d.linked.to}${d.linked.deform === false ? "n" : ""}` : "")).join("")}${n.boneColor ?? ""}:${displayAtFrame(this.store, n).display?.itemId ?? ""}${displayAtFrame(this.store, n).display?.tint ? "t" : ""}:${n.mesh ? `m${n.mesh.points.length}${n.mesh.weights ? "w" : ""}` : ""}${n.sequence ? `q${n.sequence.items.length}` : ""}`).join("|");
  }

  /**
   * Rebuild the panel's DOM.
   *
   * Never re-entrant: removing a focused field fires its `blur`, the blur
   * commits, the commit emits, and the emit used to land back here in the
   * middle of `clear` — "removeChild: the node is no longer a child", thrown
   * from inside Playback's tick, which killed the playback loop while the
   * transport still said Pause. A nested request is covered by the sync that
   * always follows.
   */
  rebuild(): void {
    if (this.rebuilding) return;
    this.rebuilding = true;
    try {
      // Commit what is being typed while its field still exists.
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.body.contains(active)) active.blur();
      this.build();
    } finally {
      this.rebuilding = false;
    }
    this.sync();
  }

  private build(): void {
    clear(this.body);
    this.fields.clear();
    this.nameInput = null;
    this.docSync = [];
    this.ikSync = [];
    this.signature = this.signatureOf();
    const nodes = this.store.selectedNodes;

    if (nodes.length === 0) {
      this.body.appendChild(documentSection(this));
      const order = constraintOrderSection(this);
      if (order) this.body.appendChild(order);
      return;
    }

    // A bone has no artwork, so width, height and a transform point would be
    // fields with nothing behind them.
    const bone = nodes.length === 1 && nodes[0]!.kind === "bone" ? nodes[0]! : null;

    this.body.appendChild(instanceSection(this, nodes.length));
    // Position, size and the rest of the transform: one section.
    this.body.appendChild(this.section("Transform", true, [
      this.row("Position", [this.field("x", "X"), this.field("y", "Y")]),
      ...(bone ? [] : [this.linkedRow("Size", "size", this.field("w", "W"), this.field("h", "H"))]),
      this.linkedRow("Scale", "scale",
        this.field("scaleX", "X", { step: 0.01, decimals: 3, sensitivity: 60 }),
        this.field("scaleY", "Y", { step: 0.01, decimals: 3, sensitivity: 60 })),
      this.row("Rotate", [this.field("rotation", "∠", { unit: "°" })]),
      // Skew X and Skew Y ARE the two angular degrees of freedom, exactly as
      // in Flash: a pure rotation shows the same value in both, and pulling
      // them apart is what shears the object.
      this.row("Skew", [
        this.field("skewX", "X", { unit: "°" }),
        this.field("skewY", "Y", { unit: "°" }),
      ]),
      ...(bone ? [] : [this.row("Pivot", [this.field("pivotX", "X"), this.field("pivotY", "Y")])]),
    ], makeFrameNote(this)));
    // A bone produces no slot, so it has neither colour nor blend mode.
    if (!bone) this.body.appendChild(colorSection(this, nodes));
    if (!bone && nodes.length === 1 && nodes[0]!.kind === "image" && !nodes[0]!.attachment) this.body.appendChild(meshSection(this, nodes[0]!));
    if (!bone && nodes.length === 1 && nodes[0]!.kind === "image" && !nodes[0]!.attachment && !nodes[0]!.mesh) this.body.appendChild(sequenceSection(this, nodes[0]!));
    if (nodes.length === 1 && (bone || nodes[0]!.kind === "image")) this.body.appendChild(skinSection(this, nodes[0]!));
    if (bone) {
      this.body.appendChild(boneSection(this, bone));
      const section = ikSection(this, bone);
      if (section) this.body.appendChild(section);
      this.body.appendChild(transformSection(this, bone));
      this.body.appendChild(physicsSection(this, bone));
      this.body.appendChild(sliderSection(this, bone));
    }
    if (nodes.length === 1 && (bone || nodes[0]!.kind === "path")) {
      const section = pathSection(this, nodes[0]!);
      if (section) this.body.appendChild(section);
    }
    if (nodes.length === 1 && nodes[0]!.kind === "point") this.body.appendChild(this.pointSection(nodes[0]!));
  }

  /** A point's offset from its node's origin and its turn (ARCHITECTURE ▸
   *  Boxes and points), Spine's point `x`, `y`, `rotation`. A scrub is one undo step. */
  private pointSection(node: Node): HTMLElement {
    // The point as the stage shows it: a shown skin's own, else the node's.
    const shown = skinnedOutline(this.store.currentSymbol, node, stageSkinOf(this.store.currentSymbol));
    const field = (key: "x" | "y" | "rotation", glyph: string, unit?: string) => {
      const nf = new NumberField({
        glyph, unit, step: key === "rotation" ? 1 : 0.5, decimals: 2,
        onInput: (v, committing) => {
          this.scrubStep("point.edit", committing);
          editShownOutline(this.store, node.id, (n) => withPointOffset(n, { [key]: v }), "Move Point", "point.edit");
          this.store.emit("stage");
          if (committing) this.store.history.endInteraction();
        },
      });
      nf.set(shown.point?.[key] ?? 0);
      return nf.el;
    };
    return this.section("Point", true, [
      this.row("Offset", [field("x", "X"), field("y", "Y")]),
      this.row("Rotation", [field("rotation", "∠", "°")]),
    ]);
  }

  section(
    title: string, open: boolean, rows: HTMLElement[], note?: HTMLElement | null,
  ): HTMLElement {
    const tri = h("span", { class: "tri" });
    const head = h("div", { class: "shead" }, tri, h("span", null, title));
    if (note) head.appendChild(note);
    const body = h("div", { class: "sbody" }, ...rows);
    const sec = h("div", { class: `section${open ? " open" : ""}` }, head, body);
    on(head, "click", () => sec.classList.toggle("open"));
    return sec;
  }

  row(label: string, controls: HTMLElement[]): HTMLElement {
    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: `fields${controls.length > 1 ? " pair" : ""}` }, ...controls));
  }

  /** A pair of fields with a chain toggle between them. */
  linkedRow(
    label: string, key: "size" | "scale" | "stage", a: HTMLElement, b: HTMLElement,
  ): HTMLElement {
    const btn = h("button", { class: "iconbtn linkbtn" });
    const paint = () => {
      clear(btn);
      btn.appendChild(icon(this.linked[key] ? "link" : "linkOff", 13));
      cls(btn, "on", this.linked[key]);
      btn.title = this.linked[key]
        ? "Linked: changing one changes the other"
        : "Not linked";
    };
    on(btn, "click", () => {
      this.linked[key] = !this.linked[key];
      saveLinked(key, this.linked[key]);
      paint();
    });
    paint();

    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: "fields pair linked" }, a, btn, b));
  }

  staticRow(label: string, value: string): HTMLElement {
    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: "fields" }, h("span", { class: "hint" }, value)));
  }

  private field(
    key: FieldKey, glyph: string,
    opts: { step?: number; decimals?: number; unit?: string; sensitivity?: number } = {},
  ): HTMLElement {
    const nf = new NumberField({
      glyph,
      unit: opts.unit,
      step: opts.step ?? 1,
      decimals: opts.decimals ?? 2,
      sensitivity: opts.sensitivity ?? 2,
      onInput: (v, committing) => this.write(key, v, committing),
    });
    this.fields.set(key, nf);
    return nf.el;
  }

  // ── Read / write ───────────────────────────────────────────────────────

  private sync(): void {
    if (this.rebuilding) return;
    if (!this.scrubbing) this.group = null;
    const nodes = this.store.selectedNodes;
    if (this.signatureOf() !== this.signature) {
      this.rebuild();
      return;
    }
    if (nodes.length === 0) {
      for (const update of this.docSync) update();
      return;
    }
    if (this.fields.size === 0) {
      this.rebuild();
      return;
    }
    if (this.nameInput && document.activeElement !== this.nameInput) {
      this.nameInput.value = nodes.length > 1 ? "" : nodes[0]!.name;
    }

    syncFrameNote(this, nodes);
    for (const update of this.ikSync) update();

    this.suppress = true;
    const first = nodes[0]!;
    // In Animate mode the fields show what is on screen at the playhead, not
    // the bind pose — otherwise typing a value would silently jump the object.
    const at = new Map(nodes.map((n) => [n.id, transformAtFrame(this.store, n)]));
    const tfOf = (n: typeof first) => at.get(n.id) ?? n.bind;
    const firstTf = tfOf(first);
    const size = displaySize(this.store.project, first, displayAtFrame(this.store, first).index);
    const pivotOf = (n: typeof first) => displayAtFrame(this.store, n).display?.pivot ?? n.pivot;
    const set = (k: FieldKey, value: number, mixed: boolean) => {
      const f = this.fields.get(k);
      if (!f || f.focused) return;
      if (mixed) f.setMixed(); else f.set(value);
    };
    const varies = (read: (n: typeof first) => number) =>
      nodes.some((n) => Math.abs(read(n) - read(first)) > 1e-6);

    const bounds = this.isGroup(nodes) ? this.groupBounds() : null;
    if (bounds) {
      set("x", bounds.x, false);
      set("y", bounds.y, false);
      set("w", bounds.w, false);
      set("h", bounds.h, false);
    } else {
      set("x", firstTf.x, varies((n) => tfOf(n).x));
      set("y", firstTf.y, varies((n) => tfOf(n).y));
      set("w", size.w * firstTf.scaleX, nodes.length > 1);
      set("h", size.h * firstTf.scaleY, nodes.length > 1);
    }
    set("scaleX", firstTf.scaleX, varies((n) => tfOf(n).scaleX));
    set("scaleY", firstTf.scaleY, varies((n) => tfOf(n).scaleY));
    set("rotation", firstTf.skewY, varies((n) => tfOf(n).skewY));
    set("skewX", firstTf.skewX, varies((n) => tfOf(n).skewX));
    set("skewY", firstTf.skewY, varies((n) => tfOf(n).skewY));
    set("pivotX", pivotOf(first).x, varies((n) => pivotOf(n).x));
    set("pivotY", pivotOf(first).y, varies((n) => pivotOf(n).y));
    this.suppress = false;
  }

  /**
   * Opens a NumberField scrub's interaction on its FIRST step: the field
   * reports no start, and `beginInteraction` on every step closed the entry
   * each time — one undo step per pointermove.
   */
  scrubStep(kind: string, committing: boolean): void {
    const history = this.store.history;
    if (!committing && !history.inInteraction) history.beginInteraction(kind);
  }

  private write(key: FieldKey, value: number, committing: boolean): void {
    if (this.suppress) return;
    const nodes = this.store.selectedNodes;
    if (nodes.length === 0) return;

    if (key === "pivotX" || key === "pivotY") {
      this.writePivot(key, value, committing);
      return;
    }

    const next = this.isGroup(nodes)
      ? this.groupWrite(key, value)
      : this.singleWrite(nodes, key, value);
    if (!next) return;

    if (!committing && !this.scrubbing) {
      this.store.history.beginInteraction("node.transform");
      this.scrubbing = true;
    }
    applyEdit(this.store, next, this.scrubbing);
    if (committing) {
      if (this.scrubbing) this.store.history.endInteraction();
      this.scrubbing = false;
      this.group = null;
    }
  }

  private singleWrite(nodes: Node[], key: FieldKey, value: number): Map<NodeId, Transform> {
    const next = new Map<NodeId, Transform>();
    for (const n of nodes) {
      const size = displaySize(this.store.project, n, displayAtFrame(this.store, n).index);
      next.set(n.id, fieldTransform(transformAtFrame(this.store, n), size, key, value, this.linked));
    }
    return next;
  }

  // ── The virtual group ──────────────────────────────────────────────────

  /** Several nodes, or one node shown in several frames by Edit Multiple
   *  Frames: either way more than one thing on stage answers to the fields. */
  private isGroup(nodes: Node[]): boolean {
    if (nodes.length > 1) return true;
    return editsMultipleFrames(this.store) && instancesOf(this.posesOf(), this.groupIds()).length > 1;
  }

  private groupIds(): NodeId[] {
    return editTargets(this.store.currentSymbol, this.store.selection.nodes, false);
  }

  private groupBounds(): Rect | null {
    return selectionBounds(this.store.project, this.posesOf(), this.groupIds());
  }

  private captureGroup(): GroupSnapshot | null {
    const pose = this.poseOf();
    const bounds = this.groupBounds();
    if (!pose || !bounds) return null;
    const snaps: NodeSnapshot[] = [];
    for (const id of this.groupIds()) {
      const n = this.store.node(id);
      const entry = pose.byNode.get(id);
      if (!n || !entry) continue;
      const parent = n.parentId ? pose.byNode.get(n.parentId)?.world : undefined;
      const shown = displayAtFrame(this.store, n);
      snaps.push(snapshotOf(
        id, transformAtFrame(this.store, n), entry.world, parent, shown.display?.pivot ?? n.pivot, shown.index,
      ));
    }
    const first = this.store.selectedNodes[0];
    if (!snaps.length || !first) return null;
    return { bounds, snaps, first: transformAtFrame(this.store, first) };
  }

  /**
   * One write to the group. Position and size are the bounding box: X moves
   * everything by the difference, W scales everything from the box's left
   * edge. Rotate, Scale and Skew are the FIRST node's values, reached by
   * turning or scaling the whole group about the box's centre — so a
   * selection of differently rotated objects keeps its arrangement instead of
   * being flattened to one angle.
   */
  private groupWrite(key: FieldKey, value: number): Map<NodeId, Transform> | null {
    this.group ??= this.captureGroup();
    return this.group ? groupFieldWrite(this.group, key, value, this.linked) : null;
  }

  /**
   * Setting the transform point numerically must behave exactly like dragging
   * it: the point moves, the artwork does not. That needs the node's world
   * matrix, which is why the panel is handed a pose provider.
   */
  private writePivot(key: "pivotX" | "pivotY", value: number, committing: boolean): void {
    const pivots = new Map<NodeId, { x: number; y: number }>();
    const displays = new Map<NodeId, number>();
    for (const n of this.store.selectedNodes) {
      const shown = displayAtFrame(this.store, n);
      const pivot = shown.display?.pivot ?? n.pivot;
      pivots.set(n.id, {
        x: key === "pivotX" ? value : pivot.x,
        y: key === "pivotY" ? value : pivot.y,
      });
      displays.set(n.id, shown.index);
    }
    if (pivots.size === 0) return;

    this.scrubStep("node.pivot", committing);
    // The command does the compensation, on the bind pose and on every
    // keyframe, so the artwork stays put whatever mode we are in.
    this.store.apply(new SetPivot(this.store.currentSymbolId, pivots, { displays }));
    if (committing) this.store.history.endInteraction();
  }
}

const LINK_KEY = "animo.props.linked";

function loadLinked(key: "size" | "scale" | "stage"): boolean {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    return raw ? !!(JSON.parse(raw) as Record<string, boolean>)[key] : false;
  } catch { return false; }
}

function saveLinked(key: "size" | "scale" | "stage", value: boolean): void {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    all[key] = value;
    localStorage.setItem(LINK_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
}

/** A number per object, the same while the object is: a replaced value gets a new one. */
const valueIds = new WeakMap<object, number>();
let nextValueId = 1;
function valueId(o: object | undefined): number {
  if (!o) return 0;
  let id = valueIds.get(o);
  if (!id) valueIds.set(o, id = nextValueId++);
  return id;
}

