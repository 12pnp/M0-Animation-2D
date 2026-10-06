import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAttachment, type AttachmentRef, findAttachment } from "@/edit/attachments";
import { History } from "@/edit/history";
import { type BoneWorlds, decodeBinds, isWeighted } from "@/edit/meshLayout";
import { addPathPoint, deletePathPoint, localOf, movePathPoint, newPathAttachment, movePathVertex, pathFrame, pathPositions, pointCount, runsAtConstantSpeed, setPathFlags, worldOf } from "@/edit/path";
import { NO_IMAGES } from "@/engine/regions";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { Skeleton } from "@/model/skeleton";
import { boneMatrix, Poser } from "@/ui/stage/posed";
import { SAMPLES } from "./fixtures/samples";

const REF: AttachmentRef = { skin: "default", slot: "rope", key: "rope" };

/** A bone at (10, 20) scaled 2, a slot on it, and a path of three points on a straight line (x = 0, 100, 200 in its space). */
function straight(extra: Record<string, unknown> = {}): Skeleton {
  const line = [-20, 0, 0, 0, 20, 0, 80, 0, 100, 0, 120, 0, 180, 0, 200, 0, 220, 0];
  return readSkeleton(JSON.stringify({
    skeleton: { hash: "h", spine: "4.3.40" },
    bones: [{ name: "root" }, { name: "arm", parent: "root", x: 10, y: 20, scaleX: 2, scaleY: 2 }],
    slots: [{ name: "rope", bone: "arm" }],
    skins: [{ name: "default", attachments: { rope: { rope: { type: "path", vertexCount: 9, vertices: line, lengths: [0, 0, 0], constantSpeed: false, ...extra } } } }],
  })).skeleton;
}

/** The setup bones' world matrices, with the skin shown that makes the bones a path is bound to active. */
function setup(s: Skeleton, skin: string | null = null): BoneWorlds {
  const p = new Poser(s, NO_IMAGES).pose(skin, null, 0);
  return s.bones!.map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]);
}

describe("a path's points, unbound", () => {
  it("moves a handle alone, and a point with its two handles", () => {
    const s = straight(), bones = setup(s);
    const h = new History(s, 50);
    h.apply("handle", movePathVertex(REF, 2, 30, 15, bones));
    const v = findAttachment(h.doc, REF)!.vertices!;
    expect([v[4], v[5]]).toEqual([30, 15]);
    expect(v.slice(0, 4)).toEqual([-20, 0, 0, 0]);
    h.apply("point", movePathPoint(REF, 1, 110, 40, bones));
    const w = findAttachment(h.doc, REF)!.vertices!;
    expect(w.slice(6, 12)).toEqual([90, 40, 110, 40, 130, 40]);
  });
  it("takes slot-space (Local) values, and converts to and from the world through the slot's bone", () => {
    const s = straight(), bones = setup(s), a = findAttachment(s, REF)!, f = pathFrame(s, REF, a, bones)!;
    // The slot's bone is at (10, 20) scaled 2: local (100, 0) is world (210, 20).
    const w = worldOf(f, 100, 0), l = localOf(f, 210, 20);
    expect(w[0]).toBeCloseTo(210, 3);
    expect(w[1]).toBeCloseTo(20, 3);
    expect(l[0]).toBeCloseTo(100, 3);
    expect(l[1]).toBeCloseTo(0, 3);
  });
  it("refuses what is not a point, and values that are not numbers", () => {
    const s = straight(), bones = setup(s);
    expect(() => movePathPoint(REF, 3, 0, 0, bones)(s)).toThrow(/no point 3/);
    expect(() => movePathVertex(REF, 9, 0, 0, bones)(s)).toThrow(/no vertex 9/);
    expect(() => movePathVertex(REF, 0, Number.NaN, 0, bones)(s)).toThrow();
    expect(() => movePathPoint({ ...REF, key: "nope" }, 0, 0, 0, bones)(s)).toThrow(/no attachment/);
  });
  it("is the same document when nothing moved", () => {
    const s = straight(), bones = setup(s);
    expect(movePathVertex(REF, 0, -20, 0, bones)(s)).toBe(s);
  });
});

describe("a path's lengths", () => {
  it("are the cumulative world lengths of the curves when it does not run at constant speed", () => {
    const s = straight(), bones = setup(s);
    const out = movePathPoint(REF, 2, 201, 0, bones)(s);
    // Curves of 100 and 101 slot units, the slot's bone scaled 2: 200 and 202 world units, cumulative; the rest filled.
    const l = findAttachment(out, REF)!.lengths!;
    expect(l).toHaveLength(3);
    expect(l[0]).toBeCloseTo(200, 1);
    expect(l[1]).toBeCloseTo(402, 1);
    expect(l[2]).toBeCloseTo(402, 1);
  });
  it("are left as written at constant speed, which is Spine's default when the file says nothing", () => {
    for (const extra of [{ constantSpeed: true }, { constantSpeed: undefined }]) {
      const s = straight(extra), bones = setup(s);
      expect(runsAtConstantSpeed(findAttachment(s, REF)!)).toBe(true);
      expect(findAttachment(movePathPoint(REF, 2, 300, 0, bones)(s), REF)!.lengths).toEqual([0, 0, 0]);
    }
    const s = straight({ constantSpeed: true }), bones = setup(s);
    const out = movePathPoint(REF, 2, 300, 0, bones)(s);
    expect(findAttachment(out, REF)!.lengths).toEqual([0, 0, 0]);
  });
  it("follow the flags: closed adds the closing curve, constant speed stops them being kept", () => {
    const s = straight(), bones = setup(s);
    const closed = setPathFlags(REF, { closed: true }, bones)(s);
    expect(findAttachment(closed, REF)!.closed).toBe(true);
    expect(findAttachment(closed, REF)!.lengths![2]).toBeGreaterThan(findAttachment(closed, REF)!.lengths![1]!);
    expect(findAttachment(setPathFlags(REF, { closed: false }, bones)(closed), REF)!.closed).toBeUndefined();
  });
});

describe("points added and removed", () => {
  it("adds a point last with its handles, and removes one with its handles; lengths keep a count a point", () => {
    const s = straight(), bones = setup(s);
    const more = addPathPoint(REF, 300, 0, bones)(s), a = findAttachment(more, REF)!;
    expect([a.vertexCount, a.vertices!.length, pointCount(a), a.lengths!.length]).toEqual([12, 24, 4, 4]);
    // The handles lie a third of the way back to the last point, either side along the path.
    expect(a.vertices!.slice(18, 24)).toEqual([266.6667, 0, 300, 0, 333.3333, 0]);
    const fewer = deletePathPoint(REF, 3, bones)(more), b = findAttachment(fewer, REF)!;
    expect([b.vertexCount, b.vertices!.length, b.lengths!.length]).toEqual([9, 18, 3]);
  });
  it("keeps at least two points", () => {
    let s = straight();
    const bones = setup(s);
    s = deletePathPoint(REF, 2, bones)(s);
    expect(() => deletePathPoint(REF, 1, bones)(s)).toThrow(/at least two/);
  });
});

describe("a path bound to bones", () => {
  const text = readFileSync(join(SAMPLES, "Hero", "hero-pro.json"), "utf8");
  const s = readSkeleton(text).skeleton, ref: AttachmentRef = { skin: "default", slot: "weapon-morningstar-path", key: "weapon-morningstar-path" };
  const bones = setup(s, "weapon/morningstar"), a = findAttachment(s, ref)!;
  it("is weighted, and a move keeps every weight and brings the vertex to where it was sent", () => {
    expect(isWeighted(a)).toBe(true);
    const f = pathFrame(s, ref, a, bones)!, before = pathPositions(a, f);
    const out = movePathPoint(ref, 1, before[8]! + 25, before[9]! - 10, bones)(s), b = findAttachment(out, ref)!;
    const after = pathPositions(b, f);
    expect(after[8]!).toBeCloseTo(before[8]! + 25, 1);
    expect(after[9]!).toBeCloseTo(before[9]! - 10, 1);
    // The point's handles went with it; the other points did not.
    expect(after[6]!).toBeCloseTo(before[6]! + 25, 1);
    expect(after[10]!).toBeCloseTo(before[10]! + 25, 1);
    expect(after[14]!).toBeCloseTo(before[14]!, 3);
    expect(decodeBinds(b.vertices!).map((v) => v.map((x) => [x.bone, x.w]))).toEqual(decodeBinds(a.vertices!).map((v) => v.map((x) => [x.bone, x.w])));
  });
});

describe("the file round trip", () => {
  it("writes an edited path and reads it back the same, weighted or not, constraint fields included", () => {
    for (const s0 of [straight(), readSkeleton(readFileSync(join(SAMPLES, "Hero", "hero-pro.json"), "utf8")).skeleton]) {
      const ref = s0.bones!.length > 2 && findAttachment(s0, { skin: "default", slot: "weapon-morningstar-path", key: "weapon-morningstar-path" }) ? { skin: "default", slot: "weapon-morningstar-path", key: "weapon-morningstar-path" } : REF;
      const bones = setup(s0, ref === REF ? null : "weapon/morningstar"), a = findAttachment(s0, ref)!, f = pathFrame(s0, ref, a, bones)!, p = pathPositions(a, f);
      const edited = addPathPoint(ref, p[4]! + 40, p[5]! + 40, bones)(movePathPoint(ref, 0, p[2]! + 5, p[3]! + 5, bones)(s0));
      const back = readSkeleton(writeSkeleton(edited)).skeleton;
      expect(back.skins).toEqual(edited.skins);
      expect(back.constraints).toEqual(edited.constraints);
      expect(writeSkeleton(back)).toBe(writeSkeleton(edited));
    }
  });
});

describe("an edited path moves what follows it", () => {
  it("poses the bones of a path constraint somewhere else, and the same again from the written file", () => {
    const s = readSkeleton(readFileSync(join(SAMPLES, "Stretchyman", "stretchyman.json"), "utf8")).skeleton;
    const ref: AttachmentRef = { skin: "default", slot: "back-arm-path", key: "back-arm-path" };
    const bones = setup(s), a = findAttachment(s, ref)!, f = pathFrame(s, ref, a, bones)!, pos = pathPositions(a, f);
    const edited = movePathPoint(ref, 1, pos[8]! + 40, pos[9]! - 30, bones)(s);
    const pose = (d: Skeleton) => { const p = new Poser(d, NO_IMAGES).pose(null, null, 0); return d.bones!.map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]); };
    const before = pose(s), after = pose(edited), again = pose(readSkeleton(writeSkeleton(edited)).skeleton);
    const worst = (x: number[][], y: number[][]) => Math.max(...x.flatMap((m, i) => m.map((v, k) => Math.abs(v - y[i]![k]!))));
    expect(worst(before, after)).toBeGreaterThan(1);
    expect(worst(after, again)).toBeLessThan(1e-3);
  });
});

describe("a new path", () => {
  it("is two points 100 apart with their handles, open, at constant speed, and a valid path in the file", () => {
    const a = newPathAttachment(10, 20);
    expect(a).toMatchObject({ type: "path", vertexCount: 6, lengths: [0, 0] });
    expect(a.vertices).toEqual([-23.33, 20, 10, 20, 43.33, 20, 76.67, 20, 110, 20, 143.33, 20]);
    expect(runsAtConstantSpeed(a)).toBe(true);
  });
  it("is made on a slot, written, and read back the same, and can be edited at once", () => {
    const s = straight(), ref: AttachmentRef = { skin: "default", slot: "rope", key: "second" };
    const withNew = addAttachment(ref, newPathAttachment())(s);
    expect(readSkeleton(writeSkeleton(withNew)).skeleton.skins).toEqual(withNew.skins);
    const out = movePathPoint(ref, 1, 90, 5, setup(withNew))(withNew);
    expect(findAttachment(out, ref)!.vertices!.slice(6, 12)).toEqual([56.67, 5, 90, 5, 123.33, 5]);
  });
  it("turns constant speed off by writing false, and on by leaving the key out; lengths follow", () => {
    const s = straight({ constantSpeed: true }), bones = setup(s);
    const off = setPathFlags(REF, { constantSpeed: false }, bones)(s), a = findAttachment(off, REF)!;
    expect(a.constantSpeed).toBe(false);
    expect(a.lengths![0]).toBeCloseTo(200, 1);
    const on = setPathFlags(REF, { constantSpeed: true }, bones)(off);
    expect(findAttachment(on, REF)!.constantSpeed).toBeUndefined();
  });
});
