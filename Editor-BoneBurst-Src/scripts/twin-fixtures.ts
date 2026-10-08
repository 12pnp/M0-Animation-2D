/**
 * Fixtures for BoneBurst's C# TwinSpline maths (docs/UNITY-EXPORT-PLAN.md; BoneBurst-ECS-P16-TwinSpline-Plan.md, step 1): several paths and what
 * this editor's own `src/motion/` says about them: the point at a few hundred times, where each node is reached, the curve's length. The C#
 * (`TwinSplineBake` and `TwinSplineMath`, in the core package) must give the same within 1e-4.
 *
 * Run: npx vite-node scripts/twin-fixtures.ts <output .json>
 */
import { writeFileSync } from "node:fs";
import { arrivalTimes, curveOf, nodeProgress, pathPose, speedAt } from "../src/motion";
import type { MotionPath } from "../src/model/sidecar";

const path = (name: string, nodes: MotionPath["nodes"], closed: boolean, duration: number): { name: string; m: MotionPath } =>
  ({ name, m: { animation: "a", bone: "b", nodes, closed, duration, loop: true } });

const CASES = [
  path("ring4-even", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], true, 1),
  path("ring4-speeds", [{ x: 0, y: 0, speed: 1.5 }, { x: 100, y: 20, speed: -0.5 }, { x: 80, y: 120, speed: 3 }, { x: -20, y: 90, speed: 0 }], true, 0.8),
  path("open3-handles", [{ x: 0, y: 0, tx: 30, ty: 40 }, { x: 80, y: 10, tx: 20, ty: -30, speed: 2 }, { x: 150, y: 60 }], false, 1.2),
  path("open2-straight", [{ x: 10, y: 5 }, { x: 110, y: 85 }], false, 0.5),
  path("ring2-lens", [{ x: 0, y: 0 }, { x: 60, y: 0 }], true, 0.6),
  path("ring3-broken-legs", [{ x: 0, y: 0, ss: 4, sb: -2, speed: 1 }, { x: 70, y: 40, ss: -3, speed: 4 }, { x: 20, y: 90, ss: 1, sb: 6, speed: -0.9 }], true, 1),
  path("ring3-broken-handles", [{ x: 0, y: 0, tx: 40, ty: 0, bx: -10, by: 30 }, { x: 80, y: 60, tx: 0, ty: 40 }, { x: 20, y: 100 }], true, 0.7),
  path("open4-extremes", [{ x: 0, y: 0, speed: -0.99 }, { x: 50, y: 50, speed: 5 }, { x: 120, y: 10, speed: -0.99 }, { x: 160, y: 90, speed: 5 }], false, 2),
];

const out = CASES.map(({ name, m }) => {
  const samples: { t: number; x: number; y: number }[] = [];
  // Past both ends too: the maths holds the ends.
  for (let i = -5; i <= 305; i++) {
    const t = (m.duration * i) / 300, p = pathPose(m, t);
    samples.push({ t, x: p.x, y: p.y });
  }
  const c = curveOf(m);
  return {
    name, closed: m.closed, duration: m.duration,
    // Flat, with explicit presence flags: Unity's JsonUtility cannot tell an absent field from a zero.
    nodes: m.nodes.map((n) => ({
      x: n.x, y: n.y, speed: n.speed ?? 0,
      hasOut: n.tx !== undefined && n.ty !== undefined, tx: n.tx ?? 0, ty: n.ty ?? 0,
      hasBack: n.bx !== undefined && n.by !== undefined, bx: n.bx ?? 0, by: n.by ?? 0,
      hasSs: n.ss !== undefined, ss: n.ss ?? 0, hasSb: n.sb !== undefined, sb: n.sb ?? 0,
    })),
    length: c.length, nodeProgress: nodeProgress(m), arrivals: arrivalTimes(m),
    speeds: Array.from({ length: 21 }, (_, k) => speedAt(m, k / 20)),
    samples,
  };
});
const file = process.argv[2];
if (!file) throw new Error("Give the output file: npx vite-node scripts/twin-fixtures.ts <output .json>");
writeFileSync(file, JSON.stringify({ format: "twinspline-fixtures", version: 1, cases: out }, null, 1));
console.log(`${out.length} paths, ${out.reduce((n, c) => n + c.samples.length, 0)} samples -> ${file}`);
