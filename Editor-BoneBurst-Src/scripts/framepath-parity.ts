/**
 * The owner's sample converted for FramePath, posed by BoneBurst's C# runtime (docs/SPINE-IMPORT-FRAMEPATH-PLAN.md, step 4):
 * 1. the converted file is ordinary Spine data the C# runtime plays as the editor does (`comparePoses`, 0.01 units);
 * 2. the converted file against the original, both as the C# runtime plays them, at the harness's steps (0.0337 s, between frames).
 * Not in `npm run check`: it needs Unity's .NET SDK.
 *
 * Run: npx vite-node scripts/framepath-parity.ts [timing] [tolerance]   (split 0.5 by default)
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToFramePath, type TimingMode } from "../src/edit/toFramePath";
import { readSkeleton } from "../src/io/skeletonRead";
import { stringifyJson } from "../src/io/json";
import { skeletonToJson } from "../src/io/skeletonWrite";
import { comparePoses, dumpWithCsharp, type Rig } from "./oracle/csharp";
import { ROOT } from "./oracle/editors";

type Dump = { animations: Record<string, { w: (number[] | null)[] }[]> };

function main(): void {
  const timing = (process.argv[2] ?? "split") as TimingMode, tolerance = Number(process.argv[3] ?? 0.5);
  const dir = join(ROOT, "..", "Assets", "Samples Custom", "BoneBurstDemo", "mix-and-match-pro");
  const tmp = mkdtempSync(join(tmpdir(), "framepath-parity-")), atlas = join(tmp, "mmp.atlas");
  copyFileSync(join(dir, "mix-and-match-pro.atlas.txt"), atlas);
  const text = readFileSync(join(dir, "mix-and-match-pro.json"), "utf8"), out = convertToFramePath(readSkeleton(text).skeleton, { timing, tolerance });
  writeFileSync(join(tmp, "original.json"), text);
  writeFileSync(join(tmp, "converted.json"), stringifyJson(skeletonToJson(out.doc)));
  console.log(`Converted (${timing}, ${tolerance}): ${out.added} keys added; the editor measures the largest move at ${out.worst.toFixed(3)} units.`);
  const rigs: Rig[] = [{ name: "original", json: join(tmp, "original.json"), atlas }, { name: "converted", json: join(tmp, "converted.json"), atlas }];
  const dumps = dumpWithCsharp(rigs);
  // 1. Each file: the C# runtime and the editor agree.
  const valid = rigs.map((r) => comparePoses(r, join(dumps, `${r.name}.poses.json`)));
  // 2. The two files in the C# runtime: every bone's world place at every dumped step.
  const a = JSON.parse(readFileSync(join(dumps, "original.poses.json"), "utf8")) as Dump, b = JSON.parse(readFileSync(join(dumps, "converted.poses.json"), "utf8")) as Dump;
  const bones = (readSkeleton(text).skeleton.bones ?? []).map((x) => x.name), worst: { d: number; at: string }[] = [];
  let steps = 0;
  for (const [anim, frames] of Object.entries(a.animations)) {
    frames.forEach((fa, f) => {
      const fb = b.animations[anim]?.[f];
      steps++;
      fa.w.forEach((m, i) => {
        const n = fb?.w[i];
        if (!m || !n) return;
        const d = Math.hypot(m[4]! - n[4]!, m[5]! - n[5]!);
        if (d > 0.05) worst.push({ d, at: `${anim} step ${f} (${(f * 0.0337).toFixed(3)} s) ${bones[i]}` });
      });
    });
  }
  worst.sort((p, q) => q.d - p.d);
  console.log(`Original against converted in C#: ${steps} steps; ${worst.length} bone places more than 0.05 units apart; the largest:`);
  for (const w of worst.slice(0, 8)) console.log(`  ${w.d.toFixed(3)}  ${w.at}`);
  if (!valid.every((v) => v.ok)) process.exitCode = 1;
}

main();
