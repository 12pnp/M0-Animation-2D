/**
 * Where the BoneBurst Editor puts the bones of a TwinSpline export (BoneBurst-ECS-P16-TwinSpline-Plan.md, step 5): the export is read back
 * (`name.json` with the translate timelines of the path bones removed, `name.atlas.txt`, `name.twinspline.json`), the paths become
 * motion paths, and at a few frames of each animation the editor's own engine poses the rig with the paths driving their bones exactly
 * as the Stage does (`pathDrive`, then a second pose with the driven locals). The world place of every path bone is written; BoneBurst's
 * ECS tests play the same files and compare.
 *
 * A path relative to a bone other than the bone's own parent is left out, and so is its whole animation (BoneBurst sets those aside).
 *
 * Run: npx vite-node scripts/twin-e2e-fixture.ts <export folder> <name> <output .json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atlasImages } from "../src/engine/regions";
import { readAtlas } from "../src/io/atlas";
import { readSkeleton } from "../src/io/skeletonRead";
import type { MotionPath } from "../src/model/sidecar";
import { animationDuration } from "../src/model/timelines";
import { pathDrive } from "../src/ui/motion";
import { boneMatrix, Poser } from "../src/ui/stage/posed";

const [dir, name, out] = process.argv.slice(2);
if (!dir || !name || !out) throw new Error("usage: npx vite-node scripts/twin-e2e-fixture.ts <export folder> <name> <output .json>");

const doc = readSkeleton(readFileSync(join(dir, `${name}.json`), "utf8")).skeleton;
const images = atlasImages(readAtlas(readFileSync(join(dir, `${name}.atlas.txt`), "utf8")));
const file = JSON.parse(readFileSync(join(dir, `${name}.twinspline.json`), "utf8")) as {
  animations: Record<string, Record<string, { parent?: string; duration: number; loop: boolean; closed: boolean; nodes: MotionPath["nodes"] }>>;
};
const parentOf = new Map((doc.bones ?? []).map((b) => [b.name, b.parent]));

const FPS = 60;
const samples: { animation: string; frame: number; bones: { name: string; x: number; y: number }[] }[] = [];
let left = 0;
for (const [animation, bones] of Object.entries(file.animations)) {
  const motions: MotionPath[] = Object.entries(bones).map(([bone, p]) => ({ animation, bone, ...(p.parent !== undefined ? { parent: p.parent } : {}), nodes: p.nodes, closed: p.closed, duration: p.duration, loop: p.loop }));
  if (motions.some((m) => (m.parent ?? null) !== (parentOf.get(m.bone) ?? null))) { left++; continue; }
  const anim = doc.animations?.find((a) => a.name === animation);
  if (!anim) continue;
  const poser = new Poser(doc, images), length = animationDuration(anim), last = Math.max(1, Math.floor(length * FPS) - 1);
  // About a dozen frames from the second to the last, spread evenly.
  const frames = [...new Set(Array.from({ length: 12 }, (_, k) => 1 + Math.floor(((last - 1) * k) / 11)))];
  for (const frame of frames) {
    const t = Math.fround(frame / FPS);
    const key = poser.pose(null, animation, t, "none"), drives = pathDrive(doc, motions, animation, key, t), driven = poser.pose(null, animation, t, "none", drives);
    samples.push({
      animation, frame,
      // A bone that belongs to a skin that is not shown has no pose; it is left out.
      bones: motions.flatMap((m) => { const i = driven.bones.get(m.bone); if (i === undefined || !driven.rig.active[i]) return []; const M = boneMatrix(driven, i); return [{ name: m.bone, x: Math.round(M[4] * 1e4) / 1e4, y: Math.round(M[5] * 1e4) / 1e4 }]; }),
    });
  }
}
writeFileSync(out, JSON.stringify({ format: "twinspline-e2e", version: 1, fps: FPS, samples }, null, 1));
console.log(`${samples.length} poses of ${new Set(samples.map((s) => s.animation)).size} animations (${left} animations left out for a path relative to another bone) -> ${out}`);
