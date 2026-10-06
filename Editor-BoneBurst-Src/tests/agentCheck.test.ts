import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { poseDifference } from "@/agent/check";
import { AgentRefused, callTool, type PosedBone } from "@/agent/host";
import { addAnimation } from "@/edit/animations";
import { keyBone } from "@/edit/boneKeys";
import { History } from "@/edit/history";
import { atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import type { Skeleton } from "@/model/skeleton";
import { frameTime } from "@/model/timelines";
import { testContext } from "./fixtures/agentContext";
import { SAMPLES } from "./fixtures/samples";

/** check_preview (E5 step 7): the editor's pose against the file as Save writes it, read back. */

const load = (dir: string, file: string) => {
  const atlas = readdirSync(dir).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
  return { doc: readSkeleton(readFileSync(join(dir, file), "utf8")).skeleton, images: atlasImages(readAtlas(atlas)) };
};
const stick = load(join(__dirname, "fixtures", "stickman"), "Stickman_IK.json");
const call = (c: ReturnType<typeof testContext>, args: unknown) => callTool("check_preview", args, c) as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { expect(e).toBeInstanceOf(AgentRefused); return (e as Error).message; } };

describe("check_preview (E5 step 7)", () => {
  it("the stickman's and spineboy-pro's animations play from the file as the editor shows them", async () => {
    const c = testContext(new History(stick.doc), stick.images);
    for (const animation of ["run", "dance"]) {
      const out = await call(c, { animation });
      expect(out, animation).toMatchObject({ matches: true });
      expect(out.largestDifference, animation).toBeLessThanOrEqual(0.01);
    }
    const sb = load(join(SAMPLES, "spineboy-pro"), "spineboy-pro.json");
    const s = testContext(new History(sb.doc), sb.images);
    for (const a of sb.doc.animations!.slice(0, 6)) {
      // Every frame up to 120 (aim is a single frame).
      const out = await call(s, { animation: a.name });
      expect(out, a.name).toMatchObject({ matches: true });
    }
  });

  it("names the bones whose last frame is not frame 0 (where a loop hitches)", async () => {
    const pose = { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
    let doc = addAnimation("w")(stick.doc as Skeleton);
    doc = keyBone("w", "hips", ["rotate"], pose, 0)(doc);
    doc = keyBone("w", "hips", ["rotate"], { ...pose, rotation: 120 }, frameTime(12, 24))(doc);
    const c = testContext(new History(doc), stick.images);
    expect((await call(c, { animation: "w" })).seam).toContain("hips");
    const closed = keyBone("w", "hips", ["rotate"], pose, frameTime(12, 24))(doc);
    expect((await call(testContext(new History(closed), stick.images), { animation: "w" })).seam).toEqual([]);
    expect(await refused(call(c, { animation: "w", frames: [20] }))).toBe('"w" is 12 frames long; frame 20 is past its end.');
  });

  it("measures each bone's joint and tip, so a turn about the joint counts", () => {
    const bone = (rot: number, x = 0): PosedBone => ({ name: "b", active: true, world: [Math.cos(rot), -Math.sin(rot), Math.sin(rot), Math.cos(rot), x, 0], local: [], length: 100 });
    expect(poseDifference([bone(0)], [bone(0)]).distance).toBe(0);
    expect(poseDifference([bone(0)], [bone(0, 3)]).distance).toBeCloseTo(3, 9);
    // Turned a tenth of a degree about the joint: the tip moves 0.17 px.
    expect(poseDifference([bone(0)], [bone(Math.PI / 1800)])).toMatchObject({ distance: expect.closeTo(0.1745, 3), bone: "b" });
  });
});
