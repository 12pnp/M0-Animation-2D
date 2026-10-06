/**
 * Where the time goes, headless (E9-PLAN step 1): on every corpus rig and a doubled mix-and-match
 * (its skins and animations twice over), the costs of what the editor does, as the browser runs
 * them: reading, the profile, building the rig, posing (setup, and an animation frame by frame with
 * physics), the draw list and its vertices, the live notes, writing; and a drag step as the stage
 * does one now: an edit, then the rig built again and posed. Medians and 95th percentiles, in ms.
 *
 * Run: npx vite-node scripts/perf.ts [filter]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateBone } from "../src/edit/bones";
import { drawnVertices } from "../src/engine/draw";
import { type AtlasImages, atlasImages } from "../src/engine/regions";
import { readAtlas } from "../src/io/atlas";
import { readSkeleton } from "../src/io/skeletonRead";
import { writeSkeleton } from "../src/io/skeletonWrite";
import { profileIssues } from "../src/model/profile";
import type { Skeleton } from "../src/model/skeleton";
import { documentNotes } from "../src/ui/notes";
import { Poser } from "../src/ui/stage/posed";
import { ROOT } from "./oracle/editors";

const SAMPLES = join(ROOT, "..", "Packages", "com.module.ta-creator-boneburst", "Tests", "Editor", "Data~", "samples");

interface Rig { readonly name: string; readonly text: string; readonly atlas: string }

function corpus(): Rig[] {
  const out: Rig[] = [{ name: "stickman", text: readFileSync(join(ROOT, "tests", "fixtures", "stickman", "Stickman_IK.json"), "utf8"), atlas: readFileSync(join(ROOT, "tests", "fixtures", "stickman", "Stickman_IK.atlas.txt"), "utf8") }];
  for (const d of readdirSync(SAMPLES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const files = readdirSync(join(SAMPLES, d.name)), atlas = files.find((f) => /\.atlas(\.txt)?$/.test(f));
    if (!atlas) continue;
    for (const j of files.filter((f) => f.endsWith(".json"))) out.push({ name: j.replace(/\.json$/, ""), text: readFileSync(join(SAMPLES, d.name, j), "utf8"), atlas: readFileSync(join(SAMPLES, d.name, atlas), "utf8") });
  }
  const mm = out.find((r) => r.name === "mix-and-match-pro");
  if (mm) out.push({ name: "mix-and-match ×2", text: doubled(mm.text), atlas: mm.atlas });
  return out;
}

/** A production-size rig from a large one: every skin and animation twice, the copies renamed. */
function doubled(text: string): string {
  const j = JSON.parse(text) as { skins?: { name: string }[]; animations?: Record<string, unknown> };
  j.skins = [...(j.skins ?? []), ...(j.skins ?? []).filter((k) => k.name !== "default").map((k) => ({ ...structuredClone(k), name: `${k.name}-copy` }))];
  j.animations = Object.fromEntries(Object.entries(j.animations ?? {}).flatMap(([n, a]) => [[n, a], [`${n}-copy`, structuredClone(a)]]));
  return JSON.stringify(j);
}

/** Median and 95th percentile of `runs` timings of `f`, in ms (one warm-up first). */
function time(runs: number, f: () => unknown): { med: number; p95: number } {
  f();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  return { med: t[Math.floor(t.length / 2)]!, p95: t[Math.min(t.length - 1, Math.ceil(t.length * 0.95) - 1)]! };
}

/** One frame as the stage draws it: the pose, the draw list's vertices. */
function frame(poser: Poser, doc: Skeleton, anim: string | null, t: number, physics: "none" | "update"): void {
  const p = poser.pose(null, anim, t, physics);
  for (const d of p.draw.slots) drawnVertices(p.rig, d, new Float64Array(d.vertexCount * 2));
  void doc;
}

function measure(r: Rig): Record<string, { med: number; p95: number }> {
  const doc = readSkeleton(r.text).skeleton, images: AtlasImages = atlasImages(readAtlas(r.atlas));
  const anim = doc.animations?.[0]?.name ?? null;
  const poser = new Poser(doc, images);
  let t = 0;
  // A bone to drag: the first one under the root.
  const bone = doc.bones?.[1]?.name ?? doc.bones![0]!.name;
  let x = 0, current = doc;
  return {
    read: time(10, () => readSkeleton(r.text)),
    profile: time(20, () => profileIssues(doc)),
    "rig build": time(20, () => new Poser(doc, images)),
    "setup pose + draw": time(60, () => frame(poser, doc, null, 0, "none")),
    "anim frame + draw": time(120, () => { t += 1 / 60; poser.rig.update(1 / 60); frame(poser, doc, anim, t, "update"); }),
    notes: time(20, () => documentNotes(doc, images, poser.pose(null, null, 0).rig.data.skipped)),
    write: time(10, () => writeSkeleton(doc)),
    // A drag step as the stage does one today: the edit, a new rig (the document changed), its pose.
    "drag step": time(60, () => {
      current = updateBone(bone, { x: (x += 0.5) })(current);
      frame(new Poser(current, images), current, anim, 0.5, "none");
    }),
  };
}

const COLUMNS = ["read", "profile", "rig build", "setup pose + draw", "anim frame + draw", "notes", "write", "drag step"];

function main(): void {
  const filter = process.argv[2];
  const rigs = corpus().filter((r) => !filter || r.name.includes(filter));
  console.log(`${"rig".padEnd(26)}${"kB".padStart(6)}  ${COLUMNS.map((c) => c.padStart(18)).join("")}`);
  console.log(`${"".padEnd(32)}  ${COLUMNS.map(() => "med / p95 ms".padStart(18)).join("")}`);
  for (const r of rigs) {
    const m = measure(r);
    console.log(`${r.name.padEnd(26)}${String(Math.round(r.text.length / 1024)).padStart(6)}  ${COLUMNS.map((c) => `${m[c]!.med.toFixed(2)} / ${m[c]!.p95.toFixed(2)}`.padStart(18)).join("")}`);
  }
}

main();
