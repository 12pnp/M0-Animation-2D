import { channelKeysOf, channelOf, keyedConstraint, setupValue, valueAt, withChannelKeys, withValueKey } from "@/core/doc/constraintKeys";
import { constraintEntries, withConstraintMoved, type ConstraintKind } from "@/core/doc/constraintOrder";
import { h, on } from "@/view/widgets/dom";
import { NumberField } from "@/view/widgets/NumberField";
import {
  doSetConstraintKeys
} from "@/app/TimelineOps";
import { chooseDialog } from "@/view/widgets/dialogs";
import type { Node } from "@/core/doc/types";
import { doAddPhysics, doAddSlider, doSetConstraints } from "@/app/AttachmentOps";
import { PHYSICS_DEFAULTS, type PhysicsSetting, SLIDER_PROPERTIES } from "@/core/doc/constraints";
import { type ConstraintField, EditNode, SetConstraintOrder } from "@/core/history/attachmentCommands";
import type { CnId } from "@/core/doc/ids";
import type { PathShape, SymbolItem } from "@/core/doc/types";
import type { PropertiesPanel } from "@/view/panels/PropertiesPanel";
import { noteRow } from "./documentSection";

/**
 * Properties ▸ Physics, Slider and Path constraints, and the constraint order.
 */

/**
 * Rows editing one physics, slider or path constraint by `specs`, each
 * synced with the document; a value at Spine's default is written absent.
 */
export function constraintRows<F extends ConstraintField>(api: PropertiesPanel, field: F, id: CnId, specs: ConstraintSpec[]): HTMLElement[] {
  type K = NonNullable<SymbolItem[F]>[number];
  const current = (): K | undefined => (api.store.currentSymbol[field] as K[] | undefined)?.find((k) => k.id === id);
  const write = (key: string, value: unknown, def: unknown, label: string, committing: boolean) => {
    const list = (api.store.currentSymbol[field] ?? []) as K[];
    const next = list.map((k) => {
      if (k.id !== id) return k;
      const out = { ...k } as Record<string, unknown>;
      if (value === def || value === undefined || value === "") delete out[key]; else out[key] = value;
      return out as unknown as K;
    });
    const kind = `constraint.edit.${id}.${key}`;
    api.scrubStep(kind, committing);
    doSetConstraints(api.store, field, next as NonNullable<SymbolItem[F]>, label, kind);
    if (committing) api.store.history.endInteraction();
  };
  const read = (key: string, def: unknown) => (current() as Record<string, unknown> | undefined)?.[key] ?? def;
  return specs.map((spec) => {
    // In Animate mode a keyable value is keyed at the playhead (`constraintKeys`).
    const channel = spec.type === "number" ? channelOf(field === "sliders" ? "slider" : field === "paths" ? "path" : "physics", spec.key) : null;
    const animate = api.store.ui.mode === "animate" ? api.store.currentAnimation : null;
    if (spec.type === "number" && channel && animate) {
      const now = () => {
        const c = keyedConstraint(api.store.currentSymbol, id);
        return c ? valueAt(channelKeysOf(api.store.currentAnimation, id, channel), api.store.ui.frame, setupValue(c, channel)) : spec.def as number;
      };
      const nf = new NumberField({
        glyph: spec.glyph, min: spec.min, max: spec.max, step: spec.step, decimals: spec.decimals ?? 2, unit: spec.unit,
        onInput: (v, committing) => {
          const anim = api.store.currentAnimation;
          if (!anim) return;
          const kind = `constraint.key.${id}.${channel}`;
          api.scrubStep(kind, committing);
          const keys = withValueKey(channelKeysOf(anim, id, channel), api.store.ui.frame, v);
          doSetConstraintKeys(api.store, withChannelKeys(anim.constraintKeys, id, channel, keys), `Key ${spec.label}`, kind);
          if (committing) api.store.history.endInteraction();
        },
      });
      nf.set(now());
      api.ikSync.push(() => nf.show(now()));
      return api.row(`${spec.label} ◆`, [nf.el]);
    }
    if (spec.type === "number") {
      const nf = new NumberField({
        glyph: spec.glyph, min: spec.min, max: spec.max, step: spec.step, decimals: spec.decimals ?? 2, unit: spec.unit,
        onInput: (v, committing) => write(spec.key, v, spec.def, spec.label, committing),
      });
      nf.set(read(spec.key, spec.def) as number);
      api.ikSync.push(() => nf.show(read(spec.key, spec.def) as number));
      return api.row(spec.label, [nf.el]);
    }
    if (spec.type === "select") {
      const sel = h("select", { class: "preview-anim" }) as HTMLSelectElement;
      for (const [value, text] of spec.options) sel.appendChild(h("option", { value }, text));
      sel.value = String(read(spec.key, spec.def));
      on(sel, "change", () => write(spec.key, sel.value, spec.def, spec.label, true));
      api.ikSync.push(() => { sel.value = String(read(spec.key, spec.def)); });
      return api.row(spec.label, [sel]);
    }
    const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
    box.checked = read(spec.key, false) === true;
    on(box, "change", () => write(spec.key, box.checked || undefined, undefined, spec.label, true));
    api.ikSync.push(() => { box.checked = read(spec.key, false) === true; });
    return api.row("", [h("label", { class: "switch-label", title: spec.title ?? "" }, box, spec.label)]);
  });
}

export function removeButton<F extends ConstraintField>(api: PropertiesPanel, field: F, id: CnId, label: string): HTMLElement {
  const b = h("button", { class: "btn" }, "Remove");
  on(b, "click", () => {
    const list = ((api.store.currentSymbol[field] ?? []) as Array<{ id: CnId }>).filter((k) => k.id !== id);
    doSetConstraints(api.store, field, list as NonNullable<SymbolItem[F]>, label);
  });
  return b;
}

/** Physics on a bone (Spine's physics constraint): it lags, springs and
 *  sways, simulated by the runtime while the stage and the Preview play. */
export function physicsSection(api: PropertiesPanel, bone: Node): HTMLElement {
  const sym = api.store.currentSymbol;
  const mine = (sym.physics ?? []).filter((k) => k.boneId === bone.id);
  const rows: HTMLElement[] = [];
  const d = PHYSICS_DEFAULTS;
  const num = (key: PhysicsSetting, label: string, glyph: string, min: number, max: number, step: number): ConstraintSpec =>
    ({ type: "number", key, label, glyph, min, max, step, def: d[key] });
  for (const k of mine) {
    rows.push(api.staticRow("Constraint", k.name));
    rows.push(...constraintRows(api, "physics", k.id, [
      num("x", "Move X", "X", 0, 1, 0.05), num("y", "Move Y", "Y", 0, 1, 0.05), num("rotate", "Rotate", "∠", 0, 1, 0.05),
      num("scaleX", "Scale X", "S", 0, 1, 0.05), num("shearX", "Shear X", "⧄", 0, 1, 0.05),
      num("inertia", "Inertia", "I", 0, 1, 0.05), num("strength", "Strength", "K", 0, 1000, 1), num("damping", "Damping", "D", 0, 1, 0.01),
      num("mass", "Mass", "M", 0.01, 100, 0.1), num("wind", "Wind", "W", -1000, 1000, 1), num("gravity", "Gravity", "G", -1000, 1000, 1),
      num("mix", "Mix", "%", 0, 1, 0.05), num("limit", "Limit", "L", 0, 100000, 10), num("fps", "Steps/s", "#", 1, 240, 1),
    ]));
    rows.push(api.row("", [removeButton(api, "physics", k.id, "Remove Physics")]));
  }
  const add = h("button", { class: "btn", title: "This bone lags, springs and sways as its parent moves (Spine's physics)" }, mine.length ? "Add Another" : "Add Physics");
  on(add, "click", () => doAddPhysics(api.store, bone.id));
  rows.push(api.row("", [add]));
  rows.push(noteRow("The stage simulates physics while it plays and shows it at rest when you scrub; the Preview plays it."));
  return api.section("Physics", mine.length > 0, rows);
}

/** Sliders this bone drives (Spine 4.3): an animation played by one of its values. */
export function sliderSection(api: PropertiesPanel, bone: Node): HTMLElement {
  const sym = api.store.currentSymbol;
  const mine = (sym.sliders ?? []).filter((k) => k.boneId === bone.id);
  const rows: HTMLElement[] = [];
  for (const k of mine) {
    rows.push(api.staticRow("Constraint", k.name));
    rows.push(...constraintRows(api, "sliders", k.id, [
      { type: "select", key: "animId", label: "Plays", options: sym.animations.map((a) => [a.id, a.name]), def: "" },
      { type: "select", key: "property", label: "By its", options: SLIDER_PROPERTIES.map((p) => [p, p]), def: "rotate" },
      { type: "number", key: "from", label: "From", glyph: "↦", min: -100000, max: 100000, step: 1, def: 0 },
      { type: "number", key: "to", label: "At (s)", glyph: "t", min: -1000, max: 1000, step: 0.05, def: 0 },
      { type: "number", key: "scale", label: "s per unit", glyph: "×", min: -100, max: 100, step: 0.001, decimals: 4, def: 1 },
      { type: "number", key: "mix", label: "Mix", glyph: "%", min: 0, max: 1, step: 0.05, def: 1 },
      { type: "check", key: "loop", label: "Loop" },
      { type: "check", key: "additive", label: "Additive" },
      { type: "check", key: "local", label: "Local value" },
    ]));
    rows.push(api.row("", [removeButton(api, "sliders", k.id, "Remove Slider")]));
  }
  const add = h("button", { class: "btn", title: "Play an animation by this bone's rotation (Spine's slider)" }, "Add Slider…");
  on(add, "click", async () => {
    const symbolId = api.store.currentSymbolId;
    const name = await chooseDialog({ title: "Add Slider", message: `Which animation does ${bone.name} play as it turns?`, options: api.store.currentSymbol.animations.map((a) => a.name), ok: "Add" });
    const anim = api.store.currentSymbol.animations.find((a) => a.name === name);
    if (!anim || api.store.currentSymbolId !== symbolId || !api.store.currentSymbol.nodes[bone.id]) return;
    doAddSlider(api.store, anim.id, bone.id);
  });
  rows.push(api.row("", [add]));
  return api.section("Slider", mine.length > 0, rows);
}

/** The path constraints a bone follows or a path node carries, and a
 *  path's own shape settings. */
export function pathSection(api: PropertiesPanel, node: Node): HTMLElement | null {
  const sym = api.store.currentSymbol;
  const mine = (sym.paths ?? []).filter((k) => k.pathId === node.id || k.boneIds.includes(node.id));
  if (!mine.length && node.kind !== "path") return null;
  const rows: HTMLElement[] = [];
  if (node.kind === "path" && node.path) {
    const shape = node.path;
    const flag = (label: string, read: () => boolean, patch: (on: boolean) => Partial<PathShape>) => {
      const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
      box.checked = read();
      on(box, "change", () => {
        api.store.apply(new EditNode(label, api.store.currentSymbolId, node.id, (n) => {
          const next = { ...n.path!, ...patch(box.checked) };
          if (!next.closed) delete next.closed;
          if (next.constantSpeed !== false) delete next.constantSpeed;
          return { ...n, path: next };
        }));
        api.store.emit("stage");
      });
      return h("label", { class: "switch-label" }, box, label);
    };
    rows.push(api.staticRow("Knots", String(shape.points.length / 6)));
    rows.push(api.row("", [flag("Closed", () => !!shape.closed, (v) => ({ closed: v })), flag("Constant speed", () => shape.constantSpeed !== false, (v) => ({ constantSpeed: v }))]));
    const edit = h("button", { class: "btn", title: "The Mesh tool (N): drag knots (their handles follow) and handles; Delete removes a knot" }, "Edit Points");
    on(edit, "click", () => api.run("tool.mesh"));
    rows.push(api.row("", [edit]));
  }
  for (const k of mine) {
    rows.push(api.staticRow("Constraint", `${k.name}: ${k.boneIds.map((id) => sym.nodes[id]?.name ?? "?").join(", ")}`));
    rows.push(...constraintRows(api, "paths", k.id, [
      { type: "select", key: "positionMode", label: "Position", options: [["percent", "Percent"], ["fixed", "Fixed"]], def: "percent" },
      { type: "number", key: "position", label: "At", glyph: "→", min: -100000, max: 100000, step: 0.01, def: 0 },
      { type: "select", key: "spacingMode", label: "Spacing", options: [["length", "Bone length"], ["fixed", "Fixed"], ["percent", "Percent"], ["proportional", "Proportional"]], def: "length" },
      { type: "number", key: "spacing", label: "Gap", glyph: "↔", min: -100000, max: 100000, step: 0.5, def: 0 },
      { type: "select", key: "rotateMode", label: "Rotate", options: [["tangent", "Tangent"], ["chain", "Chain"], ["chainScale", "Chain, scaled"]], def: "tangent" },
      { type: "number", key: "rotation", label: "Offset", glyph: "∠", min: -360, max: 360, step: 1, unit: "°", def: 0 },
      { type: "number", key: "mixRotate", label: "Mix rotate", glyph: "%", min: 0, max: 1, step: 0.05, def: 1 },
      { type: "number", key: "mixX", label: "Mix X", glyph: "%", min: 0, max: 1, step: 0.05, def: 1 },
      { type: "number", key: "mixY", label: "Mix Y", glyph: "%", min: 0, max: 1, step: 0.05, def: 1 },
    ]));
    rows.push(api.row("", [removeButton(api, "paths", k.id, "Remove Path Constraint")]));
  }
  return api.section("Path", true, rows);
}

/** A paragraph inside a section, for the rule a row of fields cannot say. */
/** The symbol's constraints in the order they are applied (ARCHITECTURE ▸
 *  Constraint order), each moved up or down a place. */
export function constraintOrderSection(api: PropertiesPanel): HTMLElement | null {
  const entries = constraintEntries(api.store.currentSymbol);
  if (entries.length < 2) return null;
  const move = (name: string, to: number) => {
    const order = withConstraintMoved(api.store.currentSymbol, name, to);
    if (!order) return;
    api.store.apply(new SetConstraintOrder("Constraint Order", api.store.currentSymbolId, order));
    api.store.emit("stage");
    api.store.emit("doc");
  };
  const rows: HTMLElement[] = entries.map((e, i) => {
    const up = h("button", { class: "iconbtn", title: `Apply “${e.name}” before “${entries[i - 1]?.name ?? ""}”` }, "▲") as HTMLButtonElement;
    const down = h("button", { class: "iconbtn", title: `Apply “${e.name}” after “${entries[i + 1]?.name ?? ""}”` }, "▼") as HTMLButtonElement;
    up.disabled = i === 0;
    down.disabled = i === entries.length - 1;
    on(up, "click", () => move(e.name, i - 1));
    on(down, "click", () => move(e.name, i + 1));
    return h("div", { class: "prow" },
      h("label", null, CONSTRAINT_KIND_LABELS[e.kind]),
      h("div", { class: "fields corder" }, h("span", { class: "corder-name", title: e.name }, e.name), up, down));
  });
  rows.push(noteRow("Applied from the top down: a constraint lower in the list reads what the ones above it did to the bones."));
  return api.section("Constraints", true, rows);
}
/** One row of a constraint's section (`constraintRows`). */
type ConstraintSpec = { type: "number"; key: string; label: string; glyph: string; min: number; max: number; step: number; decimals?: number; unit?: string; def: number; } |
{ type: "select"; key: string; label: string; options: Array<[string, string]>; def: string; } |
{ type: "check"; key: string; label: string; title?: string; };
const CONSTRAINT_KIND_LABELS: Record<ConstraintKind, string> = {
  ik: "IK", transform: "Transform", physics: "Physics", path: "Path", slider: "Slider", carried: "From file",
};
