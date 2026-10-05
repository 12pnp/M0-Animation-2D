import { describe, expect, it } from "vitest";
import { MathUtils, MixFrom, Physics, Skeleton, SkeletonJson } from "@esotericsoftware/spine-core";
import { type Matrix2D, mat, mul } from "@/core/math/Matrix2D";
import { type Transform, tf, toMatrix } from "@/core/math/Transform";
import {
  fromBoneBurstLocal, keyTime, keyValues, regionCentre, type BoneBurstLocal, toBoneBurstLocal,
} from "@/core/boneburst/transform";
import { BONEBURST_VERSION, type BoneBurstBone, type BoneBurstSkeletonFile } from "@/core/boneburst/types";

/**
 * The transform mapping, checked against the Spine runtime itself
 * (@esotericsoftware/spine-core 4.3.13, the preview's runtime) rather than
 * against a transcription of its maths: skeletons are built from the mapped
 * values, posed by the runtime, and compared with the editor's own
 * composition, flipped to y up.
 */

// The runtime's JSON reader takes an attachment loader; bones-only
// skeletons never call it.
const reader = () => new SkeletonJson({} as never);

function load(file: BoneBurstSkeletonFile): Skeleton {
  const skeleton = new Skeleton(reader().readSkeletonData(file));
  skeleton.updateWorldTransform(Physics.none);
  return skeleton;
}

function bone(name: string, parent: string | undefined, s: BoneBurstLocal): BoneBurstBone {
  return { name, ...(parent ? { parent } : {}), ...s };
}

/** The editor's world matrix as the runtime holds it: y flipped, and Spine's
 *  a/b/c/d are row-major (b is the y axis's x), where Matrix2D's b is the x
 *  axis's y. */
function expectedSpineWorld(m: Matrix2D): number[] {
  return [m.a, -m.c, -m.b, m.d, m.tx, -m.ty];
}

function runtimeWorld(skeleton: Skeleton, name: string): number[] {
  const p = skeleton.findBone(name)!.appliedPose;
  return [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
}

function expectClose(actual: number[], expected: number[], eps: number): void {
  for (let i = 0; i < expected.length; i++) {
    const tol = eps * Math.max(1, Math.abs(expected[i]!));
    if (Math.abs(actual[i]! - expected[i]!) > tol) {
      throw new Error(`component ${i}: ${actual[i]} vs ${expected[i]} (all: ${actual} vs ${expected})`);
    }
  }
}

/**
 * The runtime's degrees-to-radians uses `MathUtils.PI = 3.1415927`, 1.5e-8
 * off, so its matrices differ from exact ones by about |angle in radians| ×
 * 1.5e-8 (2e-7 at two turns: a ten-thousandth of a pixel on a 1000px rig).
 * Not worth copying into the stage; the tolerance allows for it instead.
 */
const RUNTIME_PI_EPS = 1e-6;

const PI_REL_ERROR = Math.abs(MathUtils.PI - Math.PI) / Math.PI;

/**
 * How far the runtime's world matrix can be from the exact one because of
 * the rounded pi alone, per component, down a chain of Spine locals. Each
 * local axis angle (in radians, the +90 of the y axis included) is off by at
 * most |angle| × PI_REL_ERROR, which moves that axis by as much times its
 * scale; parents carry the error down through their own matrix norm. A
 * mismatch beyond this is the mapping's fault, not the runtime's pi.
 */
function piErrorBounds(locals: BoneBurstLocal[]): number[] {
  const rad = Math.PI / 180;
  let err = 0;           // bound on any parent linear component's error
  let errT = 0;          // bound on the parent's translation error
  let normWorld = 1;      // max abs row sum of the parent's linear part
  const out: number[] = [];
  for (const s of locals) {
    const ax = Math.abs(s.rotation + s.shearX) * rad * PI_REL_ERROR;
    const ay = Math.abs(s.rotation + 90 + s.shearY) * rad * PI_REL_ERROR;
    const eLocal = Math.abs(s.scaleX) * ax + Math.abs(s.scaleY) * ay;
    const normLocal = Math.abs(s.scaleX) + Math.abs(s.scaleY);
    const eLinear = normWorld * eLocal + err * normLocal;
    errT = errT + err * (Math.abs(s.x) + Math.abs(s.y));
    err = eLinear;
    normWorld = normWorld * normLocal;
    out.push(Math.max(err, errT));
  }
  return out;
}

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTransform(r: () => number): Transform {
  const angle = () => (r() - 0.5) * 1440;                 // up to two turns either way
  const scale = () => (r() < 0.2 ? -1 : 1) * (0.2 + r() * 2.5);
  const skewY = angle();
  // Half pure rotations, half sheared.
  const skewX = r() < 0.5 ? skewY : skewY + (r() - 0.5) * 120;
  return tf((r() - 0.5) * 400, (r() - 0.5) * 400, skewX, skewY, scale(), scale());
}

const TABLE: Array<[string, Transform]> = [
  ["identity", tf()],
  ["translation", tf(12, -7)],
  ["quarter turn", tf(0, 0, 90, 90)],
  ["y-down clockwise 30°", tf(5, 5, 30, 30)],
  ["shear only", tf(0, 0, 25, 0)],
  ["shear and rotation", tf(3, 4, -40, 15, 1.5, 0.5)],
  ["mirrored x", tf(0, 0, 10, 10, -1, 1)],
  ["mirrored y", tf(0, 0, 10, 10, 1, -2)],
  ["two and a half turns", tf(0, 0, 900, 900)],
  ["near-singular skew", tf(0, 0, 89.9, -0.1, 2, 3)],
];

describe("toBoneBurstLocal / fromBoneBurstLocal", () => {
  it.each(TABLE)("round-trips %s exactly", (_name, t) => {
    const back = fromBoneBurstLocal(toBoneBurstLocal(t));
    expect(back.x).toBeCloseTo(t.x, 12);
    expect(back.y).toBeCloseTo(t.y, 12);
    expect(back.skewX).toBeCloseTo(t.skewX, 12);
    expect(back.skewY).toBeCloseTo(t.skewY, 12);
    expect(back.scaleX).toBe(t.scaleX);
    expect(back.scaleY).toBe(t.scaleY);
  });

  it("keeps multi-turn angles unwrapped", () => {
    expect(toBoneBurstLocal(tf(0, 0, 900, 900)).rotation).toBe(-900);
    expect(fromBoneBurstLocal({ ...toBoneBurstLocal(tf()), rotation: -1080 }).skewY).toBe(1080);
  });

  it("writes no negative zero", () => {
    const s = toBoneBurstLocal(tf(0, 0, 0, 0));
    for (const v of Object.values(s)) expect(Object.is(v, -0)).toBe(false);
  });

  it("reads a bone with shearX as the same matrix", () => {
    const s: BoneBurstLocal = { x: 1, y: 2, rotation: 20, shearX: 15, shearY: -30, scaleX: 1.2, scaleY: 0.7 };
    const skeleton = load({ skeleton: { spine: BONEBURST_VERSION }, bones: [bone("b", undefined, s)] });
    const m = toMatrix(mat(), fromBoneBurstLocal(s));
    expectClose(runtimeWorld(skeleton, "b"), expectedSpineWorld(m), RUNTIME_PI_EPS);
  });
});

describe("the runtime composes the editor's world matrices, flipped", () => {
  it("still uses the rounded pi RUNTIME_PI_EPS allows for", () => {
    expect(MathUtils.PI).toBe(3.1415927);
  });



  it.each(TABLE)("single bone: %s", (_name, t) => {
    const skeleton = load({ skeleton: { spine: BONEBURST_VERSION }, bones: [bone("b", undefined, toBoneBurstLocal(t))] });
    expectClose(runtimeWorld(skeleton, "b"), expectedSpineWorld(toMatrix(mat(), t)), RUNTIME_PI_EPS);
  });

  // Held to what the rounded pi can explain (piErrorBounds), not to a
  // blanket tolerance: deep, scaled chains amplify it past any fixed one.
  it("random chains up to six bones deep, 200 of them", () => {
    const r = rng(1234);
    for (let n = 0; n < 200; n++) {
      const depth = 1 + Math.floor(r() * 6);
      const locals = Array.from({ length: depth }, () => randomTransform(r));
      const bones = locals.map((t, i) => bone(`b${i}`, i ? `b${i - 1}` : undefined, toBoneBurstLocal(t)));
      const skeleton = load({ skeleton: { spine: BONEBURST_VERSION }, bones });
      const bounds = piErrorBounds(locals.map(toBoneBurstLocal));
      let world = mat();
      locals.forEach((t, i) => {
        world = mul(mat(), world, toMatrix(mat(), t));
        const actual = runtimeWorld(skeleton, `b${i}`);
        const expected = expectedSpineWorld(world);
        for (let k = 0; k < 6; k++) {
          const tol = 2 * bounds[i]! + 1e-9 * Math.max(1, Math.abs(expected[k]!));
          if (Math.abs(actual[k]! - expected[k]!) > tol) {
            throw new Error(`chain ${n}, bone ${i}, component ${k}: ${actual[k]} vs ${expected[k]} (bound ${tol})`);
          }
        }
      });
    }
  });
});

describe("keyValues: animated poses through the runtime's own timelines", () => {
  const fps = 30;

  /** A two-key linear animation on the child of a two-bone chain, sampled
   *  by the runtime at every frame and compared with the editor's linear
   *  tween of the six transform fields. */
  function checkTween(parent: Transform, setup: Transform, from: Transform, to: Transform, frames: number): void {
    const s = toBoneBurstLocal(setup);
    const k0 = keyValues(toBoneBurstLocal(from), s);
    const k1 = keyValues(toBoneBurstLocal(to), s);
    const t1 = keyTime(frames, fps);
    const file: BoneBurstSkeletonFile = {
      skeleton: { spine: BONEBURST_VERSION, fps },
      bones: [bone("p", undefined, toBoneBurstLocal(parent)), bone("c", "p", s)],
      animations: {
        a: {
          bones: {
            c: {
              translate: [{ time: 0, x: k0.x, y: k0.y }, { time: t1, x: k1.x, y: k1.y }],
              rotate: [{ time: 0, value: k0.rotate }, { time: t1, value: k1.rotate }],
              scale: [{ time: 0, x: k0.scaleX!, y: k0.scaleY! }, { time: t1, x: k1.scaleX!, y: k1.scaleY! }],
              shear: [{ time: 0, x: k0.shearX, y: k0.shearY }, { time: t1, x: k1.shearX, y: k1.shearY }],
            },
          },
        },
      },
    };
    const skeleton = load(file);
    const animation = skeleton.data.animations[0]!;
    const pw = toMatrix(mat(), parent);
    for (let f = 0; f <= frames; f++) {
      const u = f / frames;
      const lerp = (a: number, b: number) => a + (b - a) * u;
      const editorLocal = tf(
        lerp(from.x, to.x), lerp(from.y, to.y), lerp(from.skewX, to.skewX),
        lerp(from.skewY, to.skewY), lerp(from.scaleX, to.scaleX), lerp(from.scaleY, to.scaleY),
      );
      animation.apply(skeleton, 0, keyTime(f, fps), false, null, 1, MixFrom.setup, false, false, false);
      skeleton.updateWorldTransform(Physics.none);
      // Key values and times are float32 in the runtime.
      expectClose(runtimeWorld(skeleton, "c"), expectedSpineWorld(mul(mat(), pw, toMatrix(mat(), editorLocal))), 2e-4);
    }
  }

  it("a sheared, scaled bone tweening two turns keeps turning the same way", () => {
    checkTween(tf(50, 20, 15, 15, 1.2, 1.2), tf(30, 0, 10, 10), tf(30, 0, 10, 10), tf(80, -40, 760, 740, 0.5, 1.8), 24);
  });

  it("a mirrored bone tweening backwards", () => {
    checkTween(tf(0, 0, -30, -30, 1, -1), tf(10, 5, 0, 0, -1, 1), tf(10, 5, 0, 0, -1, 1), tf(-20, 5, -300, -330, -2, 0.5), 10);
  });

  it("a pose far from the setup pose, setup scale not 1", () => {
    checkTween(tf(), tf(0, 0, 45, 45, 2, 0.5), tf(100, 100, 400, 390, 3, 1.5), tf(-100, 0, -45, -45, 0.25, 4), 15);
  });

  it("has no scale key for a zero setup scale unless the pose is zero too", () => {
    const setup = toBoneBurstLocal(tf(0, 0, 0, 0, 0, 1));
    expect(keyValues(toBoneBurstLocal(tf(0, 0, 0, 0, 2, 1)), setup).scaleX).toBeNull();
    expect(keyValues(toBoneBurstLocal(tf(0, 0, 0, 0, 0, 1)), setup).scaleX).toBe(1);
  });
});

describe("keyTime", () => {
  const FPS = [12, 24, 25, 30, 50, 60, 120];

  it("is a float32 value never after frame / fps", () => {
    for (const fps of FPS) {
      for (let f = 0; f <= 1200; f++) {
        const t = keyTime(f, fps);
        expect(Math.fround(t)).toBe(t);
        expect(t).toBeLessThanOrEqual(f / fps);
        expect(f / fps - t).toBeLessThan(1e-4);
      }
    }
  });

  /** A stepped rotate timeline with a new value on every frame, seeked at
   *  frame / fps, the way the preview seeks. */
  function shownFrames(fps: number, frames: number, time: (f: number) => number): number[] {
    const keys = Array.from({ length: frames + 1 }, (_, f) => ({ time: time(f), value: f, curve: "stepped" as const }));
    const skeleton = load({
      skeleton: { spine: BONEBURST_VERSION, fps },
      bones: [{ name: "b" }],
      animations: { a: { bones: { b: { rotate: keys } } } },
    });
    const animation = skeleton.data.animations[0]!;
    const shown: number[] = [];
    for (let f = 0; f <= frames; f++) {
      animation.apply(skeleton, 0, f / fps, false, null, 1, MixFrom.setup, false, false, false);
      shown.push(skeleton.findBone("b")!.pose.rotation);
    }
    return shown;
  }

  it("makes the runtime show every key on its own frame", () => {
    for (const fps of FPS) {
      const shown = shownFrames(fps, 240, (f) => keyTime(f, fps));
      expect(shown).toEqual(Array.from({ length: 241 }, (_, f) => f));
    }
  });

  it("is needed: the plain time shows the previous key on some frames", () => {
    const shown = shownFrames(60, 240, (f) => f / 60);
    const late = shown.filter((v, f) => v !== f).length;
    expect(late).toBeGreaterThan(0);
  });
});

describe("regionCentre", () => {
  it.each([
    ["pivot at the centre", 100, 60, { x: 50, y: 30 }, { x: 0, y: 0 }],
    ["pivot at the top-left corner", 100, 60, { x: 0, y: 0 }, { x: 50, y: -30 }],
    ["pivot at the bottom-right corner", 100, 60, { x: 100, y: 60 }, { x: -50, y: 30 }],
    ["pivot outside the image", 40, 40, { x: -10, y: 50 }, { x: 30, y: 30 }],
  ] as const)("%s", (_name, w, h, pivot, centre) => {
    expect(regionCentre(w, h, pivot)).toEqual(centre);
  });
});
