/**
 * Onion skin: which frames lie between the markers, which of them to draw
 * behind the current one, and how faintly.
 *
 * Pure and separate from the viewport and the frame grid so the range
 * arithmetic — following vs anchored markers, clamping at both ends of the
 * animation, the three marker drags, never re-drawing the current frame — can
 * be tested without a canvas.
 */
export interface OnionFrame {
  frame: number;
  alpha: number;
  side: "past" | "future";
}

export interface OnionSpan {
  start: number;
  end: number;
}

export interface OnionRangePrefs {
  onionBefore: number;
  onionAfter: number;
}

/**
 * The frames between the markers. Following markers sit `onionBefore` /
 * `onionAfter` frames either side of the playhead; anchored ones stay where
 * they were put. Either way the span is clamped to `0..maxFrame`.
 *
 * `period`: the animation is a cycle whose join is frame `period` (frame 0
 * again, `core/doc/cycle.ts`). Following markers then run past either end and
 * wrap round the loop, so the span is UNWRAPPED (start may be negative, end
 * past the join), at most `period − 1` frames each side so it never reaches
 * the playhead again. `onionFrames` and `wrapSpan` map it back.
 */
export function onionSpan(
  frame: number, maxFrame: number, prefs: OnionRangePrefs, anchor: OnionSpan | null, period?: number | null,
): OnionSpan {
  const top = Math.max(0, maxFrame);
  const clamp = (f: number) => Math.max(0, Math.min(top, Math.round(f)));
  if (anchor) {
    const a = clamp(Math.min(anchor.start, anchor.end));
    const b = clamp(Math.max(anchor.start, anchor.end));
    return { start: a, end: b };
  }
  if (period && period >= 2) {
    const reach = period - 1;
    return {
      start: frame - Math.min(reach, Math.max(0, Math.round(prefs.onionBefore))),
      end: frame + Math.min(reach, Math.max(0, Math.round(prefs.onionAfter))),
    };
  }
  return { start: clamp(frame - prefs.onionBefore), end: clamp(frame + prefs.onionAfter) };
}

/** `f` brought into `0..period − 1`: the frame a cycle shows at `f`. */
export function wrapFrame(f: number, period: number): number {
  return ((f % period) + period) % period;
}

/**
 * Where an unwrapped span (`onionSpan` with `period`) lies on the timeline:
 * one piece, or two when it runs across the join. Frames past the join show
 * from 0 again and frames before 0 from the end, so the join frame itself is
 * never part of a piece. The first piece holds the span's first frame and the
 * last piece its last frame, which is where the brackets go.
 */
export function wrapSpan(span: OnionSpan, period: number): OnionSpan[] {
  if (span.end - span.start + 1 >= period) return [{ start: 0, end: period - 1 }];
  const a = wrapFrame(span.start, period), b = wrapFrame(span.end, period);
  return a <= b ? [{ start: a, end: b }] : [{ start: a, end: period - 1 }, { start: 0, end: b }];
}

export interface OnionFramesArgs {
  frame: number;
  span: OnionSpan;
  /** Opacity of the nearest ghost. */
  opacity: number;
  /** Fraction each further frame loses. */
  falloff: number;
  /** Given, only frames it accepts are drawn ("Keyframes only"). */
  isKey?: (frame: number) => boolean;
  /** A cycle's join (`onionSpan`): frames outside `0..period − 1` wrap. */
  period?: number | null;
}

/**
 * Every frame of the span except the current one, farthest first so the
 * nearest paint on top of the fainter ones, fading with
 * distance: `opacity · (1 − falloff)^(d − 1)`. The current frame is never
 * included — it is drawn opaque by the renderer afterwards, and a ghost
 * underneath it would only darken it. With `isKey`, distance still counts
 * frames rather than keys, so a ghost's faintness says how far away it is.
 */
export function onionFrames(a: OnionFramesArgs): OnionFrame[] {
  const byDistance: OnionFrame[][] = [];
  const period = a.period && a.period >= 2 ? a.period : null;
  const shown = (f: number) => (period ? wrapFrame(f, period) : f);
  const current = shown(a.frame);
  // Wrapped, a frame can be reached both ways round the loop; it is drawn
  // once, at the nearer distance (`seen` is filled nearest first).
  const seen = new Map<number, number>();
  const reach = Math.max(a.frame - a.span.start, a.span.end - a.frame);
  for (let d = 1; d <= reach; d++) {
    const ring: OnionFrame[] = [];
    byDistance.push(ring);
    for (const f of [a.frame - d, a.frame + d]) {
      if (f < a.span.start || f > a.span.end) continue;
      const g = shown(f);
      if (g === current || seen.has(g)) continue;
      if (a.isKey && !a.isKey(g)) continue;
      seen.set(g, d);
      ring.push({ frame: g, alpha: a.opacity * Math.pow(1 - a.falloff, d - 1), side: f < a.frame ? "past" : "future" });
    }
  }
  return byDistance.reverse().flat();
}

export type MarkerDrag = "start" | "end" | "both" | "range";

/**
 * Where the markers go after dragging `which` by `delta` frames from `base`
 * (the span at pointer-down). `both` is ⌘-drag: the start marker moves by
 * `-delta` while the end moves by `delta`, so the range grows or shrinks
 * symmetrically. `range` is ⇧-drag: the whole span slides.
 *
 * `playhead` is given when the markers FOLLOW the playhead: a following range
 * has to keep containing it, because what it stores is two distances from it.
 */
export function dragMarkers(
  base: OnionSpan, which: MarkerDrag, delta: number, maxFrame: number, playhead?: number, period?: number | null,
): OnionSpan {
  // A following range on a cycle is unwrapped (`onionSpan`): it may run
  // `period − 1` frames past the playhead either way instead of stopping at
  // the ends of the animation.
  const wraps = playhead !== undefined && !!period && period >= 2;
  const bottom = wraps ? playhead - (period - 1) : 0;
  const top = wraps ? playhead + (period - 1) : Math.max(0, maxFrame);
  let { start, end } = base;
  switch (which) {
    case "start": start = base.start + delta; break;
    case "end": end = base.end + delta; break;
    case "both": start = base.start - delta; end = base.end + delta; break;
    case "range": {
      const width = base.end - base.start;
      let d = delta;
      d = Math.max(bottom - base.start, Math.min(top - base.end, d));
      if (playhead !== undefined) {
        d = Math.max(playhead - base.end, Math.min(playhead - base.start, d));
      }
      return { start: base.start + d, end: base.start + d + width };
    }
  }
  start = Math.max(bottom, Math.min(top, start));
  end = Math.max(bottom, Math.min(top, end));
  if (playhead !== undefined) {
    start = Math.min(start, playhead);
    end = Math.max(end, playhead);
  }
  if (start > end) {
    if (which === "start") start = end; else end = start;
  }
  return { start, end };
}
