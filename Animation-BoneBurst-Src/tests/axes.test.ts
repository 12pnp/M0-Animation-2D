import { describe, it, expect } from "vitest";
import {
  axisDirections, constrainToAxis, rotationFromShown, scaleFactors, shownRotation,
  shownTranslation, sweptAngle, translationFromShown,
} from "@/core/math/axes";
import { type Matrix2D, mat, matOf, mul } from "@/core/math/Matrix2D";
import { type Transform, tf, toMatrix } from "@/core/math/Transform";
import { type ChildState, compensateChildren } from "@/core/doc/compensate";
import type { NodeId } from "@/core/doc/ids";

const worldOf = (parent: Matrix2D, local: Transform) => mul(mat(), parent, toMatrix(mat(), local));
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

/** A parent turned 90° and moved: its x axis points down the stage. */
const parent = worldOf(mat(), tf(100, 50, 90, 90, 1, 1));
const local = tf(10, 0, 30, 30, 2, 1);
const world = worldOf(parent, local);

describe("shown values per axes", () => {
  it("Parent shows the stored values", () => {
    expect(shownTranslation("parent", local, world)).toEqual({ x: 10, y: 0 });
    expect(shownRotation("parent", local, world)).toBe(30);
  });

  it("World shows where the origin is and how it is turned on the stage", () => {
    const p = shownTranslation("world", local, world);
    close(p.x, 100); close(p.y, 60);
    close(shownRotation("world", local, world), 120);
  });

  it("Local measures x/y along the node's own turned axes", () => {
    const p = shownTranslation("local", local, world);
    close(p.x, 10 * Math.cos(Math.PI / 6)); close(p.y, -10 * Math.sin(Math.PI / 6));
  });

  for (const axes of ["parent", "local", "world"] as const) {
    it(`${axes}: writing what is shown changes nothing, and a new value reads back`, () => {
      const t = shownTranslation(axes, local, world);
      const same = translationFromShown(axes, t, local, parent);
      close(same.x, local.x); close(same.y, local.y);

      const moved = translationFromShown(axes, { x: t.x + 7, y: t.y - 3 }, local, parent);
      const back = shownTranslation(axes, moved, worldOf(parent, moved));
      close(back.x, t.x + 7); close(back.y, t.y - 3);

      const turned = rotationFromShown(axes, 200, local, world, parent);
      const rot = shownRotation(axes, turned, worldOf(parent, turned));
      close(((rot % 360) + 360) % 360, 200);
      // Shear survives a rotation.
      close(turned.skewX - turned.skewY, local.skewX - local.skewY);
    });
  }

  it("World rotation under a mirrored parent still reads back", () => {
    const mirrored = worldOf(mat(), tf(0, 0, 0, 0, -1, 1));
    const w = worldOf(mirrored, local);
    const turned = rotationFromShown("world", 45, local, w, mirrored);
    close(shownRotation("world", turned, worldOf(mirrored, turned)), 45);
  });
});

describe("Shift-locked Translate", () => {
  it("World locks to the stage axes", () => {
    expect(constrainToAxis({ x: 5, y: 2 }, axisDirections("world", world, parent))).toEqual({ x: 5, y: 0 });
  });

  it("Parent locks to the parent's axes", () => {
    const d = constrainToAxis({ x: 1, y: 8 }, axisDirections("parent", world, parent));
    close(d.x, 0); close(d.y, 8);
  });

  it("Local locks to the node's own axes", () => {
    const [u] = axisDirections("local", world, parent);
    const d = constrainToAxis({ x: u.x * 4 + 0.1, y: u.y * 4 }, axisDirections("local", world, parent));
    close(Math.hypot(d.x, d.y), Math.abs((u.x * 4 + 0.1) * u.x + u.y * 4 * u.y));
  });
});

describe("drag geometry", () => {
  const cases: Array<[string, { x: number; y: number }, { x: number; y: number }, number]> = [
    ["a quarter turn", { x: 10, y: 0 }, { x: 0, y: 10 }, 90],
    ["back the other way", { x: 0, y: 10 }, { x: 10, y: 0 }, -90],
    ["across the ±180 seam takes the short way", { x: -10, y: 1 }, { x: -10, y: -1 }, 11.42],
  ];
  for (const [name, from, to, want] of cases) {
    it(`sweptAngle: ${name}`, () => expect(sweptAngle({ x: 0, y: 0 }, from, to)).toBeCloseTo(want, 1));
  }

  it("scaleFactors reads each own axis", () => {
    const f = scaleFactors({ x: 0, y: 0 }, mat(), { x: 10, y: 10 }, { x: 20, y: 5 }, false);
    close(f.sx, 2); close(f.sy, 0.5);
  });

  it("scaleFactors on a turned node uses its axes, not the stage's", () => {
    const turned = matOf(0, 1, -1, 0, 0, 0);
    const f = scaleFactors({ x: 0, y: 0 }, turned, { x: 0, y: 10 }, { x: 0, y: 30 }, false);
    close(f.sx, 3); close(f.sy, 1);
  });

  it("scaleFactors: Shift is uniform, and an axis started on stays at 1", () => {
    const u = scaleFactors({ x: 0, y: 0 }, mat(), { x: 3, y: 4 }, { x: 6, y: 8 }, true);
    close(u.sx, 2); close(u.sy, 2);
    const flat = scaleFactors({ x: 0, y: 0 }, mat(), { x: 20, y: 0 }, { x: 40, y: 30 }, false);
    close(flat.sx, 2); close(flat.sy, 1);
  });
});

describe("compensateChildren", () => {
  const P = "p" as NodeId, BONE = "b" as NodeId, IMG = "i" as NodeId;
  const before = worldOf(mat(), tf(0, 0, 0, 0, 1, 1));
  const childLocal = tf(30, 5, 10, 10, 1, 1);
  const kids: ChildState[] = [
    { id: BONE, parentId: P, isBone: true, world: worldOf(before, childLocal), local: childLocal },
    { id: IMG, parentId: P, isBone: false, world: worldOf(before, childLocal), local: childLocal },
  ];
  const after = worldOf(mat(), tf(40, -20, 35, 35, 1.5, 1.5));

  it("keeps a compensated child where it was on the stage", () => {
    const out = compensateChildren(kids, new Map([[P, after]]), { bones: true, images: true });
    for (const k of kids) {
      const w = worldOf(after, out.get(k.id)!);
      for (const key of ["a", "b", "c", "d", "tx", "ty"] as const) close(w[key], k.world[key]);
    }
  });

  const cases: Array<[string, { bones: boolean; images: boolean }, NodeId[]]> = [
    ["Bones only", { bones: true, images: false }, [BONE]],
    ["Images only", { bones: false, images: true }, [IMG]],
    ["neither", { bones: false, images: false }, []],
  ];
  for (const [name, on, want] of cases) {
    it(name, () => expect([...compensateChildren(kids, new Map([[P, after]]), on).keys()]).toEqual(want));
  }

  it("leaves a child that is itself being edited to the edit", () => {
    const out = compensateChildren(kids, new Map([[P, after], [BONE, after]]), { bones: true, images: true });
    expect([...out.keys()]).toEqual([IMG]);
  });
});
