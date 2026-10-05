import { type AttachmentPatch, type AttachmentRef, findAttachment, renameAttachment, updateAttachment } from "@/edit/attachments";
import { type BoneProperty, keyBone } from "@/edit/boneKeys";
import { type BonePatch, renameBone, reparentBone, subtree, updateBone } from "@/edit/bones";
import { type Edit, EditRefused } from "@/edit/history";
import { moveAttachment, renameSkin, setSkinMember } from "@/edit/skins";
import { BLEND_MODES, renameSlot, updateSlot } from "@/edit/slots";
import { BONE_DEFAULTS, boneInherit, boneNumber, type BoneNumber } from "@/model/defaults";
import { attachmentType, type Skeleton } from "@/model/skeleton";
import type { Selection, Session } from "../session";
import { animatedLocal, localUnder, Poser } from "../stage/posed";
import { empty, heading } from "./outline";

/** The timeline each value keys in Animate mode (length is setup only). */
const KEYED: Partial<Record<BoneNumber, BoneProperty>> = {
  x: "translate", y: "translate", rotation: "rotate", scaleX: "scale", scaleY: "scale", shearX: "shear", shearY: "shear",
};

const BONE_FIELDS: ReadonlyArray<{ key: BoneNumber; label: string }> = [
  { key: "x", label: "X" }, { key: "y", label: "Y" }, { key: "rotation", label: "Rotation" },
  { key: "scaleX", label: "Scale X" }, { key: "scaleY", label: "Scale Y" },
  { key: "shearX", label: "Shear X" }, { key: "shearY", label: "Shear Y" }, { key: "length", label: "Length" },
];

/** A region's numbers (Format-Json-Atlas.md §8.3), with what an absent key means. */
const REGION_FIELDS: ReadonlyArray<{ key: "x" | "y" | "rotation" | "scaleX" | "scaleY" | "width" | "height"; label: string; default?: number }> = [
  { key: "x", label: "X", default: 0 }, { key: "y", label: "Y", default: 0 }, { key: "rotation", label: "Rotation", default: 0 },
  { key: "scaleX", label: "Scale X", default: 1 }, { key: "scaleY", label: "Scale Y", default: 1 },
  { key: "width", label: "Width" }, { key: "height", label: "Height" },
];

/**
 * The properties of what is selected: a bone, a slot or an attachment. A field commits on Enter
 * or when it loses focus, as one undo step; a value the edit refuses is put back and the reason
 * shown. In Animate mode a bone's transform fields key at the playhead.
 */
export class Inspector {
  readonly element: HTMLDivElement;
  onStatus: (message: string) => void = () => {};
  /** What the panel shows, as a key; undefined until it first draws. */
  private shown: string | undefined;
  private inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel inspector";
    session.onChange(() => this.update());
    this.update();
  }

  private update(force = false): void {
    const s = this.session, doc = s.doc, sel = s.selected, anim = s.animation;
    // The selected object changes exactly when its values do; the frame matters in Animate mode.
    const target = doc && sel ? selectedObject(doc, sel) : undefined;
    const key = JSON.stringify([!!doc, sel, anim ? [anim.name, s.frame, s.history?.revision] : null]) + (target ? identity(target) : "");
    if (this.shown === key) return;
    // Not under a field being typed in, nor while playing: it shows the document once that ends.
    if (!force && (this.element.contains(this.element.ownerDocument.activeElement) || s.playing)) return;
    this.shown = key;
    this.inputs.clear();
    if (!doc || !sel || !target) {
      this.element.replaceChildren(heading("Properties"), empty(doc ? "Select a bone, slot or attachment." : "Nothing open."));
      return;
    }
    const form = document.createElement("div");
    form.className = "fields";
    if (sel.kind === "bone") this.boneForm(form, doc, sel.name);
    else if (sel.kind === "slot") this.slotForm(form, doc, sel.name);
    else if (sel.kind === "skin") this.skinForm(form, doc, sel.name);
    else this.attachmentForm(form, doc, sel);
    const title = sel.kind === "bone" ? (anim ? `Bone · keys at frame ${s.frame}` : "Bone") : sel.kind === "slot" ? "Slot" : sel.kind === "skin" ? "Skin" : "Attachment";
    this.element.replaceChildren(heading(title), form);
  }

  private boneForm(form: HTMLElement, doc: Skeleton, name: string): void {
    const s = this.session, bone = doc.bones!.find((b) => b.name === name)!, anim = s.animation;
    form.append(this.textField("name", "Name", bone.name, (v) => (v === name ? null : renameBone(name, v)), (v) => `Rename bone ${name} to ${v}`,
      (v) => s.select({ kind: "bone", name: v })));
    const p = anim ? s.pose() : null, index = p?.bones.get(name);
    const local = p && index !== undefined ? animatedLocal(p, index) : null;
    const time = s.keyTime;
    for (const f of BONE_FIELDS) {
      const keyed = local && f.key !== "length" ? KEYED[f.key] : undefined;
      const shownValue = keyed && local ? local[f.key as keyof typeof local] : boneNumber(bone, f.key);
      form.append(this.textField(f.key, f.label, format(shownValue), (v) => {
        const n = number(v, f.label);
        if (keyed && local && anim) return keyBone(anim.name, name, [keyed], { ...local, [f.key]: n }, time);
        const patch: BonePatch = {};
        // Back to the default: drop the key, as Spine writes it.
        patch[f.key] = n === BONE_DEFAULTS[f.key] ? undefined : n;
        return updateBone(name, patch);
      }, () => (keyed ? `Key ${f.label.toLowerCase()} of ${name} at frame ${s.frame}` : `Set ${f.label.toLowerCase()} of bone ${name}`), undefined, "decimal"));
    }
    if (bone.parent === undefined) form.append(readOnly("Parent", "— (root)"));
    else {
      // A bone can hang from any bone but itself and those under it; it stays where it is on screen.
      const under = new Set(subtree(doc, name));
      const options = (doc.bones ?? []).map((b) => b.name).filter((n) => !under.has(n));
      form.append(this.selectField("parent", "Parent", options.map((n) => [n, n]), bone.parent, (v) => {
        const setup = new Poser(doc, s.images).pose(s.skin, null, 0);
        const i = setup.bones.get(name), j = setup.bones.get(v);
        const keep = i !== undefined && j !== undefined && boneInherit(bone) === "normal" ? localUnder(setup, i, j) : {};
        // A value at its default leaves the key out, as Spine writes it.
        const patch: Record<string, number | undefined> = {};
        for (const [k, n] of Object.entries(keep) as [BoneNumber, number][]) patch[k] = n === BONE_DEFAULTS[k] ? undefined : n;
        return reparentBone(name, v, patch as BonePatch);
      }, (v) => `Move bone ${name} under ${v}`));
    }
    form.append(readOnly("Inherit", boneInherit(bone)));
    form.append(this.checkField("skin", "Skin required", bone.skin === true, (on) => updateBone(name, { skin: on ? true : undefined }),
      (on) => `${on ? "Make" : "Stop making"} bone ${name} skin-required`));
  }

  private skinForm(form: HTMLElement, doc: Skeleton, name: string): void {
    const s = this.session, skin = doc.skins!.find((k) => k.name === name)!;
    if (name === "default") form.append(readOnly("Name", "default"));
    else form.append(this.textField("name", "Name", name, (v) => (v === name ? null : renameSkin(name, v)), (v) => `Rename skin ${name} to ${v}`,
      (v) => { if (s.skin === name) s.skin = v; s.select({ kind: "skin", name: v }); }));
    const count = (skin.attachments ?? []).reduce((n, ss) => n + ss.entries.length, 0);
    form.append(readOnly("Attachments", String(count)));
    // The bones and constraints marked skin-required: each is on only while a shown skin lists it.
    const bones = (doc.bones ?? []).filter((b) => b.skin === true).map((b) => b.name);
    const constraints = (doc.constraints ?? []).filter((c) => c.skin === true);
    if (!bones.length && !constraints.length) {
      form.append(empty("No bone or constraint is skin-required. Mark a bone \"Skin required\" in its properties to let skins turn it on."));
      return;
    }
    if (bones.length) form.append(subheading("Bones it turns on"));
    for (const b of bones) {
      form.append(this.checkField(`bones/${b}`, b, skin.bones?.includes(b) ?? false, (on) => setSkinMember(name, "bones", b, on),
        (on) => `${on ? "Add" : "Remove"} ${b} ${on ? "to" : "from"} skin ${name}`));
    }
    if (constraints.length) form.append(subheading("Constraints it turns on"));
    for (const c of constraints) {
      form.append(this.checkField(`${c.type}/${c.name}`, `${c.name} (${c.type})`, skin[c.type]?.includes(c.name) ?? false, (on) => setSkinMember(name, c.type, c.name, on),
        (on) => `${on ? "Add" : "Remove"} ${c.name} ${on ? "to" : "from"} skin ${name}`));
    }
  }

  private slotForm(form: HTMLElement, doc: Skeleton, name: string): void {
    const s = this.session, slot = doc.slots!.find((x) => x.name === name)!;
    form.append(this.textField("name", "Name", slot.name, (v) => (v === name ? null : renameSlot(name, v)), (v) => `Rename slot ${name} to ${v}`,
      (v) => s.select({ kind: "slot", name: v })));
    form.append(this.selectField("bone", "Bone", (doc.bones ?? []).map((b) => [b.name, b.name]), slot.bone, (v) => updateSlot(name, { bone: v }), (v) => `Put slot ${name} on ${v}`));
    const keys = [...new Set((doc.skins ?? []).flatMap((k) => k.attachments ?? []).filter((ss) => ss.slot === name).flatMap((ss) => ss.entries.map((e) => e.key)))];
    form.append(this.selectField("attachment", "Shows", [["", "— nothing"], ...keys.map((k): [string, string] => [k, k])], slot.attachment ?? "",
      (v) => updateSlot(name, { attachment: v || undefined }), (v) => (v ? `Show ${v} in slot ${name}` : `Show nothing in slot ${name}`)));
    form.append(this.textField("color", "Colour", slot.color ?? "ffffffff", (v) => updateSlot(name, { color: v.toLowerCase() === "ffffffff" ? undefined : v }), () => `Set colour of slot ${name}`));
    form.append(this.textField("dark", "Dark", slot.dark ?? "", (v) => updateSlot(name, { dark: v.trim() === "" ? undefined : v }), () => `Set dark colour of slot ${name}`));
    form.append(this.selectField("blend", "Blend", BLEND_MODES.map((m) => [m, m]), slot.blend ?? "normal",
      (v) => updateSlot(name, { blend: v === "normal" ? undefined : v }), (v) => `Set blend of slot ${name} to ${v}`));
  }

  private attachmentForm(form: HTMLElement, doc: Skeleton, r: AttachmentRef): void {
    const s = this.session, a = findAttachment(doc, r)!, type = attachmentType(a);
    form.append(this.textField("name", "Name", r.key, (v) => (v === r.key ? null : renameAttachment(r, v)), (v) => `Rename attachment ${r.key} to ${v}`,
      (v) => s.select({ kind: "attachment", skin: r.skin, slot: r.slot, key: v })));
    form.append(readOnly("Type", type));
    form.append(this.selectField("skin", "Skin", (doc.skins ?? []).map((k) => [k.name, k.name]), r.skin, (v) => moveAttachment(r, v), (v) => `Move ${r.key} to skin ${v}`,
      (v) => s.select({ kind: "attachment", skin: v, slot: r.slot, key: r.key })));
    form.append(readOnly("Slot", r.slot));
    if (type !== "region") {
      form.append(empty("Editing this kind arrives in a later step; it is kept as it is."));
      return;
    }
    form.append(this.textField("path", "Image", a.path ?? a.name ?? r.key, (v) => updateAttachment(r, { path: v === (a.name ?? r.key) ? undefined : v }), () => `Set image of ${r.key}`));
    for (const f of REGION_FIELDS) {
      const value = a[f.key] ?? f.default ?? 0;
      form.append(this.textField(f.key, f.label, format(value), (v) => {
        const n = number(v, f.label);
        const patch: AttachmentPatch = {};
        patch[f.key] = f.default !== undefined && n === f.default ? undefined : n;
        return updateAttachment(r, patch);
      }, () => `Set ${f.label.toLowerCase()} of ${r.key}`, undefined, "decimal"));
    }
    form.append(this.textField("color", "Colour", a.color ?? "ffffffff", (v) => updateAttachment(r, { color: v.toLowerCase() === "ffffffff" ? undefined : v }), () => `Set colour of ${r.key}`));
  }

  /** Apply an edit from a field; refusals go to the status line; the panel then shows the document. */
  private commit(label: string, edit: () => Edit<Skeleton> | null, after?: () => void): void {
    const h = this.session.history;
    if (!h) return;
    try {
      const e = edit();
      if (e && h.apply(label, e)) {
        after?.();
        this.session.changed();
      }
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
    const focused = [...this.inputs].find(([, i]) => i === this.element.ownerDocument.activeElement)?.[0];
    this.shown = undefined;
    this.update(true);
    if (focused) this.inputs.get(focused)?.focus();
  }

  private textField(
    key: string, label: string, value: string,
    edit: (v: string) => Edit<Skeleton> | null, labelFor: (v: string) => string, after?: (v: string) => void, mode?: "decimal",
  ): HTMLLabelElement {
    const input = document.createElement("input");
    input.value = value;
    input.spellcheck = false;
    if (mode) { input.inputMode = mode; input.classList.add("number"); }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = value; input.blur(); }
    });
    input.addEventListener("change", () => this.commit(labelFor(input.value), () => edit(input.value), after && (() => after(input.value))));
    this.inputs.set(key, input);
    return field(label, input);
  }

  private selectField(key: string, label: string, options: ReadonlyArray<readonly [string, string]>, value: string,
    edit: (v: string) => Edit<Skeleton> | null, labelFor: (v: string) => string, after?: (v: string) => void): HTMLLabelElement {
    const select = document.createElement("select");
    select.append(...options.map(([v, text]) => new Option(text, v)));
    select.value = value;
    select.addEventListener("change", () => this.commit(labelFor(select.value), () => edit(select.value), after && (() => after(select.value))));
    this.inputs.set(key, select);
    return field(label, select);
  }

  private checkField(key: string, label: string, value: boolean, edit: (on: boolean) => Edit<Skeleton> | null, labelFor: (on: boolean) => string): HTMLLabelElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = value;
    box.addEventListener("change", () => this.commit(labelFor(box.checked), () => edit(box.checked)));
    this.inputs.set(key, box);
    const row = field(label, box);
    row.classList.add("check");
    return row;
  }
}

/** The bone, slot or attachment a selection names, if the document has it. */
export function selectedObject(doc: Skeleton, sel: Selection): object | undefined {
  if (sel.kind === "bone") return doc.bones?.find((b) => b.name === sel.name);
  if (sel.kind === "skin") return doc.skins?.find((k) => k.name === sel.name);
  if (sel.kind === "slot") return doc.slots?.find((x) => x.name === sel.name);
  return findAttachment(doc, sel);
}

/** A stable text for an object's identity within a session, so a changed object redraws the panel. */
const ids = new WeakMap<object, number>();
let nextId = 1;
function identity(o: object): string {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return `#${id}`;
}

function number(v: string, label: string): number {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) throw new EditRefused(`${label} needs a number.`);
  return n;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  control.setAttribute("aria-label", label);
  row.append(span, control);
  return row;
}

function subheading(text: string): HTMLHeadingElement {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

function readOnly(label: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "field readonly";
  const a = document.createElement("span"), b = document.createElement("output");
  a.textContent = label;
  b.textContent = value;
  row.append(a, b);
  return row;
}

/** A value as the field shows it: up to four decimals, no trailing zeros. */
export function format(n: number): string {
  return String(Math.round(n * 1e4) / 1e4);
}
