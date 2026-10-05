import { describe, expect, it } from "vitest";
import { type Json, compare } from "./fixtures/runtimeOracle";

/**
 * The BoneBurst runtime's constraint solvers against spine-core 4.3.13 on
 * small rigs built to reach the cases the samples do not: every option and
 * inherit mode, non-uniform and negative scale, targets that circle near,
 * through and past the chain's reach. Each rig plays y up and y down.
 */

const EMPTY_ATLAS = "";

/** A target circling the origin at `radius`, keyed every 0.1 s for 2 s. */
function circle(radius: number, cx = 40, cy = 10): Json[] {
  return Array.from({ length: 21 }, (_, i) => {
    const a = (i / 20) * Math.PI * 2;
    return { time: i / 10, x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius };
  });
}

interface IkCase {
  name: string;
  chain: 1 | 2;
  root?: Json;
  parent?: Json;
  child?: Json;
  ik?: Json;
  radius?: number;
  /** IK keys, absolute. */
  keys?: Json[];
}

function ikRig(c: IkCase): Json {
  const bones: Json[] = [
    { name: "root", ...c.root },
    { name: "a", parent: "root", length: 60, rotation: 20, x: 5, y: 3, ...c.parent },
  ];
  if (c.chain === 2) bones.push({ name: "b", parent: "a", length: 45, x: 60, rotation: -15, ...c.child });
  bones.push({ name: "t", parent: "root" });
  return {
    skeleton: { spine: "4.3.0", fps: 30 },
    bones,
    constraints: [{ type: "ik", name: "k", bones: c.chain === 2 ? ["a", "b"] : ["a"], target: "t", ...c.ik }],
    animations: {
      move: {
        bones: { t: { translate: circle(c.radius ?? 70) } },
        ...(c.keys ? { ik: { k: c.keys } } : {}),
      },
    },
  };
}

const CASES: IkCase[] = [
  { name: "one bone", chain: 1 },
  { name: "one bone, mix 0.4", chain: 1, ik: { mix: 0.4 } },
  { name: "one bone, compress and stretch", chain: 1, ik: { compress: true, stretch: true }, radius: 90 },
  { name: "one bone, stretch, uniform y", chain: 1, ik: { stretch: true, scaleY: "uniform" }, radius: 110 },
  { name: "one bone, compress, volume y", chain: 1, ik: { compress: true, scaleY: "volume" }, radius: 30 },
  { name: "one bone, negative scale", chain: 1, parent: { scaleX: -1.3, scaleY: 0.8 } },
  { name: "one bone, under a non-uniform root", chain: 1, root: { scaleX: 1.6, scaleY: 0.7, rotation: 25 } },
  ...(["onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"] as const).map((inherit): IkCase => ({
    name: `one bone, ${inherit}`, chain: 1, parent: { inherit }, root: { scaleX: 1.4, scaleY: -0.9, rotation: 30 },
    ik: { stretch: true, compress: true },
  })),
  { name: "two bones", chain: 2 },
  { name: "two bones, bend negative", chain: 2, ik: { bendPositive: false } },
  { name: "two bones, out of reach", chain: 2, radius: 150 },
  { name: "two bones, stretch", chain: 2, ik: { stretch: true }, radius: 150 },
  { name: "two bones, stretch uniform y", chain: 2, ik: { stretch: true, scaleY: "uniform" }, radius: 150 },
  { name: "two bones, stretch volume y", chain: 2, ik: { stretch: true, scaleY: "volume" }, radius: 150 },
  { name: "two bones, softness", chain: 2, ik: { softness: 25 }, radius: 100 },
  { name: "two bones, softness and stretch", chain: 2, ik: { softness: 25, stretch: true }, radius: 130 },
  { name: "two bones, non-uniform parent", chain: 2, parent: { scaleX: 1.5, scaleY: 0.6 } },
  { name: "two bones, non-uniform parent, bend negative", chain: 2, parent: { scaleX: 0.7, scaleY: 1.4 }, ik: { bendPositive: false } },
  { name: "two bones, negative parent x", chain: 2, parent: { scaleX: -1 } },
  { name: "two bones, negative parent y", chain: 2, parent: { scaleY: -1.2 } },
  { name: "two bones, negative child", chain: 2, child: { scaleX: -0.9 } },
  { name: "two bones, child off the parent's axis", chain: 2, child: { y: 12 } },
  { name: "two bones, sheared parent", chain: 2, parent: { shearX: 8, shearY: -14, scaleY: 1.3 } },
  { name: "two bones, under a turned, scaled root", chain: 2, root: { rotation: -40, scaleX: 1.2, scaleY: 1.2, x: 10, y: -20 } },
  {
    name: "two bones, keyed", chain: 2, radius: 120,
    keys: [
      { mix: 0, softness: 0, curve: [0.4, 0.2, 0.6, 1, 0.4, 0, 0.6, 30] },
      { time: 1, mix: 1, softness: 30, bendPositive: false, stretch: true, curve: "stepped" },
      { time: 1.5, mix: 0.5, compress: true },
    ],
  },
];

describe("IK against spine-core", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const rig = ikRig(c);
      expect(compare(c.name, rig, EMPTY_ATLAS).bones).toBeGreaterThan(0);
      expect(compare(c.name, rig, EMPTY_ATLAS, undefined, undefined, true).bones).toBeGreaterThan(0);
    });
  }
});

const SAME = { rotate: { to: { rotate: {} } }, x: { to: { x: {} } }, y: { to: { y: {} } }, scaleX: { to: { scaleX: {} } }, scaleY: { to: { scaleY: {} } }, shearY: { to: { shearY: {} } } };

interface TcCase { name: string; tc: Json; /** Constraints before the transform one. */ before?: Json[]; after?: Json[]; keys?: Json[]; targetUnder?: string }

/** A source bone that turns, moves and scales over 2 s, two target bones (one
 *  with a child), and the constraint under test. */
function tcRig(c: TcCase): Json {
  const turn = Array.from({ length: 11 }, (_, i) => ({ time: i / 5, value: -60 + i * 37 }));
  const move = Array.from({ length: 11 }, (_, i) => ({ time: i / 5, x: Math.sin(i) * 40, y: Math.cos(i * 0.7) * 30 }));
  const scale = Array.from({ length: 11 }, (_, i) => ({ time: i / 5, x: 0.6 + (i % 4) * 0.35, y: 1.4 - (i % 3) * 0.3 }));
  return {
    skeleton: { spine: "4.3.0", fps: 30 },
    bones: [
      { name: "root" },
      { name: "src", parent: "root", x: 30, y: 10, rotation: 15, length: 40, shearY: 7 },
      { name: "p", parent: "root", x: -20, y: 5, rotation: -35, scaleX: 1.3, scaleY: 0.8, length: 30 },
      { name: "t1", parent: c.targetUnder ?? "p", x: 25, y: -6, rotation: 50, scaleX: 0.9, shearY: -12, length: 25 },
      { name: "t2", parent: "root", x: 60, y: 40, rotation: 270, length: 20 },
      { name: "t1c", parent: "t1", x: 25, rotation: 20, length: 30 },
      { name: "goal", parent: "root", x: 40, y: -50 },
    ],
    constraints: [
      ...(c.before ?? []),
      { type: "transform", name: "tc", source: "src", bones: ["t1", "t2"], properties: SAME, ...c.tc },
      ...(c.after ?? []),
    ],
    animations: {
      play: {
        bones: { src: { rotate: turn, translate: move, scale }, goal: { translate: circle(50, 20, -40) } },
        ...(c.keys ? { transform: { tc: c.keys } } : {}),
      },
    },
  };
}

const TC_CASES: TcCase[] = [
  { name: "world, absolute", tc: {} },
  { name: "world, partial mixes", tc: { mixRotate: 0.3, mixX: 0.6, mixScaleX: 0.5, mixShearY: 0.25 } },
  { name: "world, mixY and mixScaleY follow x", tc: { mixX: 0.4, mixScaleX: 0.7 } },
  { name: "world, offsets", tc: { rotation: 30, x: 12, y: -8, scaleX: 0.2, scaleY: -0.1, shearY: 10 } },
  { name: "world, additive", tc: { additive: true, mixRotate: 0.5, mixX: 0.5 } },
  { name: "local source", tc: { localSource: true } },
  { name: "local target", tc: { localTarget: true } },
  { name: "local both, additive", tc: { localSource: true, localTarget: true, additive: true, mixRotate: 0.7, mixScaleX: 0.5 } },
  {
    name: "remapped with scale, offset and clamp", tc: {
      clamp: true,
      properties: {
        rotate: { offset: 10, to: { x: { offset: 5, scale: 0.5, max: 40 }, shearY: { scale: -0.3, max: -20 } } },
        x: { to: { rotate: { scale: 2, max: 90 } } },
        scaleX: { offset: 0.5, to: { scaleY: { offset: 1, scale: 0.8, max: 2 } } },
      },
    },
  },
  {
    name: "remapped, local, unclamped", tc: {
      localSource: true, localTarget: true,
      properties: { y: { to: { rotate: { scale: 1.5 } } }, rotate: { to: { y: { scale: -0.4, offset: 3 } } } },
    },
  },
  {
    name: "keyed mixes", tc: {},
    keys: [
      { mixRotate: 0, mixX: 0.2, curve: Array.from({ length: 24 }, (_, i) => [0.3, 0, 0.7, 1][i % 4]! * (i % 4 === 1 || i % 4 === 3 ? 1 : 0.6)) },
      { time: 1, mixRotate: 1, mixX: 1, mixY: 0.3, mixScaleX: 0.5, curve: "stepped" },
      { time: 1.6, mixRotate: 0.4, mixShearY: 0 },
    ],
  },
  { name: "after IK on its source", tc: {}, before: [{ type: "ik", name: "k", bones: ["src"], target: "goal" }] },
  { name: "before IK on its target's child", tc: {}, after: [{ type: "ik", name: "k", bones: ["t1", "t1c"], target: "goal" }] },
  { name: "world, under the source", tc: {}, targetUnder: "src" },
  {
    name: "world, then its parent moved, then IK reads it", tc: {},
    after: [
      { type: "transform", name: "tc2", source: "goal", bones: ["p"], properties: { rotate: { to: { rotate: {} } }, x: { to: { x: {} } } }, mixRotate: 0.5, mixX: 0.5 },
      { type: "ik", name: "k", bones: ["t1", "t1c"], target: "goal" },
    ],
  },
];

describe("transform constraints against spine-core", () => {
  for (const c of TC_CASES) {
    it(c.name, () => {
      const rig = tcRig(c);
      expect(compare(c.name, rig, EMPTY_ATLAS).bones).toBeGreaterThan(0);
      expect(compare(c.name, rig, EMPTY_ATLAS, undefined, undefined, true).bones).toBeGreaterThan(0);
    });
  }
});

describe("constraints only some skins enable", () => {
  it("apply while their skin shows", () => {
    const rig = ikRig({ name: "skin", chain: 2, ik: { skin: true } });
    rig.skins = [{ name: "default" }, { name: "armed", ik: ["k"] }];
    expect(compare("skin", rig, EMPTY_ATLAS).bones).toBeGreaterThan(0);
    expect(compare("skin", rig, EMPTY_ATLAS, "armed").bones).toBeGreaterThan(0);
  });
});

interface PathCase { name: string; pc?: Json; path?: Json; weighted?: boolean; keys?: Json }

/** Four points along a wave, each with its in-handle and out-handle. */
function waveVertices(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const x = i * 60, y = i % 2 ? 30 : -10;
    out.push(x - 20, y - 8, x, y, x + 20, y + 8);
  }
  return out;
}

/** The same vertices, each bound half to the path bone and half to a second one. */
function weightedWave(): number[] {
  const v = waveVertices(), out: number[] = [];
  for (let i = 0; i < v.length; i += 2) out.push(2, 1, v[i]!, v[i + 1]!, 0.5, 2, v[i]! - 15, v[i + 1]! + 5, 0.5);
  return out;
}

function pathRig(c: PathCase): Json {
  const chain = Array.from({ length: 4 }, (_, i) => ({ name: `c${i}`, parent: i ? `c${i - 1}` : "root", length: 30, x: i ? 30 : 0, rotation: i ? 10 : 0 }));
  return {
    skeleton: { spine: "4.3.0", fps: 30 },
    bones: [{ name: "root" }, { name: "pathBone", parent: "root", x: -40, y: 20, rotation: 12 }, { name: "bender", parent: "root", x: 50, y: 60 }, ...chain],
    slots: [{ name: "path", bone: "pathBone", attachment: "wave" }],
    skins: [{
      name: "default",
      attachments: {
        path: {
          wave: {
            type: "path", vertexCount: 12, lengths: [70, 140, 210, 280],
            vertices: c.weighted ? weightedWave() : waveVertices(), ...c.path,
          },
        },
      },
    }],
    constraints: [{ type: "path", name: "pc", slot: "path", bones: chain.map((b) => b.name), ...c.pc }],
    animations: {
      play: {
        bones: {
          pathBone: { rotate: [{ value: 0 }, { time: 1, value: 40 }, { time: 2, value: -20 }] },
          bender: { translate: circle(30, 50, 60) },
        },
        ...(c.keys ? { path: { pc: c.keys } } : {}),
      },
    },
  };
}

const PATH_CASES: PathCase[] = [
  { name: "tangent, length spacing" },
  { name: "chain", pc: { rotateMode: "chain" } },
  { name: "chain scale", pc: { rotateMode: "chainScale" } },
  { name: "chain with a rotation offset", pc: { rotateMode: "chain", rotation: 25 } },
  { name: "fixed position and spacing", pc: { positionMode: "fixed", position: 30, spacingMode: "fixed", spacing: 40 } },
  { name: "percent spacing", pc: { spacingMode: "percent", spacing: 0.2, position: 0.1 } },
  { name: "proportional spacing, chain scale", pc: { spacingMode: "proportional", spacing: 0.9, rotateMode: "chainScale" } },
  { name: "length spacing with extra spacing", pc: { spacing: 12 } },
  { name: "before the start", pc: { positionMode: "fixed", position: -80 } },
  { name: "past the end", pc: { positionMode: "fixed", position: 200, spacing: 30 } },
  { name: "closed", path: { closed: true }, pc: { position: 0.6 } },
  { name: "not constant speed", path: { constantSpeed: false } },
  { name: "not constant speed, closed, past the end", path: { constantSpeed: false, closed: true }, pc: { positionMode: "fixed", position: 250 } },
  { name: "not constant speed, before and after", path: { constantSpeed: false }, pc: { positionMode: "fixed", position: -40, spacing: 80 } },
  { name: "weighted", weighted: true },
  { name: "weighted, chain scale", weighted: true, pc: { rotateMode: "chainScale" } },
  { name: "partial mixes", pc: { mixRotate: 0.4, mixX: 0.7, mixY: 0.2 } },
  {
    name: "keyed position, spacing and mix", pc: { rotateMode: "chain" },
    keys: {
      position: [{ value: 0, curve: [0.5, 0, 0.8, 0.5] }, { time: 1, value: 0.5 }, { time: 2, value: 0.2 }],
      spacing: [{ value: 0 }, { time: 1.5, value: 20, curve: "stepped" }],
      mix: [{ mixRotate: 1, mixX: 0.5 }, { time: 1, mixRotate: 0.2, mixX: 1, mixY: 0.3 }],
    },
  },
];

describe("path constraints against spine-core", () => {
  for (const c of PATH_CASES) {
    it(c.name, () => {
      const rig = pathRig(c);
      expect(compare(c.name, rig, EMPTY_ATLAS).bones).toBeGreaterThan(0);
      expect(compare(c.name, rig, EMPTY_ATLAS, undefined, undefined, true).bones).toBeGreaterThan(0);
    });
  }
});

describe("two-colour tint against spine-core", () => {
  it("dark colours and their keys", () => {
    const rig: Json = {
      skeleton: { spine: "4.3.0", fps: 30 },
      bones: [{ name: "root" }],
      slots: [
        { name: "a", bone: "root", color: "ff8040c0", dark: "203040" },
        { name: "b", bone: "root", dark: "000000" },
        { name: "c", bone: "root", color: "80ff80ff" },
      ],
      animations: {
        tint: {
          slots: {
            a: { rgba2: [
              { light: "ffffffff", dark: "000000", curve: Array.from({ length: 28 }, (_, i) => [0.3, 0.1, 0.7, 0.9][i % 4]! * (i % 2 ? 1 : 2)) },
              { time: 1, light: "ff000080", dark: "00ff00", curve: "stepped" },
              { time: 1.5, light: "0000ffff", dark: "ffffff" },
            ] },
            b: { rgb2: [{ light: "102030", dark: "a0b0c0" }, { time: 2, light: "ffffff", dark: "000000" }] },
            c: { rgba: [{ color: "ffffffff" }, { time: 1, color: "00000000" }] },
          },
        },
      },
    };
    const n = compare("two-colour", rig, EMPTY_ATLAS);
    expect(n.darks).toBeGreaterThan(100);
    compare("two-colour", rig, EMPTY_ATLAS, undefined, undefined, true);
  });
});

interface SliderCase { name: string; slider: Json; keys?: Json; before?: Json[]; after?: Json[] }

/** A driver bone that turns, moves and scales; a slider playing "pose",
 *  which moves, turns and scales two bones, tints a slot, swaps its
 *  attachment and keys an IK mix. */
function sliderRig(c: SliderCase): Json {
  const turn = Array.from({ length: 11 }, (_, i) => ({ time: i / 5, value: -100 + i * 45 }));
  const move = Array.from({ length: 11 }, (_, i) => ({ time: i / 5, x: i * 9 - 40, y: (i % 3) * 15 }));
  const scale = Array.from({ length: 11 }, (_, i) => ({ time: i / 5, x: 0.5 + i * 0.1, y: 1.5 - i * 0.05 }));
  return {
    skeleton: { spine: "4.3.0", fps: 30 },
    bones: [
      { name: "root" }, { name: "parent", parent: "root", rotation: 25, scaleX: 1.2 },
      { name: "drv", parent: "parent", x: 10, y: 5, shearY: 8 },
      { name: "a", parent: "root", x: 30, length: 40 }, { name: "b", parent: "a", x: 40, length: 30 },
      { name: "goal", parent: "root", x: 70, y: 20 },
    ],
    slots: [{ name: "s", bone: "a", color: "ffffffff" }],
    constraints: [
      ...(c.before ?? []),
      { type: "slider", name: "sl", animation: "pose", ...c.slider },
      ...(c.after ?? []),
    ],
    animations: {
      pose: {
        bones: {
          a: { rotate: [{ value: 0 }, { time: 1, value: 90 }], translate: [{ x: 0 }, { time: 1, x: 20, y: -10 }] },
          b: { scale: [{ x: 1 }, { time: 1, x: 2, y: 0.5 }], shear: [{ x: 0 }, { time: 0.5, x: 15, y: -10 }] },
        },
        slots: { s: { rgba: [{ color: "ff0000ff" }, { time: 1, color: "0000ff80" }] } },
        ik: { k: [{ mix: 0 }, { time: 1, mix: 1 }] },
      },
      drive: {
        bones: { drv: { rotate: turn, translate: move, scale } },
        ...(c.keys ? { slider: { sl: c.keys } } : {}),
      },
    },
  };
}

const IK_AFTER = [{ type: "ik", name: "k", bones: ["a", "b"], target: "goal" }];
const SLIDER_CASES: SliderCase[] = [
  { name: "its own time", slider: { time: 0.4 }, after: IK_AFTER },
  { name: "its own time, half mixed, looping past the end", slider: { time: 1.4, mix: 0.5, loop: true }, after: IK_AFTER },
  { name: "additive", slider: { time: 0.7, additive: true, mix: 0.6 }, after: IK_AFTER },
  ...(["rotate", "x", "y", "scaleX", "scaleY", "shearY"] as const).flatMap((property) => [false, true].map((local): SliderCase => ({
    name: `${property}, ${local ? "local" : "world"}`,
    slider: { bone: "drv", property, local, scale: property === "rotate" || property === "shearY" ? 0.01 : property.startsWith("scale") ? 0.8 : 0.02, from: 0.1, to: 0.05, loop: property === "rotate" },
    after: IK_AFTER,
  }))),
  { name: "bone-driven below 0, looping", slider: { bone: "drv", property: "x", local: true, scale: 0.05, to: -1, loop: true }, after: IK_AFTER },
  { name: "keyed time and mix", slider: {}, keys: { time: [{ value: 0 }, { time: 2, value: 1.2, curve: [0.5, 0, 1, 0.5] }], mix: [{ value: 0.2 }, { time: 1, value: 1 }] }, after: IK_AFTER },
  { name: "before an IK it keys", slider: { time: 0.5 }, before: [], after: IK_AFTER },
  { name: "after the IK", slider: { time: 0.5 }, before: IK_AFTER },
];

describe("sliders against spine-core", () => {
  for (const c of SLIDER_CASES) {
    it(c.name, () => {
      const rig = sliderRig(c);
      expect(compare(c.name, rig, EMPTY_ATLAS).bones).toBeGreaterThan(0);
      expect(compare(c.name, rig, EMPTY_ATLAS, undefined, undefined, true).bones).toBeGreaterThan(0);
    });
  }
});

describe("bounding boxes against spine-core", () => {
  it("unweighted and weighted, deformed", () => {
    const rig: Json = {
      skeleton: { spine: "4.3.0", fps: 30 },
      bones: [{ name: "root" }, { name: "a", parent: "root", x: 20, rotation: 30 }, { name: "b", parent: "a", x: 40, scaleX: 1.3 }],
      slots: [{ name: "plain", bone: "a", attachment: "box" }, { name: "bound", bone: "b", attachment: "box" }],
      skins: [{
        name: "default",
        attachments: {
          plain: { box: { type: "boundingbox", vertexCount: 3, vertices: [0, 0, 30, 0, 15, 25] } },
          bound: { box: { type: "boundingbox", vertexCount: 3, vertices: [1, 1, 0, 0, 1, 2, 1, 30, 0, 0.6, 2, -10, 5, 0.4, 1, 2, 15, 25, 1] } },
        },
      }],
      animations: {
        bend: {
          bones: { a: { rotate: [{ value: 0 }, { time: 1, value: 60 }] } },
          attachments: { default: {
            plain: { box: { deform: [{ vertices: [0, 0, 5, 5] }, { time: 1, offset: 2, vertices: [10, -4, 3, 3] }] } },
            bound: { box: { deform: [{}, { time: 1, vertices: [2, 2, 4, -4, 1, 1, 6, 6] }] } },
          } },
        },
      },
    };
    expect(compare("boxes", rig, EMPTY_ATLAS).boxes).toBeGreaterThan(50);
    compare("boxes", rig, EMPTY_ATLAS, undefined, undefined, true);
  });
});
