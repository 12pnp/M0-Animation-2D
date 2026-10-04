import { h, on } from "@/view/widgets/dom";
import { NumberField } from "@/view/widgets/NumberField";

export interface Box { left: number; top: number; right: number; bottom: number }

const MARGIN = 4;

/**
 * Where a popup `w` × `h` opens for a button at `anchor`: under it, its left
 * edge on the button's; above it when there is no room below; pushed inside
 * the window either way.
 */
export function popupAt(anchor: Box, w: number, hgt: number, viewW: number, viewH: number): { x: number; y: number } {
  const below = anchor.bottom + 2;
  const above = anchor.top - 2 - hgt;
  const y = below + hgt <= viewH - MARGIN || above < MARGIN ? below : above;
  const x = Math.min(anchor.left, viewW - MARGIN - w);
  return { x: Math.max(MARGIN, x), y: Math.max(MARGIN, Math.min(y, viewH - MARGIN - hgt)) };
}

/** The two counts a popup edits, wherever they are kept. */
export interface OnionCounts {
  get(): { before: number; after: number };
  set(patch: { before?: number; after?: number }): void;
  /** Calls `fn` when they may have changed; returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
}

/** As the timeline's onion counts. */
const COUNT_MAX = 100;

let open: { el: HTMLElement; close: () => void } | null = null;

/**
 * Onion frame counts, from a button: frames before and after the playhead,
 * typed or picked from equal presets. A second click on the same button
 * closes it, as do a click elsewhere and Escape.
 */
export function openOnionFrames(button: HTMLElement, counts: OnionCounts, title = "Onion frames"): void {
  if (open) {
    const was = open.el;
    open.close();
    if (was.dataset.for === button.dataset.onionFor) return;
  }
  const field = (key: "before" | "after") => {
    const f = new NumberField({ min: 0, max: COUNT_MAX, step: 1, decimals: 0, unit: "f",
      onInput: (v, committing) => { if (committing) counts.set({ [key]: Math.round(v) }); } });
    f.set(counts.get()[key]);
    return f;
  };
  const before = field("before");
  const after = field("after");
  const preset = (n: number) => {
    const b = h("button", { class: "btn", title: `${n} frame${n === 1 ? "" : "s"} each side` }, String(n));
    on(b, "click", () => counts.set({ before: n, after: n }));
    return b;
  };
  const row = (label: string, f: NumberField) => h("label", { class: "onion-pop-row" }, h("span", null, label), f.el);
  const el = h("div", { class: "popmenu onion-pop" },
    h("div", { class: "onion-pop-title" }, title),
    row("Before", before),
    row("After", after),
    h("div", { class: "onion-pop-presets" }, h("span", null, "Both"), preset(1), preset(2), preset(3), preset(5), preset(10)));
  el.dataset.for = button.dataset.onionFor ?? "";

  const unsubscribe = counts.subscribe(() => {
    const c = counts.get();
    before.show(c.before);
    after.show(c.after);
  });

  document.body.appendChild(el);
  const place = () => {
    const at = popupAt(button.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, innerWidth, innerHeight);
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
  };
  place();

  const outside = (e: PointerEvent) => {
    const n = e.target as Node;
    if (!el.contains(n) && !button.contains(n)) close();
  };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const close = () => {
    el.remove();
    unsubscribe();
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("resize", place);
    button.classList.remove("open");
    open = null;
  };
  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("resize", place);
  button.classList.add("open");
  open = { el, close };
}
