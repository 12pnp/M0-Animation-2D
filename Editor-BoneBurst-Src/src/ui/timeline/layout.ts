import type { KeyRef } from "@/edit/keys";
import type { Animation, Skeleton } from "@/model/skeleton";
import { frameTime, keyLists, keyTime, pathId, type PathKeys, timeFrame, type TimelinePath } from "@/model/timelines";

/**
 * The timeline's rows and geometry, without the DOM (`tests/timeline.test.ts`): which rows an
 * animation shows, where a frame is, and which keys are under the pointer.
 */

export interface Row {
  readonly id: string;
  readonly label: string;
  /** 0 for a bone, slot or constraint; 1 for one of its timelines when it is expanded. */
  readonly depth: 0 | 1;
  /** The bone this row is, for selection from the timeline. */
  readonly bone?: string;
  /** The event this row is (E6 step 4b): its keys are the events list's keys firing it. */
  readonly event?: string;
  readonly lists: readonly PathKeys[];
  readonly expandable: boolean;
  readonly expanded: boolean;
}

/** One diamond: a frame of a row, and every key it stands for. */
export interface Mark { readonly frame: number; readonly refs: readonly KeyRef[]; readonly stepped: boolean; readonly eased: boolean }

/**
 * One row per bone, slot and constraint the animation keys, in the skeleton's order, plus the
 * selected bone; then draw order; then a row per event the animation fires (the skeleton's order,
 * then any it does not define), and the selected event. An expanded row is followed by one row
 * per timeline. Deform and sequence keys go with their slot.
 */
export function buildRows(doc: Skeleton, anim: Animation, selected: string | null, expanded: ReadonlySet<string>, selectedEvent: string | null = null): Row[] {
  const lists = keyLists(anim);
  const rows: Row[] = [];
  const add = (id: string, label: string, mine: PathKeys[], sub: (p: TimelinePath) => string, bone?: string) => {
    const open = expanded.has(id) && mine.length > 0;
    rows.push({ id, label, depth: 0, lists: mine, expandable: mine.length > 0, expanded: open, ...(bone !== undefined ? { bone } : {}) });
    if (open) for (const l of mine) rows.push({ id: pathId(l.path), label: sub(l.path), depth: 1, lists: [l], expandable: false, expanded: false, ...(bone !== undefined ? { bone } : {}) });
  };
  const timelineName = (p: TimelinePath) => ("timeline" in p ? p.timeline : p.section);
  for (const b of doc.bones ?? []) {
    const mine = lists.filter((l) => l.path.section === "bones" && "owner" in l.path && l.path.owner === b.name);
    if (mine.length || b.name === selected) add(`bone/${b.name}`, b.name, mine, timelineName, b.name);
  }
  for (const s of doc.slots ?? []) {
    const mine = lists.filter((l) => (l.path.section === "slots" && l.path.owner === s.name) || (l.path.section === "attachments" && l.path.slot === s.name));
    if (mine.length) add(`slot/${s.name}`, `${s.name} (slot)`, mine, (p) => (p.section === "attachments" ? `${p.timeline}: ${p.attachment}` : timelineName(p)));
  }
  const owners = new Map<string, PathKeys[]>();
  for (const l of lists) {
    if (!["ik", "transform", "path", "physics", "slider"].includes(l.path.section) || !("owner" in l.path)) continue;
    const k = l.path.owner;
    owners.set(k, [...(owners.get(k) ?? []), l]);
  }
  for (const [owner, mine] of owners) {
    add(`constraint/${owner}`, owner === "" ? "physics (all)" : owner, mine, (p) => ("timeline" in p ? p.timeline : p.section));
  }
  const order = lists.filter((l) => l.path.section === "drawOrder");
  if (order.length) rows.push({ id: "drawOrder", label: "draw order", depth: 0, lists: order, expandable: false, expanded: false });
  const fired = lists.find((l) => l.path.section === "events")?.keys ?? [];
  const names = [...(doc.events ?? []).map((e) => e.name), ...fired.map((k) => String(k.name ?? ""))].filter((n, i, all) => all.indexOf(n) === i);
  for (const name of names) {
    const keys = fired.filter((k) => k.name === name);
    if (keys.length || name === selectedEvent) rows.push({ id: `event/${name}`, label: name, depth: 0, lists: [{ path: { section: "events" }, keys }], expandable: false, expanded: false, event: name });
  }
  return rows;
}

/** A row's diamonds: each frame with keys, and the keys there. */
export function marks(row: Row, fps: number): Mark[] {
  const by = new Map<number, { refs: KeyRef[]; stepped: boolean; eased: boolean }>();
  for (const l of row.lists) {
    for (const k of l.keys) {
      const f = timeFrame(keyTime(k), fps);
      const m = by.get(f) ?? { refs: [], stepped: false, eased: false };
      m.refs.push({ path: l.path, time: keyTime(k), ...(l.path.section === "events" ? { name: String(k.name ?? "") } : {}) });
      if (k.curve === "stepped") m.stepped = true;
      else if (Array.isArray(k.curve)) m.eased = true;
      by.set(f, m);
    }
  }
  return [...by].sort(([a], [b]) => a - b).map(([frame, m]) => ({ frame, ...m }));
}

/** How the track area is scrolled and zoomed. */
export interface View {
  /** CSS pixels per frame. */
  readonly frameWidth: number;
  /** The frame at the track's left edge (may be fractional). */
  readonly first: number;
}

export const RULER = 24;
/** A row's height in pixels: a live binding, set from Preferences ▸ Timeline (`setRowHeight`). */
export let ROW = 22;
export function setRowHeight(n: number): void { ROW = Math.max(8, Math.round(n)); }

export function frameX(v: View, frame: number): number { return (frame - v.first) * v.frameWidth; }
export function xFrame(v: View, x: number): number { return x / v.frameWidth + v.first; }

/** The row under a y in the track (0 at the top of the rows, below the ruler), or -1. */
export function rowAt(y: number, count: number): number {
  const i = Math.floor((y - RULER) / ROW);
  return y >= RULER && i < count ? i : -1;
}

/** The mark on `row` within `radius` pixels of x, nearest first. */
export function markAt(v: View, ms: readonly Mark[], x: number, radius = 6): Mark | null {
  let best: Mark | null = null, bestD = radius;
  for (const m of ms) {
    const d = Math.abs(frameX(v, m.frame) - x);
    if (d <= bestD) { best = m; bestD = d; }
  }
  return best;
}

/** How often the ruler labels frames: every 1, 2, 5, 10 … frames, at least 48 px apart. */
/** The steps between labelled ticks: the frame-rate divisors, or (fewer ticks) a 1-2-5 series. */
const TICKS_FPS: readonly number[] = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const TICKS_125: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
let ticks = TICKS_FPS;
export function setTickSeries(fewer: boolean): void { ticks = fewer ? TICKS_125 : TICKS_FPS; }

export function labelStep(frameWidth: number): number {
  for (const s of ticks) if (s * frameWidth >= 48) return s;
  return ticks.at(-1)! * 2;
}

/** A key's identity in the selection. */
export function refId(r: KeyRef, fps: number): string {
  return `${pathId(r.path)}${r.name !== undefined ? `/${r.name}` : ""}@${timeFrame(r.time, fps)}`;
}

/**
 * The refs of keys a drag has moved `applied` frames: as they were before any move (the time the
 * file stores, which may be a float32 step off the frame's own), at the frame's time after one.
 */
export function shiftedRefs(refs: readonly KeyRef[], applied: number, fps: number): KeyRef[] {
  return refs.map((r) => (applied === 0 ? r : { ...r, time: frameTime(timeFrame(r.time, fps) + applied, fps) }));
}
