/**
 * One step of the playhead (`Playback`), as a decision: where it is after
 * `dt` seconds, and whether a frame is due on screen.
 *
 * The position is fractional: at 60 or 120 redraws a second the stage poses
 * between the animation's frames (spine-core and the editor's own tweens
 * both take a fractional frame). `rate` caps the redraws, so the display's
 * own 120 Hz does not cost twice the posing of a 60 Hz choice.
 */
export const PLAY_RATES = [30, 60, 120] as const;
export type PlayRate = (typeof PLAY_RATES)[number];

export interface PlayState {
  /** Playhead, in frames, fractional. */
  pos: number;
  /** Seconds since the last redraw. */
  sinceDraw: number;
  loopsDone: number;
}

export interface PlayClock {
  fps: number;
  speed: number;
  rate: number;
  /** The last frame (`maxFrame`), and the frame a loop wraps at. */
  last: number;
  period: number;
  /** Wraps at `period` (Loop on and an endless animation, or more plays to go). */
  loops: (loopsDone: number) => boolean;
}

export type PlayStepResult =
  | { kind: "wait"; state: PlayState }
  | { kind: "draw"; state: PlayState }
  | { kind: "end"; state: PlayState };

/** rAF times jitter by a millisecond or two around the display's period. */
const SLACK = 0.002;

export function playStep(s: PlayState, dt: number, c: PlayClock): PlayStepResult {
  let pos = s.pos + dt * c.fps * c.speed;
  let loopsDone = s.loopsDone;
  const sinceDraw = s.sinceDraw + dt;
  if (pos >= c.period) {
    if (c.loops(loopsDone)) {
      loopsDone += Math.floor(pos / c.period);
      pos %= c.period;
    } else if (pos > c.last) {
      return { kind: "end", state: { pos: c.last, sinceDraw: 0, loopsDone } };
    }
  }
  if (sinceDraw < 1 / c.rate - SLACK) return { kind: "wait", state: { pos, sinceDraw, loopsDone } };
  return { kind: "draw", state: { pos, sinceDraw: 0, loopsDone } };
}
