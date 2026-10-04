import { describe, it, expect } from "vitest";
import { animationAfterRemoval, uniqueAnimationName } from "@/core/doc/animationList";
import { toggledSkins } from "@/core/spine/spinePose";

describe("uniqueAnimationName", () => {
  const cases: Array<[string[], string]> = [
    [[], "animation"],
    [["animation"], "animation_2"],
    [["animation", "animation_2", "walk"], "animation_3"],
    [["walk"], "animation"],
  ];
  for (const [taken, want] of cases) it(JSON.stringify(taken), () => expect(uniqueAnimationName(taken)).toBe(want));
});

describe("animationAfterRemoval", () => {
  const ids = ["idle", "walk", "run"];
  const cases: Array<[string, string, string | null, string | null]> = [
    ["the current one survives another's removal", "run", "walk", "walk"],
    ["the current one goes: the next takes its place", "walk", "walk", "run"],
    ["the last one goes: the one before it", "run", "run", "walk"],
    ["the first one goes", "idle", "idle", "walk"],
    ["nothing was current", "walk", null, "run"],
  ];
  for (const [name, removed, current, want] of cases) {
    it(name, () => expect(animationAfterRemoval(ids, removed, current)).toBe(want));
  }
  it("none left", () => expect(animationAfterRemoval(["only"], "only", "only")).toBeNull());
});

describe("toggledSkins", () => {
  const named = ["hair/long", "hair/short", "hat", "shoes"];
  const cases: Array<[string, string[], string, string[]]> = [
    ["turns one on, in the rig's order", ["shoes"], "hat", ["hat", "shoes"]],
    ["turns one off", ["hat", "shoes"], "hat", ["shoes"]],
    ["from none", [], "hair/short", ["hair/short"]],
    ["drops what the rig no longer has", ["gone", "hat"], "shoes", ["hat", "shoes"]],
  ];
  for (const [name, shown, toggle, want] of cases) it(name, () => expect(toggledSkins(named, shown, toggle)).toEqual(want));
});
