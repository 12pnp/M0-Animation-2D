import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createProject, createKeyframe, createNode } from "@/core/doc/defaults";
import type { SymbolItem } from "@/core/doc/types";
import { validateProject } from "@/core/doc/schema";
import { migrate } from "@/core/doc/migrations";
import { Store } from "@/app/Store";
import { PosesService } from "@/app/PosesService";
import { posePrompt } from "@/app/agent/poseHandoff";
import { referenceIndexAt, referencePlayFrame, referenceStarts } from "@/core/doc/reference";
import type { AnimationReference } from "@/core/doc/types";

beforeEach(() => reseed());

describe("the pose list in the document", () => {
  it("is sanitized: whole, sorted, unique; empty reads as none", () => {
    const project = createProject("P");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    sym.animations[0]!.poses = [7.6, 3, 3, -2, "x", 12] as unknown as number[];
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    expect((out.items[out.rootSymbolId] as SymbolItem).animations[0]!.poses).toEqual([0, 3, 8, 12]);

    sym.animations[0]!.poses = [];
    const none = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    expect((none.items[none.rootSymbolId] as SymbolItem).animations[0]!.poses).toBeUndefined();
  });

  it("moves with the file's version: a v11 document opens as the current one", () => {
    const project = createProject("P");
    const raw = JSON.parse(JSON.stringify({ ...project, version: 11 }));
    const out = validateProject(migrate(raw)).project;
    expect(out.version).toBeGreaterThanOrEqual(12);
  });
});

describe("PosesService", () => {
  it("adds, moves and removes poses, each one undo step, the list sorted and unique", () => {
    const project = createProject("P");
    const store = new Store(project);
    const poses = new PosesService(store);
    poses.add([10, 1]);
    poses.add([1, 20, 10]);
    expect(store.currentAnimation?.poses).toEqual([1, 10, 20]);
    poses.move(10, 5);
    expect(store.currentAnimation?.poses).toEqual([1, 5, 20]);
    poses.remove(5);
    expect(store.currentAnimation?.poses).toEqual([1, 20]);
    store.undo();
    expect(store.currentAnimation?.poses).toEqual([1, 5, 20]);
    store.undo();
    expect(store.currentAnimation?.poses).toEqual([1, 10, 20]);
    store.undo();
    store.undo();
    expect(store.currentAnimation?.poses).toBeUndefined();
  });

  it("collects every keyed frame of the animation, in time order", () => {
    const project = createProject("P");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    expect(PosesService.keyedFrames(sym.animations[0])).toEqual([]);
    expect(PosesService.keyedFrames(null)).toEqual([]);
    const n1 = createNode("group", "one", { x: 0, y: 0 });
    const n2 = createNode("group", "two", { x: 0, y: 0 });
    sym.nodes[n1.id] = n1;
    sym.nodes[n2.id] = n2;
    const track = (id: string, frames: number[]) => ({ nodeId: id as never, keys: frames.map((f) => createKeyframe(f, n1)), endFrame: 20 });
    sym.animations[0]!.tracks[n1.id] = track(n1.id, [9, 3]);
    sym.animations[0]!.tracks[n2.id] = track(n2.id, [3, 20]);
    expect(PosesService.keyedFrames(sym.animations[0])).toEqual([3, 9, 20]);
  });
});

describe("the handoff prompt", () => {
  it("names each picture's frame, the pairs to animate, and the cap", () => {
    const text = posePrompt("walk", 30, [1, 10, 20], 2);
    expect(text).toContain('"walk" (30 fps)');
    expect(text).toContain("frames 1, 10, 20");
    expect(text).toContain("picture 1 = frame 1, picture 2 = frame 10");
    expect(text).toContain("1 to 10, 10 to 20");
    expect(text).toContain("Only the first 2 are attached");
    expect(text).toContain("Keep the keys at frames 1, 10, 20 exactly as they are");
    expect(text).not.toContain("no keys yet");
  });

  it("says nothing of a cap when every pose rides along", () => {
    expect(posePrompt("idle", 24, [0, 12], 2)).not.toContain("Only the first");
  });

  it("mentions the bones only when the pictures carry them", () => {
    expect(posePrompt("idle", 24, [0, 12], 2)).toContain("bones drawn and named");
    expect(posePrompt("idle", 24, [0, 12], 2, { withBones: false })).not.toContain("bones");
  });

  it("asks for the poses not keyed yet first, from the reference when the pictures carry it", () => {
    const fromRef = posePrompt("run", 24, [0, 4, 8], 3, { overReference: true, keyed: [0] });
    expect(fromRef).toContain("see-through over the reference picture");
    expect(fromRef).toContain("Frames 4, 8 have no keys yet: first pose the rig at each to match the reference picture");
    expect(fromRef).toContain("Keep the keys at frame 0 exactly");
    const none = posePrompt("run", 24, [0, 4], 2, { keyed: [] });
    expect(none).toContain("Frames 0, 4 have no keys yet: key a pose at each");
    expect(none).not.toContain("Keep the keys");
  });
});

describe("referenceStarts", () => {
  it("lists the frames the pictures start on, in time order, once each", () => {
    const ref = { frames: ["a", "b", "c", "d"], width: 1, height: 1, start: 2, hold: 3, x: 0, y: 0, scale: 1 } as unknown as AnimationReference;
    expect(referenceStarts(ref)).toEqual([2, 5, 8, 11]);
    expect(referenceStarts({ ...ref, at: [9, 0, 9, 4] })).toEqual([0, 4, 9]);
  });
});

describe("referencePlayFrame", () => {
  // Four pictures from frame 2, three frames each: frames 2–13.
  const ref = { frames: ["a", "b", "c", "d"], width: 1, height: 1, start: 2, hold: 3, x: 0, y: 0, scale: 1 } as unknown as AnimationReference;
  it.each([
    [0, 24, 1, 2], [1 / 24, 24, 1, 3], [11 / 24, 24, 1, 13], [12 / 24, 24, 1, 2], [13 / 24, 24, 1, 3],
    [1, 12, 1, 2], [0.5, 24, 2, 2], [0.25, 24, 0.5, 5], [-1, 24, 1, 2],
  ])("at %ss, %d fps, ×%d: frame %d", (seconds, fps, speed, frame) => {
    expect(referencePlayFrame(ref, seconds, fps, speed)).toBe(frame);
  });
  it("shows every picture in turn, each for its hold, wrapping after the last", () => {
    const shown = Array.from({ length: 14 }, (_, i) => referenceIndexAt(ref, referencePlayFrame(ref, i / 24, 24)));
    expect(shown).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0, 0]);
  });
  it("loops over the pictures' own frames when they were moved apart", () => {
    const moved = { ...ref, at: [10, 0, 20, 5] } as AnimationReference;
    // Frames 0–22: 23 frames round.
    expect(referencePlayFrame(moved, 22 / 24, 24)).toBe(22);
    expect(referencePlayFrame(moved, 23 / 24, 24)).toBe(0);
  });
});
