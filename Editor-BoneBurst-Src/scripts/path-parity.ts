/**
 * Path attachments edited by the editor, against BoneBurst's C# runtime (docs/PATH-PLAN.md step 5):
 * the corpus rigs that carry path constraints (Stretchyman and mix-and-match: bound to bones;
 * spineboy-unity: unbound and closed) have one path's point moved and, in a second copy, a point
 * added and the path's constant speed flipped; each copy is written as Spine JSON and posed by the
 * C# runtime and by v2's engine (`scripts/oracle/csharp.ts`: every animation, every active bone).
 * Not in `npm run check`: it needs Unity's .NET SDK.
 *
 * Run: npx vite-node scripts/path-parity.ts
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AttachmentRef, findAttachment } from "../src/edit/attachments";
import { addPathPoint, movePathPoint, pathFrame, pathPositions, setPathFlags } from "../src/edit/path";
import { atlasImages } from "../src/engine/regions";
import { readAtlas } from "../src/io/atlas";
import { readSkeleton } from "../src/io/skeletonRead";
import { writeSkeleton } from "../src/io/skeletonWrite";
import { boneMatrix, Poser } from "../src/ui/stage/posed";
import { compareWithCsharp, type Rig } from "./oracle/csharp";
import { ROOT } from "./oracle/editors";

const SAMPLES = join(ROOT, "..", "Packages", "com.module.ta-creator-boneburst", "Tests", "Editor", "Data~", "samples");
const RIGS = [
  { dir: "Stretchyman", file: "stretchyman", path: "back-arm-path" },
  { dir: "mix-and-match", file: "mix-and-match-pro", path: "arm-front-path" },
  { dir: "spineboy-unity", file: "spineboy-unity", path: "gunspath" },
];

function main(): void {
  const tmp = mkdtempSync(join(tmpdir(), "path-parity-")), rigs: Rig[] = [];
  for (const r of RIGS) {
    const jsonPath = join(SAMPLES, r.dir, `${r.file}.json`), atlasName = require("node:fs").readdirSync(join(SAMPLES, r.dir)).find((f: string) => /\.atlas(\.txt)?$/.test(f)) as string;
    const atlasPath = join(SAMPLES, r.dir, atlasName);
    const doc = readSkeleton(readFileSync(jsonPath, "utf8")).skeleton;
    const poser = new Poser(doc, atlasImages(readAtlas(readFileSync(atlasPath, "utf8"))));
    const p = poser.pose(null, null, 0), bones = doc.bones!.map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]);
    const ref: AttachmentRef = { skin: "default", slot: r.path, key: r.path };
    const a = findAttachment(doc, ref)!, f = pathFrame(doc, ref, a, bones), pos = pathPositions(a, f);
    // One: a middle point moved 15 right and 10 down in the slot bone's space.
    const mid = Math.min(1, Math.floor((a.vertexCount ?? 0) / 3) - 1), c = (mid * 3 + 1) * 2;
    const moved = movePathPoint(ref, mid, pos[c]! + 15, pos[c + 1]! - 10, bones)(doc);
    // Two: a point added past the end, and constant speed flipped.
    const last = Math.floor((a.vertexCount ?? 0) / 3) - 1, lc = (last * 3 + 1) * 2;
    const grown = setPathFlags(ref, { constantSpeed: !a.constantSpeed }, bones)(addPathPoint(ref, pos[lc]! + 40, pos[lc + 1]! + 25, bones)(doc));
    for (const [tag, d] of [["moved", moved], ["grown", grown]] as const) {
      const name = `${r.file}-${tag}`, json = join(tmp, `${name}.json`), atlas = join(tmp, `${name}.atlas`);
      writeFileSync(json, writeSkeleton(d));
      copyFileSync(atlasPath, atlas);
      rigs.push({ name, json, atlas });
    }
  }
  const { compared, failed } = compareWithCsharp(rigs);
  if (compared !== rigs.length) throw new Error(`Only ${compared} of ${rigs.length} edited rigs were compared: a run that compares less is a failure.`);
  if (failed) { console.log(`${failed} edited rig${failed === 1 ? "" : "s"} differ.`); process.exitCode = 1; } else console.log(`All ${compared} edited path rigs agree with the C# runtime.`);
}

main();
