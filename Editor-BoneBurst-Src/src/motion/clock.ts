/**
 * The path's own clock (docs/TWO-SYSTEMS-PLAN.md): a time in seconds over the run's `duration`, playing or not, looping or not. It reads no
 * animation and no frame; whoever owns a timer calls `advance` with the seconds that passed.
 */
export class PathClock {
  time = 0;
  playing = false;
  loop = true;

  constructor(loop = true) {
    this.loop = loop;
  }

  /** The clock put at `t`, held to the run. */
  seek(t: number, duration: number): void {
    this.time = Math.min(duration, Math.max(0, t));
  }

  /** `dt` seconds go by while playing: at the end a looping clock starts over, any other stops there. Returns true when the clock stopped. */
  advance(dt: number, duration: number): boolean {
    if (!this.playing || !(dt > 0) || !(duration > 0)) return false;
    const next = this.time + dt;
    if (next < duration) { this.time = next; return false; }
    if (this.loop) { this.time = next % duration; return false; }
    this.time = duration;
    this.playing = false;
    return true;
  }
}
