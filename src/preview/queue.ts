/**
 * The Preview's animation queue (ARCHITECTURE ▸ Events), pure: what
 * `AnimationState` is told to play. The first animation is set; each next one
 * is added to crossfade in over its mix, the fade ending as the previous ends. Only the
 * last can loop: an earlier one that looped would never end.
 */

export interface QueueEntry {
  name: string;
  /** Seconds of crossfade into it from the previous one. */
  mix: number;
}

export interface QueueStep {
  name: string;
  mix: number;
  loop: boolean;
}

/** The steps for `entries`: animations the skeleton lacks left out, the first
 *  with no mix, mixes finite and at least 0, the last looping when `loop`. */
export function queueSteps(entries: readonly QueueEntry[], animations: readonly string[], loop: boolean): QueueStep[] {
  const known = new Set(animations);
  const kept = entries.filter((e) => known.has(e.name));
  return kept.map((e, i) => ({
    name: e.name,
    mix: i === 0 || !Number.isFinite(e.mix) ? 0 : Math.max(0, e.mix),
    loop: loop && i === kept.length - 1,
  }));
}
