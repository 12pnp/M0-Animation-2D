import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keysOffFrame, setFps } from "@/edit/header";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";

/** The frame rate (E6 step 4i): the header's fps set, no key moved; keys off the new grid counted. */

const stick = readSkeleton(readFileSync(join(__dirname, "fixtures", "stickman", "Stickman_IK.json"), "utf8")).skeleton;

describe("the frame rate (E6 step 4i)", () => {
  it("sets the header's fps and nothing else; back to the default leaves it out", () => {
    expect(stick.header?.fps).toBe(24);
    const s = setFps(30)(stick);
    expect(s.header?.fps).toBe(30);
    expect(s.animations).toBe(stick.animations);
    expect(setFps(24)(stick)).toBe(stick);
    const none = setFps(undefined)(stick);
    expect(none.header && "fps" in none.header).toBe(false);
    expect(JSON.parse(writeSkeleton(none)).skeleton.fps).toBeUndefined();
  });

  it("refuses a rate that is not a whole number from 1 to 240", () => {
    for (const bad of [0, -24, 24.5, 241, Number.NaN]) expect(() => setFps(bad)(stick)).toThrow(/whole number from 1 to 240/);
  });

  it("counts the keys that fall between frames at a rate", () => {
    expect(keysOffFrame(stick, 24)).toBe(0);
    // The stickman keys every 2 frames at 24 fps: at 30, a key at 1/12 s is at frame 2.5.
    expect(keysOffFrame(stick, 30)).toBeGreaterThan(0);
    expect(keysOffFrame(stick, 48)).toBe(0);
  });
});
