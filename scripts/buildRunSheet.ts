/**
 * Writes `tests/fixtures/references/stickman-run.png`: a stick figure running
 * to the right, 24 frames (one cycle, two strides) in a 6 × 4 sheet of
 * 200 × 240 cells, drawn here rather than rendered from the rig, so it tests
 * the Reference panel and the AI on art that comes from outside. Near limbs
 * dark, far limbs light. The gait is the motion library's run
 * (`scripts/buildMotions.ts`), so a fitted rig can match it.
 *
 * Run: npx vite-node scripts/buildRunSheet.ts
 * Add it in the Reference panel: 6 columns, 4 rows, 24 frames, each image 1 frame.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { capsule, circle, encodePng, Raster, type Sdf } from "./stickmanArt";

const COLS = 6, ROWS = 4, FRAMES = 24, CW = 200, CH = 240, GROUND = 228;
const THIGH = 48, SHIN = 46, TORSO = 58, NECK = 9, HEAD = 15, UPPER = 36, FORE = 34, FOOT = 15;
const NEAR = "#2f4a72", FAR = "#93a7c4", BODY = "#3d5a80", EDGE = "#1d2c44", SKIN = "#e8b48a", SKIN_EDGE = "#a8734b";

const DEG = Math.PI / 180;
const pos = (v: number) => Math.max(0, v);
/** A point `len` along world angle `deg` (y up) from `from`, in raster space (y down). */
const along = (from: [number, number], deg: number, len: number): [number, number] =>
  [from[0] + len * Math.cos(deg * DEG), from[1] - len * Math.sin(deg * DEG)];

interface Limb { a: [number, number]; b: [number, number]; c: [number, number]; d?: [number, number] }

/** The run at phase p (0..2π): the motion library's gait, facing right. */
function pose(p: number) {
  const leg = (q: number, hip: [number, number]): Limb => {
    const thigh = -90 + 38 * Math.sin(q);
    const shin = thigh - (22 + 85 * pos(Math.cos(q)) ** 1.3);
    const knee = along(hip, thigh, THIGH), ankle = along(knee, shin, SHIN);
    return { a: hip, b: knee, c: ankle, d: along(ankle, -25 * pos(Math.cos(q)), FOOT) };
  };
  const arm = (q: number, shoulder: [number, number]): Limb => {
    const upper = -90 + 40 * Math.sin(q + Math.PI);
    const elbow = along(shoulder, upper, UPPER);
    return { a: shoulder, b: elbow, c: along(elbow, upper + 75 + 15 * pos(Math.sin(q + Math.PI)), FORE) };
  };
  const build = (hip: [number, number]) => {
    const torso = 78 + 2 * Math.sin(2 * p);
    const neck = along(hip, torso, TORSO);
    const shoulder = along(hip, torso, TORSO - 6);
    return {
      hip, neck, head: along(neck, torso + 4, NECK + HEAD),
      legs: [leg(p, hip), leg(p + Math.PI, hip)], arms: [arm(p, shoulder), arm(p + Math.PI, shoulder)],
    };
  };
  // Stand the lowest foot on the ground, then lift by the flight.
  const first = build([CW / 2, 100]);
  const lowest = Math.max(...first.legs.flatMap((l) => [l.c[1], l.d![1]]));
  const lift = 0.07 * (THIGH + SHIN) * pos(Math.sin(2 * p));
  return build([CW / 2, 100 + (GROUND - 4 - lowest) - lift]);
}

function drawLimb(r: Raster, l: Limb, colour: string): void {
  const seg = (a: [number, number], b: [number, number], w: number) => (rr: number): Sdf => capsule(a[0], a[1], b[0], b[1], rr * w);
  r.fillOutlined(seg(l.a, l.b, 1), 6.5, colour, EDGE);
  r.fillOutlined(seg(l.b, l.c, 0.9), 6.5, colour, EDGE);
  if (l.d) r.fillOutlined(seg(l.c, l.d, 0.8), 6.5, EDGE, EDGE);
}

const sheet = new Raster(COLS * CW, ROWS * CH);
for (let f = 0; f < FRAMES; f++) {
  const cell = new Raster(CW, CH);
  const s = pose((2 * Math.PI * f) / FRAMES);
  // Back to front: far arm and leg, torso, head, near leg and arm.
  drawLimb(cell, s.arms[1]!, FAR);
  drawLimb(cell, s.legs[1]!, FAR);
  cell.fillOutlined((rr) => capsule(s.hip[0], s.hip[1], s.neck[0], s.neck[1], rr + 2), 7, BODY, EDGE);
  cell.fillOutlined(circle(s.head[0], s.head[1]), HEAD, SKIN, SKIN_EDGE);
  drawLimb(cell, s.legs[0]!, NEAR);
  drawLimb(cell, s.arms[0]!, NEAR);
  const ox = (f % COLS) * CW, oy = Math.floor(f / COLS) * CH;
  for (let y = 0; y < CH; y++) sheet.data.set(cell.data.subarray(y * CW * 4, (y + 1) * CW * 4), ((oy + y) * sheet.w + ox) * 4);
}

const out = fileURLToPath(new URL("../tests/fixtures/references/stickman-run.png", import.meta.url));
writeFileSync(out, encodePng(sheet));
console.log(`${FRAMES} frames, ${COLS}×${ROWS} cells of ${CW}×${CH} → ${out}`);
