import { type BonePatch, renameBone, updateBone } from "@/edit/bones";
import { type Edit, EditRefused } from "@/edit/history";
import { BONE_DEFAULTS, boneInherit, boneNumber, type BoneNumber } from "@/model/defaults";
import type { Bone, Skeleton } from "@/model/skeleton";
import { type BoneProperty, keyBone } from "@/edit/boneKeys";
import type { Session } from "../session";
import { animatedLocal } from "../stage/posed";
import { empty, heading } from "./outline";

/** The timeline each value keys in Animate mode (length is setup only). */
const KEYED: Partial<Record<BoneNumber, BoneProperty>> = {
  x: "translate", y: "translate", rotation: "rotate", scaleX: "scale", scaleY: "scale", shearX: "shear", shearY: "shear",
};

const FIELDS: ReadonlyArray<{ key: BoneNumber; label: string }> = [
  { key: "x", label: "X" }, { key: "y", label: "Y" }, { key: "rotation", label: "Rotation" },
  { key: "scaleX", label: "Scale X" }, { key: "scaleY", label: "Scale Y" },
  { key: "shearX", label: "Shear X" }, { key: "shearY", label: "Shear Y" }, { key: "length", label: "Length" },
];

/**
 * The selected bone's setup values. A field commits on Enter or when it loses focus, as one undo
 * step; a value the edit refuses is put back and the reason shown.
 */
export class Inspector {
  readonly element: HTMLDivElement;
  onStatus: (message: string) => void = () => {};
  /** What the panel shows; undefined until it first draws. */
  private shown: { doc: Skeleton | null; bone: Bone | null; name: string | null; at: string } | undefined;
  private inputs = new Map<string, HTMLInputElement>();

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel inspector";
    session.onChange(() => this.update());
    this.update();
  }

  private update(force = false): void {
    const name = this.session.selection;
    const bone = name !== null ? this.session.doc?.bones?.find((b) => b.name === name) ?? null : null;
    const doc = this.session.doc;
    const anim = this.session.animation;
    // In Animate mode the values are the pose at the playhead: they change with the document and the frame.
    const at = anim ? `${anim.name}|${this.session.frame}|${this.session.history?.revision}` : "";
    // A bone object changes exactly when its setup values do; `doc` is only for the empty message.
    if (this.shown && bone === this.shown.bone && name === this.shown.name && !doc === !this.shown.doc && at === this.shown.at) return;
    // Not under a field being typed in, nor while playing: it shows the document once that ends.
    if (!force && (this.element.contains(this.element.ownerDocument.activeElement) || this.session.playing)) return;
    this.shown = { doc, bone, name, at };
    this.inputs.clear();
    this.element.replaceChildren(heading(anim ? `Bone · keys at frame ${this.session.frame}` : "Bone"));
    if (!bone) {
      this.element.append(empty(this.session.doc ? "Select a bone on the stage or in the list." : "Nothing open."));
      return;
    }
    const form = document.createElement("div");
    form.className = "fields";
    const was = bone.name;
    form.append(this.textField("name", "Name", bone.name, (v) => (v === was ? null : renameBone(was, v)), (v) => `Rename bone ${was} to ${v}`));
    const p = anim ? this.session.pose() : null, index = p?.bones.get(was);
    const local = p && index !== undefined ? animatedLocal(p, index) : null;
    const time = this.session.keyTime;
    for (const f of FIELDS) {
      const keyed = local && f.key !== "length" ? KEYED[f.key] : undefined;
      const shownValue = keyed && local ? local[f.key as keyof typeof local] : boneNumber(bone, f.key);
      form.append(this.textField(f.key, f.label, format(shownValue), (v) => {
        const n = Number(v);
        if (v.trim() === "" || !Number.isFinite(n)) throw new EditRefused(`${f.label} needs a number.`);
        if (keyed && local && anim) return keyBone(anim.name, was, [keyed], { ...local, [f.key]: n }, time);
        const patch: BonePatch = {};
        // Back to the default: drop the key, as Spine writes it.
        patch[f.key] = n === BONE_DEFAULTS[f.key] ? undefined : n;
        return updateBone(was, patch);
      }, () => (keyed ? `Key ${f.label.toLowerCase()} of ${was} at frame ${this.session.frame}` : `Set ${f.label.toLowerCase()} of bone ${was}`), "decimal"));
    }
    form.append(readOnly("Parent", bone.parent ?? "—"), readOnly("Inherit", boneInherit(bone)));
    this.element.append(form);
  }

  private textField(
    key: string, label: string, value: string,
    edit: (v: string) => Edit<Skeleton> | null, labelFor: (v: string) => string, mode?: "decimal",
  ): HTMLLabelElement {
    const row = document.createElement("label");
    row.className = "field";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.value = value;
    input.spellcheck = false;
    if (mode) input.inputMode = mode;
    const commit = () => {
      const h = this.session.history;
      if (!h) return;
      try {
        const e = edit(input.value);
        if (e && h.apply(labelFor(input.value), e)) {
          if (key === "name") this.session.selection = input.value;
          this.session.changed();
        }
      } catch (err) {
        if (!(err instanceof EditRefused)) throw err;
        this.onStatus(err.message);
      }
      // Whatever happened, show what the document holds now, keeping the field focus moved to.
      const focused = [...this.inputs].find(([, i]) => i === this.element.ownerDocument.activeElement)?.[0];
      this.shown = undefined;
      this.update(true);
      if (focused) this.inputs.get(focused)?.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = value; input.blur(); }
    });
    input.addEventListener("change", commit);
    this.inputs.set(key, input);
    row.append(span, input);
    return row;
  }
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
