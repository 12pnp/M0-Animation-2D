import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addGuide, addReference, hasContent, moveGuide, moveReference, removeGuide, removeReference, updateReference, viewOf, withView } from "@/edit/sidecar";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { readSidecar, sidecarName, writeSidecar } from "@/io/sidecar";
import { axisOf, guideScreen, hitGuide, rulerAt, rulerOf, tickStep } from "@/ui/stage/guides";
import { hitReference, matchReferences, movedReference, referenceCorner, referenceFile, referenceQuad, scaledReference } from "@/ui/stage/references";
import { STICKMAN } from "./fixtures/rigs";
import type { Json } from "@/model/json";
import { EMPTY_SIDECAR, type Sidecar } from "@/model/sidecar";

const FULL: Sidecar = {
  view: new Map([["zoom", 2]]),
  guides: [{ axis: "x", at: 12.5 }],
  references: [{ path: "ref/run.png", x: 10, y: -4, scale: 0.5, opacity: 0.4 }],
  notes: [{ text: "hips lead", author: "AI", about: "hip" }, { text: "plain" }],
  tags: [{ key: "bone:hip", tags: ["IK", "left leg"] }, { key: "attachment:default/eye/open", tags: ["face"] }],
  extra: new Map([["later", true]]),
};

describe("sidecar", () => {
  it("writes and reads back everything, newer top-level keys included", () => {
    const { sidecar, issues } = readSidecar(writeSidecar(FULL));
    expect(issues).toEqual([]);
    expect(sidecar).toEqual(FULL);
  });
  it.each([
    ["not JSON", "{", /not JSON/],
    ["another format", '{"format": "x", "version": 1}', /not a boneburst-sidecar/],
    ["a newer version", '{"format": "boneburst-sidecar", "version": 2}', /version 2/],
  ])("refuses %s rather than guess", (_w, text, want) => {
    const { sidecar, issues } = readSidecar(text);
    expect(sidecar).toBe(EMPTY_SIDECAR);
    expect(issues[0]!.message).toMatch(want);
  });
  it("drops an entry that does not read, and says so", () => {
    const { sidecar, issues } = readSidecar('{"format": "boneburst-sidecar", "version": 1, "guides": [{"axis": "z", "at": 1}, {"axis": "y", "at": 2}]}');
    expect(sidecar.guides).toEqual([{ axis: "y", at: 2 }]);
    expect(issues).toEqual([{ where: "guides[0]", message: "does not read; dropped" }]);
  });
  it.each([["hero.json", "hero.bb.json"], ["a.b.JSON", "a.b.bb.json"], ["noext", "noext.bb.json"]])("names %s → %s", (a, b) => {
    expect(sidecarName(a)).toBe(b);
  });
});

describe("sidecar edits", () => {
  it("add, move and remove guides, to two decimals; no change is the same sidecar", () => {
    let s = addGuide(EMPTY_SIDECAR, "y", 10.456);
    s = addGuide(s, "x", -3);
    expect(s.guides).toEqual([{ axis: "y", at: 10.46 }, { axis: "x", at: -3 }]);
    expect(hasContent(s)).toBe(true);
    expect(moveGuide(s, 0, 10.4601)).toBe(s);
    s = moveGuide(s, 1, 7.25);
    expect(s.guides[1]).toEqual({ axis: "x", at: 7.25 });
    expect(removeGuide(s, 5)).toBe(s);
    expect(removeGuide(s, 0).guides).toEqual([{ axis: "x", at: 7.25 }]);
    expect(hasContent(EMPTY_SIDECAR)).toBe(false);
  });
  it("keeps the view through the file, a newer editor's view keys too, and leaves out what does not read", () => {
    const s = withView({ ...EMPTY_SIDECAR, view: new Map<string, Json>([["later", 1], ["skin", "old"]]) }, { camera: { x: 1.234, y: -5, zoom: 2.123456 }, skin: "alt", animation: "run", bone: "hips", loopOff: ["jump"] });
    const back = readSidecar(writeSidecar(s)).sidecar;
    expect(viewOf(back)).toEqual({ camera: { x: 1.23, y: -5, zoom: 2.1235 }, skin: "alt", animation: "run", bone: "hips", loopOff: ["jump"] });
    expect(back.view.get("later")).toBe(1);
    expect(viewOf(withView(back, {}))).toEqual({});
    expect(viewOf({ ...EMPTY_SIDECAR, view: new Map<string, Json>([["camera", new Map<string, Json>([["x", 1], ["y", 2], ["zoom", 0]])], ["skin", 3]]) })).toEqual({});
  });
  it("drops TwinSpline's paths (a top-level `motion`, docs/REMOVE-TWINSPLINE-PLAN.md) on reading, and writes none back", () => {
    const text = JSON.stringify({ format: "boneburst-sidecar", version: 1, notes: [{ text: "kept" }], motion: [{ animation: "run", bone: "hip", nodes: [{ x: 0, y: 0 }, { x: 5, y: 8, speed: 2 }], closed: true, duration: 0.5 }], later: 1 });
    const { sidecar, issues } = readSidecar(text);
    expect(issues).toEqual([]);
    expect(sidecar).not.toHaveProperty("motion");
    expect(sidecar.extra.has("motion")).toBe(false);
    expect(sidecar.extra.get("later")).toBe(1);
    expect(sidecar.notes).toEqual([{ text: "kept" }]);
    const back = writeSidecar(sidecar);
    expect(back).not.toContain('"motion"');
    expect(back).not.toContain("speed");
    expect(readSidecar(back).sidecar).toEqual(sidecar);
  });
  it("never changes the skeleton: its text is the same with any sidecar beside it", () => {
    const text = readFileSync(join(STICKMAN, "Stickman_IK.json"), "utf8");
    const doc = readSkeleton(text).skeleton;
    const before = writeSkeleton(doc);
    writeSidecar(withView(addGuide(FULL, "x", 4), { skin: "x" }));
    expect(writeSkeleton(doc)).toBe(before);
  });
});

describe("rulers and guides on the stage", () => {
  const cam = { x: 0, y: 0, zoom: 2 }, size = { width: 400, height: 300 };
  it("the top ruler makes horizontal guides, the left one vertical; the corner neither", () => {
    expect(rulerAt(200, 5)).toBe("top");
    expect(rulerAt(5, 200)).toBe("left");
    expect(rulerAt(5, 5)).toBeNull();
    expect(rulerAt(200, 200)).toBeNull();
    expect(axisOf("top")).toBe("y");
    expect(rulerOf("x")).toBe("left");
  });
  it("finds the guide under the pointer, on screen where its value is", () => {
    const guides = [{ axis: "x" as const, at: 10 }, { axis: "y" as const, at: -20 }];
    // x = 10 at zoom 2 → 220 px; y = -20 → 150 + 40 = 190 px.
    expect(guideScreen(guides[0]!, cam, size)).toBe(220);
    expect(guideScreen(guides[1]!, cam, size)).toBe(190);
    expect(hitGuide(guides, cam, size, 223, 50)).toBe(0);
    expect(hitGuide(guides, cam, size, 50, 187)).toBe(1);
    expect(hitGuide(guides, cam, size, 300, 50)).toBe(-1);
  });
  it("spaces ticks 1, 2 or 5 × 10ⁿ, at least 50 pixels apart", () => {
    expect(tickStep(1)).toBe(50);
    expect(tickStep(2)).toBe(50);
    expect(tickStep(3)).toBe(20);
    expect(tickStep(0.1)).toBe(500);
    expect(tickStep(40)).toBe(2);
  });
});

describe("reference images", () => {
  const ref = { path: "refs/run.png", x: 10.456, y: -2, scale: 0.5, opacity: 0.4 };
  it("add, update, order and remove; values checked, two decimals for the place", () => {
    let s = addReference(EMPTY_SIDECAR, ref);
    expect(s.references).toEqual([{ ...ref, x: 10.46 }]);
    expect(hasContent(s)).toBe(true);
    s = addReference(s, { path: "b.png", x: 0, y: 0, scale: 1, opacity: 1 });
    expect(updateReference(s, 0, { opacity: 0.4 })).toBe(s);
    s = updateReference(s, 0, { opacity: 0.25, scale: 2 });
    expect(s.references[0]).toMatchObject({ opacity: 0.25, scale: 2 });
    expect(() => updateReference(s, 0, { opacity: 1.5 })).toThrow(/from 0 to 1/);
    expect(() => updateReference(s, 0, { scale: 0 })).toThrow(/above 0/);
    expect(() => addReference(s, { ...ref, path: " " })).toThrow(/file name/);
    expect(moveReference(s, 1, 0).references.map((r) => r.path)).toEqual(["b.png", "refs/run.png"]);
    expect(moveReference(s, 0, 0)).toBe(s);
    expect(removeReference(s, 0).references.map((r) => r.path)).toEqual(["b.png"]);
    expect(readSidecar(writeSidecar(s)).sidecar.references).toEqual(s.references);
  });
  it("draw centred on their place, sized by their pixels times their scale, the image upright", () => {
    const q = referenceQuad({ path: "a.png", x: 10, y: 20, scale: 0.5, opacity: 1 }, 200, 100);
    // 100 × 50 units around (10, 20): top-left (-40, 45) shows the image's top-left (u 0, v 0).
    expect(q.xy).toEqual([-40, 45, 60, 45, 60, -5, -40, -5]);
    expect(q.uv).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(referenceFile("refs/run.png")).toBe("run.png");
  });
  it("take their pictures from the opened images by file name, never an atlas page", () => {
    const m = matchReferences(["refs/Run.png", "walk.png", "hero.png"], ["run.PNG", "hero.png", "extra.png"], ["hero.png"]);
    expect([...m.found]).toEqual([["refs/Run.png", "run.PNG"]]);
    expect(m.missing).toEqual(["walk.png", "hero.png"]);
  });
});

describe("references dragged on the stage (E4 step 13)", () => {
  const ref = (x: number, y: number, scale = 1) => ({ path: "a.png", x, y, scale, opacity: 0.5 });
  it("picks the topmost picture under the point, never a missing one", () => {
    const placed = [{ r: ref(0, 0), width: 100, height: 100 }, null, { r: ref(40, 0, 0.5), width: 100, height: 100 }];
    expect(hitReference(placed, 30, 10)).toBe(2);
    expect(hitReference(placed, -40, 0)).toBe(0);
    expect(hitReference(placed, 0, 51)).toBe(-1);
    expect(hitReference([null], 0, 0)).toBe(-1);
    // Scale counts: half size reaches 25 either side of 40.
    expect(hitReference(placed, 66, 0)).toBe(-1);
  });
  it("finds a corner within the radius, the nearest", () => {
    const p = { r: ref(0, 0, 2), width: 10, height: 20 };
    // y up in the world, down on screen.
    const screen = (x: number, y: number): [number, number] => [x + 100, 100 - y];
    expect(referenceCorner(p, screen, 90, 80)).toBe(0);
    expect(referenceCorner(p, screen, 112, 122)).toBe(2);
    expect(referenceCorner(p, screen, 100, 100)).toBe(-1);
  });
  it("moves by the pointer's travel and scales about its centre, never to 0", () => {
    expect(movedReference(ref(5, 5), [10, 10], [13, 6])).toEqual({ x: 8, y: 1 });
    expect(scaledReference(ref(0, 0, 0.5), [10, 0], [0, 20])).toBe(1);
    expect(scaledReference(ref(0, 0, 0.5), [10, 0], [0, 0])).toBe(0.005);
    expect(scaledReference(ref(0, 0, 0.5), [0, 0], [5, 5])).toBe(0.5);
    // About its own centre, not the origin.
    expect(scaledReference(ref(100, 50, 1), [110, 50], [100, 80])).toBe(3);
  });
});
