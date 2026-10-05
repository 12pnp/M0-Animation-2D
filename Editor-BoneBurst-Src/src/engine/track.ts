import type { EventFire } from "./rigTypes";
import type { AnimationData, Timeline } from "./rigTypes";
import type { Blend, Rig } from "./rig";

/** One step of a queue: an animation, crossfaded in over `mix` seconds. */
export interface TrackStep { anim: AnimationData; loop: boolean; mix: number }

/**
 * How a timeline mixes, as flags (spine-core 4.3's timeline modes, read off
 * its `timelineMode`): first to set the property (mix from the setup pose) or
 * subsequent (mix from the current value), and, while its entry mixes out,
 * held at full strength when the incoming animation sets the property too.
 * 4.2 never held a subsequent timeline; 4.3 does.
 */
const FIRST = 1, SUBSEQUENT = 2, HOLD = 4;

interface Entry {
  anim: AnimationData;
  loop: boolean;
  /** Seconds the entry has run. */
  trackTime: number;
  /** `trackTime` and the animation time at the last pose, -1 before it. */
  trackLast: number;
  nextTrackLast: number;
  animationLast: number;
  nextAnimationLast: number;
  /** Seconds the crossfade into it takes, and has run. */
  mixDuration: number;
  mixTime: number;
  /** When the queue starts it: its mix before the previous entry ends. */
  delay: number;
  mixingFrom: Entry | null;
  mixingTo: Entry | null;
  /** The summed alpha of its timelines at its last pose while mixing out. */
  totalAlpha: number;
  /** Per unit (one of the file's timelines): its mode flags. */
  mode: number[];
  holdMix: Array<Entry | null>;
  /** Per unit: a rotation's total turn and last difference (`Rig.applyRotate`). */
  rotations: Float64Array | null;
}

function entry(anim: AnimationData, loop: boolean): Entry {
  return {
    anim, loop, trackTime: 0, trackLast: -1, nextTrackLast: -1, animationLast: -1, nextAnimationLast: -1,
    mixDuration: 0, mixTime: 0, delay: 0, mixingFrom: null, mixingTo: null, totalAlpha: 0,
    mode: [], holdMix: [], rotations: null,
  };
}

/**
 * The engine's one animation track (docs/SPEC.md §6),
 * DOM-free, as spine-core's `AnimationState` runs track 0: what plays, the
 * queue after it, the crossfade from what played before, time, and which
 * events fire. Playback (E3) drives it; `tests/engineOracle.test.ts` holds it to
 * `AnimationState`.
 *
 * In a crossfade the outgoing animation fades its properties back toward the
 * setup pose while the incoming one fades in; a property both key is held at
 * the outgoing value and blended straight to the incoming one. The outgoing
 * animation fires no events (spine-core's default event threshold).
 */
export class Track {
  private current: Entry | null = null;
  private queued: Entry[] = [];

  /** `anim` from its start. */
  start(anim: AnimationData, loop: boolean): void {
    this.current = entry(anim, loop);
    this.queued = [];
    this.changed();
  }

  /** `anim` at `time` seconds, as if it had just been set there. */
  seek(anim: AnimationData, time: number, loop: boolean): void {
    this.start(anim, loop);
    this.current!.trackTime = time;
  }

  /** Play the steps one after another, each crossfaded in over its mix. */
  queue(steps: TrackStep[]): void {
    if (!steps.length) return;
    this.start(steps[0]!.anim, steps[0]!.loop);
    let previous = this.current!;
    for (const step of steps.slice(1)) {
      const e = entry(step.anim, step.loop);
      e.mixDuration = step.mix;
      // It starts its mix before the previous one completes.
      e.delay = Math.max(complete(previous) - step.mix, 0);
      this.queued.push(e);
      previous = e;
    }
  }

  setLoop(on: boolean): void { if (this.current) this.current.loop = on; }

  /** Move on `dt` seconds (`AnimationState.update`). */
  advance(dt: number): void {
    const c = this.current;
    if (!c) return;
    c.animationLast = c.nextAnimationLast;
    c.trackLast = c.nextTrackLast;
    const next = this.queued[0];
    if (next) {
      // Judged on the time at the last pose: it starts a step late, at the
      // time it would have reached.
      const nextTime = c.trackLast - next.delay;
      if (nextTime >= 0) {
        this.queued.shift();
        next.delay = 0;
        next.trackTime += nextTime + dt;
        c.trackTime += dt;
        this.setCurrent(next);
        for (let e: Entry | null = next; e?.mixingFrom; e = e.mixingFrom) e.mixTime += dt;
        return;
      }
    }
    if (c.mixingFrom && this.updateMixingFrom(c, dt)) {
      const from = c.mixingFrom;
      c.mixingFrom = null;
      if (from) from.mixingTo = null;
    }
    c.trackTime += dt;
  }

  private setCurrent(e: Entry): void {
    const from = this.current;
    this.current = e;
    if (from) {
      e.mixingFrom = from;
      from.mixingTo = e;
      e.mixTime = 0;
      from.rotations = null;
    }
    this.changed();
  }

  /** True once the crossfades into `to` are done and its sources can go. */
  private updateMixingFrom(to: Entry, dt: number): boolean {
    const from = to.mixingFrom;
    if (!from) return true;
    const finished = this.updateMixingFrom(from, dt);
    from.animationLast = from.nextAnimationLast;
    from.trackLast = from.nextTrackLast;
    if (to.nextTrackLast !== -1 && to.mixTime >= to.mixDuration) {
      if (from.totalAlpha === 0 || to.mixDuration === 0) {
        to.mixingFrom = from.mixingFrom;
        if (from.mixingFrom) from.mixingFrom.mixingTo = to;
        this.changed();
      }
      return finished;
    }
    from.trackTime += dt;
    to.mixTime += dt;
    return false;
  }

  /** Each entry's modes, oldest first, from which properties later ones set
   *  (`AnimationState.computeHold`). */
  private changed(): void {
    let oldest = this.current;
    if (!oldest) return;
    while (oldest.mixingFrom) oldest = oldest.mixingFrom;
    const set = new Set<string>();
    for (let e: Entry | null = oldest; e; e = e.mixingTo) computeHold(e, set);
  }

  /** The animation time the pose shows: wrapped when looping, held at the end otherwise. */
  time(): number {
    return this.current ? animationTime(this.current) : 0;
  }

  state(): { name: string; time: number; trackTime: number; duration: number; loop: boolean } | null {
    const e = this.current;
    return e && { name: e.anim.name, time: animationTime(e), trackTime: e.trackTime, duration: e.anim.duration, loop: e.loop };
  }

  /** Pose the rig (`AnimationState.apply`) and return the events the playing
   *  animation passed since the last pose, in order. */
  apply(rig: Rig): EventFire[] {
    rig.setupPose();
    const c = this.current;
    if (!c) return [];
    let mix = 1;
    if (c.mixingFrom) mix *= this.applyMixingFrom(c, rig, "first");
    const time = animationTime(c);
    rig.applyLast = c.animationLast;
    if (mix === 1) {
      for (const t of c.anim.timelines) {
        if (t.kind === "attachment") rig.applyAttachment(t, time, "first", true);
        else rig.applyTimeline(t, time, 1, "first", false);
      }
    } else {
      const first = !c.rotations;
      if (first) c.rotations = new Float64Array(c.anim.units * 2);
      for (const t of c.anim.timelines) {
        const blend: Blend = c.mode[t.unit]! & SUBSEQUENT ? "first" : "setup";
        if (t.kind === "bone" && t.prop === "rotate") rig.applyRotate(t, time, mix, blend, c.rotations!, t.unit * 2, first);
        else if (t.kind === "attachment") rig.applyAttachment(t, time, "first", true);
        else rig.applyTimeline(t, time, mix, blend, false);
      }
    }
    rig.settleAttachments();
    const fired = firedBetween(c.anim, c.animationLast, time);
    c.nextAnimationLast = time;
    c.nextTrackLast = c.trackTime;
    return fired;
  }

  /** Pose what `to` mixes from, oldest first; how far `to` has mixed in. */
  private applyMixingFrom(to: Entry, rig: Rig, blendIn: Blend): number {
    const from = to.mixingFrom!;
    if (from.mixingFrom) this.applyMixingFrom(from, rig, blendIn);
    let mix: number, blend = blendIn;
    if (to.mixDuration === 0) {
      mix = 1;
      if (blend === "first") blend = "setup";
    } else {
      mix = Math.min(1, to.mixTime / to.mixDuration);
      if (blend !== "first") blend = "replace";
    }
    // An entry cut off while mixing in holds only as far as it has mixed in,
    // and that keeps growing (4.3; measured, where 4.2 froze it at the cut).
    const alphaHold = from.mixingFrom && from.mixDuration > 0 ? Math.min(1, from.mixTime / from.mixDuration) : 1;
    const alphaMix = alphaHold * (1 - mix);
    const time = animationTime(from);
    const first = !from.rotations;
    if (first) from.rotations = new Float64Array(from.anim.units * 2);
    from.totalAlpha = 0;
    let unit = -1;
    for (const t of from.anim.timelines) {
      const mode = from.mode[t.unit]!;
      // Draw order mixing out is left to the incoming animation.
      if (mode === SUBSEQUENT && t.kind === "drawOrder") continue;
      const tb: Blend = mode & FIRST ? "setup" : blend;
      let alpha = alphaMix;
      if (mode & HOLD) {
        const hold = from.holdMix[t.unit];
        alpha = hold ? alphaHold * Math.max(0, 1 - hold.mixTime / hold.mixDuration) : alphaHold;
      }
      // One file timeline counts once, though it may be several of ours.
      if (t.unit !== unit) { from.totalAlpha += alpha; unit = t.unit; }
      if (t.kind === "bone" && t.prop === "rotate") rig.applyRotate(t, time, alpha, tb, from.rotations!, t.unit * 2, first);
      else if (t.kind === "attachment") rig.applyAttachment(t, time, tb, false);
      else rig.applyTimeline(t, time, alpha, tb, true);
    }
    from.nextAnimationLast = time;
    from.nextTrackLast = from.trackTime;
    return mix;
  }
}

function animationTime(e: Entry): number {
  const d = e.anim.duration;
  if (e.loop) return d > 0 ? e.trackTime % d : 0;
  return Math.min(e.trackTime, d);
}

/** When an entry next completes: the end of its current loop, or its end. */
function complete(e: Entry): number {
  const d = e.anim.duration;
  if (d !== 0) {
    if (e.loop) return d * (1 + Math.floor(e.trackTime / d));
    if (e.trackTime < d) return d;
  }
  return e.trackTime;
}

const NEVER_HELD = new Set<Timeline["kind"]>(["attachment", "drawOrder", "event"]);

/**
 * An entry's mode per unit, against the properties older entries set (`set`,
 * which it adds to): a property already set mixes from the current value; one
 * the incoming animation does not key mixes from the setup pose; one it keys
 * is held, fading only as a later crossfade that does not key it fades.
 */
function computeHold(e: Entry, set: Set<string>): void {
  const to = e.mixingTo;
  e.mode = new Array(e.anim.units).fill(FIRST);
  e.holdMix = new Array(e.anim.units).fill(null);
  const seen = new Set<number>();
  for (const t of e.anim.timelines) {
    if (seen.has(t.unit)) continue;
    seen.add(t.unit);
    const fresh = t.ids.some((id) => !set.has(id));
    for (const id of t.ids) set.add(id);
    let mode = fresh ? FIRST : SUBSEQUENT;
    if (to && !NEVER_HELD.has(t.kind) && t.ids.some((id) => to.anim.ids.has(id))) {
      mode |= HOLD;
      for (let next = to.mixingTo; next; next = next.mixingTo) {
        if (t.ids.some((id) => next!.anim.ids.has(id))) continue;
        if (next.mixDuration > 0) e.holdMix[t.unit] = next;
        break;
      }
    }
    e.mode[t.unit] = mode;
  }
}

/**
 * The events an animation fires going from `last` to `time`: keys after
 * `last` up to and including `time`, every key from the start when `last` is
 * -1, and across the end when `time` wrapped round below `last`.
 */
function firedBetween(anim: AnimationData, last: number, time: number): EventFire[] {
  const out: EventFire[] = [];
  for (const t of anim.timelines) {
    if (t.kind !== "event") continue;
    const fire = (from: number, to: number) => {
      t.times.forEach((at, i) => { if (at > from && at <= to) out.push(t.events[i]!); });
    };
    if (last > time) {
      fire(last, Infinity);
      fire(-1, time);
    } else fire(last, time);
  }
  return out;
}
