import { arrivalTimes, curveOf, pathPose } from "@/motion";
import { fitChannel, type TimedKey } from "@/edit/pathKeys";
import type { MotionPath } from "@/model/sidecar";

/**
 * A path as translate keys over an animation's length (docs/UNITY-EXPORT-PLAN.md, step 1): the keys the export writes for a bone that uses
 * its path. In exact seconds, not frames. Pure: where the path's point lands in the bone's own parent's space (the reference bone as the key
 * animation poses it at that time) is `place`, so this file knows no rig.
 */

/** How many samples a stretch's curve is fitted to. */
const FIT_SAMPLES = 12;

/** The gap an open path's repeat jumps over: the run's last place, then the first, this far apart in time. */
export const SEAM_GAP = 0.001;

const EPS = 1e-6;

export interface KeysOver {
  readonly keys: TimedKey[];
  /** How far the keys' motion strays from the path at worst. */
  readonly stray: number;
  /** Whether the animation is a whole number of the path's runs long: when it is not, the path's repeat does not meet the animation's loop point (a jump there). */
  readonly wholeRuns: boolean;
}

interface Anchor {
  readonly time: number;
  /** The run (0 for the first) the stretch that starts here belongs to. */
  readonly run: number;
  /** The stretch to the next anchor is a jump (an open path's repeat): straight, never refined. */
  readonly jump: boolean;
}

/**
 * The keys of `m` over [0, `length`] seconds. The path's own time is the animation's time from 0: a looping path starts over each run, any
 * other holds its last place. A key where the bone reaches each node, at each repeat and at the end, then more inside any stretch whose
 * fitted curve strays more than a little (stretches under two frames of `fps` are not split), each stretch with its fit's control values.
 * An open path that repeats jumps from its last place to its first within `SEAM_GAP`; a ring just continues.
 */
export function keysOver(m: MotionPath, length: number, fps: number, place: (time: number, x: number, y: number) => readonly [number, number]): KeysOver {
  const D = m.duration, whole = D > 0 && Math.abs(length / D - Math.round(length / D)) < 1e-6;
  if (!(length > 0) || !(D > 0)) return { keys: [], stray: 0, wholeRuns: whole };
  const runs = m.loop ? Math.ceil(length / D - EPS) : 1;
  // Where the bone reaches each node, in each run; the repeats; the end.
  const raw: Anchor[] = [];
  for (let r = 0; r < runs; r++) {
    // A run's end is the next run's start (a repeat) or the animation's end, so a looping path's arrival at `D` is left to those.
    for (const a of arrivalTimes(m)) { const t = r * D + a; if (t < length - EPS && !(m.loop && a > D - EPS)) raw.push({ time: t, run: r, jump: false }); }
    if (r > 0) raw.push({ time: r * D, run: r, jump: false });
  }
  if (!m.loop && D < length - EPS) raw.push({ time: D, run: 0, jump: false });
  raw.sort((a, b) => a.time - b.time);
  // An open path's repeat: the run's end just before, the start at the repeat.
  const anchors: Anchor[] = [];
  for (const a of raw) {
    if (anchors.length && a.time - anchors.at(-1)!.time < EPS) continue;
    if (m.loop && !m.closed && a.run > 0 && Math.abs(a.time - a.run * D) < EPS) anchors.push({ time: a.time - SEAM_GAP, run: a.run - 1, jump: true });
    anchors.push(a);
  }
  if (!anchors.length || anchors[0]!.time > EPS) anchors.unshift({ time: 0, run: 0, jump: false });
  // The end: a whole number of runs of an open looping path ends on a jump too (the animation loops to the start).
  const last = anchors.at(-1)!;
  if (m.loop && !m.closed && whole && length > D - EPS && last.time < length - SEAM_GAP - EPS) anchors.push({ time: length - SEAM_GAP, run: runs - 1, jump: true });
  anchors.push({ time: length, run: m.loop ? Math.floor(length / D + EPS) : 0, jump: false });
  const end = anchors.at(-1)!;

  // The path's point at `time`, taking the stretch's run: a stretch ending on a repeat reads the run's end, not the next run's start.
  const point = (time: number, run: number): readonly [number, number] => {
    const own = m.loop ? Math.min(D, Math.max(0, time - run * D)) : Math.min(D, time), q = pathPose(m, own);
    return place(time, q.x, q.y);
  };
  const tolerance = Math.max(0.1, curveOf(m).length * 0.002), minSpan = 2 / fps;
  const fit = (t0: number, t1: number, run: number) => {
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k <= FIT_SAMPLES; k++) { const [px, py] = point(t0 + ((t1 - t0) * k) / FIT_SAMPLES, run); xs.push(px); ys.push(py); }
    const fx = fitChannel(xs), fy = fitChannel(ys);
    return { fx, fy, error: Math.hypot(fx.error, fy.error) };
  };
  // A stretch whose fit strays gets a key in the middle (a limited number of times over).
  const starts: { time: number; run: number; jump: boolean }[] = [];
  const split = (t0: number, t1: number, run: number, jump: boolean, depth: number): void => {
    starts.push({ time: t0, run, jump });
    if (!jump && t1 - t0 >= minSpan && depth < 4 && fit(t0, t1, run).error > tolerance) {
      const mid = (t0 + t1) / 2;
      split(t0, mid, run, false, depth + 1);
      split(mid, t1, run, false, depth + 1);
    }
  };
  for (let i = 0; i + 1 < anchors.length; i++) split(anchors[i]!.time, anchors[i + 1]!.time, anchors[i]!.run, anchors[i]!.jump, 0);

  const keys: TimedKey[] = [];
  let stray = 0;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!, next = starts[i + 1]?.time ?? end.time, [x, y] = point(s.time, s.run);
    if (s.jump) { keys.push({ time: s.time, x, y }); continue; }
    const { fx, fy, error } = fit(s.time, next, s.run);
    stray = Math.max(stray, error);
    keys.push({ time: s.time, x, y, control: [fx.c1, fx.c2, fy.c1, fy.c2] });
  }
  // The last key: a ring ends where it began; an open path's loop ends at its start; else where the path is.
  const [ex, ey] = point(end.time, end.run);
  keys.push({ time: end.time, x: ex, y: ey });
  return { keys, stray, wholeRuns: whole };
}
