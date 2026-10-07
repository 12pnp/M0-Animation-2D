import { icon } from "../icons";
import type { Preferences, PreferenceValues } from "../preferences";

type Key = "boneSelect" | "bones" | "boneNames" | "imageSelect" | "otherSelect" | "constraints";
type Column = "select" | "visible" | "names";

interface Row {
  readonly label: string;
  /** The preference each column is, or null where the kind has no such column (its cell is dimmed). */
  readonly cells: Readonly<Record<Column, Key | null>>;
}

const ROWS: readonly Row[] = [
  { label: "Bones", cells: { select: "boneSelect", visible: "bones", names: "boneNames" } },
  { label: "Images", cells: { select: "imageSelect", visible: null, names: null } },
  { label: "Others", cells: { select: "otherSelect", visible: "constraints", names: null } },
];

const COLUMNS: ReadonlyArray<{ column: Column; icon: "select" | "visible" | "names"; tip: string }> = [
  { column: "select", icon: "select", tip: "Select: a press on the stage picks it" },
  { column: "visible", icon: "visible", tip: "Visible: drawn on the stage" },
  { column: "names", icon: "names", tip: "Names: its name drawn beside it" },
];

/**
 * The Stage's Select · Visible · Names matrix: a row each for Bones, Images and Others (constraints),
 * a column each for what a press picks, what is drawn, and whether names show. Each cell is one
 * preference (the same ones Preferences and the View menu set); a kind without a column has its
 * cell dimmed.
 */
export function viewMatrix(prefs: Preferences): { element: HTMLElement; update: (p: PreferenceValues) => void } {
  const element = document.createElement("div");
  element.className = "view-matrix";
  const cells = new Map<Key, HTMLButtonElement>();
  const corner = document.createElement("span");
  element.append(corner);
  for (const c of COLUMNS) {
    const head = document.createElement("span");
    head.className = "vm-head";
    head.title = c.tip;
    head.append(icon(c.icon));
    element.append(head);
  }
  for (const row of ROWS) {
    const name = document.createElement("span");
    name.className = "vm-row";
    name.textContent = row.label;
    element.append(name);
    for (const c of COLUMNS) {
      const key = row.cells[c.column];
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "vm-cell";
      cell.setAttribute("aria-label", `${row.label}: ${c.column}`);
      if (key === null) cell.disabled = true;
      else {
        cell.title = `${row.label}: ${c.tip}`;
        cell.addEventListener("click", () => prefs.set({ [key]: !prefs.values[key] }));
        cells.set(key, cell);
      }
      element.append(cell);
    }
  }
  const update = (p: PreferenceValues): void => {
    for (const [key, cell] of cells) cell.setAttribute("aria-pressed", String(p[key]));
  };
  update(prefs.values);
  return { element, update };
}
