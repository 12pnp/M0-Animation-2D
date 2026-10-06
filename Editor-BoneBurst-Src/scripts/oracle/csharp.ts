/**
 * v2's engine against BoneBurst's C# runtime, the comparison `scripts/unity-parity.ts` (the corpus)
 * and `scripts/daily-driver.ts` (the daily driver's export, E7-PLAN step 6) share: each rig posed
 * by the Unity package's parity harness (`Tools~/ParityHarness/run.sh --dump`: every animation
 * from its start in steps of 0.0337 s, physics stepping, the default skin) and by v2's engine
 * stepped the same way; every active bone's world matrix compared at every frame. Needs Unity's
 * .NET SDK.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atlasImages } from "../../src/engine/regions";
import { readAtlas } from "../../src/io/atlas";
import { readSkeleton } from "../../src/io/skeletonRead";
import { Poser } from "../../src/ui/stage/posed";
import { ROOT } from "./editors";

const RUN = join(ROOT, "..", "Packages", "com.module.ta-creator-boneburst", "Tools~", "ParityHarness", "run.sh");
/** The dump's step: not a multiple of 1/30, 1/24 or 1/60 (see Dump.cs). */
const STEP = Math.fround(0.0337);
/** Agreement: float32 against float64, in skeleton units (a hundredth of a pixel). */
const TOLERANCE = 0.01;
/**
 * The wider bound for an ill-conditioned frame (root CLAUDE.md §5: IK out of reach, where the
 * solve amplifies rounding): only a bone in or under an IK chain whose target is beyond its reach
 * on that frame, each such case listed.
 */
const OUT_OF_REACH = 0.1;

export interface Rig { readonly name: string; readonly json: string; readonly atlas: string }
type Frame = { w: (number[] | null)[] };

/** Pose `rigs` in both runtimes and compare; prints a line a rig. Returns the rigs compared and those that differ. */
export function compareWithCsharp(rigs: readonly Rig[]): { compared: number; failed: number } {
  const dir = mkdtempSync(join(tmpdir(), "unity-parity-")), inDir = join(dir, "in"), outDir = join(dir, "out");
  mkdirSync(inDir);
  // The dump reads name.json beside name.atlas; a sample's atlas file may be named after another skeleton.
  for (const r of rigs) { copyFileSync(r.json, join(inDir, `${r.name}.json`)); copyFileSync(r.atlas, join(inDir, `${r.name}.atlas`)); }
  const run = spawnSync("bash", [RUN, "--dump", inDir, outDir], { cwd: join(ROOT, ".."), encoding: "utf8" });
  if (run.status !== 0) throw new Error(`The C# dump failed (${run.status}):\n${run.stderr || run.stdout}`);
  let worstAll = 0, compared = 0, failed = 0;
  for (const r of rigs) {
    const file = join(outDir, `${r.name}.poses.json`);
    if (!existsSync(file)) { console.log(`${r.name.padEnd(28)} NO DUMP`); continue; }
    const dump = JSON.parse(readFileSync(file, "utf8")) as { animations: Record<string, Frame[]> };
    const doc = readSkeleton(readFileSync(r.json, "utf8")).skeleton, images = atlasImages(readAtlas(readFileSync(r.atlas, "utf8")));
    let worst = { d: 0, at: "" }, frames = 0, wider = { d: 0, at: "" };
    // Each bone's parent, and the two-bone IK chains: the bones under an out-of-reach chain take the wider bound.
    const parent = doc.bones!.map((b) => doc.bones!.findIndex((x) => x.name === b.parent));
    const chains = (doc.constraints ?? []).flatMap((c) => (c.type === "ik" && c.bones?.length === 2 && c.target !== undefined
      ? [{ bones: c.bones.map((n) => doc.bones!.findIndex((x) => x.name === n)), target: doc.bones!.findIndex((x) => x.name === c.target) }] : []));
    const under = (i: number, root: number) => { for (let b = i; b >= 0; b = parent[b]!) if (b === root) return true; return false; };
    for (const [anim, list] of Object.entries(dump.animations)) {
      const poser = new Poser(doc, images);
      let time = 0;
      list.forEach((want, f) => {
        // As the dump steps it: no time first, then a step; physics started over, then stepped.
        const dt = f === 0 ? 0 : STEP;
        time = Math.fround(time + dt);
        poser.rig.update(dt);
        const p = poser.pose(null, anim, time, f === 0 ? "reset" : "update");
        frames++;
        // The chains whose target lies beyond the chain's length on this frame.
        const len = (b: number) => (doc.bones![b]!.length ?? 0) * Math.hypot(p.rig.matrix(b)[0]!, p.rig.matrix(b)[2]!);
        const stretched = chains.filter((c) => {
          const a = p.rig.matrix(c.bones[0]!), t = p.rig.matrix(c.target);
          return Math.hypot(t[4]! - a[4]!, t[5]! - a[5]!) > len(c.bones[0]!) + len(c.bones[1]!);
        });
        want.w.forEach((m, i) => {
          if (!m || !p.rig.active[i]) return;
          const got = p.rig.matrix(i);
          for (let k = 0; k < 6; k++) {
            // Positions in units; the 2×2 part scaled to a 100-unit bone so both read as distance.
            const d = Math.abs(got[k]! - m[k]!) * (k < 4 ? 100 : 1), at = `${anim} frame ${f} bone ${doc.bones![i]!.name}`;
            if (stretched.some((c) => under(i, c.bones[0]!))) { if (d > wider.d) wider = { d, at }; } else if (d > worst.d) worst = { d, at };
          }
        });
      });
    }
    compared++;
    const ok = worst.d <= TOLERANCE && wider.d <= OUT_OF_REACH;
    if (!ok) failed++;
    worstAll = Math.max(worstAll, worst.d);
    console.log(`${r.name.padEnd(28)} ${String(frames).padStart(5)} frames  ${ok ? "agrees" : "DIFFERS"}: ${worst.d.toFixed(4)}${worst.d > TOLERANCE ? ` (${worst.at})` : ""}`
      + (wider.d > 0 ? `; IK out of reach: ${wider.d.toFixed(4)} (${wider.at}, bound ${OUT_OF_REACH})` : ""));
  }
  console.log(`${compared} rigs; worst ${worstAll.toFixed(4)} (tolerance ${TOLERANCE})`);
  return { compared, failed };
}
