import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";

/**
 * Phase 8: the editor's exports in Unity. `Assets/AnimoTest/Spine` in
 * M0-Animation2D holds exported rigs (Animo-authored and opened-then-exported),
 * imported by spine-unity. `scripts/unity-check/dump.cs`, run in that Editor,
 * poses each with spine-csharp 4.3.40 at every frame of every animation and
 * writes `Library/AnimoSpineCheck/dump.json`, positions in Unity units (the
 * asset's import scale). This test poses the same files
 * with spine-core 4.3.13, the preview's runtime, and compares: every bone's
 * world matrix, the draw order, and each slot's attachment and colour. Skipped,
 * not passed, without the folder or the dump.
 */

const M0 = process.env.M0_PROJECT ?? resolve(__dirname, "../../M0-Animation2D");
const RIGS = `${M0}/Assets/AnimoTest/Spine`;
const DUMP = `${M0}/Library/AnimoSpineCheck/dump.json`;

type Frame = { b: number[]; s: Array<[string, string | null, number, number, number, number]> };
type Dump = Record<string, { fps: number; scale: number; animations: Record<string, Frame[]> } | null>;

const ready = existsSync(RIGS) && existsSync(DUMP);

describe.skipIf(!ready)("spine-unity plays the exports as the preview's runtime does", () => {
  const dump: Dump = ready ? JSON.parse(readFileSync(DUMP, "utf8")) : {};
  const rigs = ready ? readdirSync(RIGS).filter((d) => !d.includes(".")) : [];

  it("has every rig in the folder in the dump", () => {
    expect(rigs.length).toBeGreaterThanOrEqual(5);
    for (const rig of rigs) expect(dump[rig], rig).toBeTruthy();
  });

  for (const rig of rigs) {
    it(rig, () => {
      const files = readdirSync(`${RIGS}/${rig}`);
      const json = JSON.parse(readFileSync(`${RIGS}/${rig}/${files.find((f) => f.endsWith(".json"))!}`, "utf8"));
      const atlas = readFileSync(`${RIGS}/${rig}/${files.find((f) => f.endsWith(".atlas.txt"))!}`, "utf8");
      const data = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlas))).readSkeletonData(json);
      const sk = new Skeleton(data);
      // dump.cs's rule, the stage's: a default skin that draws nothing shows the first other.
      const draws = data.defaultSkin?.getAttachments().some((e) => e.attachment instanceof RegionAttachment || e.attachment instanceof MeshAttachment);
      if (!draws) {
        const other = data.skins.find((s) => s.name !== "default");
        if (other) sk.setSkin(other);
      }
      const unity = dump[rig]!;
      let worst = 0, frames = 0;
      for (const anim of data.animations) {
        const theirs = unity.animations[anim.name];
        expect(theirs, `${rig} "${anim.name}"`).toBeTruthy();
        theirs!.forEach((u, f) => {
          const where = `${rig} "${anim.name}" frame ${f}`;
          sk.setupPose();
          anim.apply(sk, 0, f / unity.fps + 1e-5, false, null, 1, MixFrom.setup, false, false, false);
          sk.updateWorldTransform(Physics.reset);
          frames++;
          sk.bones.forEach((bone, i) => {
            const p = bone.appliedPose, q = u.b.slice(i * 6, i * 6 + 6);
            const m = Math.max(Math.abs(p.a - q[0]!), Math.abs(p.b - q[1]!), Math.abs(p.c - q[2]!), Math.abs(p.d - q[3]!));
            // spine-unity reads the file at the asset's import scale.
            const d = Math.max(Math.abs(p.worldX - q[4]! / unity.scale), Math.abs(p.worldY - q[5]! / unity.scale));
            worst = Math.max(worst, d);
            if (m > 1e-3 || d > 0.01) throw new Error(`${where}: bone "${bone.data.name}" matrix off by ${m}, position by ${d}`);
          });
          const order = sk.drawOrder.appliedPose;
          if (order.map((s) => s.data.name).join("|") !== u.s.map((s) => s[0]).join("|")) throw new Error(`${where}: draw order differs`);
          order.forEach((slot, i) => {
            const [name, att, r, g, b, a] = u.s[i]!;
            const mine = slot.appliedPose.getAttachment()?.name ?? null;
            if (mine !== att) throw new Error(`${where}: slot "${name}" shows ${att} in Unity, ${mine} in spine-core`);
            const c = slot.appliedPose.color;
            if (Math.max(Math.abs(c.r - r), Math.abs(c.g - g), Math.abs(c.b - b), Math.abs(c.a - a)) > 1e-4) {
              throw new Error(`${where}: slot "${name}" colour differs`);
            }
          });
        });
      }
      console.log(rig, "frames", frames, "worst px", worst);
      expect(frames).toBeGreaterThan(0);
    });
  }
});
