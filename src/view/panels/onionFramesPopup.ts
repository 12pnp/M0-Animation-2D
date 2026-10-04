import { h, on } from "@/view/widgets/dom";
import { NumberField } from "@/view/widgets/NumberField";
import type { Store } from "@/app/Store";
import { clampPref, PREF_LIMITS } from "@/core/prefs/prefs";

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

let open: { el: HTMLElement; close: () => void } | null = null;

/**
 * The onion frame counts, from a Path panel's button: frames before and after
 * the playhead. They are the timeline's onion preferences, so the stage's
 * onion skin and its markers take them too. Setting one lets anchored markers
 * follow the playhead again, as the timeline's Range menu does.
 */
export function openOnionFrames(store: Store, button: HTMLElement): void {
  if (open) {
    const was = open.el;
    open.close();
    // A second click on the same button closes it.
    if (was.dataset.for === button.dataset.onionFor) return;
  }
  const t = () => store.prefs.value.timeline;
  const setCount = (key: "onionBefore" | "onionAfter", v: number) => {
    store.setUi({ onionAnchor: null }, "stage");
    store.prefs.set("timeline", { [key]: clampPref(`timeline.${key}`, v) });
  };
  const field = (key: "onionBefore" | "onionAfter") => {
    const lim = PREF_LIMITS[`timeline.${key}`]!;
    const f = new NumberField({ min: lim.min, max: lim.max, step: 1, decimals: 0, unit: "f",
      onInput: (v, committing) => { if (committing) setCount(key, v); } });
    f.set(t()[key]);
    return f;
  };
  const before = field("onionBefore");
  const after = field("onionAfter");
  const preset = (n: number) => {
    const b = h("button", { class: "btn", title: `${n} frame${n === 1 ? "" : "s"} each side` }, String(n));
    on(b, "click", () => {
      store.setUi({ onionAnchor: null }, "stage");
      store.prefs.set("timeline", { onionBefore: n, onionAfter: n });
    });
    return b;
  };
  const anchored = h("div", { class: "onion-pop-note" }, "The markers are anchored on the timeline; a count here makes them follow the playhead.");
  const row = (label: string, f: NumberField) => h("label", { class: "onion-pop-row" }, h("span", null, label), f.el);
  const el = h("div", { class: "popmenu onion-pop" },
    h("div", { class: "onion-pop-title" }, "Onion frames"),
    row("Before", before),
    row("After", after),
    h("div", { class: "onion-pop-presets" }, h("span", null, "Both"), preset(1), preset(2), preset(3), preset(5), preset(10)),
    anchored);
  el.dataset.for = button.dataset.onionFor ?? "";

  const sync = () => {
    before.show(t().onionBefore);
    after.show(t().onionAfter);
    anchored.hidden = !store.ui.onionAnchor;
  };
  sync();
  const unPrefs = store.prefs.subscribe(sync);
  const unStore = store.subscribe(sync);

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
    unPrefs();
    unStore();
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
