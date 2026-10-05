import { BONE_ICONS, boneIconGlyph } from "@/core/doc/boneIcons";
import { INHERIT_LABELS, INHERIT_MODES, inheritAt, withInheritKey } from "@/core/doc/inherit";
import type { BoneBurstInherit } from "@/core/boneburst/types";
import { h, on } from "@/view/widgets/dom";
import { NumberField } from "@/view/widgets/NumberField";
import {
  SetPathDrag, SetBonePrimary
} from "@/core/history/commands";
import {
  doSetIkKeys, doSetInheritKeys
} from "@/app/TimelineOps";
import { type IkPose, ikPoseAt, withIkKey } from "@/core/doc/ikKeys";
import type { NodeId } from "@/core/doc/ids";
import type { Node } from "@/core/doc/types";
import { ikRelations } from "@/core/doc/ikGraph";
import { EditNode } from "@/core/history/attachmentCommands";
import { type IkPatch, RemoveIkConstraint, SetBoneLength, SetIkOptions, } from "@/core/history/ikCommands";
import type { PropertiesPanel } from "@/view/panels/PropertiesPanel";
import { noteRow } from "./documentSection";

/**
 * Properties ▸ Bone and IK.
 */

/** Bone length: the second segment of a two-bone IK solve, not decoration. */
export function boneSection(api: PropertiesPanel, node: Node): HTMLElement {
  const length = new NumberField({
    glyph: "L", min: 1, max: 4096, step: 1, decimals: 0,
    onInput: (v, committing) => {
      api.scrubStep("bone.length", committing);
      api.store.apply(new SetBoneLength(
        api.store.currentSymbolId, new Map([[node.id, v]]),
      ));
      api.store.emit("stage");
      if (committing) api.store.history.endInteraction();
    },
  });
  length.set(node.boneLength ?? 0);

  // What dragging this bone's path on the stage turns (core/doc/pathEdit.ts).
  const drag = h("select", { class: "preview-anim", title: "Dragging this bone's path turns this bone alone, or it and its parent. Hold ⌥ to use the other for one drag." },
    h("option", { value: "" }, "This bone"), h("option", { value: "parent" }, "With parent"));
  drag.value = node.pathDrag ?? "";
  on(drag, "change", () => {
    api.store.apply(new SetPathDrag(api.store.currentSymbolId, [node.id], drag.value === "parent" ? "parent" : undefined));
    api.store.emit("doc");
  });
  // A main bone (a leg, an arm, the head): the stage toolbar's Primary row governs it.
  const primary = h("input", { type: "checkbox", class: "switch", title: "A main bone: the stage toolbar's Primary row shows, picks and names it instead of the Bones row" }) as HTMLInputElement;
  primary.checked = !!node.primary;
  on(primary, "change", () => {
    const ids = api.store.selection.nodes.filter((id) => api.store.currentSymbol.nodes[id]?.kind === "bone");
    api.store.apply(new SetBonePrimary(api.store.currentSymbolId, ids.length ? ids : [node.id], primary.checked));
    api.store.emit("doc");
  });
  // Spine's bone colour: the stage and the Tree draw it; exported as nonessential data.
  const color = h("input", { type: "color", class: "bone-color", title: "This bone's colour on the stage and in the Tree" }) as HTMLInputElement;
  color.value = `#${(node.boneColor ?? "989898").slice(0, 6)}`;
  const setColor = (value: string | undefined, label: string) => {
    const ids = api.store.selection.nodes.filter((id) => api.store.currentSymbol.nodes[id]?.kind === "bone");
    api.store.transaction(label, () => {
      for (const id of ids.length ? ids : [node.id]) {
        api.store.apply(new EditNode(label, api.store.currentSymbolId, id, (n) => {
          const out = { ...n };
          if (value) out.boneColor = value; else delete out.boneColor;
          return out;
        }));
      }
    });
    api.store.emit("stage");
  };
  on(color, "change", () => setColor(`${color.value.slice(1)}ff`, "Bone Colour"));
  const reset = h("button", { class: "btn", title: "Spine's default bone colour" }, "Default");
  on(reset, "click", () => setColor(undefined, "Default Bone Colour"));
  // Spine's inherit: the bone's own in Setup mode, keyed at the playhead in
  // Animate mode (ARCHITECTURE ▸ Inherit modes).
  const animate = api.store.ui.mode === "animate" ? api.store.currentAnimation : null;
  const inherit = h("select", {
    class: "preview-anim",
    title: animate ? "What this bone takes from its parent from this frame on: keyed here (Spine's inherit key)" : "What this bone takes from its parent: its position always, and its rotation, scale and reflection unless left out",
  }, ...INHERIT_MODES.map((m) => h("option", { value: m }, INHERIT_LABELS[m]))) as HTMLSelectElement;
  const inheritNow = () => {
    const n = api.store.currentSymbol.nodes[node.id] ?? node;
    return animate ? inheritAt(n, api.store.currentAnimation, api.store.ui.frame) : n.inherit ?? "normal";
  };
  inherit.value = inheritNow();
  api.ikSync.push(() => { if (document.activeElement !== inherit) inherit.value = inheritNow(); });
  on(inherit, "change", () => {
    const mode = inherit.value as BoneBurstInherit;
    if (animate) {
      doSetInheritKeys(api.store, node.id, withInheritKey(api.store.currentAnimation?.inherits?.[node.id] ?? [], api.store.ui.frame, mode), "Inherit Key");
      return;
    }
    api.store.apply(new EditNode("Inherit", api.store.currentSymbolId, node.id, (n) => {
      const out = { ...n };
      if (mode !== "normal") out.inherit = mode; else delete out.inherit;
      return out;
    }));
    api.store.emit("stage");
    api.store.emit("timeline");
  });
  // Spine's bone icon (nonessential): shown in the Tree, written to the file.
  const iconSel = h("select", { class: "preview-anim", title: "This bone's icon in the Tree and in Spine's editor" },
    h("option", { value: "" }, "None"),
    ...[...new Set([...Object.keys(BONE_ICONS), ...(node.boneIcon ? [node.boneIcon] : [])])].map((n) => h("option", { value: n }, `${boneIconGlyph(n)} ${n}`))) as HTMLSelectElement;
  iconSel.value = node.boneIcon ?? "";
  on(iconSel, "change", () => {
    api.store.apply(new EditNode("Bone Icon", api.store.currentSymbolId, node.id, (n) => {
      const out = { ...n };
      if (iconSel.value) out.boneIcon = iconSel.value; else delete out.boneIcon;
      return out;
    }));
    api.store.emit("doc");
  });
  return api.section("Bone", true, [
    api.row("Length", [length.el]), api.row("Path drag", [drag]), api.row("Primary", [primary]),
    api.row("Colour", [color, ...(node.boneColor ? [reset] : [])]),
    api.row("Icon", [iconSel]),
    api.row("Inherit", [inherit]),
  ]);
}

/**
 * Every constraint this bone takes part in — as the target doing the
 * pulling, as the effector being solved, or as the chain ROOT, which the
 * constraint never names and the solver moves anyway.
 *
 * A list, not a lookup: one target can drive several chains, and `find`
 * showed the first and hid the rest. The named bones matter more than the
 * options do — a target is parented OUTSIDE the chain it drives, so nothing
 * in the layer tree says what it is attached to, and this section is the
 * only place that spells the relationship out.
 */
export function ikSection(api: PropertiesPanel, node: Node): HTMLElement | null {
  const symbol = api.store.currentSymbol;
  const relations = ikRelations(symbol, node.id);
  if (relations.length === 0) return null;
  const nameOf = (id: NodeId) => symbol.nodes[id]?.name ?? "\u2014";

  const rows: HTMLElement[] = [];
  for (const rel of relations) {
    const constraint = rel.constraint;
    const write = (patch: IkPatch) => {
      api.store.apply(new SetIkOptions(api.store.currentSymbolId, constraint.id, patch));
      api.store.emit("stage");
      api.store.emit("doc");
    };

    const chainSel = h("select", { class: "preview-anim" },
      h("option", { value: "1" }, "2 bones"),
      h("option", { value: "0" }, "1 bone"));
    chainSel.value = String(constraint.chain);
    on(chainSel, "change", () => write({ chain: chainSel.value === "1" ? 1 : 0 }));

    // In Animate mode the mix and bend are keyed at the playhead (Spine's
    // IK timeline); in Setup mode they are the constraint's own.
    const animate = api.store.ui.mode === "animate" ? api.store.currentAnimation : null;
    const keysOf = () => api.store.currentAnimation?.ik?.[constraint.id] ?? [];
    const poseNow = () => ikPoseAt(constraint, api.store.currentAnimation, api.store.ui.frame);
    const keyAt = (pose: IkPose, label: string, kind?: string) =>
      doSetIkKeys(api.store, constraint.id, withIkKey(keysOf(), api.store.ui.frame, pose, constraint.softness), label, kind);

    const bend = h("button", { class: "btn" }, constraint.bendPositive ? "Positive" : "Negative");
    on(bend, "click", () => {
      if (!animate) { write({ bendPositive: !constraint.bendPositive }); return; }
      const now = poseNow();
      keyAt({ ...now, bendPositive: !now.bendPositive }, "IK Bend");
    });

    const weight = new NumberField({
      glyph: animate ? "M" : "W", min: 0, max: 1, step: 0.05, decimals: 2, sensitivity: 200,
      onInput: (v, committing) => {
        if (animate) {
          api.scrubStep("ik.key", committing);
          keyAt({ ...poseNow(), mix: v }, "IK Mix", "ik.key");
        } else {
          api.scrubStep("ik.options", committing);
          write({ weight: v });
        }
        if (committing) api.store.history.endInteraction();
      },
    });
    weight.set(constraint.weight);

    // Softness eases a two-bone chain into straight near full reach.
    const softness = new NumberField({
      glyph: "S", min: 0, step: 1, decimals: 1, sensitivity: 4, unit: "px",
      onInput: (v, committing) => {
        if (animate) {
          api.scrubStep("ik.key", committing);
          keyAt({ ...poseNow(), softness: v }, "IK Softness", "ik.key");
        } else {
          api.scrubStep("ik.options", committing);
          write({ softness: v });
        }
        if (committing) api.store.history.endInteraction();
      },
    });
    softness.set(constraint.softness ?? 0);

    // Stretch and compress scale the bone along its length (Spine's IK
    // options); scale y follows the stretch, keeps the area, or stays.
    const check = (label: string, title: string, read: () => boolean, patch: (on: boolean) => IkPatch) => {
      const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
      box.checked = read();
      on(box, "change", () => write(patch(box.checked)));
      api.ikSync.push(() => { box.checked = read(); });
      return { label: h("label", { class: "switch-label", title }, box, label) };
    };
    const live = () => api.store.currentSymbol.ik.find((k) => k.id === constraint.id) ?? constraint;
    const stretchBox = check("Stretch", "Scale the bones along their length to reach a target out of reach", () => !!live().stretch, (v) => ({ stretch: v }));
    const compressBox = check("Compress", "Scale the bone down for a target nearer than its length", () => !!live().compress, (v) => ({ compress: v }));
    const scaleYSel = h("select", { class: "preview-anim", title: "What scale y does when a bone stretches or compresses" }) as HTMLSelectElement;
    for (const [value, text] of [["", "Stays"], ["uniform", "Follows (uniform)"], ["volume", "Keeps the area (volume)"]]) scaleYSel.appendChild(h("option", { value }, text));
    scaleYSel.value = live().scaleY ?? "";
    on(scaleYSel, "change", () => write({ scaleY: (scaleYSel.value || null) as IkPatch["scaleY"] }));
    api.ikSync.push(() => { scaleYSel.value = live().scaleY ?? ""; });

    const key = h("button", { class: "btn", title: "Key the mix and bend in force here" }, "Key");
    on(key, "click", () => keyAt(poseNow(), "Key IK"));
    if (animate) {
      api.ikSync.push(() => {
        const now = poseNow();
        bend.textContent = now.bendPositive ? "Positive" : "Negative";
        weight.show(now.mix);
        softness.show(now.softness);
        const keyed = keysOf().some((k) => k.frame === api.store.ui.frame);
        key.textContent = keyed ? "Keyed" : "Key";
        (key as HTMLButtonElement).disabled = keyed;
      });
    }

    const remove = h("button", { class: "btn" }, "Remove");
    on(remove, "click", () => {
      api.store.apply(new RemoveIkConstraint(api.store.currentSymbolId, constraint.id));
      api.store.emit("stage");
      api.store.emit("doc");
    });

    const role = rel.role === "target" ? "Target: drag this"
      : rel.role === "root" ? "Solved bone (chain root)"
      : "Solved bone (effector)";

    // Which bones this constraint MOVES, root first, and which one pulls
    // them. Both named, whichever end of the constraint is selected: the
    // question is always "what is on the other side of this?".
    // The names are the navigation. A constraint's cast is scattered down
    // the layer column — the target is not even near the bones, since it is
    // parented outside the chain — so reading a name here and then hunting
    // for its row is the actual work this section was leaving to the user.
    const chainLinks: LinkPart[] = [];
    rel.chain.forEach((id, i) => {
      if (i > 0) chainLinks.push(" \u2192 ");
      chainLinks.push({ text: nameOf(id), select: [id] });
    });

    rows.push(
      // The constraint itself has no layer: clicking it selects everything
      // it touches, which is the nearest true answer.
      linkRow(api, "Constraint", [{
        text: constraint.name,
        select: [...rel.chain, constraint.targetId],
        title: "Select the target and every bone it moves",
      }]),
      api.staticRow("Role", role),
      linkRow(api, "Solves", chainLinks),
      // The pulling end, unless it is the node already selected.
      ...(rel.role === "target" ? [] : [linkRow(api, "Target", [
        { text: nameOf(constraint.targetId), select: [constraint.targetId] },
      ])]),
      api.row("Chain", [chainSel]),
      api.row("Bend", [bend]),
      api.row(animate ? "Mix" : "Weight", [weight.el]),
      ...(rel.chain.length > 1 ? [api.row("Softness", [softness.el])] : []),
      api.row("Scale", [stretchBox.label, ...(rel.chain.length > 1 ? [] : [compressBox.label])]),
      api.row("Scale Y", [scaleYSel]),
      ...(animate ? [api.row("", [key])] : []),
      api.row("", [remove]),
    );
  }

  // Two things nothing else in the UI answers: where targets come from, and
  // which mode a drag writes into. Setup moves the rest pose the file
  // carries; Animate keys the target at the playhead. The solved bones are
  // never keyed either way \u2014 the runtime re-solves them on playback, so a
  // keyframe on one fights the solver and the preview drifts off the stage.
  rows.push(noteRow(
    "To add IK, pick the IK tool (K) and click the last bone of a chain: a target "
    + "appears at its end. Drag the target to pose the chain. In Animate mode that "
    + "sets a keyframe on the target, in Setup mode it changes the rest pose. The "
    + "bones themselves never get keyframes: they follow the target. In Animate mode "
    + "Mix and Bend are keyed at the playhead, on the constraint's IK row.",
  ));

  return api.section("IK", true, rows);
}

/**
 * A row of names that select what they name. A part with no live node falls
 * back to plain text rather than a dead link — a constraint can outlive the
 * bone it points at while the document is mid-edit.
 */
export function linkRow(api: PropertiesPanel, label: string, parts: LinkPart[]): HTMLElement {
  const symbol = api.store.currentSymbol;
  const fields = h("div", { class: "fields links" });
  for (const part of parts) {
    if (typeof part === "string") {
      fields.appendChild(h("span", { class: "hint sep" }, part));
      continue;
    }
    const live = part.select.filter((id) => symbol.nodes[id]);
    if (live.length === 0) {
      fields.appendChild(h("span", { class: "hint" }, part.text));
      continue;
    }
    const btn = h("button", {
      class: "nodelink",
      title: part.title ?? `Select ${part.text}`,
    }, part.text);
    on(btn, "click", () => api.store.selectNodes(live));
    fields.appendChild(btn);
  }
  return h("div", { class: "prow" }, h("label", null, label), fields);
}
/**
 * A multi-selection edited as one object — Flash's behaviour, and the
 * "virtual group" of Edit Multiple Frames: X/Y/W/H are its bounding box, and
 * every write moves, scales or rotates the whole group.
 */
/**
 * The inspector. Every field writes through the same commands the stage
 * gizmo uses, so numeric entry and direct manipulation share one undo story.
 */
/** One piece of a link row: a separator, or a name that selects nodes. */
export type LinkPart = string | { text: string; select: NodeId[]; title?: string };
