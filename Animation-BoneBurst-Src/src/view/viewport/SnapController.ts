import type { Store } from "@/app/Store";
import type { NodeId } from "@/core/doc/ids";
import { withDescendants } from "@/core/doc/layerTree";
import type { FrameContext, Pose } from "@/core/doc/pose";
import { apply, invert, mat } from "@/core/math/Matrix2D";
import { type SnapLine, snapMove, snapPoint, type SnapTargets, snapValue } from "@/core/math/snap";
import type { Camera } from "./Camera";
import type { Guide } from "./Overlay";
import { collectSnapTargets, selectionRefs } from "./snapTargets";

/** What snapping reads off the stage, at the moment it asks. */
export interface SnapStage {
  readonly store: Store;
  readonly camera: Camera;
  pose(): Pose | null;
  guides(): readonly Guide[];
  frameContext(): FrameContext;
  /** The bone paths last drawn, for a dragged path dot to snap to the others. */
  bonePath(id: NodeId): ReadonlyArray<{ frame: number; x: number; y: number }> | undefined;
}

/**
 * Snapping on the stage: a drag's delta, a bone path's dot and a guide land
 * on grid lines, guides, the stage or other objects. The arithmetic happens
 * in SCENE space, the frame the grid, the guides and the stage rectangle live
 * in, so values go in through `camera.base` and back out through its inverse:
 * inside an edited symbol that base carries the instance's own scale and
 * rotation, and snapping without the round trip would land on the wrong lines.
 */
export class SnapController {
  /** Smart guides for the snap the drag in progress is holding. */
  lines: SnapLine[] = [];
  /**
   * What the drag in progress snaps FROM and TO, captured when it started.
   *
   * A tool's delta is measured from the pointer-down position and applied to
   * the snapshot it took there, so the reference points have to come from
   * that same moment: taken from the live pose they would already include
   * the move, and every frame would add the correction again. The targets are
   * captured with them — nothing else moves during a drag, so this is also
   * one bounds walk per drag instead of one per pointer event.
   */
  private session: { refs: { xs: number[]; ys: number[] }; targets: SnapTargets } | null = null;
  /** What a bone path's dot snaps to while it is dragged: built at its first step. */
  private dot: { key: string; targets: SnapTargets; points: Array<{ x: number; y: number }> } | null = null;

  constructor(private readonly stage: SnapStage) {}

  /** A drag of `moving` starts: capture what it snaps from and to. */
  begin(moving: Iterable<string>): void {
    const { store, camera } = this.stage;
    const sp = store.prefs.value.snap;
    const pose = this.stage.pose();
    this.lines = [];
    this.session = null;
    if (!store.ui.snap || !sp.enabled || !pose) return;

    const base = camera.base;
    // What moves with the drag, children included: they are the selection's
    // edges (a group or a bone has no artwork of its own) and must not be
    // targets, or the drag catches on where its own contents started.
    const ids = new Set(withDescendants(store.currentSymbol, [...moving] as NodeId[]));
    const when = this.stage.frameContext();
    const refs = selectionRefs(store.project, pose, base, ids, when);
    if (refs.xs.length === 0) return;
    this.session = {
      refs,
      targets: collectSnapTargets(store.project, store.currentSymbol, pose, base, this.stage.guides(), ids, when, sp),
    };
  }

  /** A tool's world-space drag delta, corrected so the selection lands on a line. */
  delta(dx: number, dy: number, free = false): { dx: number; dy: number } {
    const session = this.session;
    if (free || !session) {
      this.lines = [];
      return { dx, dy };
    }
    const { store, camera } = this.stage;
    const prefs = store.prefs.value;
    const sp = prefs.snap;
    const base = camera.base;
    const inv = mat();
    if (!invert(inv, base)) { this.lines = []; return { dx, dy }; }

    const res = snapMove(
      session.refs.xs, session.refs.ys,
      base.a * dx + base.c * dy, base.b * dx + base.d * dy,
      session.targets, {
        grid: sp.toGrid ? prefs.stage.gridSize : null,
        pixel: sp.toPixel,
        // Screen pixels -> scene units: the tolerance must feel the same at
        // every zoom, which is what makes it usable at 800%.
        tolerance: sp.tolerancePx / camera.zoom,
      });

    this.lines = sp.showLines ? res.lines : [];
    return {
      dx: inv.a * res.dx + inv.c * res.dy,
      dy: inv.b * res.dx + inv.d * res.dy,
    };
  }

  /** The drag ended. */
  end(): void {
    this.session = null;
    this.dot = null;
    this.lines = [];
  }

  /** A bone path's dot at `world`, snapped (`ToolContext.snapDot`). */
  snapDot(world: { x: number; y: number }, boneId: NodeId, frame: number, free = false): { x: number; y: number } {
    const { store, camera } = this.stage;
    const prefs = store.prefs.value;
    const sp = prefs.snap;
    const pose = this.stage.pose();
    const base = camera.base;
    const inv = mat();
    if (free || !store.ui.snap || !sp.enabled || !pose || !invert(inv, base)) { this.lines = []; return world; }
    const key = `${boneId}#${frame}`;
    if (this.dot?.key !== key) {
      // The bone and what it carries move with the drag: never targets.
      const ids = new Set(withDescendants(store.currentSymbol, [boneId]));
      const points = (this.stage.bonePath(boneId) ?? []).filter((p) => p.frame !== frame).map((p) => apply({ x: 0, y: 0 }, base, p.x, p.y));
      this.dot = { key, targets: collectSnapTargets(store.project, store.currentSymbol, pose, base, this.stage.guides(), ids, this.stage.frameContext(), sp), points };
    }
    const at = apply({ x: 0, y: 0 }, base, world.x, world.y);
    const r = snapPoint(at.x, at.y, this.dot.points, this.dot.targets, {
      grid: sp.toGrid ? prefs.stage.gridSize : null, pixel: false, tolerance: sp.tolerancePx / camera.zoom,
    });
    this.lines = sp.showLines ? r.lines : [];
    return apply({ x: 0, y: 0 }, inv, r.x, r.y);
  }

  /** A guide dragged out of a ruler snaps to the same lines everything else
   *  does — otherwise the one thing meant to be a precise reference is the
   *  one thing placed by eye. `exclude`: the guide being moved. */
  snapGuide(axis: "x" | "y", at: number, exclude = -1): number {
    const { store, camera } = this.stage;
    const prefs = store.prefs.value;
    const sp = prefs.snap;
    const pose = this.stage.pose();
    if (!store.ui.snap || !sp.enabled || !pose) return Math.round(at);
    const guides = this.stage.guides();
    const others = exclude < 0 ? guides : guides.filter((_, i) => i !== exclude);
    const targets = collectSnapTargets(store.project, store.currentSymbol, pose, camera.base, others, new Set(), this.stage.frameContext(), sp);
    return snapValue(at, axis === "x" ? targets.xs : targets.ys, {
      grid: sp.toGrid ? prefs.stage.gridSize : null,
      pixel: true,
      tolerance: sp.tolerancePx / camera.zoom,
    });
  }
}
