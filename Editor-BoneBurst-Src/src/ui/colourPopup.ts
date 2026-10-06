import { type Hsv, hexToHsv, hsvToHex } from "./colour";
import { icon } from "./icons";

/** The browser's eyedropper (Chromium has it; Firefox and Safari do not). */
interface EyeDropperApi { open(): Promise<{ sRGBHex: string }> }
declare const EyeDropper: (new () => EyeDropperApi) | undefined;

/**
 * A colour picker in a small popup beside `anchor`: a square for saturation and value, a hue
 * slider, a hex field and a preview. Nothing is applied until Apply; Close (or Escape, or a click
 * outside) leaves the colour as it was. The popup goes inside the anchor's dialog, since a modal
 * dialog leaves everything outside it inert.
 */
export function pickColour(anchor: HTMLElement, current: string, onApply: (hex: string) => void): void {
  const host = anchor.closest("dialog") ?? document.body;
  let hsv: Hsv = hexToHsv(current) ?? { h: 0, s: 0, v: 0.5 };

  const pop = document.createElement("div");
  pop.className = "colour-popup";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Choose a colour");
  const square = document.createElement("div");
  square.className = "sv";
  const marker = document.createElement("span");
  marker.className = "marker";
  square.append(marker);
  const hue = document.createElement("input");
  hue.type = "range";
  hue.min = "0";
  hue.max = "360";
  hue.className = "hue";
  hue.setAttribute("aria-label", "Hue");
  const row = document.createElement("div");
  row.className = "row";
  const preview = document.createElement("span");
  preview.className = "preview";
  const hex = document.createElement("input");
  hex.type = "text";
  hex.spellcheck = false;
  hex.maxLength = 7;
  hex.setAttribute("aria-label", "Hex colour");
  row.append(preview, hex);
  // The eyedropper: click, then click any pixel on the screen to take its colour.
  if (typeof EyeDropper !== "undefined") {
    const dropper = document.createElement("button");
    dropper.type = "button";
    dropper.className = "dropper";
    dropper.title = "Pick a colour from anywhere on the screen";
    dropper.setAttribute("aria-label", "Pick a colour from the screen");
    dropper.append(icon("pipette"));
    dropper.addEventListener("click", () => {
      new EyeDropper!().open().then((r) => { const parsed = hexToHsv(r.sRGBHex.toLowerCase()); if (parsed) { hsv = parsed.s === 0 || parsed.v === 0 ? { ...parsed, h: hsv.h } : parsed; draw(); } }, () => { /* cancelled with Escape */ });
    });
    row.append(dropper);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "Apply";
  apply.setAttribute("aria-pressed", "true");
  actions.append(close, apply);
  pop.append(square, hue, row, actions);

  const draw = (fromHex = false) => {
    const now = hsvToHex(hsv);
    square.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))`;
    marker.style.left = `${hsv.s * 100}%`;
    marker.style.top = `${(1 - hsv.v) * 100}%`;
    hue.value = String(Math.round(hsv.h));
    preview.style.background = now;
    if (!fromHex) hex.value = now;
  };
  const sv = (e: PointerEvent) => {
    const r = square.getBoundingClientRect();
    hsv = { h: hsv.h, s: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), v: 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    draw();
  };
  square.addEventListener("pointerdown", (e) => {
    square.setPointerCapture(e.pointerId);
    sv(e);
    const move = (m: PointerEvent) => sv(m);
    const up = () => { square.removeEventListener("pointermove", move); square.removeEventListener("pointerup", up); };
    square.addEventListener("pointermove", move);
    square.addEventListener("pointerup", up);
  });
  hue.addEventListener("input", () => { hsv = { ...hsv, h: Number(hue.value) }; draw(); });
  hex.addEventListener("input", () => {
    const v = hex.value.startsWith("#") ? hex.value : `#${hex.value}`;
    const parsed = hexToHsv(v);
    if (parsed) { hsv = parsed.s === 0 || parsed.v === 0 ? { ...parsed, h: hsv.h } : parsed; draw(true); }
  });

  const finish = () => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    host.removeEventListener("keydown", key, true);
    host.removeEventListener("cancel", hold);
  };
  const outside = (e: PointerEvent) => { if (!pop.contains(e.target as Node)) finish(); };
  // Escape closes the popup, not the dialog under it.
  const key = (e: Event) => { if ((e as KeyboardEvent).key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); } };
  const hold = (e: Event) => e.preventDefault();
  close.addEventListener("click", finish);
  apply.addEventListener("click", () => { onApply(hsvToHex(hsv)); finish(); });

  host.append(pop);
  const a = anchor.getBoundingClientRect(), w = 220, h = 236;
  pop.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - w - 8))}px`;
  pop.style.top = `${a.bottom + h + 8 > window.innerHeight ? Math.max(8, a.top - h - 4) : a.bottom + 4}px`;
  draw();
  setTimeout(() => document.addEventListener("pointerdown", outside, true));
  host.addEventListener("keydown", key, true);
  host.addEventListener("cancel", hold);
}
