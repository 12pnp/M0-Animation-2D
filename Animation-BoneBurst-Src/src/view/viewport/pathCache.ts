import type { Pose } from "@/core/doc/pose";
import type { Animation, Project, SymbolItem } from "@/core/doc/types";
import { posedSymbol } from "@/core/boneburst/boneburstPose";

export type PathSampler = (frame: number, force?: boolean) => Pose | null;

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

  /** A sampler for `bonePaths`, valid for one draw. Past its budget a frame
   *  with no pose at all comes back null (left out of the path until a later
   *  draw), unless `force`d: a big rig's first look at a long animation is
   *  spread over several draws instead of freezing the stage. */
  sampler(
    project: Project, sym: SymbolItem, anim: Animation, revision: number, now: () => number = () => performance.now(),
  ): PathSampler {
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
    return (frame, force = false) => {
      const hit = this.fresh.get(frame);
      if (hit) return hit;
      const old = this.stale.get(frame);
      if (!force && now() > until) {
        this.pending = true;
        return old ?? null;
      }
      const pose = posedSymbol(project, sym, anim, frame, "animate");
      this.fresh.set(frame, pose);
      this.stale.delete(frame);
      return pose;
    };
  }
}
