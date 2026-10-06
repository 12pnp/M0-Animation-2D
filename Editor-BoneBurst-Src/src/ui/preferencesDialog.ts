import { AUTOSAVE_RANGE, GRID_RANGE, ONION_RANGE, type Preferences, type Theme, UNDO_RANGE } from "./preferences";

/**
 * The Preferences dialog (E4-PLAN step 10): a native `<dialog>`; each change applies at once.
 * Reset puts every preference back to its default; Close or Escape closes it.
 */
export class PreferencesDialog {
  readonly element: HTMLDialogElement;
  private readonly form: HTMLFormElement;

  constructor(private readonly prefs: Preferences) {
    this.element = document.createElement("dialog");
    this.element.className = "preferences";
    this.element.setAttribute("aria-label", "Preferences");
    this.form = document.createElement("form");
    this.form.method = "dialog";
    this.element.append(this.form);
    prefs.onChange(() => { if (this.element.open) this.draw(); });
  }

  open(): void {
    this.draw();
    if (!this.element.open) this.element.showModal();
  }

  private draw(): void {
    const p = this.prefs.values;
    const title = document.createElement("h2");
    title.textContent = "Preferences";
    const theme = select("Theme", [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]], p.theme, (v) => this.prefs.set({ theme: v as Theme }));
    const rulers = check("Show rulers on the stage", p.rulers, (on) => this.prefs.set({ rulers: on }));
    const bones = check("Show bones on the stage", p.bones, (on) => this.prefs.set({ bones: on }));
    const constraints = check("Show constraints on the stage", p.constraints, (on) => this.prefs.set({ constraints: on }));
    const undo = number(`Undo steps kept (${UNDO_RANGE[0]}–${UNDO_RANGE[1]})`, p.undoSteps, 1, (n) => this.prefs.set({ undoSteps: n }));
    const undoNote = document.createElement("p");
    undoNote.className = "note";
    undoNote.textContent = "Takes effect for the next document opened.";
    const opacity = number("New references' opacity (%)", Math.round(p.referenceOpacity * 100), 1, (n) => this.prefs.set({ referenceOpacity: n / 100 }));
    const autosave = check("Keep a recovery copy of unsaved work", p.autosave, (on) => this.prefs.set({ autosave: on }));
    const every = number(`Every (seconds, ${AUTOSAVE_RANGE[0]}–${AUTOSAVE_RANGE[1]})`, p.autosaveSeconds, 1, (n) => this.prefs.set({ autosaveSeconds: n }));
    const autosaveNote = document.createElement("p");
    autosaveNote.className = "note";
    autosaveNote.textContent = "One copy, in this browser. It is not your file: Save writes that.";
    const onion = check("Onion skin (View ▸ Onion Skin)", p.onion, (on) => this.prefs.set({ onion: on }));
    const before = number(`Onion frames before (${ONION_RANGE[0]}–${ONION_RANGE[1]})`, p.onionBefore, 1, (n) => this.prefs.set({ onionBefore: n }));
    const after = number(`Onion frames after (${ONION_RANGE[0]}–${ONION_RANGE[1]})`, p.onionAfter, 1, (n) => this.prefs.set({ onionAfter: n }));
    const keyedOnly = check("Onion: keyed frames only", p.onionKeyedOnly, (on) => this.prefs.set({ onionKeyedOnly: on }));
    const colour = check("Onion: colour-coded (past red, future green)", p.onionColour, (on) => this.prefs.set({ onionColour: on }));
    const gridSize = number(`Grid spacing (units, ${GRID_RANGE[0]}–${GRID_RANGE[1]})`, p.gridSize, 1, (n) => this.prefs.set({ gridSize: n }));
    const gridNote = document.createElement("p");
    gridNote.className = "note";
    gridNote.textContent = "View ▸ Grid shows it; View ▸ Snapping and its Snap to… items choose what a dragged bone or vertex snaps to.";
    const actions = document.createElement("div");
    actions.className = "actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset";
    reset.title = "Every preference back to its default";
    reset.addEventListener("click", () => this.prefs.reset());
    const close = document.createElement("button");
    close.textContent = "Close";
    close.value = "close";
    actions.append(reset, close);
    this.form.replaceChildren(title, theme, rulers, bones, constraints, undo, undoNote, opacity, autosave, every, autosaveNote, onion, before, after, keyedOnly, colour, gridSize, gridNote, actions);
  }
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.className = "field";
  const s = document.createElement("span");
  s.textContent = label;
  control.setAttribute("aria-label", label);
  l.append(s, control);
  return l;
}

function select(label: string, options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void): HTMLLabelElement {
  const sel = document.createElement("select");
  sel.append(...options.map(([v, t]) => new Option(t, v)));
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return row(label, sel);
}

function check(label: string, value: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = value;
  box.addEventListener("change", () => onChange(box.checked));
  const r = row(label, box);
  r.classList.add("check");
  return r;
}

function number(label: string, value: number, step: number, onChange: (n: number) => void): HTMLLabelElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("change", () => {
    const n = Number(input.value);
    // A change redraws the dialog with what was kept (brought into range); anything else shows the old value.
    if (input.value.trim() !== "" && Number.isFinite(n)) onChange(n);
    if (input.isConnected) input.value = String(value);
  });
  return row(label, input);
}

