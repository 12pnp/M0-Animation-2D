import { describe, expect, it } from "vitest";
import { onionFrames } from "@/ui/stage/onion";

/** Onion skin (E6 step 4d): which frames get a ghost, and how strong. */

const o = (before: number, after: number, keyedOnly = false) => ({ before, after, keyedOnly });
const frames = (r: ReturnType<typeof onionFrames>) => r.map((g) => `${g.side === "before" ? "-" : "+"}${g.frame}`);

describe("onion skin (E6 step 4d)", () => {
  it("every frame: the counts before and after, nearer stronger, stopped at the ends", () => {
    const r = onionFrames(5, 20, o(2, 3), [], false);
    expect(frames(r)).toEqual(["-4", "-3", "+6", "+7", "+8"]);
    expect(r[0]!.opacity).toBeGreaterThan(r[1]!.opacity);
    expect(r[2]!.opacity).toBeGreaterThan(r[4]!.opacity);
    expect(r[4]!.opacity).toBeGreaterThan(0);
    expect(frames(onionFrames(1, 20, o(3, 0), [], false))).toEqual(["-0"]);
    expect(frames(onionFrames(20, 20, o(0, 2), [], false))).toEqual([]);
  });

  it("a loop wraps past either end; the playhead's own frame is never a ghost", () => {
    expect(frames(onionFrames(1, 20, o(3, 0), [], true))).toEqual(["-0", "-19", "-18"]);
    expect(frames(onionFrames(19, 20, o(0, 2), [], true))).toEqual(["+20", "+1"]);
    expect(frames(onionFrames(0, 2, o(5, 0), [], true))).toEqual(["-1"]);
  });

  it("keyed frames only: the nearest keyed frames either side, wrapping when looping", () => {
    expect(frames(onionFrames(7, 30, o(2, 2, true), [0, 4, 4, 10, 16, 24], false))).toEqual(["-4", "-0", "+10", "+16"]);
    expect(frames(onionFrames(2, 30, o(2, 1, true), [0, 10, 24], true))).toEqual(["-0", "-24", "+10"]);
    expect(onionFrames(7, 30, o(0, 0, true), [0, 10], false)).toEqual([]);
  });
});
