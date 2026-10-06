import { GRID_RANGE, type Preferences, type PreferenceValues } from "./preferences";

/** Where Snapping shows its settings besides Preferences: the Properties and References panels. */
type Toggle = "snap" | "snapGrid" | "snapGuides" | "snapBones" | "snapPixels";
const TOGGLES: ReadonlyArray<readonly [Toggle, string]> = [
  ["snap", "Snapping"], ["snapGrid", "Snap to grid"], ["snapGuides", "Snap to guides"], ["snapBones", "Snap to bones"], ["snapPixels", "Snap to pixels"],
];

function row(label: string, control: HTMLElement, check = false): HTMLLabelElement {
  const r = document.createElement("label");
  r.className = check ? "field check" : "field";
  const span = document.createElement("span");
  span.textContent = label;
  control.setAttribute("aria-label", label);
  r.append(span, control);
  return r;
}

/**
 * The snapping settings as panel fields: on or off, the grid's size, and what a dragged bone or vertex
 * snaps to. They are the preferences themselves (Preferences ▸ Stage ▸ Grid and snapping), so a change
 * here shows there and in the View menu, and the other way round. They follow the preferences until the
 * panel (`owner`) draws itself again without them.
 */
export function snapFields(prefs: Preferences, owner: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "snap-fields";
  const heading = document.createElement("h3");
  heading.textContent = "Snapping";
  const size = document.createElement("input");
  size.className = "number";
  size.inputMode = "decimal";
  size.spellcheck = false;
  size.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); size.blur(); }
    if (e.key === "Escape") { size.value = String(prefs.values.gridSize); size.blur(); }
  });
  size.addEventListener("change", () => {
    const n = Number(size.value);
    if (size.value.trim() !== "" && Number.isFinite(n)) prefs.set({ gridSize: n });
    size.value = String(prefs.values.gridSize);
  });
  size.title = `Snap and grid size, ${GRID_RANGE[0]}–${GRID_RANGE[1]} units`;
  const checks = new Map<Toggle, HTMLInputElement>();
  const rows: HTMLElement[] = [];
  for (const [key, label] of TOGGLES) {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.addEventListener("change", () => prefs.set({ [key]: c.checked }));
    checks.set(key, c);
    rows.push(row(label, c, true));
    if (key === "snap") rows.push(row("Snap size", size));
  }
  const show = (p: PreferenceValues): void => {
    for (const [key, c] of checks) c.checked = p[key];
    if (document.activeElement !== size) size.value = String(p.gridSize);
  };
  show(prefs.values);
  const off = prefs.onChange((p) => { if (box.dataset.shown === "1" && !owner.contains(box)) off(); else show(p); });
  queueMicrotask(() => { box.dataset.shown = "1"; });
  box.append(heading, ...rows);
  return box;
}
