import { describe, expect, it } from "vitest";
import { deleteKeys, keySpan, keyTweenOf, keyTweenSpec, moveKeys, SMOOTH_CURVE, withKeyAt, withKeyTween, type ListKey } from "@/core/doc/keyList";

type K = ListKey & { v: number };
const k = (frame: number, v: number, tween?: K["tween"]): K => (tween ? { frame, v, tween } : { frame, v });

describe("keySpan", () => {
  const keys = [k(0, 0), k(10, 10, { kind: "none" }), k(20, 20)];
  it.each([
    [-1, null],
    [0, { a: 0, b: 10, e: 0 }],
    [5, { a: 0, b: 10, e: 0.5 }],
    [12, { a: 10, b: undefined, e: 0 }], // stepped holds
    [25, { a: 20, b: undefined, e: 0 }], // past the last key
  ])("at %s", (frame, want) => {
    const s = keySpan(keys, frame);
    expect(s && { a: s.a.frame, b: s.b?.frame, e: s.e }).toEqual(want);
  });
  it("is null with no keys", () => expect(keySpan(undefined, 3)).toBeNull());
});

describe("edits", () => {
  const keys = [k(0, 0), k(5, 5), k(10, 10)];
  it("moves keys, replacing what they land on, never before 0", () => {
    expect(moveKeys(keys, [5], 5).map((x) => [x.frame, x.v])).toEqual([[0, 0], [10, 5]]);
    expect(moveKeys(keys, [0, 5], -5).map((x) => [x.frame, x.v])).toEqual([[0, 5], [10, 10]]);
  });
  it("deletes keys", () => expect(deleteKeys(keys, [0, 10]).map((x) => x.frame)).toEqual([5]));
  it("puts a key at a frame from the one there", () => {
    const out = withKeyAt([k(0, 0, { kind: "none" }), k(4, 4)], 0, (at) => ({ ...at!, v: 9 }));
    expect(out).toEqual([k(0, 9, { kind: "none" }), k(4, 4)]);
    expect(withKeyAt(keys, 7, () => k(7, 7)).map((x) => x.frame)).toEqual([0, 5, 7, 10]);
  });
  it("sets tweens by name or spec, linear as none", () => {
    expect(withKeyTween(keys, [5], "smooth")[1]!.tween).toEqual({ kind: "curve", curve: SMOOTH_CURVE });
    expect(withKeyTween(keys, [5], { kind: "none" })[1]!.tween).toEqual({ kind: "none" });
    expect("tween" in withKeyTween([k(0, 0, { kind: "none" })], [0], "linear")[0]!).toBe(false);
  });
  it.each(["linear", "stepped", "smooth"] as const)("round-trips %s", (t) => {
    const spec = keyTweenSpec(t);
    expect(keyTweenOf(spec ? { frame: 0, tween: spec } : { frame: 0 })).toBe(t);
  });
});
