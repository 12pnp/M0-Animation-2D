import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createProject } from "@/core/doc/defaults";
import type { AnimationReference, SymbolItem } from "@/core/doc/types";
import { fitReference, imageFrame, referenceEnd, referenceFrameOf, referenceIndexAt, referenceSpacing, sheetCells } from "@/core/doc/reference";
import { migrate, validateProject } from "@/core/doc/schema";
import { History } from "@/core/history/History";
import { SetAnimationReference } from "@/core/history/timelineCommands";

beforeEach(() => reseed());

const ref = (over: Partial<AnimationReference> = {}): AnimationReference => ({
  frames: ["a", "b", "c"] as AssetId[], width: 100, height: 200,
  at: [3, 5, 7], hold: 2, start: 3, x: 0, y: 0, scale: 1, ...over,
});

describe("reference timing", () => {
  it("shows each image for `hold` frames from `start`, and nothing outside", () => {
    const r = ref();
    expect([2, 3, 4, 5, 6, 7, 8, 9].map((f) => referenceIndexAt(r, f))).toEqual([null, 0, 0, 1, 1, 2, 2, null]);
    expect(referenceFrameOf(r, 2)).toBe(7);
    expect(referenceEnd(r)).toBe(8);
  });

  it("holds an image until the next one's frame, however uneven the spacing", () => {
    const r = ref({ at: [0, 5, 12] });
    expect([0, 4, 5, 11, 12, 13, 14].map((f) => referenceIndexAt(r, f))).toEqual([0, 0, 1, 1, 2, 2, null]);
    expect(referenceFrameOf(r, 1)).toBe(5);
    expect(referenceEnd(r)).toBe(13); // the last image holds `hold` frames
  });

  it("keeps the old even spacing when `at` is absent (half-migrated payload)", () => {
    const r = ref();
    delete (r as Partial<AnimationReference>).at;
    expect(referenceFrameOf(r, 2)).toBe(7);
    expect(referenceIndexAt(r, 6)).toBe(1);
    expect(referenceEnd(r)).toBe(8);
  });

  it("lets strip order decide when `at` is not ascending, visibly", () => {
    const r = ref({ at: [0, 10, 5] });
    expect(referenceIndexAt(r, 6)).toBe(2); // picture 3, keyed at 5, holds
    expect(referenceIndexAt(r, 10)).toBe(1); // until picture 2's key at 10 takes over
    expect(referenceIndexAt(r, 11)).toBe(1);
    expect(referenceIndexAt(r, 12)).toBeNull();
  });

  it("re-spaces every picture for the panel's bulk fields", () => {
    expect(referenceSpacing(3, 4, 5)).toEqual([4, 9, 14]);
  });
});

describe("placement", () => {
  it("stands the image over the rig: as tall, centred", () => {
    const p = fitReference(100, 200, { x: -30, y: -300, w: 60, h: 300 });
    expect(p).toEqual({ x: -75, y: -300, scale: 1.5 });
  });

  it("falls back to the image at its own size above the origin when the rig draws nothing", () => {
    expect(fitReference(100, 200, null)).toEqual({ x: -50, y: -200, scale: 1 });
  });
});

describe("sprite sheet cells", () => {
  it("reads left to right, top to bottom, and stops at the count", () => {
    const cells = sheetCells(400, 200, 4, 2, 6);
    expect(cells).toHaveLength(6);
    expect(cells[0]).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(cells[3]).toEqual({ x: 300, y: 0, w: 100, h: 100 });
    expect(cells[4]).toEqual({ x: 0, y: 100, w: 100, h: 100 });
  });

  it("drops the remainder of a sheet that does not divide evenly, and refuses cells under a pixel", () => {
    expect(sheetCells(410, 205, 4, 2)[7]).toEqual({ x: 306, y: 102, w: 102, h: 102 });
    expect(sheetCells(3, 3, 4, 1)).toEqual([]);
  });
});

describe("pictures for the AI", () => {
  it("fits every box inside the longest side, padded, and maps both ways", () => {
    const f = imageFrame([{ x: -50, y: -200, w: 100, h: 200 }, { x: -120, y: -150, w: 60, h: 50 }], 512, 16);
    expect(f.height).toBe(512);
    expect(f.width).toBe(Math.ceil(170 * f.scale + 32));
    expect(f.toPixel(-120, -200)).toEqual([16, 16]);
    const [px, py] = f.toPixel(10, -40);
    expect(f.fromPixel(px, py).map((v) => +v.toFixed(9))).toEqual([10, -40]);
  });

  it("ignores empty and broken boxes, and frames something even with none", () => {
    const f = imageFrame([{ x: 0, y: 0, w: 0, h: 10 }, { x: NaN, y: 0, w: 5, h: 5 }], 100, 0);
    expect(f.fromPixel(0, 0)).toEqual([-100, -100]);
    expect(f.width).toBe(100);
  });
});

describe("in the document", () => {
  it("survives the schema, repaired where it can be and dropped where it cannot", () => {
    const project = createProject("R");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    (sym.animations[0] as unknown as Record<string, unknown>).reference = {
      frames: ["a", 5, "b"], width: 64.4, height: 0, hold: -3, start: 2, x: "x", y: 4, scale: 0,
    };
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    expect((out.items[out.rootSymbolId] as SymbolItem).animations[0]!.reference).toEqual({
      frames: ["a", "b"], width: 64, height: 1, at: [2, 3], hold: 1, start: 2, x: 0, y: 4, scale: 1e-4,
    });
    (sym.animations[0] as unknown as Record<string, unknown>).reference = { frames: [] };
    const none = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    expect((none.items[none.rootSymbolId] as SymbolItem).animations[0]!.reference).toBeUndefined();
  });

  it("keeps each picture's frame when the file has one, and re-derives it when wrong", () => {
    const project = createProject("R");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const keep = { frames: ["a", "b"], width: 8, height: 8, at: [7, 2], hold: 2, start: 0, x: 0, y: 0, scale: 1 };
    (sym.animations[0] as unknown as Record<string, unknown>).reference = keep;
    const good = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    expect((good.items[good.rootSymbolId] as SymbolItem).animations[0]!.reference?.at).toEqual([7, 2]);

    const broken = { ...keep, at: [7] };
    (sym.animations[0] as unknown as Record<string, unknown>).reference = broken;
    const bad = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    expect((bad.items[bad.rootSymbolId] as SymbolItem).animations[0]!.reference?.at).toEqual([0, 2]);
  });

  it("is set and removed in one undo step each", () => {
    const project = createProject("R");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const anim = sym.animations[0]!;
    const history = new History(project);
    history.apply(new SetAnimationReference(sym.id, anim.id, ref(), "Add Reference"));
    expect(anim.reference?.frames).toEqual(["a", "b", "c"]);
    history.apply(new SetAnimationReference(sym.id, anim.id, undefined, "Delete Reference"));
    expect(anim.reference).toBeUndefined();
    history.undo();
    expect(anim.reference?.hold).toBe(2);
    history.undo();
    expect(anim.reference).toBeUndefined();
  });
});
