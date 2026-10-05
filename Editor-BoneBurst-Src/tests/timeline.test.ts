import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { keyLists } from "@/model/timelines";
import { atlasImages } from "@/engine/regions";
import { animatedLocal, Poser } from "@/ui/stage/posed";
import { buildRows, shiftedRefs, frameX, labelStep, markAt, marks, refId, ROW, rowAt, RULER, xFrame } from "@/ui/timeline/layout";
import { STICKMAN } from "./fixtures/rigs";

const stickman = () => readSkeleton(readFileSync(join(STICKMAN, "Stickman_IK.json"), "utf8")).skeleton;
const images = () => atlasImages(readAtlas(readFileSync(join(STICKMAN, "Stickman_IK.atlas.txt"), "utf8")));

describe("timeline rows", () => {
  const doc = stickman(), run = doc.animations!.find((a) => a.name === "run")!;
  it("one row per keyed bone in the skeleton's order, every key list once", () => {
    const rows = buildRows(doc, run, null, new Set());
    const bones = (doc.bones ?? []).map((b) => b.name);
    const order = rows.filter((r) => r.bone !== undefined).map((r) => bones.indexOf(r.bone!));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(rows.flatMap((r) => r.lists).length).toBe(keyLists(run).length);
  });
  it("adds the selected bone even with no keys, and expands a row into its timelines", () => {
    const rows = buildRows(doc, { name: "empty", extra: new Map() }, "head", new Set());
    expect(rows.map((r) => r.id)).toEqual(["bone/head"]);
    const first = buildRows(doc, run, null, new Set())[0]!;
    const open = buildRows(doc, run, null, new Set([first.id]));
    const subs = open.filter((r) => r.depth === 1 && r.bone === first.bone);
    expect(subs.length).toBe(first.lists.length);
  });
  it("a row's diamonds are the frames with keys, each holding every key there", () => {
    const row = buildRows(doc, run, null, new Set()).find((r) => r.lists.length > 1)!;
    const ms = marks(row, 24);
    expect(ms.map((m) => m.frame)).toEqual([...new Set(ms.map((m) => m.frame))].sort((a, b) => a - b));
    expect(ms.reduce((n, m) => n + m.refs.length, 0)).toBe(row.lists.reduce((n, l) => n + l.keys.length, 0));
  });
});

describe("timeline geometry", () => {
  const v = { frameWidth: 10, first: 2 };
  it("maps frames to x and back", () => {
    expect(frameX(v, 2)).toBe(0);
    expect(frameX(v, 7)).toBe(50);
    expect(xFrame(v, 50)).toBe(7);
  });
  it("finds the row under y and the nearest diamond in reach", () => {
    expect(rowAt(RULER - 1, 5)).toBe(-1);
    expect(rowAt(RULER + ROW * 2 + 1, 5)).toBe(2);
    expect(rowAt(RULER + ROW * 9, 5)).toBe(-1);
    const ms = [{ frame: 5, refs: [], stepped: false, eased: false }, { frame: 6, refs: [], stepped: false, eased: false }];
    expect(markAt(v, ms, 34)!.frame).toBe(5);
    expect(markAt(v, ms, 38)!.frame).toBe(6);
    expect(markAt(v, ms, 80)).toBeNull();
  });
  it("labels the ruler at least 48 px apart", () => {
    expect(labelStep(60)).toBe(1);
    expect(labelStep(12)).toBe(5);
    expect(labelStep(1)).toBe(60);
  });
  it("a dragged key keeps the file's stored time until it has moved", () => {
    const path = { section: "bones" as const, owner: "a", timeline: "rotate" };
    const stored = [{ path, time: 0.0833333283662796 }];
    expect(shiftedRefs(stored, 0, 24)).toEqual(stored);
    expect(shiftedRefs(stored, 1, 24)).toEqual([{ path, time: 0.125 }]);
  });
  it("names a key by its list and frame, so float32 noise does not split it", () => {
    const path = { section: "bones" as const, owner: "a", timeline: "rotate" };
    expect(refId({ path, time: 0.0833333283662796 }, 24)).toBe(refId({ path, time: 0.083333336 }, 24));
  });
});

describe("posing an animation", () => {
  it("keeps the pose before constraints for keying: an IK-driven bone's own values", () => {
    const doc = stickman(), poser = new Poser(doc, images());
    const p = poser.pose(null, "run", Math.fround(0.25));
    const i = p.bones.get("leg_near_thigh")!;
    const before = animatedLocal(p, i).rotation, after = p.rig.local[i * 7 + 2]!;
    // The thigh is in a two-bone IK chain: the solver turns it away from its keyed value.
    expect(Math.abs(after - before)).toBeGreaterThan(0.01);
  });
  it("poses the same frame the same way however it is reached", () => {
    const poser = new Poser(stickman(), images());
    const at = (t: number) => Array.from(poser.pose(null, "run", Math.fround(t)).rig.world);
    const once = at(0.5);
    at(0.1);
    expect(at(0.5)).toEqual(once);
  });
});
