import { mergePairs } from "../pairs";
import { EditRefused } from "@/edit/history";
import { moveReference, type ReferencePatch, removeReference, updateReference } from "@/edit/sidecar";
import type { Sidecar } from "@/model/sidecar";
import { fileSource, type Session } from "../session";
import { iconButton } from "../icons";
import { referenceFile } from "../stage/references";
import { empty, heading } from "./outline";

/**
 * The Reference panel (E4-PLAN step 9): the reference images in the sidecar, drawn behind the
 * skeleton in this order. Add image… (or images dropped on an open document) adds one; the fields
 * place and fade the chosen one. Changes are the sidecar's: not undo steps, but saved with it.
 */
export class References {
  readonly element: HTMLDivElement;
  onStatus: (message: string) => void = () => {};
  /** Where a new reference goes: the stage's centre. */
  centre: () => [number, number] = () => [0, 0];
  private chosen = 0;
  private shown = "";
  private readonly picker: HTMLInputElement;

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel outline references";
    this.picker = document.createElement("input");
    this.picker.type = "file";
    this.picker.accept = "image/*";
    this.picker.multiple = true;
    this.picker.hidden = true;
    this.picker.addEventListener("change", () => {
      const files = [...(this.picker.files ?? [])];
      this.picker.value = "";
      if (files.length) void this.session.addReferenceImages(files.map(fileSource), this.centre()).then((m) => {
        this.chosen = this.session.sidecar.references.length - 1;
        this.session.selectReference(this.chosen);
        this.onStatus(m);
      });
    });
    session.onChange(() => {
      // The reference chosen on the stage is the panel's too.
      if (session.reference !== null) this.chosen = session.reference;
      this.update();
    });
    this.update();
  }

  private apply(edit: (s: Sidecar) => Sidecar): void {
    try {
      this.session.setSidecar(edit(this.session.sidecar));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
    this.shown = "";
    this.update(true);
  }

  /** Move the chosen reference by one place; it stays chosen. */
  private move(by: number): void {
    const i = this.chosen, s = this.session;
    this.chosen = Math.max(0, Math.min(s.sidecar.references.length - 1, i + by));
    const onStage = s.reference === i;
    this.apply((x) => moveReference(x, i, i + by));
    if (onStage) s.selectReference(this.chosen);
  }

  private update(force = false): void {
    const s = this.session, refs = s.sidecar.references;
    const key = JSON.stringify([!!s.doc, refs, this.chosen, [...s.referenceImages.keys()]]);
    if (key === this.shown) return;
    const active = this.element.ownerDocument.activeElement;
    if (!force && active instanceof HTMLInputElement && active.type !== "file" && this.element.contains(active)) return;
    this.shown = key;
    if (!s.doc) { this.element.replaceChildren(heading("References"), empty("Nothing open.")); return; }
    if (this.chosen >= refs.length) this.chosen = Math.max(0, refs.length - 1);
    const bar = document.createElement("div");
    bar.className = "outline-bar";
    bar.append(
      iconButton(button("Add image…", "Add pictures to rig and animate against; keep the files beside the skeleton. The chosen one is dragged on the stage, its corners size it", () => this.picker.click()), "addImage"),
      iconButton(button("Remove", "Remove the chosen reference (its file is not touched)", () => { this.session.selectReference(null); this.apply((x) => removeReference(x, this.chosen)); }, !refs.length), "delete"),
      iconButton(button("↑", "Draw it earlier (further back)", () => this.move(-1), this.chosen <= 0), "up", false),
      iconButton(button("↓", "Draw it later (nearer the skeleton)", () => this.move(1), this.chosen >= refs.length - 1), "down", false),
      this.picker,
    );
    const list = document.createElement("div");
    list.className = "rows";
    list.setAttribute("role", "listbox");
    refs.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = `row${i === this.chosen ? " selected" : ""}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === this.chosen));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = referenceFile(r.path);
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = s.referenceImages.has(r.path) ? `${Math.round(r.opacity * 100)}%` : "missing: drop the file to show it";
      row.append(name, note);
      row.addEventListener("click", () => { this.chosen = i; this.shown = ""; this.session.selectReference(i); this.update(true); });
      list.append(row);
    });
    if (!refs.length) list.append(empty("No references. Add image…, or drop pictures on the window, to animate against them."));
    const parts: HTMLElement[] = [heading("References"), bar, list];
    const r = refs[this.chosen];
    if (r) {
      const form = document.createElement("div");
      form.className = "fields";
      const field = (key: keyof ReferencePatch, label: string, value: number, read: (n: number) => number = (n) => n) => {
        const input = document.createElement("input");
        input.value = String(Math.round(value * 1e4) / 1e4);
        input.inputMode = "decimal";
        input.classList.add("number");
        input.setAttribute("aria-label", label);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
        input.addEventListener("change", () => {
          const n = Number(input.value);
          if (input.value.trim() === "" || !Number.isFinite(n)) { this.onStatus(`${label} needs a number.`); this.shown = ""; this.update(true); return; }
          this.apply((x) => updateReference(x, this.chosen, { [key]: read(n) }));
        });
        const row = document.createElement("label");
        row.className = "field";
        const span = document.createElement("span");
        span.textContent = label;
        row.append(span, input);
        return row;
      };
      form.append(field("x", "X", r.x), field("y", "Y", r.y), field("scale", "Scale", r.scale), field("opacity", "Opacity %", r.opacity * 100, (n) => n / 100));
      mergePairs(form);
      parts.push(form);
    }
    this.element.replaceChildren(...parts);
  }
}

function button(text: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}
