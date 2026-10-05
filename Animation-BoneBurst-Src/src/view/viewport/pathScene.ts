import { bonePaths, type BonePath, keyedIn, parentSpace, type PathPointKind, pathPoint } from "@/core/doc/bonePath";
import { seamFrame } from "@/core/doc/cycle";
import type { NodeId } from "@/core/doc/ids";
import { pathDragMode } from "@/core/doc/pathEdit";
import { fitCubic, type PathHandle, splineSegments } from "@/core/doc/pathSpline";
import type { Animation, SymbolItem } from "@/core/doc/types";
import type { PathSampler } from "./pathCache";

/**
 * What the stage and the Path panel draw for bone paths: the paths, and the
 * handles of the one bone `handlesFor` (ARCHITECTURE ▸ Bone paths). A bone
 * that moves gets spline handles (its keys' x and y eases), one that turns
 * gets handles fitted to the arc its tip draws, which bake when dragged.
 * With `relativeAt` everything is relative to each bone's parent, drawn in
 * the parent's pose at that frame.
 */
export function pathScene(args: {
  sym: SymbolItem;
  anim: Animation;
  sample: PathSampler;
  ids: readonly NodeId[];
  frames: readonly number[];
  closed: boolean;
  which: PathPointKind;
  relativeAt?: number;
  handlesFor: NodeId | null;
}): { paths: BonePath[]; handles: PathHandle[] } {
  const { sym, anim, sample, frames, which, relativeAt } = args;
  // The parent's pose the paths are drawn in, whatever the budget.
  if (relativeAt !== undefined) sample(relativeAt, true);
  const paths = bonePaths({ sample, ids: args.ids, frames, closed: args.closed, which, isKey: keyedIn(anim), relativeAt });

  const handles: PathHandle[] = [];
  const one = args.handlesFor;
  const node = one ? sym.nodes[one] : undefined;
  if (!one || !node || !args.ids.includes(one)) return { paths, handles };
  const rule = pathDragMode(sym, anim, one, which, node.pathDrag === "parent");
  // A bone the IK solves: its own keys do not shape its path.
  if (!("mode" in rule) || rule.mode === "throughTarget") return { paths, handles };
  const space = relativeAt === undefined ? null : parentSpace(sample, one, relativeAt);
  const rel = space ? { relativeAt } : {};
  const shownFrames = new Set(frames);
  const join = seamFrame(anim);
  const shownAt = (f: number) => {
    const p = pathPoint(sample(f, true)!, one, which);
    return p && space ? space.shown(f, p) : p;
  };

  for (const seg of splineSegments(anim.tracks[one])) {
    if (!shownFrames.has(seg.from) || !shownFrames.has(seg.to === join ? 0 : seg.to)) continue;
    if (rule.mode === "translate") {
      const hang = (f: number, dx: number, dy: number, end: "out" | "in") => {
        const anchor = shownAt(f);
        if (!anchor) return;
        const parent = node.parentId ? sample(f, true)!.byNode.get(node.parentId)?.world : undefined;
        const m = space ? space.at : parent ?? { a: 1, b: 0, c: 0, d: 1 };
        handles.push({
          from: seg.from, to: seg.to, end, anchorX: anchor.x, anchorY: anchor.y,
          x: anchor.x + m.a * dx + m.c * dy, y: anchor.y + m.b * dx + m.d * dy,
          lin: { a: m.a, b: m.b, c: m.c, d: m.d }, ...rel,
        });
      };
      const s = seg.spline;
      hang(seg.from, s.p1.x - s.p0.x, s.p1.y - s.p0.y, "out");
      hang(seg.to, s.p2.x - s.p3.x, s.p2.y - s.p3.y, "in");
      continue;
    }
    // A bone that turns: a one-frame interval has no frame inside it to bake.
    const span = seg.to - seg.from;
    if (span < 2) continue;
    const p0 = shownAt(seg.from), p3 = shownAt(seg.to);
    if (!p0 || !p3) continue;
    const samples = Array.from({ length: span - 1 }, (_, i) => {
      const f = seg.from + i + 1;
      return { t: (f - seg.from) / span, p: shownAt(f)! };
    });
    const s = fitCubic(p0, p3, samples);
    handles.push({ from: seg.from, to: seg.to, end: "out", x: s.p1.x, y: s.p1.y, anchorX: s.p0.x, anchorY: s.p0.y, bake: s, ...rel });
    handles.push({ from: seg.from, to: seg.to, end: "in", x: s.p2.x, y: s.p2.y, anchorX: s.p3.x, anchorY: s.p3.y, bake: s, ...rel });
  }
  return { paths, handles };
}
