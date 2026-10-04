import { describe, it, expect } from "vitest";
import { adjacentKeyFrame, keyFrames } from "@/core/doc/keyNav";
import type { Animation } from "@/core/doc/types";

const track = (id: string, frames: number[]) => ({ nodeId: id, keys: frames.map((frame) => ({ frame })), endFrame: 40 });
const anim = {
  duration: 40,
  tracks: { a: track("a", [0, 10, 20]), b: track("b", [5, 10, 30]) },
  drawOrder: [{ frame: 25 }],
} as unknown as Animation;

describe("keyFrames", () => {
  it("every layer and the draw order when nothing is selected", () => {
    expect(keyFrames(anim, null)).toEqual([0, 5, 10, 20, 25, 30]);
  });
  it("only the selected layers' keys", () => {
    expect(keyFrames(anim, ["b" as never])).toEqual([5, 10, 30]);
  });
  it("a selected node without a track has none", () => {
    expect(keyFrames(anim, ["c" as never])).toEqual([]);
  });
});

describe("adjacentKeyFrame", () => {
  const frames = [0, 5, 10, 20];
  const cases: Array<[string, number, -1 | 1, number | null]> = [
    ["next from between keys", 7, 1, 10],
    ["next from on a key skips it", 10, 1, 20],
    ["previous from between keys", 7, -1, 5],
    ["previous from on a key skips it", 5, -1, 0],
    ["next after the last key wraps to the first", 20, 1, 0],
    ["previous before the first wraps to the last", 0, -1, 20],
    ["next from past the end wraps too", 35, 1, 0],
    ["previous from past the end", 35, -1, 20],
  ];
  for (const [name, frame, dir, want] of cases) {
    it(name, () => expect(adjacentKeyFrame(frames, frame, dir)).toBe(want));
  }
  it("none when there are no keys", () => expect(adjacentKeyFrame([], 3, 1)).toBeNull());
  it("none when the only key is where the playhead is", () => {
    expect(adjacentKeyFrame([4], 4, 1)).toBeNull();
    expect(adjacentKeyFrame([4], 4, -1)).toBeNull();
    expect(adjacentKeyFrame([4], 9, 1)).toBe(4);
  });
});
