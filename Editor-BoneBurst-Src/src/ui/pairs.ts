import { pageScale } from "./pageScale";

/**
 * Fields that come in twos share one line, as Spine's panels do: X and Y become Position, "Scale X" and
 * "Scale Y" become Scale, Width and Height become Size. Each box keeps its own input (and aria-label) and
 * gets a small green letter in front of it.
 */
const SAME = [/^(.*?)\s*X$/i, /^(.*?)\s*Y$/i] as const;

/** The merged label and the two letters for two neighbouring rows' labels, or null when they are not a pair. */
function pairOf(a: string, b: string): { label: string; tags: [string, string] } | null {
  if (a === "Width" && b === "Height") return { label: "Size", tags: ["w", "h"] };
  const x = SAME[0].exec(a), y = SAME[1].exec(b);
  if (!x || !y || x[1] !== y[1] || !/(^|\s)X$/.test(a) || !/(^|\s)Y$/.test(b)) return null;
  const base = x[1]!;
  return { label: base === "" ? "Position" : base, tags: ["x", "y"] };
}

/** Dragging a letter left or right changes its number: a step per pixel (Shift: a tenth of it), one edit when let go. */
function scrub(head: HTMLElement, input: HTMLInputElement, step: number): void {
  let from: { x: number; value: number } | null = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const value = Number(input.value);
    from = { x: e.clientX, value: Number.isFinite(value) ? value : 0 };
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!from) return;
    const n = from.value + ((e.clientX - from.x) / pageScale(head.ownerDocument)) * step * (e.shiftKey ? 0.1 : 1);
    input.value = String(Math.round(n * 10000) / 10000);
  });
  const end = (e: PointerEvent): void => {
    if (!from) return;
    const moved = e.clientX !== from.x;
    from = null;
    if (moved) input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", () => { from = null; });
}

/** An input with its letter in front: the head cell shaded, dragged to change the number. */
export function tagged(input: HTMLInputElement, tag: string, step: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "axis-box";
  const t = document.createElement("i");
  t.className = "axis-tag";
  t.textContent = tag;
  t.setAttribute("aria-hidden", "true");
  t.title = "Drag left or right to change the value (Shift: finer)";
  scrub(t, input, step);
  wrap.append(t, input);
  return wrap;
}

/** Fields that stand alone but get a head cell too: Rotation (and a constraint's Rotate), and a bone's Length. */
const SINGLES: Readonly<Record<string, string>> = { Rotation: "r", Rotate: "r", Length: "l" };

/** Merge each X/Y (and Width/Height) pair of neighbouring `.field` rows in `form` into one row. */
export function mergePairs(form: HTMLElement): void {
  const rows = Array.from(form.children) as HTMLElement[];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i]!, b = rows[i + 1]!;
    if (!a.classList.contains("field") || !b.classList.contains("field")) continue;
    const la = a.querySelector(":scope > span")?.textContent ?? "", lb = b.querySelector(":scope > span")?.textContent ?? "";
    const ia = a.querySelector<HTMLInputElement>(":scope > input"), ib = b.querySelector<HTMLInputElement>(":scope > input");
    const pair = pairOf(la, lb);
    if (!pair || !ia || !ib) continue;
    // Scales and mixes run near 1: a hundredth a pixel; positions, shears and sizes a unit.
    const step = /^(Scale|Mix)$/.test(pair.label) ? 0.01 : 1;
    const box = document.createElement("div");
    box.className = "pair";
    box.append(tagged(ia, pair.tags[0], step), tagged(ib, pair.tags[1], step));
    const row = document.createElement("div");
    row.className = "field";
    const span = document.createElement("span");
    span.textContent = pair.label;
    row.append(span, box);
    form.replaceChild(row, a);
    b.remove();
    i++;
  }
  for (const row of Array.from(form.children) as HTMLElement[]) {
    if (!row.classList.contains("field")) continue;
    const tag = SINGLES[row.querySelector(":scope > span")?.textContent ?? ""];
    const input = row.querySelector<HTMLInputElement>(":scope > input");
    if (tag && input) row.append(tagged(input, tag, 1));
  }
}
