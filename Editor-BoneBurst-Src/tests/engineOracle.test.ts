import { describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { readAtlas } from "@/io/atlas";
import { plainJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { skeletonToJson } from "@/io/skeletonWrite";
import { drawList, drawnVertices } from "@/engine/draw";
import { atlasImages } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";
import { rigFiles } from "./fixtures/rigs";

/**
 * The engine against spine-core 4.3.13 (a dev dependency, never shipped): every sample and the
 * stickman, read through the document (read, written, handed over as plain JSON, SPEC §6), posed
 * in the setup pose and in each animation at six times, for the default skin and every other
 * skin. Bone world matrices and the drawn vertices must agree.
 */

const files = rigFiles();
const TIMES = [0, 0.2, 0.4, 0.6, 0.8, 1];
/** Relative to the value (or 1, whichever is larger). The engine keeps doubles where spine-core
 *  rounds some values to float32: the worst sample agrees to 6.6e-5 (raptor-pro's front leg);
 *  a wrong pose is off by whole units. */
const TOLERANCE = 1e-4;
const REGION_CORNERS = [0, 3, 2, 1];

interface Worst { value: number; where: string }

function compare(name: string, json: string, atlasText: string): { poses: number; worst: Worst } {
  const doc = readSkeleton(json).skeleton;
  const data = readRig(plainJson(skeletonToJson(doc)), atlasImages(readAtlas(atlasText)));
  const rig = new Rig(data);
  const sd = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlasText), true)).readSkeletonData(json);
  const sk = new Skeleton(sd);
  const worst: Worst = { value: 0, where: "" };
  const check = (got: number, want: number, where: string) => {
    const d = Math.abs(got - want) / Math.max(1, Math.abs(want));
    if (!(d <= worst.value)) { worst.value = Number.isNaN(d) ? Infinity : d; worst.where = where; }
  };
  let poses = 0;
  const skins = [null, ...sd.skins.map((s) => s.name).filter((n) => n !== "default")];
  for (const skin of skins) {
    rig.setSkins(skin ? [skin] : []);
    if (skin) sk.setSkin(skin); else sk.setSkin(null);
    const poseAt = (anim: string | null, t: number) => {
      rig.setupPose();
      sk.setupPose();
      if (anim) {
        const a = data.animations.find((x) => x.name === anim)!;
        rig.apply(a, t, false);
        sd.findAnimation(anim)!.apply(sk, -1, t, false, null, 1, MixFrom.setup, false, false, false);
      }
      rig.updateWorld("none");
      sk.updateWorldTransform(Physics.none);
      const at = `${name} skin ${skin ?? "default"} ${anim ?? "setup"}@${t.toFixed(3)}`;
      sk.bones.forEach((b, i) => {
        if (!b.active) return;
        const p = b.appliedPose, m = rig.matrix(i);
        [p.a, p.b, p.c, p.d, p.worldX, p.worldY].forEach((v, k) => check(m[k]!, v, `${at} bone ${b.data.name}[${k}]`));
      });
      const drawn = drawList(rig).slots;
      const theirs = sk.drawOrder.appliedPose.filter((s) => {
        const a = s.appliedPose.attachment;
        return s.bone.active && (a instanceof RegionAttachment || a instanceof MeshAttachment) && a.sequence.regions.some((r) => r);
      });
      expect(drawn.map((d) => d.slot), `${at} drawn slots`).toEqual(theirs.map((s) => s.data.index));
      drawn.forEach((d, i) => {
        const slot = theirs[i]!, a = slot.appliedPose.attachment!;
        const mine = new Float64Array(d.vertexCount * 2), want: number[] = new Array(d.vertexCount * 2).fill(0);
        drawnVertices(rig, d, mine);
        if (a instanceof RegionAttachment) a.computeWorldVertices(slot, a.getOffsets(slot.appliedPose), want, 0, 2);
        else (a as MeshAttachment).computeWorldVertices(sk, slot, 0, want.length, want, 0, 2);
        // A region's corners: ours bottom-left, bottom-right, top-right, top-left; spine-core's
        // bottom-left, top-left, top-right, bottom-right.
        const order = a instanceof RegionAttachment ? REGION_CORNERS : null;
        want.forEach((v, k) => {
          const mk = order ? order[k >> 1]! * 2 + (k & 1) : k;
          check(mine[mk]!, v, `${at} slot ${slot.data.name} vertex ${k}`);
        });
      });
      poses++;
    };
    poseAt(null, 0);
    for (const a of data.animations) for (const f of TIMES) poseAt(a.name, a.duration * f);
  }
  return { poses, worst };
}

describe("engine against spine-core", () => {
  it("reads every sample and the stickman", () => {
    expect(files.length).toBeGreaterThanOrEqual(17);
    expect(files.some((f) => f.name.startsWith("stickman/"))).toBe(true);
  });
  it.each(files.map((f) => [f.name, f] as const))("%s poses as spine-core does", (name, f) => {
    const { poses, worst } = compare(name, f.json, f.atlas);
    expect(poses).toBeGreaterThan(0);
    expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
  });
});
