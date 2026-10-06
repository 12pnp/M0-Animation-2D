/**
 * The bake's side of E8 step 3: what BoneBurst's bake made of v2's export, read back in Unity
 * (Temp/AgentScripts/E8Bake.cs ▸ Read: the asset's names, and its data posed by BoneBurst's C#
 * runtime), against the export itself: the same bones, slots, skins, constraints and animations,
 * and every bone at every frame as v2's engine poses the export (`scripts/oracle/csharp.ts`).
 *
 * Run: npx vite-node scripts/bake-check.ts <export folder> <report.json> <poses.json>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSkeleton } from "../src/io/skeletonRead";
import { comparePoses } from "./oracle/csharp";

const [exportDir, reportFile, posesFile] = process.argv.slice(2);
if (!exportDir || !reportFile || !posesFile) throw new Error("Usage: bake-check.ts <export folder> <report.json> <poses.json>");
const files = readdirSync(exportDir), json = files.find((f) => f.endsWith(".json"))!, atlas = files.find((f) => /\.atlas(\.txt)?$/.test(f))!;
const doc = readSkeleton(readFileSync(join(exportDir, json), "utf8")).skeleton;
const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
if (report.ok !== true) throw new Error(`The bake failed: ${String(report.error)}`);

let failed = 0;
const same = (what: string, baked: unknown, exported: readonly string[]) => {
  const ok = JSON.stringify(baked) === JSON.stringify(exported);
  if (!ok) failed++;
  console.log(`${what.padEnd(12)} ${ok ? "same" : "DIFFER"} (${exported.length})${ok ? "" : `: baked ${JSON.stringify(baked)}, exported ${JSON.stringify(exported)}`}`);
};
same("bones", report.bones, (doc.bones ?? []).map((b) => b.name));
same("slots", report.slots, (doc.slots ?? []).map((s) => s.name));
same("skins", report.skins, (doc.skins ?? []).map((s) => s.name));
same("constraints", report.constraints, (doc.constraints ?? []).map((c) => c.name));
same("animations", report.animations, (doc.animations ?? []).map((a) => a.name));
const { ok } = comparePoses({ name: "baked", json: join(exportDir, json), atlas: join(exportDir, atlas) }, posesFile);
if (!ok) failed++;
console.log(failed ? `${failed} check${failed === 1 ? "" : "s"} differ.` : "The baked asset holds what v2 exported, and BoneBurst poses it as v2 does.");
if (failed) process.exitCode = 1;
