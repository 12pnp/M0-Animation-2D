import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createProject, createKeyframe, createNode } from "@/core/doc/defaults";
import type { SymbolItem } from "@/core/doc/types";
import { migrate, validateProject } from "@/core/doc/schema";
import { Store } from "@/app/Store";
import { PosesService } from "@/app/PosesService";
import { posePrompt } from "@/app/agent/poseHandoff";

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
    expect(text).toContain("Keep the pose frames' keys exactly as they are");
  });

  it("says nothing of a cap when every pose rides along", () => {
    expect(posePrompt("idle", 24, [0, 12], 2)).not.toContain("Only the first");
  });

  it("mentions the bones only when the pictures carry them", () => {
    expect(posePrompt("idle", 24, [0, 12], 2)).toContain("bones drawn and named");
    expect(posePrompt("idle", 24, [0, 12], 2, false)).not.toContain("bones");
  });
});

