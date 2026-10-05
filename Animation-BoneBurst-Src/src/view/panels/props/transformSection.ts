import { h, on } from "@/view/widgets/dom";
import { NumberField } from "@/view/widgets/NumberField";
import {
  doSetTcKeys,
  doSetTransforms
} from "@/app/TimelineOps";
import { isIdentityMap, tcMixAt, transformPlan, usedMixes, withMapping, withoutMapping, withSourceOffset, withTcKey } from "@/core/doc/transformKeys";
import { TC_CHANNELS, type TcChannel, type TcFrom } from "@/core/doc/types";
import { newTcId } from "@/core/doc/ids";
import { alertDialog, chooseDialog } from "@/view/widgets/dialogs";
import type { NodeId } from "@/core/doc/ids";
import type { Node, TransformConstraint } from "@/core/doc/types";
import type { PropertiesPanel } from "@/view/panels/PropertiesPanel";
import { linkRow, type LinkPart } from "./boneSection";
import { noteRow } from "./documentSection";

/**
 * Properties ▸ Transform constraint: its bones, mixes and property map.
 */

/**
 * A transform constraint's property map (Spine 4.3's `properties`): which
 * source property drives which bone property, with its scale, offset and
 * max, and what is added to the source first. Shown once it is more than
 * each property driving itself; Add maps one more. Spine's units.
 */
export function transformMapRows(api: PropertiesPanel, k: TransformConstraint, current: () => TransformConstraint, replace: (k: TransformConstraint, label: string, kind?: string) => void, label: Record<TcChannel, string>): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const num = (glyph: string, value: number, kind: string, write: (v: number) => TcFrom[], unit?: string) => {
    const field = new NumberField({
      glyph, unit, step: 0.1, decimals: 3, sensitivity: 20,
      onInput: (v, committing) => {
        api.scrubStep(kind, committing);
        replace({ ...current(), properties: write(v) }, "Transform Map", kind);
        if (committing) api.store.history.endInteraction();
      },
    });
    field.set(value);
    return field.el;
  };
  if (!isIdentityMap(k.properties)) {
    for (const p of k.properties) {
      rows.push(api.row(`${label[p.from]} +`, [num("+", p.offset, `tc.map.${k.id}.${p.from}`, (v) => withSourceOffset(current().properties, p.from, v))]));
      for (const t of p.to) {
        const kind = `tc.map.${k.id}.${p.from}.${t.to}`;
        const remove = h("button", { class: "iconbtn", title: `Stop ${label[p.from]} driving ${label[t.to]}` }, "×");
        on(remove, "click", () => replace({ ...current(), properties: withoutMapping(current().properties, p.from, t.to) }, "Remove Transform Mapping"));
        rows.push(api.row(`${label[p.from]} → ${label[t.to]}`, [
          num("×", t.scale, `${kind}.scale`, (v) => withMapping(current().properties, p.from, t.to, { scale: v })),
          num("+", t.offset, `${kind}.offset`, (v) => withMapping(current().properties, p.from, t.to, { offset: v })),
        ]));
        rows.push(api.row("", [num("≤", t.max, `${kind}.max`, (v) => withMapping(current().properties, p.from, t.to, { max: v })), remove]));
      }
    }
  }
  const pick = () => h("select", { class: "preview-anim" }, ...TC_CHANNELS.map((c) => h("option", { value: c }, label[c]))) as HTMLSelectElement;
  const from = pick(), to = pick();
  to.value = "x";
  const add = h("button", { class: "btn", title: "Make the source property on the left drive the bones' property on the right" }, "Map");
  on(add, "click", () => replace({ ...current(), properties: withMapping(current().properties, from.value as TcChannel, to.value as TcChannel) }, "Add Transform Mapping"));
  rows.push(api.row("Drive", [from, to]), api.row("", [add]));
  return rows;
}

/**
 * The transform constraints this bone takes part in, as the source or as one
 * of the bones that follow it, and a button that makes the selected bones
 * follow another (ARCHITECTURE ▸ Transform constraints). In Animate mode the
 * mixes are keyed at the playhead; offsets and the switches belong to the
 * constraint itself.
 */
export function transformSection(api: PropertiesPanel, node: Node): HTMLElement {
  const symbol = api.store.currentSymbol;
  const nameOf = (id: NodeId) => symbol.nodes[id]?.name ?? "\u2014";
  const animate = api.store.ui.mode === "animate" ? api.store.currentAnimation : null;
  const rows: HTMLElement[] = [];
  const list = () => api.store.currentSymbol.transforms ?? [];
  const replace = (k: TransformConstraint, label: string, kind?: string) =>
    doSetTransforms(api.store, list().map((c) => (c.id === k.id ? k : c)), label, kind);

  for (const k of symbol.transforms ?? []) {
    if (k.sourceId !== node.id && !k.boneIds.includes(node.id)) continue;
    const current = () => list().find((c) => c.id === k.id) ?? k;
    const keysOf = () => api.store.currentAnimation?.transforms?.[k.id] ?? [];
    const boneLinks: LinkPart[] = [];
    k.boneIds.forEach((id, i) => {
      if (i > 0) boneLinks.push(", ");
      boneLinks.push({ text: nameOf(id), select: [id] });
    });
    rows.push(
      linkRow(api, "Constraint", [{ text: k.name, select: [k.sourceId, ...k.boneIds], title: "Select the source and every bone that follows it" }]),
      linkRow(api, "Source", [{ text: nameOf(k.sourceId), select: [k.sourceId] }]),
      linkRow(api, "Bones", boneLinks),
    );

    const MIX_LABEL: Record<TcChannel, string> = { rotate: "Rotate", x: "X", y: "Y", scaleX: "Scale X", scaleY: "Scale Y", shearY: "Shear Y" };
    for (const c of usedMixes(k)) {
      const field = new NumberField({
        glyph: "%", min: 0, max: 1, step: 0.05, decimals: 2, sensitivity: 200,
        onInput: (v, committing) => {
          if (animate) {
            api.scrubStep("tc.key", committing);
            const now = tcMixAt(current(), api.store.currentAnimation, api.store.ui.frame);
            doSetTcKeys(api.store, k.id, withTcKey(keysOf(), api.store.ui.frame, { ...now, [c]: v }), "Transform Mix", "tc.key");
          } else {
            api.scrubStep(`tc.mix.${k.id}.${c}`, committing);
            const cur = current();
            replace({ ...cur, mix: { ...cur.mix, [c]: v } }, "Transform Mix", `tc.mix.${k.id}.${c}`);
          }
          if (committing) api.store.history.endInteraction();
        },
      });
      field.set(k.mix[c]);
      if (animate) api.ikSync.push(() => field.show(tcMixAt(current(), api.store.currentAnimation, api.store.ui.frame)[c]));
      rows.push(api.row(`Mix ${MIX_LABEL[c]}`, [field.el]));
    }
    if (animate) {
      const key = h("button", { class: "btn", title: "Key every mix in force here" }, "Key");
      on(key, "click", () => doSetTcKeys(api.store, k.id,
        withTcKey(keysOf(), api.store.ui.frame, tcMixAt(current(), api.store.currentAnimation, api.store.ui.frame)), "Key Transform"));
      api.ikSync.push(() => {
        const keyed = keysOf().some((x) => x.frame === api.store.ui.frame);
        key.textContent = keyed ? "Keyed" : "Key";
        (key as HTMLButtonElement).disabled = keyed;
      });
      rows.push(api.row("", [key]));
    } else {
      for (const c of TC_CHANNELS) {
        const field = new NumberField({
          glyph: c === "rotate" || c === "shearY" ? "°" : c.startsWith("scale") ? "×" : "px",
          step: c.startsWith("scale") ? 0.01 : 1, decimals: c.startsWith("scale") ? 3 : 1, sensitivity: c.startsWith("scale") ? 200 : 4,
          onInput: (v, committing) => {
            api.scrubStep(`tc.offset.${k.id}.${c}`, committing);
            const cur = current();
            const offsets = { ...cur.offsets, [c]: v };
            if (!v) delete offsets[c];
            replace({ ...cur, offsets }, "Transform Offset", `tc.offset.${k.id}.${c}`);
            if (committing) api.store.history.endInteraction();
          },
        });
        field.set(k.offsets?.[c] ?? 0);
        rows.push(api.row(`Offset ${MIX_LABEL[c]}`, [field.el]));
      }
    }
    const toggle = (f: "localSource" | "localTarget" | "additive" | "clamp", label: string, title: string) => {
      const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
      box.checked = !!k[f];
      on(box, "change", () => {
        const cur = current();
        const next = { ...cur };
        if (box.checked) next[f] = true; else delete next[f];
        replace(next, label);
      });
      return h("label", { class: "switch-label", title }, box, label);
    };
    rows.push(api.row("", [
      toggle("localSource", "Local source", "Read the source's local values instead of its world ones"),
      toggle("localTarget", "Local bones", "Write the bones' local values instead of their world ones"),
    ]));
    rows.push(api.row("", [
      toggle("additive", "Relative", "Add the source's values to the bones' own instead of replacing them"),
      toggle("clamp", "Clamp", "Keep each value between its offset and its maximum"),
    ]));
    const remove = h("button", { class: "btn" }, "Remove");
    on(remove, "click", () => doSetTransforms(api.store, list().filter((c) => c.id !== k.id), `Remove "${k.name}"`));
    rows.push(api.row("", [remove]));
    if (!animate) rows.push(...transformMapRows(api, k, current, replace, MIX_LABEL));
  }

  const add = h("button", { class: "btn", title: "Make the selected bones follow a bone you choose next" }, "Follow a Bone…");
  on(add, "click", async () => {
    const sym = api.store.currentSymbol;
    const followers = api.store.selectedNodes.filter((n) => n.kind === "bone").map((n) => n.id);
    const choices = Object.values(sym.nodes).filter((n) => n.kind === "bone" && !followers.includes(n.id));
    const picked = await chooseDialog({
      title: "Follow a Bone",
      message: `${followers.map(nameOf).join(", ")} will follow the bone you choose.`,
      options: choices.map((n) => n.name),
      ok: "Follow",
    });
    const now = api.store.currentSymbol;
    const source = choices.find((n) => n.name === picked);
    if (!source || now.id !== sym.id) return;
    const plan = transformPlan(now, followers, source.id, newTcId());
    if ("refused" in plan) { await alertDialog({ title: "Follow a Bone", message: plan.refused }); return; }
    doSetTransforms(api.store, [...(now.transforms ?? []), plan], `Transform Constraint "${plan.name}"`);
  });
  rows.push(api.row("", [add]));
  rows.push(noteRow("Offsets are as Spine writes them: y up, angles counter-clockwise. In Animate mode the mixes are keyed at the playhead."));
  return api.section("Transform", (symbol.transforms ?? []).some((k) => k.sourceId === node.id || k.boneIds.includes(node.id)), rows);
}
