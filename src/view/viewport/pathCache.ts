import type { Pose } from "@/core/doc/pose";
import type { Animation, Project, SymbolItem } from "@/core/doc/types";
import { posedSymbol } from "@/core/spine/spinePose";

/**
 * Posed frames for the bone paths (`core/doc/bonePath.ts`), kept between
 * draws. A playhead move only changes which dot is filled, so it reuses every
 * pose; an edit makes them stale.
 *
 * Posing every frame of a long animation on each step of a drag would stall
 * the stage, so a draw poses only what fits in `budgetMs` and the rest comes
 * from the previous revision until the next draw catches up: the path lags
 * an edit by a frame or two instead of the drag stuttering. `pending` says
 * whether another draw is needed.
 */
export class PathCache {
  private key = "";
  private revision = -1;
  private fresh = new Map<number, Pose>();
  private stale = new Map<number, Pose>();
  pending = false;

  constructor(private readonly budgetMs = 6) {}

  /** A sampler for `bonePaths`, valid for one draw. */
  sampler(
    project: Project, sym: SymbolItem, anim: Animation, revision: number, now: () => number = () => performance.now(),
  ): (frame: number) => Pose {
    const key = `${sym.id}|${anim.id}`;
    if (key !== this.key) {
      this.key = key;
      this.fresh = new Map();
      this.stale = new Map();
    } else if (revision !== this.revision) {
      // Keep the newest pose of every frame for the frames not redone yet.
      for (const [f, p] of this.fresh) this.stale.set(f, p);
      this.fresh = new Map();
    }
    this.revision = revision;
    this.pending = false;
    const until = now() + this.budgetMs;
    return (frame) => {
      const hit = this.fresh.get(frame);
      if (hit) return hit;
      const old = this.stale.get(frame);
      if (old && now() > until) {
        this.pending = true;
        return old;
      }
      const pose = posedSymbol(project, sym, anim, frame, "animate");
      this.fresh.set(frame, pose);
      this.stale.delete(frame);
      return pose;
    };
  }
}
