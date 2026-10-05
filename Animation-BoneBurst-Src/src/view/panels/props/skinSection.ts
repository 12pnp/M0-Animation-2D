import { constraintHost, keyedConstraint } from "@/core/doc/constraintKeys";
import { h, on } from "@/view/widgets/dom";
import { alertDialog } from "@/view/widgets/dialogs";
import type { ItemId } from "@/core/doc/ids";
import type { Node } from "@/core/doc/types";
import { DEFAULT_SKIN, editedSkin, skinsOf } from "@/core/doc/skins";
import { displaysOf } from "@/core/doc/displays";
import { isImage } from "@/core/doc/types";
import { doSetSkinImage, doSetSkinMembers, doSetSkinOnly } from "@/app/SkinOps";
import type { PropertiesPanel } from "@/view/panels/PropertiesPanel";
import { noteRow } from "./documentSection";

/**
 * Properties ▸ Skins.
 */

/**
 * Skins (ARCHITECTURE ▸ Skins). On an image: what the skin being edited
 * shows in place of each of its displays, and which displays only skins
 * fill. On a bone: the skins it (with the bones below it) belongs to, and
 * those of the constraints it drives.
 */
export function skinSection(api: PropertiesPanel, node: Node): HTMLElement {
  const sym = api.store.currentSymbol;
  const named = skinsOf(sym).filter((n) => n !== DEFAULT_SKIN);
  if (!named.length) {
    return api.section("Skins", false, [noteRow("No skins. The Skins panel makes them; then each layer can show its own image in each skin.")]);
  }
  const rows: HTMLElement[] = [];
  if (node.kind === "bone") {
    const iks = sym.ik.filter((k) => k.targetId === node.id);
    const tcs = (sym.transforms ?? []).filter((k) => k.sourceId === node.id);
    // Physics, sliders and paths under this bone (`constraintHost`).
    const cns = [...(sym.physics ?? []), ...(sym.sliders ?? []), ...(sym.paths ?? [])]
      .filter((k) => { const c = keyedConstraint(sym, k.id); return !!c && constraintHost(c) === node.id; });
    for (const name of named) {
      const def = sym.skins?.find((d) => d.name === name);
      const check = (label: string, title: string, checked: boolean, run: (on: boolean) => void) => {
        const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
        box.checked = checked;
        on(box, "change", () => run(box.checked));
        return h("label", { class: "switch-label", title }, box, label);
      };
      rows.push(api.row(name, [
        check("Bone", "Only this skin (and others that list it) has the bone and the bones and pictures below it", !!def?.bones?.includes(node.id),
          (v) => doSetSkinMembers(api.store, name, { bones: [node.id] }, v)),
        ...iks.map((k) => check(k.name, `Only this skin solves the IK "${k.name}"`, !!def?.ik?.includes(k.id),
          (v) => doSetSkinMembers(api.store, name, { ik: [k.id] }, v))),
        ...tcs.map((k) => check(k.name, `Only this skin applies the transform constraint "${k.name}"`, !!def?.transforms?.includes(k.id),
          (v) => doSetSkinMembers(api.store, name, { transforms: [k.id] }, v))),
        ...cns.map((k) => check(k.name, `Only this skin applies "${k.name}"`, !!def?.constraints?.includes(k.id),
          (v) => doSetSkinMembers(api.store, name, { constraints: [k.id] }, v))),
      ]));
    }
    rows.push(noteRow("A bone in a skin exists only while a skin listing it shows, with the bones and pictures below it; a constraint in a skin applies only then."));
    return api.section("Skins", named.some((n) => sym.skins?.find((d) => d.name === n)?.bones?.includes(node.id)), rows);
  }

  const edited = editedSkin(sym, api.store.ui.editSkin)!;
  const skinSel = h("select", { class: "preview-anim", title: "The skin edited here (also picked in the Skins panel)" }) as HTMLSelectElement;
  for (const name of named) skinSel.appendChild(h("option", { value: name }, name));
  skinSel.value = edited;
  on(skinSel, "change", () => api.store.setUi({ editSkin: skinSel.value }, "stage"));
  rows.push(api.row("Skin", [skinSel]));
  const images = api.store.project.itemOrder.map((id) => api.store.project.items[id]).filter(isImage);
  const def = sym.skins?.find((d) => d.name === edited);
  displaysOf(node).forEach((own, index) => {
    const ownName = api.store.project.items[own.itemId]?.name ?? "?";
    const sel = h("select", { class: "preview-anim", title: `What “${edited}” shows here` }) as HTMLSelectElement;
    sel.appendChild(h("option", { value: "" }, own.skinOnly ? "— nothing —" : `— ${ownName} (default) —`));
    for (const item of images) sel.appendChild(h("option", { value: item.id }, item.name));
    sel.value = def?.displays?.[node.id]?.[String(index)]?.itemId ?? "";
    on(sel, "change", () => {
      const problem = doSetSkinImage(api.store, edited, node.id, index, (sel.value || null) as ItemId | null);
      if (problem) void alertDialog({ title: "Skin Image", message: problem });
    });
    const only = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
    only.checked = !!own.skinOnly;
    on(only, "change", () => doSetSkinOnly(api.store, node.id, index, only.checked));
    const onlyLabel = h("label", { class: "switch-label", title: `The default skin shows nothing here; only skins fill it (Spine's skin placeholder). ${ownName} stands in while editing.` }, only, "Only in skins");
    rows.push(api.row(index === 0 ? "Image" : `Display ${index}`, [sel]));
    rows.push(api.row("", [onlyLabel]));
  });
  const used = named.some((n) => Object.keys(sym.skins?.find((d) => d.name === n)?.displays?.[node.id] ?? {}).length) || displaysOf(node).some((d) => d.skinOnly);
  return api.section("Skins", used, rows);
}
