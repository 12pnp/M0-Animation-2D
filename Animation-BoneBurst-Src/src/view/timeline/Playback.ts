import type { Store } from "@/app/Store";
import { playStep, type PlayState } from "./playStep";

/**
 * Real-time playback of the current animation.
 *
 * Time is accumulated in seconds and converted to frames rather than adding
 * one frame per animation frame: at 24fps on a 120Hz display the naive
 * version plays five times too fast, and on a busy frame it stutters. The
 * playhead is fractional and redrawn `timeline.playRate` times a second
 * (`playStep`), so the stage moves between frames.
 */
export class Playback {
  private raf = 0;
  private lastTime = 0;
  private state: PlayState = { pos: 0, sinceDraw: 0, loopsDone: 0 };
  /** The frame this last put the playhead on: anything else moved it since. */
  private shown = 0;

  constructor(
    private readonly store: Store,
    private readonly onFrame: (frame: number) => void,
  ) {}

  get playing(): boolean { return this.store.ui.playing; }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  play(): void {
    if (this.playing) return;
    const anim = this.store.currentAnimation;
    if (!anim) return;
    // Restarting from the end is what a play button should do.
    if (this.store.ui.frame >= this.store.maxFrame) this.store.setFrame(0);
    this.state = { pos: this.store.ui.frame, sinceDraw: 0, loopsDone: 0 };
    this.shown = this.store.ui.frame;
    this.lastTime = performance.now();
    this.store.setUi({ playing: true }, "playback");
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.playing) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.store.setUi({ playing: false }, "playback");
    // Rest on the whole frame the timeline shows.
    this.store.setFrame(this.store.ui.frame);
  }

  stop(): void {
    this.pause();
    this.store.setFrame(0);
  }

  /**
   * Step the playhead. Stepping forward stops at the end of the animation:
   * the playhead may be PARKED past it (that is how the empty frames are
   * given content) but an arrow key held down should not wander off into
   * them. A playhead already out there keeps its position rather than being
   * yanked back.
   */
  stepBy(delta: number): void {
    this.pause();
    const frame = this.store.ui.frame;
    const limit = Math.max(this.store.maxFrame, frame);
    this.store.setFrame(Math.min(frame + delta, limit));
  }

  toStart(): void { this.pause(); this.store.setFrame(0); }
  toEnd(): void { this.pause(); this.store.setFrame(this.store.maxFrame); }

  private tick = (now: number): void => {
    if (!this.playing) return;
    const anim = this.store.currentAnimation;
    if (!anim) { this.pause(); return; }

    // Scheduled before any listener runs. A throw further down — a panel
    // failing mid-update — used to end the rAF chain while `ui.playing`
    // stayed true: the playhead froze and the transport still showed Pause.
    // `pause()` cancels this very request, so stopping below still works.
    this.raf = requestAnimationFrame(this.tick);

    const dt = Math.min(0.25, (now - this.lastTime) / 1000);   // clamp after a stall
    this.lastTime = now;
    // A scrub while playing carries on from where it left the playhead.
    if (this.store.ui.frame !== this.shown) this.state = { ...this.state, pos: this.store.ui.frame };
    const last = this.store.maxFrame;
    const t = this.store.prefs.value.timeline;
    const step = playStep(this.state, dt, {
      fps: this.store.project.frameRate, speed: t.playSpeed, rate: t.playRate, last,
      // Spine's timing (`endsAtLastFrame`): the last frame IS the next
      // loop's first, so a loop wraps onto 0 there instead of showing both.
      period: anim.endsAtLastFrame && last > 0 ? last : last + 1,
      loops: (done) => (this.store.ui.loop && anim.playTimes === 0) || (anim.playTimes > 0 && done + 1 < anim.playTimes),
    });
    this.state = step.state;
    if (step.kind === "wait") return;
    const before = this.store.ui.frame;
    if (step.kind === "end") {
      this.store.setFrame(last);
      this.onFrame(last);
      this.pause();
      return;
    }
    this.store.setPlayhead(step.state.pos);
    this.shown = this.store.ui.frame;
    if (this.shown !== before) this.onFrame(this.shown);
  };

  dispose(): void { cancelAnimationFrame(this.raf); }
}
