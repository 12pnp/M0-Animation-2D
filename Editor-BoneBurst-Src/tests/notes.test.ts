import { describe, expect, it } from "vitest";
import { atlasImages, NO_IMAGES } from "@/engine/regions";
import { readRig } from "@/engine/rigData";
import { readAtlas } from "@/io/atlas";
import { plainJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { skeletonToJson } from "@/io/skeletonWrite";
import type { Skeleton } from "@/model/skeleton";
import { documentNotes, poseNotes } from "@/ui/notes";
import type { Posed } from "@/ui/stage/posed";

/** The live notes (E8-PLAN step 1): each names its thing, and says what to select. */

const doc = (extra: object): Skeleton => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0" },
  bones: [{ name: "root" }, { name: "a", parent: "root", length: 10 }],
  slots: [{ name: "s", bone: "root" }],
  ...extra,
})).skeleton;
const skipped = (d: Skeleton) => readRig(plainJson(skeletonToJson(d)), NO_IMAGES).skipped;

describe("what the engine skips, named (it said \"IK with unknown bones\")", () => {
  it.each([
    ["an IK naming missing bones", { constraints: [{ type: "ik", name: "reach", bones: ["x"], target: "w" }] },
      'IK "reach" names bones the skeleton lacks ("x", "w"); it is not solved', { kind: "constraint", type: "ik", name: "reach" }],
    ["a path constraint on a missing slot", { constraints: [{ type: "path", name: "p", bones: ["a"], slot: "none" }] },
      'path constraint "p" names the slot "none", which the skeleton lacks; it is not applied', { kind: "constraint", type: "path", name: "p" }],
    ["physics on a missing bone", { constraints: [{ type: "physics", name: "f", bone: "gone" }] },
      'physics "f" names a bone the skeleton lacks ("gone"); it does nothing', { kind: "constraint", type: "physics", name: "f" }],
    ["a slider on a missing animation", { constraints: [{ type: "slider", name: "sl", animation: "none" }] },
      'slider "sl" plays the animation "none", which is not there; it does nothing', { kind: "constraint", type: "slider", name: "sl" }],
    ["a linked mesh without its source", { skins: [{ name: "default", attachments: { s: { l: { type: "linkedmesh", source: "none" } } } }] },
      '"l" in "s" of skin "default" links to the mesh "none", which is not there; it is not drawn', { kind: "attachment", skin: "default", slot: "s", key: "l" }],
    ["keys the engine does not play", { animations: { w: { bones: { a: { wobble: [{ value: 1 }] } } } } },
      'animation "w": wobble keys are not played', { kind: "animation", name: "w" }],
  ])("%s", (_, extra, message, subject) => {
    expect(skipped(doc(extra))).toContainEqual({ message, subject });
  });
  it("a file the engine plays whole: nothing skipped", () => expect(skipped(doc({}))).toEqual([]));
});

describe("the document's notes, each with the thing to select", () => {
  it("a profile issue on a bone, a slot, a constraint, an attachment in a skin whose name has a slash, an animation", () => {
    const d = doc({
      bones: [{ name: "root" }, { name: "a", parent: "root", color: "zz" }],
      slots: [{ name: "s", bone: "root", color: "zz" }],
      constraints: [{ type: "ik", name: "reach", bones: ["a"], target: "root" }, { type: "path", name: "p", bones: ["a"], slot: "none" }],
      skins: [{ name: "full/girl", attachments: { s: { m: { type: "mesh", uvs: [0, 0, 1], triangles: [0, 1, 2], vertices: [0, 0, 1, 1, 2, 2] } } } }],
      animations: { "run/fast": { drawOrder: [{ offsets: [{ slot: "s", offset: 9 }] }] } },
    });
    const notes = documentNotes(d, null, []);
    const about = (text: RegExp) => notes.find((n) => text.test(n.text))?.subject;
    expect(about(/^bones\[1\].*color "zz"/)).toEqual({ kind: "bone", name: "a" });
    expect(about(/^slots\[0\].*color "zz"/)).toEqual({ kind: "slot", name: "s" });
    expect(about(/^constraints\[1\]/)).toEqual({ kind: "constraint", type: "path", name: "p" });
    expect(about(/^skins\/full\/girl\/s\/m: .*uvs come in pairs/)).toEqual({ kind: "attachment", skin: "full/girl", slot: "s", key: "m" });
    expect(about(/^animations\/run\/fast\/drawOrder/)).toEqual({ kind: "animation", name: "run/fast" });
  });
  it("a region the atlas lacks, with the attachment", () => {
    const d = doc({ skins: [{ name: "default", attachments: { s: { gone: { width: 1, height: 1 } } } }] });
    const notes = documentNotes(d, atlasImages(readAtlas("p.png\nsize: 4,4\nother\n  bounds: 0,0,1,1\n")), []);
    expect(notes).toContainEqual({ text: expect.stringMatching(/region "gone" is not in the atlas/), subject: { kind: "attachment", skin: "default", slot: "s", key: "gone" } });
  });
  it("what the engine skipped, as it says it", () => {
    expect(documentNotes(doc({}), null, [{ message: "x", subject: { kind: "animation", name: "w" } }])).toEqual([{ text: "x", subject: { kind: "animation", name: "w" } }]);
  });
});

describe("bones the pose shown leaves without one (E7 F6)", () => {
  const posed = (finite: boolean[]) => ({ rig: { active: finite.map(() => 1), matrix: (i: number) => (finite[i] ? [1, 0, 0, 1, 0, 0] : [NaN, 0, 0, 1, 0, 0]) } }) as unknown as Posed;
  it("one note naming them, selecting the first", () => {
    const d = doc({ bones: [{ name: "root" }, { name: "a", parent: "root" }, { name: "b", parent: "a" }] });
    expect(poseNotes(d, posed([true, false, false]), "run frame 3")).toEqual([{
      text: 'run frame 3: 2 bones "a", "b" have no pose: a constraint they are in cannot be solved here; they are not drawn',
      subject: { kind: "bone", name: "a" },
    }]);
  });
  it("none when every bone has a pose", () => expect(poseNotes(doc({}), posed([true, true]), "x")).toEqual([]));
});
