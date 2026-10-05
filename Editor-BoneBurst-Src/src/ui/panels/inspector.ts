import { type BonePatch, renameBone, updateBone } from "@/edit/bones";
import { type Edit, EditRefused } from "@/edit/history";
import { BONE_DEFAULTS, boneInherit, boneNumber, type BoneNumber } from "@/model/defaults";
import type { Bone, Skeleton } from "@/model/skeleton";
import type { Session } from "../session";
import { empty, heading } from "./outline";

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
  private shown: { doc: Skeleton | null; bone: Bone | null; name: string | null } | undefined;
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
    // A bone object changes exactly when its values do; `doc` is only for the empty message.
    if (this.shown && bone === this.shown.bone && name === this.shown.name && !doc === !this.shown.doc) return;
    // Not under a field being typed in: it commits, then shows the document as it is then.
    if (!force && this.element.contains(document.activeElement)) return;
    this.shown = { doc, bone, name };
    this.inputs.clear();
    this.element.replaceChildren(heading("Bone"));
    if (!bone) {
      this.element.append(empty(this.session.doc ? "Select a bone on the stage or in the list." : "Nothing open."));
      return;
    }
    const form = document.createElement("div");
    form.className = "fields";
    const was = bone.name;
    form.append(this.textField("name", "Name", bone.name, (v) => (v === was ? null : renameBone(was, v)), (v) => `Rename bone ${was} to ${v}`));
    for (const f of FIELDS) {
      form.append(this.textField(f.key, f.label, format(boneNumber(bone, f.key)), (v) => {
        const n = Number(v);
        if (v.trim() === "" || !Number.isFinite(n)) throw new EditRefused(`${f.label} needs a number.`);
        const patch: BonePatch = {};
        // Back to the default: drop the key, as Spine writes it.
        patch[f.key] = n === BONE_DEFAULTS[f.key] ? undefined : n;
        return updateBone(was, patch);
      }, () => `Set ${f.label.toLowerCase()} of bone ${was}`, "decimal"));
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
      const focused = [...this.inputs].find(([, i]) => i === document.activeElement)?.[0];
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
