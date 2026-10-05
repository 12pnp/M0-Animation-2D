import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { changedProps, KEY_GROUPS, keyProps } from "@/core/doc/keyButtons";
import { propertyKeys } from "@/core/doc/propertyKeys";
import { createNode } from "@/core/doc/defaults";
import { sampleTransformRaw } from "@/core/doc/timeline";
import { tf, type Transform } from "@/core/math/Transform";
import { TWEEN_LINEAR } from "@/core/math/easing";
import { TIMELINE_PROPS, type Track } from "@/core/doc/types";

beforeEach(() => reseed());

const node = { ...createNode("bone", "b"), bind: tf(10, 20, 5, 5) };
const track = (...ts: Transform[]): Track => ({
  nodeId: node.id, endFrame: 30,
  keys: ts.map((transform, i) => ({ frame: i * 10, transform, displayIndex: 0, tween: TWEEN_LINEAR })),
});

describe("what changed from the setup pose", () => {
  it.each([
    { name: "no keys: nothing", t: undefined, frame: 4, want: [] },
    { name: "at the setup pose: nothing", t: track(node.bind, node.bind), frame: 5, want: [] },
    { name: "moved in x only", t: track(node.bind, tf(30, 20, 5, 5)), frame: 5, want: ["x"] },
    { name: "turned and scaled", t: track(node.bind, tf(10, 20, 50, 50, 2, 1)), frame: 10, want: ["rotate", "scale"] },
    { name: "sheared", t: track(node.bind, tf(10, 20, 25, 5)), frame: 10, want: ["shear"] },
    { name: "back at setup at the frame: nothing", t: track(node.bind, tf(30, 0, 5, 5), node.bind), frame: 20, want: [] },
    { name: "a whole turn round is changed", t: track(node.bind, tf(10, 20, 365, 365)), frame: 10, want: ["rotate"] },
  ])("$name", ({ t, frame, want }) => {
    expect(changedProps(t, node, frame)).toEqual(want);
  });
});

describe("keying properties at a frame", () => {
  const moving = track(node.bind, tf(30, 0, 45, 45, 1.5, 1), node.bind);

  it.each([
    { group: "rotate" as const }, { group: "translate" as const }, { group: "scale" as const }, { group: "shear" as const },
  ])("the $group group: its keys at the frame, the pose unchanged", ({ group }) => {
    const out = keyProps(moving, node, KEY_GROUPS[group], 4);
    for (const p of KEY_GROUPS[group]) expect(propertyKeys(out, p)).toContain(4);
    for (let f = 0; f <= 20; f++) expect(sampleTransformRaw(out, f)).toEqual(sampleTransformRaw(moving, f));
  });

  it("everything at once; again at the same frame changes nothing", () => {
    const out = keyProps(moving, node, TIMELINE_PROPS, 4);
    for (const p of TIMELINE_PROPS) expect(propertyKeys(out, p)).toContain(4);
    expect(keyProps(out, node, TIMELINE_PROPS, 4)).toBe(out);
  });
});
