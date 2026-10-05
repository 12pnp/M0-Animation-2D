import type { NodeId } from "./ids";
import { unwrapTurns } from "./propertyKeys";
import { cutKeepingEase, keyIndexAt, sampleTransformRaw } from "./timeline";
import type { Keyframe, Node, Track } from "./types";

/**
 * Offset keys (ARCHITECTURE ▸ Offset keys), pure: a layer's keys moved in time
 * inside its span, the way Spine's Offset tool staggers a chain of bones
 * (overlapping action).
 *
 * In a cycle a track that runs from frame 0 to the join wraps: what is pushed
 * past the join comes round to frame 0, keys cut in where the wrap falls so
 * the motion is the same loop started elsewhere. A bone that turns a whole
 * number of times over the loop keeps turning the same way. Any other track
 * keeps its span: moved later, its first pose holds until the moved keys start
 * and what passes its end is cut there; moved earlier, what passes its start
 * is cut there and the last pose holds to the end.
 */

const HOLD = { kind: "none" } as const;

function keyedAt(t: Track, frame: number, node: Node): Track {
  return keyIndexAt(t, frame) >= 0 ? t : cutKeepingEase(t, frame, node) ?? t;
}

function sorted(keys: Keyframe[]): Keyframe[] {
  return [...keys].sort((a, b) => a.frame - b.frame);
}

/** The track's keys moved by `delta` frames. `seam`: the cycle's join, or null. */
export function offsetTrack(track: Track, node: Node, delta: number, seam: number | null): Track {
  if (!delta || !track.keys.length) return track;
  const start = track.keys[0]!.frame;
  if (seam !== null && seam > 0 && start === 0 && track.endFrame >= seam) return wrapped(track, node, delta, seam);

  const end = track.endFrame;
  if (delta > 0) {
    const last = end - delta;
    if (last < start) return { ...track, keys: [{ ...track.keys[0]!, tween: HOLD, eases: undefined }].map(clean) };
    const t = keyedAt(track, last, node);
    const moved = t.keys.filter((k) => k.frame <= last).map((k) => ({ ...k, frame: k.frame + delta }));
    return { ...track, keys: sorted([clean({ ...track.keys[0]!, tween: HOLD, eases: undefined }), ...moved]) };
  }
  const from = start - delta;
  const lastKey = track.keys[track.keys.length - 1]!;
  if (from >= lastKey.frame) return { ...track, keys: [{ ...lastKey, frame: start }] };
  const t = keyedAt(track, from, node);
  return { ...track, keys: t.keys.filter((k) => k.frame >= from).map((k) => ({ ...k, frame: k.frame + delta })) };
}

function clean(k: Keyframe): Keyframe {
  if (k.eases !== undefined) return k;
  const { eases: _e, ...rest } = k;
  return rest;
}

function wrapped(track: Track, node: Node, delta: number, seam: number): Track {
  const d = ((delta % seam) + seam) % seam;
  if (d === 0) return track;
  const cut = seam - d;
  let t = unwrapTurns(track);
  t = keyedAt(keyedAt(t, seam, node), cut, node);
  // Whole turns over the loop: the keys that come round start a turn back.
  const turn = 360 * Math.round(((sampleTransformRaw(t, seam)?.skewY ?? 0) - (sampleTransformRaw(t, 0)?.skewY ?? 0)) / 360);
  const keys = t.keys.filter((k) => k.frame < seam).map((k) => {
    const f = k.frame + d;
    if (f < seam) return { ...k, frame: f };
    return { ...k, frame: f - seam, transform: { ...k.transform, skewX: k.transform.skewX - turn, skewY: k.transform.skewY - turn } };
  });
  const first = keys.find((k) => k.frame === 0)!;
  keys.push({ ...first, frame: seam, transform: { ...first.transform, skewX: first.transform.skewX + turn, skewY: first.transform.skewY + turn } });
  return { ...track, keys: sorted(keys), endFrame: Math.max(track.endFrame, seam) };
}

/** Each row's offset: `step` for every row, or with `stagger` the step times
 *  the row's place, so the first row stays and each next one lags more. */
export function offsetPlan(rows: readonly NodeId[], step: number, stagger: boolean): Map<NodeId, number> {
  return new Map(rows.map((id, i) => [id, stagger ? step * i : step]));
}
