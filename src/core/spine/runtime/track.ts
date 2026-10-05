import type { AnimationData, EventFire } from "./rigData";
import type { Rig } from "./rig";

/** One step of a queue: an animation, crossfaded in over `mix` seconds. */
export interface TrackStep { anim: AnimationData; loop: boolean; mix: number }

interface Entry {
  anim: AnimationData;
  loop: boolean;
  /** Seconds the entry has run. */
  trackTime: number;
  /** The animation time posed last, or -1 before the first pose: events
   *  fire for keys after it, up to and including the new time. */
  last: number;
}

/**
 * The BoneBurst runtime's one animation track (docs/PREVIEW-RUNTIME-PLAN.md),
 * DOM-free: what plays, the queue after it, time, and which events fire.
 * The preview's `boneburstRig` drives it; `tests/runtimeTrack.test.ts` holds
 * it to spine-core's `AnimationState`.
 *
 * A queued animation starts its mix before the current one ends, as
 * spine-core's does, but cuts instead of crossfading (not yet in the
 * runtime), and the one it replaces fires no more events, as spine-core's
 * outgoing animation fires none with the default event threshold.
 */
export class Track {
  private entry: Entry | null = null;
  private rest: TrackStep[] = [];

  /** `anim` from its start. */
  start(anim: AnimationData, loop: boolean): void {
    this.entry = { anim, loop, trackTime: 0, last: -1 };
    this.rest = [];
  }

  /** `anim` at `time` seconds, as if it had just been set there. */
  seek(anim: AnimationData, time: number, loop: boolean): void {
    this.entry = { anim, loop, trackTime: time, last: -1 };
    this.rest = [];
  }

  /** Play the steps one after another. */
  queue(steps: TrackStep[]): void {
    if (!steps.length) return;
    this.start(steps[0]!.anim, steps[0]!.loop);
    this.rest = steps.slice(1);
  }

  setLoop(on: boolean): void { if (this.entry) this.entry.loop = on; }

  /**
   * Move on `dt` seconds. The next queued step takes over its mix before the
   * current one's end, judged on the time BEFORE this step, as spine-core
   * does: it starts a step late, at the time it would have reached.
   */
  advance(dt: number): void {
    const e = this.entry;
    if (!e) return;
    const before = e.trackTime;
    e.trackTime += dt;
    const next = this.rest[0];
    if (!next) return;
    const at = Math.max(0, e.anim.duration - next.mix);
    if (before < at) return;
    this.rest.shift();
    this.entry = { anim: next.anim, loop: next.loop, trackTime: before - at + dt, last: -1 };
  }

  /** The animation time the pose shows: wrapped when looping, held at the end otherwise. */
  time(): number {
    const e = this.entry;
    if (!e) return 0;
    const d = e.anim.duration;
    if (e.loop) return d > 0 ? e.trackTime % d : 0;
    return Math.min(e.trackTime, d);
  }

  state(): { name: string; time: number; trackTime: number; duration: number; loop: boolean } | null {
    const e = this.entry;
    return e && { name: e.anim.name, time: this.time(), trackTime: e.trackTime, duration: e.anim.duration, loop: e.loop };
  }

  /** Pose the rig at the track's time, and return the events passed since
   *  the last pose, in order. */
  apply(rig: Rig): EventFire[] {
    rig.setupPose();
    const e = this.entry;
    if (!e) return [];
    const time = this.time();
    rig.apply(e.anim, time, false);
    const fired = firedBetween(e.anim, e.last, time);
    e.last = time;
    return fired;
  }
}

/**
 * The events an animation fires going from `last` to `time`: keys after
 * `last` up to and including `time`, every key from the start when `last` is
 * -1, and across the end when `time` wrapped round below `last`.
 */
export function firedBetween(anim: AnimationData, last: number, time: number): EventFire[] {
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
