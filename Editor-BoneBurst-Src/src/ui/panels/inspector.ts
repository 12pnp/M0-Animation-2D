import { type AttachmentPatch, type AttachmentRef, findAttachment, renameAttachment, updateAttachment } from "@/edit/attachments";
import { type BoneProperty, keyBone } from "@/edit/boneKeys";
import { type BonePatch, renameBone, reparentBone, subtree, updateBone } from "@/edit/bones";
import { type ConstraintPatch, type ConstraintRef, findConstraint, IK_SCALE_Y, PHYSICS_SCALE_Y, POSITION_MODES, renameConstraint,
  ROTATE_MODES, SPACING_MODES, TRANSFORM_PROPERTIES, updateConstraint } from "@/edit/constraints";
import { type Edit, EditRefused } from "@/edit/history";
import { regionToMesh, retriangulate, verticesOutside } from "@/edit/mesh";
import { moveAttachment, renameSkin, setSkinMember } from "@/edit/skins";
import { BLEND_MODES, renameSlot, updateSlot } from "@/edit/slots";
import { BONE_DEFAULTS, boneInherit, boneNumber, type BoneNumber, CONSTRAINT_DEFAULTS, constraintValue, DEPENDENT_DEFAULTS, TRANSFORM_MIXES, transformTargets } from "@/model/defaults";
import { attachmentType, type Constraint, type Skeleton, type TransformFrom } from "@/model/skeleton";
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
    // A checkbox or menu commits as it changes, so keeping focus on one does not hold the panel.
    const active = this.element.ownerDocument.activeElement;
    const typing = active instanceof HTMLInputElement && active.type !== "checkbox" && this.element.contains(active);
    if (!force && (typing || s.playing)) return;
    this.shown = key;
    this.inputs.clear();
    if (!doc || !sel || !target) {
      this.element.replaceChildren(heading("Properties"), empty(doc ? "Select a bone, slot, attachment, skin or constraint." : "Nothing open."));
      return;
    }
    const form = document.createElement("div");
    form.className = "fields";
    if (sel.kind === "bone") this.boneForm(form, doc, sel.name);
    else if (sel.kind === "slot") this.slotForm(form, doc, sel.name);
    else if (sel.kind === "skin") this.skinForm(form, doc, sel.name);
    else if (sel.kind === "constraint") this.constraintForm(form, doc, sel);
    else this.attachmentForm(form, doc, sel);
    const title = sel.kind === "bone" ? (anim ? `Bone · keys at frame ${s.frame}` : "Bone") : sel.kind === "slot" ? "Slot" : sel.kind === "skin" ? "Skin"
      : sel.kind === "constraint" ? `Constraint · ${KIND_TITLES[sel.type]}` : "Attachment";
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
      form.append(empty("No bone or constraint is skin-required. Mark one \"Skin required\" in its properties to let skins turn it on."));
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

  /**
   * A constraint's references and values, kind by kind (Format-Json-Atlas.md §7). A value set to
   * its default leaves the key out, except a mix whose default follows another key.
   */
  private constraintForm(form: HTMLElement, doc: Skeleton, r: ConstraintRef): void {
    const s = this.session, c = findConstraint(doc, r)!, type = c.type, name = c.name;
    const set = (patch: Record<string, unknown>) => updateConstraint(r, patch as ConstraintPatch);
    const fixed = CONSTRAINT_DEFAULTS[type], dependent = DEPENDENT_DEFAULTS[type] ?? [];
    const num = (key: string, label: string) => this.textField(key, label, format(constraintValue(c, key) as number), (v) => {
      const n = number(v, label);
      return set({ [key]: !dependent.includes(key) && n === fixed[key] ? undefined : n });
    }, () => `Set ${label.toLowerCase()} of ${name}`, undefined, "decimal");
    const flag = (key: string, label: string) => this.checkField(key, label, constraintValue(c, key) === true,
      (on) => set({ [key]: on === fixed[key] ? undefined : on }), (on) => `${on ? "Turn on" : "Turn off"} ${label.toLowerCase()} of ${name}`);
    // Modes are case-insensitive in the file; the menu shows the canonical spelling.
    const mode = (key: string, label: string, options: readonly string[]) => {
      const v = String(constraintValue(c, key));
      return this.selectField(key, label, options.map((o) => [o, o]), options.find((o) => o.toLowerCase() === v.toLowerCase()) ?? v,
        (o) => set({ [key]: o === fixed[key] ? undefined : o }), (o) => `Set ${label.toLowerCase()} of ${name} to ${o}`);
    };
    const boneNames = (doc.bones ?? []).map((b) => b.name);
    const boneMenu = (key: string, label: string, value: string, options = boneNames) =>
      this.selectField(key, label, options.map((n) => [n, n]), value, (v) => set({ [key]: v }), (v) => `Set ${label.toLowerCase()} of ${name} to ${v}`);
    /** The bones a transform or path constraint moves: one checkbox each, and a menu to add one. */
    const boneList = (bones: readonly string[]) => {
      form.append(subheading("Bones it moves"));
      for (const b of bones) form.append(this.checkField(`bones/${b}`, b, true, () => set({ bones: bones.filter((x) => x !== b) }), () => `Remove ${b} from ${name}`));
      const rest = boneNames.filter((n) => !bones.includes(n));
      form.append(this.selectField("addBone", "Add", [["", "— a bone…"], ...rest.map((n): [string, string] => [n, n])], "",
        (v) => (v ? set({ bones: [...bones, v] }) : null), (v) => `Add ${v} to ${name}`));
    };

    form.append(this.textField("name", "Name", name, (v) => (v === name ? null : renameConstraint(r, v)), (v) => `Rename ${name} to ${v}`,
      (v) => s.select({ kind: "constraint", type, name: v })));
    const order = (doc.constraints ?? []).indexOf(c);
    form.append(readOnly("Applies", `${order + 1} of ${doc.constraints!.length}`));
    form.append(this.checkField("skin", "Skin required", c.skin === true, (on) => set({ skin: on ? true : undefined }),
      (on) => `${on ? "Make" : "Stop making"} ${name} skin-required`));
    switch (c.type) {
      case "ik": {
        const l = c.bones ?? [], bone = l.at(-1)!, parent = doc.bones!.find((b) => b.name === bone)?.parent;
        // Another bone keeps one bone or two as before (two: it and its parent).
        form.append(this.selectField("bone", "Bone", boneNames.filter((n) => n !== c.target).map((n) => [n, n]), bone, (v) => {
          const p = doc.bones!.find((b) => b.name === v)?.parent;
          if (l.length === 2 && p === undefined) throw new EditRefused(`"${v}" has no parent to bend.`);
          return set({ bones: l.length === 2 ? [p!, v] : [v] });
        }, (v) => `Make ${name} bend ${v}`));
        form.append(this.checkField("two", "Bend its parent too", l.length === 2, (on) => {
          if (on && parent === undefined) throw new EditRefused(`"${bone}" has no parent to bend.`);
          return set({ bones: on ? [parent!, bone] : [bone] });
        }, (on) => `${on ? "Bend two bones" : "Bend one bone"} in ${name}`));
        const under = new Set(subtree(doc, l[0]!));
        form.append(boneMenu("target", "Target", c.target!, boneNames.filter((n) => !under.has(n))));
        form.append(num("mix", "Mix"), num("softness", "Softness"), flag("bendPositive", "Bend positive"),
          flag("compress", "Compress"), flag("stretch", "Stretch"), mode("scaleY", "Scale Y", IK_SCALE_Y));
        break;
      }
      case "transform": {
        form.append(boneMenu("source", "Source", c.source!, boneNames.filter((n) => !(c.bones ?? []).includes(n))));
        form.append(flag("localSource", "Local source"), flag("localTarget", "Local target"), flag("additive", "Additive"), flag("clamp", "Clamp"));
        const targets = transformTargets(c);
        for (const [key, kind] of TRANSFORM_MIXES) if (targets.has(kind)) form.append(num(key, `Mix ${kind}`));
        form.append(subheading("Offsets"));
        for (const [key, label] of [["rotation", "Rotation"], ["x", "X"], ["y", "Y"], ["scaleX", "Scale X"], ["scaleY", "Scale Y"], ["shearY", "Shear Y"]] as const) form.append(num(key, label));
        this.propertyMap(form, c.properties ?? [], (properties) => set({ properties }), name);
        boneList(c.bones ?? []);
        break;
      }
      case "path": {
        form.append(this.selectField("slot", "Slot", (doc.slots ?? []).map((x) => [x.name, x.name]), c.slot!, (v) => set({ slot: v }), (v) => `Make ${name} follow ${v}`));
        form.append(mode("positionMode", "Position mode", POSITION_MODES), mode("spacingMode", "Spacing mode", SPACING_MODES), mode("rotateMode", "Rotate mode", ROTATE_MODES));
        form.append(num("position", "Position"), num("spacing", "Spacing"), num("rotation", "Rotation"), num("mixRotate", "Mix rotate"), num("mixX", "Mix X"), num("mixY", "Mix Y"));
        boneList(c.bones ?? []);
        break;
      }
      case "physics": {
        form.append(boneMenu("bone", "Bone", c.bone!));
        form.append(subheading("What it feeds in"));
        form.append(num("x", "X"), num("y", "Y"), num("rotate", "Rotate"), num("scaleX", "Scale X"), num("shearX", "Shear X"), mode("scaleY", "Scale Y", PHYSICS_SCALE_Y));
        form.append(subheading("Simulation"));
        for (const [key, label] of [["inertia", "Inertia"], ["strength", "Strength"], ["damping", "Damping"], ["mass", "Mass"], ["wind", "Wind"], ["gravity", "Gravity"], ["mix", "Mix"]] as const) {
          form.append(num(key, label), flag(`${key}Global`, `${label}: global`));
        }
        form.append(num("limit", "Limit"), num("fps", "Steps per second"));
        break;
      }
      case "slider": {
        form.append(this.selectField("animation", "Animation", (doc.animations ?? []).map((a) => [a.name, a.name]), c.animation!, (v) => set({ animation: v }), (v) => `Make ${name} play ${v}`));
        form.append(num("mix", "Mix"), flag("additive", "Additive"), flag("loop", "Loop"));
        // Driven by a bone (its property mapped to time), or by its own time.
        form.append(this.selectField("driver", "Driven by", [["", "— its time"], ...boneNames.map((n): [string, string] => [n, n])], c.bone ?? "",
          (v) => set(v ? { bone: v, property: c.property ?? "rotate" } : { bone: undefined, property: undefined, from: undefined, to: undefined, scale: undefined, local: undefined }),
          (v) => (v ? `Drive ${name} by ${v}` : `Drive ${name} by its time`)));
        if (c.bone === undefined) form.append(num("time", "Time"));
        else {
          form.append(this.selectField("property", "Property", TRANSFORM_PROPERTIES.map((p) => [p, p]), c.property ?? "rotate", (v) => set({ property: v }), (v) => `Make ${name} read ${v}`));
          form.append(num("from", "From"), num("to", "To"), num("scale", "Scale"), flag("local", "Local"));
        }
        break;
      }
    }
  }

  /** A transform constraint's from → to pairs: offset, scale and max of each; add and remove pairs. */
  private propertyMap(form: HTMLElement, props: readonly TransformFrom[], write: (p: readonly TransformFrom[]) => Edit<Skeleton>, name: string): void {
    form.append(subheading("Mapping (from → to)"));
    const pairs = props.flatMap((p) => (p.to ?? []).map((t) => `${p.from}>${t.to}`));
    const change = (from: string, to: string, f: (t: Record<string, unknown> | null) => Record<string, unknown> | null) => write(props.flatMap((p) => {
      if (p.from !== from) return [p];
      const tos = (p.to ?? []).flatMap((t) => { if (t.to !== to) return [t]; const n = f(t as unknown as Record<string, unknown>); return n ? [n as unknown as typeof t] : []; });
      // A from with no to left is dropped, as the runtimes drop it (§7.3).
      return tos.length ? [{ ...p, to: tos }] : [];
    }));
    for (const p of props) for (const t of p.to ?? []) {
      const label = `${p.from} → ${t.to}`;
      form.append(subheading(label));
      for (const [key, text, d] of [["offset", "Offset", 0], ["scale", "Scale", 1], ["max", "Max", 1]] as const) {
        form.append(this.textField(`${p.from}>${t.to}/${key}`, text, format(t[key] ?? d), (v) => {
          const n = number(v, text);
          return change(p.from, t.to, (x) => { const o = { ...x! }; if (n === d) delete o[key]; else o[key] = n; return o; });
        }, () => `Set ${label} ${text.toLowerCase()} of ${name}`, undefined, "decimal"));
      }
      form.append(this.checkField(`${p.from}>${t.to}/on`, "Mapped", true, () => change(p.from, t.to, () => null), () => `Unmap ${label} in ${name}`));
    }
    const free = TRANSFORM_PROPERTIES.flatMap((f) => TRANSFORM_PROPERTIES.map((to) => `${f}>${to}`)).filter((k) => !pairs.includes(k));
    form.append(this.selectField("addPair", "Add", [["", "— a mapping…"], ...free.map((k): [string, string] => [k, k.replace(">", " → ")])], "", (v) => {
      if (!v) return null;
      const [from, to] = v.split(">") as [string, string];
      const entry = { to, extra: new Map() };
      const has = props.some((p) => p.from === from);
      return write(has ? props.map((p) => (p.from === from ? { ...p, to: [...(p.to ?? []), entry] } : p)) : [...props, { from, to: [entry], extra: new Map() }]);
    }, (v) => `Map ${v.replace(">", " → ")} in ${name}`));
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
    if (type === "mesh" || type === "linkedmesh") { this.meshFields(form, r); return; }
    if (type !== "region") {
      form.append(empty("Editing this kind arrives in a later step; it is kept as it is."));
      return;
    }
    form.append(this.action("Convert to mesh", "Make it a mesh with the same image in the same place; shape it on the stage", () => regionToMesh(r), `Convert ${r.key} to a mesh`));
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

  /** A mesh's image, colour and counts; Triangulate. Its vertices are edited on the stage. */
  private meshFields(form: HTMLElement, r: AttachmentRef): void {
    const a = findAttachment(this.session.doc!, r)!;
    if (a.source !== undefined) {
      form.append(readOnly("Linked to", `${a.source}${a.skin ? ` (${a.skin})` : ""}`));
      form.append(empty("A linked mesh takes its vertices from its source; select that mesh to shape them."));
      return;
    }
    const n = (a.uvs?.length ?? 0) / 2, weighted = a.vertices?.length !== a.uvs?.length;
    form.append(this.textField("path", "Image", a.path ?? a.name ?? r.key, (v) => updateAttachment(r, { path: v === (a.name ?? r.key) ? undefined : v }), () => `Set image of ${r.key}`));
    form.append(this.textField("color", "Colour", a.color ?? "ffffffff", (v) => updateAttachment(r, { color: v.toLowerCase() === "ffffffff" ? undefined : v }), () => `Set colour of ${r.key}`));
    form.append(readOnly("Vertices", `${n} (${a.hull ?? 0} on the outline)`));
    form.append(readOnly("Triangles", String((a.triangles?.length ?? 0) / 3)));
    form.append(readOnly("Bound to bones", weighted ? "yes" : "no"));
    if (weighted) { form.append(empty("Weighted meshes are shaped once weights arrive; shown as they are.")); return; }
    const outside = verticesOutside(a);
    if (outside.length) form.append(empty(`${outside.length} inner vertex${outside.length > 1 ? "es lie" : " lies"} outside the outline and in no triangle.`));
    form.append(this.action("Triangulate", "Triangulate again from the outline and the inner vertices", () => retriangulate(r), `Triangulate ${r.key}`));
    form.append(empty(this.session.animation
      ? "Switch to the setup pose to shape the mesh on the stage."
      : "On the stage: drag a vertex (Alt stretches the image), click inside or on the outline to add one, Delete removes the selected one."));
  }

  /** A button that applies one edit. */
  private action(text: string, title: string, edit: () => Edit<Skeleton>, label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "action";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", () => this.commit(label, edit));
    return b;
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
  if (sel.kind === "constraint") return findConstraint(doc, sel);
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

const KIND_TITLES: Record<Constraint["type"], string> = { ik: "IK", transform: "transform", path: "path", physics: "physics", slider: "slider" };

/** A value as the field shows it: up to four decimals, no trailing zeros. */
export function format(n: number): string {
  return String(Math.round(n * 1e4) / 1e4);
}
