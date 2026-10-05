import type { LinkedMesh } from "@/core/doc/types";
import { h, on } from "@/view/widgets/dom";
import { NumberField } from "@/view/widgets/NumberField";
import { alertDialog } from "@/view/widgets/dialogs";
import type { NodeId } from "@/core/doc/ids";
import type { Node } from "@/core/doc/types";
import { displayAt, linkableDisplays, withLink } from "@/core/doc/displays";
import { doMakeSequence, doRemoveSequence, doSetSequenceKeys, doSetSequenceSetup } from "@/app/AttachmentOps";
import { EditNode } from "@/core/history/attachmentCommands";
import { SEQUENCE_MODE_LABELS, SEQUENCE_MODES, withSequenceKey } from "@/core/doc/sequence";
import type { SequenceKey } from "@/core/doc/types";
import type { PropertiesPanel } from "@/view/panels/PropertiesPanel";
import { noteRow } from "./documentSection";

/**
 * Properties ▸ Mesh and Sequence.
 */

/**
 * The image as a mesh (ARCHITECTURE ▸ Meshes): make or remove it, bind it to
 * bones, and the Mesh tool's weight brush.
 */
export function meshSection(api: PropertiesPanel, node: Node): HTMLElement {
  const mesh = node.mesh;
  const btn = (label: string, command: string, title: string) => {
    const b = h("button", { class: "btn", title }, label);
    on(b, "click", () => api.run(command));
    return b;
  };
  const rows: HTMLElement[] = [];
  if (!mesh) {
    rows.push(api.row("", [btn("Make Mesh", "modify.makeMesh", "Turn the image into a mesh from its outline")]));
    rows.push(noteRow("A mesh can bend: bind it to bones, or key its points with the Mesh tool (N) in Animate mode."));
    return api.section("Mesh", false, rows);
  }
  rows.push(api.staticRow("Points", `${mesh.points.length / 2} (${mesh.hull} on the outline), ${mesh.triangles.length / 3} triangles`));
  rows.push(api.staticRow("Follows", mesh.weights ? `${new Set(mesh.weights.flat().map(([b]) => b)).size} bone(s), weighted` : "its own node"));
  rows.push(api.row("", [
    btn("Bind to Bones", "modify.bindMesh", "Weight the mesh to the bones selected with it (⇧-click them), each point to the nearest two"),
    ...(mesh.weights ? [btn("Unbind", "modify.unbindMesh", "Follow its own node again")] : []),
  ]));
  rows.push(api.row("", [
    btn("Edit Points", "tool.mesh", "The Mesh tool: drag points, click inside to add, Delete to remove; in Animate, keys a deform"),
    btn("Remove Mesh", "modify.removeMesh", "Back to a plain image; its deform keys go too"),
  ]));

  // The weight brush: the Mesh tool paints the chosen bone's weight.
  const paint = api.store.ui.meshPaint;
  const sym = api.store.currentSymbol;
  const set = (patch: Partial<typeof paint>) => api.store.setUi({ meshPaint: { ...api.store.ui.meshPaint, ...patch } }, "stage");
  const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
  box.checked = paint.on;
  on(box, "change", () => { set({ on: box.checked }); if (box.checked) api.run("tool.mesh"); });
  const boneSel = h("select", { class: "preview-anim" }) as HTMLSelectElement;
  boneSel.appendChild(h("option", { value: node.id }, `${node.name} (its own)`));
  for (const b of Object.values(sym.nodes).filter((n) => n.kind === "bone")) boneSel.appendChild(h("option", { value: b.id }, b.name));
  boneSel.value = paint.bone && (paint.bone === node.id || sym.nodes[paint.bone]?.kind === "bone") ? paint.bone : node.id;
  if (paint.bone !== boneSel.value) queueMicrotask(() => set({ bone: boneSel.value as NodeId }));
  on(boneSel, "change", () => set({ bone: boneSel.value as NodeId }));
  const radius = new NumberField({ glyph: "R", min: 4, max: 400, step: 1, decimals: 0, unit: "px", onInput: (v) => set({ radius: v }) });
  radius.set(paint.radius);
  const strength = new NumberField({ glyph: "%", min: 0.01, max: 1, step: 0.01, decimals: 2, sensitivity: 200, onInput: (v) => set({ strength: v }) });
  strength.set(paint.strength);
  rows.push(api.row("Weights", [h("label", { class: "switch-label", title: "Drag over points with the Mesh tool to add this bone's weight" }, box, "Paint")]));
  rows.push(api.row("Bone", [boneSel]));
  rows.push(api.row("Brush", [radius.el, strength.el]));
  // Linked meshes: this node's other images drawing this mesh (Spine's linked mesh).
  const others = linkableDisplays(node, 0);
  if (others.length) {
    const setLink = (index: number, link: LinkedMesh | undefined, label: string) => {
      api.store.apply(new EditNode(label, api.store.currentSymbolId, node.id, (n) => withLink(n, index, link)));
      api.store.emit("stage");
      api.store.emit("doc");
    };
    rows.push(noteRow("Its other images can draw this mesh, bending as it does (Spine's linked mesh):"));
    for (const i of others) {
      const d = displayAt(node, i)!;
      const linked = d.linked?.to === 0;
      const use = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
      use.checked = linked;
      on(use, "change", () => setLink(i, use.checked ? { to: 0 } : undefined, use.checked ? "Link Mesh" : "Unlink Mesh"));
      const controls = [h("label", { class: "switch-label", title: "This image draws the mesh" }, use, api.store.project.items[d.itemId]?.name ?? "image")];
      if (linked) {
        const deform = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
        deform.checked = d.linked!.deform !== false;
        on(deform, "change", () => setLink(i, deform.checked ? { to: 0 } : { to: 0, deform: false }, "Linked Mesh Deform"));
        controls.push(h("label", { class: "switch-label", title: "It takes the mesh's deform keys too (Spine's timelines)" }, deform, "Deform"));
      }
      rows.push(api.row(`${i + 1}`, controls));
    }
  }
  return api.section("Mesh", true, rows);
}

/**
 * A sequence (ARCHITECTURE ▸ Sequences): made from the library images
 * numbered like this one; the setup frame; in Animate, the key in force at
 * the playhead (mode, first image, frames per image), edited by keying here.
 */
export function sequenceSection(api: PropertiesPanel, node: Node): HTMLElement {
  const rows: HTMLElement[] = [];
  const seq = node.sequence;
  if (!seq) {
    const make = h("button", { class: "btn", title: "Use the library images numbered like this one (fire_01, fire_02, …) as frames" }, "Make Sequence");
    on(make, "click", () => {
      const problem = doMakeSequence(api.store, node.id);
      if (problem) void alertDialog({ title: "Make Sequence", message: problem });
    });
    rows.push(api.row("", [make]));
    rows.push(noteRow("Frame-by-frame images in one layer, as Spine's sequence: keys pick which image shows and how they play."));
    return api.section("Sequence", false, rows);
  }
  const names = seq.items.map((id) => api.store.project.items[id]?.name ?? "?");
  rows.push(api.staticRow("Frames", `${seq.items.length}: ${names[0]} … ${names[names.length - 1]}`));
  const setup = new NumberField({
    glyph: "#", min: 0, max: seq.items.length - 1, step: 1, decimals: 0,
    onInput: (v, committing) => { doSetSequenceSetup(api.store, node.id, v); if (committing) api.store.history.endInteraction(); },
  });
  setup.set(seq.setup ?? 0);
  rows.push(api.row("Setup", [setup.el]));
  const anim = api.store.ui.mode === "animate" ? api.store.currentAnimation : null;
  if (anim) {
    const keysOf = () => api.store.currentAnimation?.sequences?.[node.id] ?? [];
    const inForce = (): SequenceKey => {
      const keys = keysOf(), frame = api.store.ui.frame;
      const k = [...keys].reverse().find((x) => x.frame <= frame);
      return k ? { ...k, frame } : { frame, mode: "loop", index: seq.setup ?? 0, delay: 1 };
    };
    const keyWith = (patch: Partial<SequenceKey>, label: string) =>
      doSetSequenceKeys(api.store, node.id, withSequenceKey(keysOf(), { ...inForce(), ...patch, frame: api.store.ui.frame }), label);
    const mode = h("select", { class: "preview-anim", title: "How the images play from the key" }) as HTMLSelectElement;
    for (const m of SEQUENCE_MODES) mode.appendChild(h("option", { value: m }, SEQUENCE_MODE_LABELS[m]));
    on(mode, "change", () => keyWith({ mode: mode.value as SequenceKey["mode"] }, "Sequence Mode"));
    const index = new NumberField({ glyph: "#", min: 0, max: seq.items.length - 1, step: 1, decimals: 0, onInput: (v, c) => { if (c) keyWith({ index: Math.round(v) }, "Sequence Image"); } });
    const delay = new NumberField({ glyph: "⏱", min: 0.05, max: 1000, step: 0.25, decimals: 2, unit: "f", onInput: (v, c) => { if (c) keyWith({ delay: v }, "Sequence Delay"); } });
    const key = h("button", { class: "btn", title: "Key the sequence here with these values" }, "Key");
    on(key, "click", () => keyWith({}, "Key Sequence"));
    const sync = () => {
      const k = inForce();
      mode.value = k.mode;
      index.show(k.index);
      delay.show(k.delay);
      const keyed = keysOf().some((x) => x.frame === api.store.ui.frame);
      key.textContent = keyed ? "Keyed" : "Key";
      (key as HTMLButtonElement).disabled = keyed;
    };
    sync();
    api.ikSync.push(sync);
    rows.push(api.row("Mode", [mode]), api.row("From", [index.el]), api.row("Delay", [delay.el]), api.row("", [key]));
  } else {
    rows.push(noteRow("In Animate mode, key which image plays and how at the playhead; the Sequence row shows the keys."));
  }
  const remove = h("button", { class: "btn", title: "Back to one image; the sequence keys go too" }, "Remove Sequence");
  on(remove, "click", () => doRemoveSequence(api.store, node.id));
  rows.push(api.row("", [remove]));
  return api.section("Sequence", true, rows);
}
