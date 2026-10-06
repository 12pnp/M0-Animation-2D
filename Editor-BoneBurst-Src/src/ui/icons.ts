import type { ConstraintType } from "@/model/skeleton";

/**
 * The interface's icons (E4-PLAN step 13a): vendored SVG files under public/vendor/icons, Lucide
 * for the general ones and Godot's editor icons (restyled) for the animation glyphs Lucide lacks.
 * An icon is a span masked by its file and filled with `currentColor`, so it takes the colour of
 * the text around it, in either theme and in popout windows.
 */

const FILES = {
  open: "lucide/folder-open", save: "lucide/save", exportUnity: "lucide/folder-output", event: "lucide/flag", undo: "lucide/undo-2", redo: "lucide/redo-2", history: "lucide/rotate-ccw-clock",
  move: "lucide/move", rotate: "lucide/rotate-cw", scale: "lucide/scaling", shear: "lucide/shear", autoKey: "lucide/key-round", fit: "lucide/scan",
  settings: "lucide/settings", search: "lucide/search", pipette: "lucide/pipette", back: "lucide/arrow-left", forward: "lucide/arrow-right", up: "lucide/arrow-up", down: "lucide/arrow-down", delete: "lucide/trash",
  play: "lucide/play", pause: "lucide/pause", start: "lucide/skip-back", loop: "lucide/repeat",
  addImage: "lucide/image-plus", key: "lucide/diamond", drawOrder: "lucide/layers", ai: "lucide/bot",
  bone: "lucide/bone", panelStage: "lucide/layout-dashboard", panels: "lucide/layout-panel-left", panelRig: "lucide/list-tree", panelProperties: "lucide/sliders-horizontal", panelTimeline: "lucide/film", skin: "lucide/shirt", slot: "lucide/square-dashed",
  region: "lucide/image", linkedmesh: "lucide/link", path: "lucide/spline", point: "lucide/crosshair", clipping: "lucide/scissors",
  mesh: "godot/mesh", boundingbox: "godot/bounding-box",
  ik: "godot/constraint-ik", transform: "godot/constraint-transform", pathConstraint: "godot/constraint-path",
  physics: "godot/constraint-physics", slider: "godot/constraint-slider",
  keyTranslate: "godot/key-translate", keyRotate: "godot/key-rotate", keyScale: "godot/key-scale", keyDeform: "godot/key-deform",
  curveLinear: "godot/curve-linear", curveStepped: "godot/curve-stepped", curveEaseIn: "godot/curve-ease-in",
  curveEaseOut: "godot/curve-ease-out", curveEaseInOut: "godot/curve-ease-in-out",
} as const;

export type IconName = keyof typeof FILES;

/** Each icon's file under public/vendor/icons, without `.svg`. */
export const ICON_FILES: Readonly<Record<IconName, string>> = FILES;

/** Each constraint kind's icon. */
export const CONSTRAINT_ICONS: Readonly<Record<ConstraintType, IconName>> = { ik: "ik", transform: "transform", path: "pathConstraint", physics: "physics", slider: "slider" };

const url = (name: IconName) => `${import.meta.env.BASE_URL}vendor/icons/${FILES[name]}.svg`;

/** An icon, for beside a label: hidden from screen readers. */
export function icon(name: IconName): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "icon";
  setIcon(s, name);
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** Point an icon span (or a button holding one) at another icon. */
export function setIcon(el: HTMLElement, name: IconName): void {
  const s = el.classList.contains("icon") ? el : el.querySelector<HTMLElement>(":scope > .icon");
  if (!s) return;
  s.className = "icon";
  s.dataset.icon = name;
  s.style.setProperty("--icon", `url("${url(name)}")`);
}

/**
 * Give a button its icon. With `label`, the icon goes before the button's words; without, the
 * icon replaces them and the words become its accessible name.
 */
export function iconButton(b: HTMLButtonElement, name: IconName, label = true): HTMLButtonElement {
  const text = b.textContent ?? "";
  if (label) {
    const words = document.createElement("span");
    words.className = "label";
    words.textContent = text;
    b.replaceChildren(icon(name), words);
  } else {
    b.replaceChildren(icon(name));
    b.classList.add("icon-only");
    if (!b.getAttribute("aria-label")) b.setAttribute("aria-label", b.title || text);
  }
  return b;
}
