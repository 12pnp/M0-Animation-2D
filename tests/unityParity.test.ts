import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, PointAttachment, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas, Vector2, VertexAttachment,
} from "@esotericsoftware/spine-core";

/**
 * Phase 8: the editor's exports in Unity. `Assets/AnimoTest/Spine` in
 * M0-Animation2D holds exported rigs (Animo-authored and opened-then-exported),
 * imported by spine-unity. `scripts/unity-check/dump.cs`, run in that Editor,
 * poses each with spine-csharp 4.3.40 at every frame of every animation and
 * writes `Library/AnimoSpineCheck/dump.json`, positions in Unity units (the
 * asset's import scale). This test poses the same files
 * with spine-core 4.3.13, the preview's runtime, and compares: every bone's
 * world matrix, the draw order, each slot's attachment and colour, and where the
 * attachment is: a region's corners, a mesh's, box's, path's or clip's world
 * vertices, a point's position and rotation (`v`, absent in a dump from before), in
 * each skin at the setup pose, and for a rig with up to four skins every frame
 * in each skin. Skipped,
 * not passed, without the folder or the dump.
 */

const M0 = process.env.M0_PROJECT ?? resolve(__dirname, "../../M0-Animation2D");
const RIGS = `${M0}/Assets/AnimoTest/Spine`;
const DUMP = `${M0}/Library/AnimoSpineCheck/dump.json`;

type Frame = { b: number[]; s: Array<[string, string | null, number, number, number, number, number[]?]> };
type Dump = Record<string, { fps: number; scale: number; animations: Record<string, Frame[]>; skins?: Record<string, Frame["s"]>; skinAnimations?: Record<string, Record<string, Frame[]>> } | null>;

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
      let worst = 0, worstVertex = 0, frames = 0;
      /** Each slot in draw order against Unity's: attachment, colour and where it is. */
      const slotsMatch = (sk2: Skeleton, theirs: Frame["s"], where: string) => {
        const order = sk2.drawOrder.appliedPose;
        if (order.map((s) => s.data.name).join("|") !== theirs.map((s) => s[0]).join("|")) throw new Error(`${where}: draw order differs`);
        order.forEach((slot, i) => {
          const [name, att, r, g, b, a, v] = theirs[i]!;
          const mine = slot.appliedPose.getAttachment()?.name ?? null;
          if (mine !== att) throw new Error(`${where}: slot "${name}" shows ${att} in Unity, ${mine} in spine-core`);
          const c = slot.appliedPose.color;
          if (Math.max(Math.abs(c.r - r), Math.abs(c.g - g), Math.abs(c.b - b), Math.abs(c.a - a)) > 1e-4) {
            throw new Error(`${where}: slot "${name}" colour differs`);
          }
          if (!v) return;
          const shown = slot.appliedPose.getAttachment();
          let mine2: number[] = [];
          // A point first: spine-core's is a vertex attachment too.
          if (shown instanceof PointAttachment) {
            const at = shown.computeWorldPosition(slot.bone.appliedPose, new Vector2());
            mine2 = [at.x, at.y, shown.computeWorldRotation(slot.bone.appliedPose)];
          } else if (shown instanceof RegionAttachment) {
            mine2 = new Array<number>(8);
            shown.computeWorldVertices(slot, shown.getOffsets(slot.appliedPose), mine2, 0, 2);
          } else if (shown instanceof VertexAttachment) {
            mine2 = new Array<number>(shown.worldVerticesLength);
            shown.computeWorldVertices(sk2, slot, 0, shown.worldVerticesLength, mine2, 0, 2);
          }
          if (mine2.length !== v.length) throw new Error(`${where}: slot "${name}" has ${v.length} numbers in Unity, ${mine2.length} in spine-core`);
          const point = shown instanceof PointAttachment;
          // spine-csharp starts a region from another corner when its atlas
          // region is rotated: the same four corners, shifted round.
          const shifts = shown instanceof RegionAttachment ? [0, 2, 4, 6] : [0];
          const off = (shift: number) => Math.max(...mine2.map((x, k) => {
            const theirs = v[(k + shift) % v.length]!;
            // A point's rotation is in degrees, not scaled.
            return point && k === 2 ? Math.abs(((((x - theirs) % 360) + 540) % 360) - 180) : Math.abs(x - theirs / unity.scale);
          }));
          const d = Math.min(...shifts.map(off));
          worstVertex = Math.max(worstVertex, d);
          if (d > 0.01) throw new Error(`${where}: slot "${name}" ${point ? "point" : "vertices"} off by ${d}`);
        });
      };
      /** Every animation at every frame against Unity's, `label` naming the skin played. */
      const animationsMatch = (sk2: Skeleton, played: Record<string, Frame[]>, label: string) => {
        for (const anim of data.animations) {
          const theirs = played[anim.name];
          expect(theirs, `${label} "${anim.name}"`).toBeTruthy();
          theirs!.forEach((u, f) => {
            const where = `${label} "${anim.name}" frame ${f}`;
            sk2.setupPose();
            anim.apply(sk2, 0, f / unity.fps + 1e-5, false, null, 1, MixFrom.setup, false, false, false);
            sk2.updateWorldTransform(Physics.reset);
            frames++;
            sk2.bones.forEach((bone, i) => {
              const p = bone.appliedPose, q = u.b.slice(i * 6, i * 6 + 6);
              const m = Math.max(Math.abs(p.a - q[0]!), Math.abs(p.b - q[1]!), Math.abs(p.c - q[2]!), Math.abs(p.d - q[3]!));
              // spine-unity reads the file at the asset's import scale.
              const d = Math.max(Math.abs(p.worldX - q[4]! / unity.scale), Math.abs(p.worldY - q[5]! / unity.scale));
              worst = Math.max(worst, d);
              if (m > 1e-3 || d > 0.01) throw new Error(`${where}: bone "${bone.data.name}" matrix off by ${m}, position by ${d}`);
            });
            slotsMatch(sk2, u.s, where);
          });
        }
      };
      animationsMatch(sk, unity.animations, rig);
      // A rig with a few skins plays every animation in each (a dump from before has none).
      for (const [name, played] of Object.entries(unity.skinAnimations ?? {})) {
        const one = new Skeleton(data);
        one.setSkin(name);
        animationsMatch(one, played, `${rig} skin "${name}"`);
      }
      // Each skin alone over the default one, at the setup pose (a dump from before has none).
      let skins = 0;
      for (const [name, theirs] of Object.entries(unity.skins ?? {})) {
        const one = new Skeleton(data);
        one.setSkin(name);
        one.setupPose();
        one.updateWorldTransform(Physics.reset);
        slotsMatch(one, theirs, `${rig} skin "${name}"`);
        skins++;
      }
      console.log(rig, "frames", frames, "skins", skins, "worst px", worst, "worst vertex px", worstVertex);
      expect(frames).toBeGreaterThan(0);
    });
  }
});
