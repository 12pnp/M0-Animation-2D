import { pageScale } from "../pageScale";

/**
 * The stage's tool panels as floating cards: each gets a small grip button on its corner to drag it by (a click folds it), and where it was left is remembered. A card keeps its place in the centred row; the
 * drag only offsets it from there (CSS `translate`), so the default layout is untouched.
 */
const KEY = "bb.stageGroups";

interface Place {
  dx: number;
  dy: number;
  folded: boolean;
  /** The person turned the whole card off (the small buttons on the stage's left edge). */
  hidden?: boolean;
}

function load(): Record<string, Place> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Place>) : {};
  } catch {
    return {};
  }
}

function save(places: Record<string, Place>): void {
  try { localStorage.setItem(KEY, JSON.stringify(places)); } catch { /* storage blocked: kept for this session only */ }
}

/** Make `groups` (by id) draggable and foldable inside `bounds`. Returns what puts every card back where it started, and turns a card off or on. */
export function floatGroups(bounds: HTMLElement, groups: Readonly<Record<string, HTMLElement>>, onHidden: () => void = () => {}): { reset: () => void; toggle: (id: string) => void; isHidden: (id: string) => boolean } {
  const places = load();
  const apply = (id: string, el: HTMLElement): void => {
    const p = places[id] ?? { dx: 0, dy: 0, folded: false };
    el.style.translate = p.dx || p.dy ? `${p.dx}px ${p.dy}px` : "";
    el.classList.toggle("folded", p.folded);
    el.classList.toggle("user-hidden", p.hidden === true);
  };
  /** Pull a card back inside the stage when the stage is smaller than where the card was left. */
  const keepInside = (id: string, el: HTMLElement): void => {
    const p = places[id];
    if (!p || (!p.dx && !p.dy)) return;
    const b = bounds.getBoundingClientRect(), r = el.getBoundingClientRect();
    const fix = (low: number, high: number): number => (low < 0 ? -low : high > 0 ? -high : 0);
    const mx = fix(r.left - b.left, r.right - b.right), my = fix(r.top - b.top, r.bottom - b.bottom);
    if (!mx && !my) return;
    places[id] = { ...p, dx: p.dx + mx, dy: p.dy + my };
    apply(id, el);
  };

  /** The cards other than `id` that are showing, as screen rectangles. */
  const others = (id: string): DOMRect[] =>
    Object.entries(groups).filter(([k, g]) => k !== id && g.offsetParent !== null && !g.hidden && !g.classList.contains("user-hidden")).map(([, g]) => g.getBoundingClientRect());
  const overlap = (a: DOMRect, b: DOMRect): number => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  /** Whether moving card `id` to offset `to` would put it on another card, or deeper into one it already overlaps. */
  const blocked = (id: string, el: HTMLElement, from: Place, to: { dx: number; dy: number }, k: number): boolean => {
    const now = el.getBoundingClientRect();
    const moved = new DOMRect(now.x + (to.dx - from.dx) * k, now.y + (to.dy - from.dy) * k, now.width, now.height);
    return others(id).some((o) => { const after = overlap(moved, o); return after > 1 && after > overlap(now, o); });
  };

  for (const [id, el] of Object.entries(groups)) {
    const grip = document.createElement("div");
    grip.className = "grip";
    grip.title = "Drag to move this panel; click to fold it";
    const fold = document.createElement("span");
    fold.className = "fold";
    fold.textContent = "▾";
    grip.append(fold);
    el.prepend(grip);
    apply(id, el);

    let start: { x: number; y: number; dx: number; dy: number; moved: boolean } | null = null;
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const p = places[id] ?? { dx: 0, dy: 0, folded: false };
      start = { x: e.clientX, y: e.clientY, dx: p.dx, dy: p.dy, moved: false };
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!start) return;
      const mx = e.clientX - start.x, my = e.clientY - start.y;
      if (!start.moved && Math.hypot(mx, my) < 3) return;
      start.moved = true;
      const prev = places[id] ?? { dx: 0, dy: 0, folded: false }, k = pageScale(el.ownerDocument);
      const want = { dx: start.dx + mx / k, dy: start.dy + my / k };
      // A card never lands on another: try the move whole, then along x only and along y only (so it slides along an edge); else it stays.
      const spot = [want, { dx: want.dx, dy: prev.dy }, { dx: prev.dx, dy: want.dy }].find((c) => !blocked(id, el, prev, c, k));
      if (!spot) return;
      places[id] = { ...prev, dx: spot.dx, dy: spot.dy };
      apply(id, el);
      keepInside(id, el);
    });
    const end = (): void => {
      if (!start) return;
      const wasClick = !start.moved;
      start = null;
      if (wasClick) {
        const prev = places[id] ?? { dx: 0, dy: 0, folded: false };
        places[id] = { ...prev, folded: !prev.folded };
        apply(id, el);
      }
      save(places);
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  new ResizeObserver(() => { for (const [id, el] of Object.entries(groups)) keepInside(id, el); }).observe(bounds);

  return {
    reset: () => {
      for (const k of Object.keys(places)) delete places[k];
      for (const [id, el] of Object.entries(groups)) apply(id, el);
      save(places);
      onHidden();
    },
    toggle: (id) => {
      const el = groups[id];
      if (!el) return;
      const prev = places[id] ?? { dx: 0, dy: 0, folded: false };
      places[id] = { ...prev, hidden: prev.hidden !== true };
      apply(id, el);
      save(places);
      onHidden();
    },
    isHidden: (id) => places[id]?.hidden === true,
  };
}
