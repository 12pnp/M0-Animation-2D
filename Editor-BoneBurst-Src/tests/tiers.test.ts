import { describe, expect, it } from "vitest";
import { setOf, tiersAround } from "@/ui/stage/tiers";

/** root(0) ▸ hips(1) ▸ thigh(2) ▸ shin(3) ▸ foot(4); hips ▸ chest(5) ▸ head(6); chest ▸ arm(7). */
const parents = [-1, 0, 1, 2, 3, 1, 5, 5];

describe("tiers around a bone", () => {
  it("tier 1 up is the parent, 2 the grandparent, root-most first", () => {
    expect(tiersAround(parents, 4, 1, 0).above).toEqual([3]);
    expect(tiersAround(parents, 4, 3, 0).above).toEqual([1, 2, 3]);
  });
  it("only the tiers asked for, and not past the root", () => {
    expect(tiersAround(parents, 4, 0, 0).above).toEqual([]);
    const t = tiersAround(parents, 4, 99, 0);
    expect(t.above).toEqual([0, 1, 2, 3]);
    expect(t.maxUp).toBe(4);
  });
  it("down: children first, then theirs, each tier in the rig's order; a branch shows all of its bones at a tier", () => {
    expect(tiersAround(parents, 1, 0, 1).below).toEqual([2, 5]);
    expect(tiersAround(parents, 1, 0, 2).below).toEqual([2, 5, 3, 6, 7]);
    expect(tiersAround(parents, 5, 0, 9).below).toEqual([6, 7]);
  });
  it("the counts that exist: the root has no tier up, a leaf none down", () => {
    expect(tiersAround(parents, 0, 3, 0)).toMatchObject({ above: [], maxUp: 0, maxDown: 4 });
    expect(tiersAround(parents, 4, 0, 3)).toMatchObject({ below: [], maxDown: 0 });
  });
  it("a bone beside the chain is not drawn: the foot's tiers up are its own line, not the arm's", () => {
    expect(setOf(parents, 4, 2, 0)).toEqual([2, 3, 4]);
    expect(setOf(parents, 3, 1, 1)).toEqual([2, 3, 4]);
  });
  it("a loop in the parents cannot hang it", () => {
    expect(() => tiersAround([1, 0], 0, 5, 5)).not.toThrow();
  });
});
