/**
 * v2's engine against BoneBurst's C# runtime on the corpus (E6-PLAN step 5): the comparison in
 * `scripts/oracle/csharp.ts`, on every corpus rig. The check the old editor kept in its
 * tests/boneburstUnity.test.ts, now for v2. Not in `npm run check`: it needs Unity's .NET SDK.
 *
 * Run: npx vite-node scripts/unity-parity.ts [filter]
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { compareWithCsharp, type Rig } from "./oracle/csharp";
import { ROOT } from "./oracle/editors";

const SAMPLES = join(ROOT, "..", "Packages", "com.module.ta-creator-boneburst", "Tests", "Editor", "Data~", "samples");
function corpus(): Rig[] {
  const out: Rig[] = [{ name: "Stickman_IK", json: join(ROOT, "tests", "fixtures", "stickman", "Stickman_IK.json"), atlas: join(ROOT, "tests", "fixtures", "stickman", "Stickman_IK.atlas.txt") }];
  for (const d of readdirSync(SAMPLES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const files = readdirSync(join(SAMPLES, d.name)), atlas = files.find((f) => /\.atlas(\.txt)?$/.test(f));
    if (!atlas) continue;
    for (const j of files.filter((f) => f.endsWith(".json"))) out.push({ name: j.replace(/\.json$/, ""), json: join(SAMPLES, d.name, j), atlas: join(SAMPLES, d.name, atlas) });
  }
  return out;
}

function main(): void {
  const filter = process.argv[2];
  const { compared, failed } = compareWithCsharp(corpus().filter((r) => !filter || r.name.includes(filter)));
  if (!compared) throw new Error("No rig was compared: a run that compares nothing is a failure.");
  if (failed) { console.log(`${failed} rig${failed === 1 ? "" : "s"} differ.`); process.exitCode = 1; }
}

main();
