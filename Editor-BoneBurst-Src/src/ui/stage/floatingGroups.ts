/**
 * The stage's tool panels as floating cards: each gets a grip bar to drag it by and a fold
 * button, and where it was left is remembered. A card keeps its place in the centred row; the
 * drag only offsets it from there (CSS `translate`), so the default layout is untouched.
 */
const KEY = "bb.stageGroups";

interface Place {
  dx: number;
  dy: number;
  folded: boolean;
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

/** Make `groups` (by id) draggable and foldable inside `bounds`. Returns a function that puts every card back where it started. */
export function floatGroups(bounds: HTMLElement, groups: Readonly<Record<string, HTMLElement>>): () => void {
  const places = load();
  const apply = (id: string, el: HTMLElement): void => {
    const p = places[id] ?? { dx: 0, dy: 0, folded: false };
    el.style.translate = p.dx || p.dy ? `${p.dx}px ${p.dy}px` : "";
    el.classList.toggle("folded", p.folded);
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

  for (const [id, el] of Object.entries(groups)) {
    const grip = document.createElement("div");
    grip.className = "grip";
    grip.title = "Drag to move this panel; the arrow folds it";
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
      const prev = places[id] ?? { dx: 0, dy: 0, folded: false };
      places[id] = { ...prev, dx: start.dx + mx, dy: start.dy + my };
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

  return () => {
    for (const k of Object.keys(places)) delete places[k];
    for (const [id, el] of Object.entries(groups)) apply(id, el);
    save(places);
  };
}
