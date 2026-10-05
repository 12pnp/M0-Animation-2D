import { describe, expect, it } from "vitest";
import {
  AnimationState, AnimationStateData, AtlasAttachmentLoader, Physics, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { readAtlas } from "@/core/spine/runtime/atlasRead";
import { readRig } from "@/core/spine/runtime/rigData";
import { Rig } from "@/core/spine/runtime/rig";
import { Track } from "@/core/spine/runtime/track";
import { sampleRigs } from "./fixtures/spineSamples";
import type { Json } from "./fixtures/runtimeOracle";

/**
 * The BoneBurst runtime's physics (`core/spine/runtime/physics.ts`) against
 * spine-core 4.3.13, stepped as the Preview steps it — the track, then the
 * skeleton's clock, then the pose with physics updating — with uneven frame
 * times, every bone compared at every step.
 */

const steps = (n: number) => Array.from({ length: n }, (_, i) => (1 / 60) * (0.6 + ((i * 7919) % 13) / 15));

export function simulate(name: string, json: Json, atlas: string, animation: string | null, count: number, yDown = false): number {
  Skeleton.yDown = yDown;
  try {
    const data = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlas))).readSkeletonData(json);
    const skeleton = new Skeleton(data);
    const state = new AnimationState(new AnimationStateData(data));
    const rig = new Rig(readRig(json, readAtlas(atlas)));
    if (yDown) rig.scaleY = -1;
    const track = new Track();
    skeleton.setupPose();
    if (animation) { state.setAnimation(0, animation, true); track.start(rig.animation(animation)!, true); }
    let compared = 0;
    [0, ...steps(count)].forEach((dt, step) => {
      state.update(dt); state.apply(skeleton); skeleton.update(dt); skeleton.updateWorldTransform(Physics.update);
      track.advance(dt); track.apply(rig); rig.update(dt); rig.updateWorld("update");
      let size = 0;
      for (let i = 0; i < rig.world.length; i += 6) size = Math.max(size, Math.abs(rig.world[i + 4]!), Math.abs(rig.world[i + 5]!));
      skeleton.bones.forEach((b, i) => {
        if (!b.active) return;
        const p = b.appliedPose, got = rig.world.subarray(i * 6, i * 6 + 6);
        const want = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
        want.forEach((v, j) => {
          const tol = j >= 4 ? Math.max(1e-5, 1e-5 * Math.max(Math.abs(v), size)) : Math.max(1e-5, 1e-5 * Math.abs(v));
          if (Math.abs(got[j]! - v) > tol) throw new Error(`${name}${yDown ? " (y down)" : ""} step ${step}: bone ${b.data.name} ${Array.from(got)} vs ${want}`);
        });
        compared++;
      });
    });
    return compared;
  } finally {
    Skeleton.yDown = false;
  }
}

describe("physics against spine-core", () => {
  if (!sampleRigs().length) it.skip("spine-unity's samples (folder missing)", () => {});
  for (const rig of sampleRigs()) {
    const file = JSON.parse(rig.json) as Json;
    if (!((file.constraints as Json[]) ?? []).some((k) => k.type === "physics")) continue;
    const names = Object.keys((file.animations as Record<string, Json>) ?? {});
    it(`${rig.name}: at rest, then each animation`, () => {
      expect(simulate(`${rig.name} rest`, file, rig.atlas, null, 120)).toBeGreaterThan(0);
      for (const anim of names) simulate(`${rig.name} ${anim}`, file, rig.atlas, anim, 240);
    });
    it(`${rig.name}: y down`, () => {
      for (const anim of names.slice(0, 2)) simulate(`${rig.name} ${anim}`, file, rig.atlas, anim, 240, true);
    });
  }
});

interface PhysicsCase { name: string; pc: Json; keys?: Json; second?: Json }

/** A bone thrown about by its parent — moved, turned and scaled — with the
 *  constraint under test on it, and a child bone with a second one when given. */
function physicsRig(c: PhysicsCase): Json {
  const move = Array.from({ length: 13 }, (_, i) => ({ time: i / 6, x: Math.sin(i * 1.3) * 80, y: Math.cos(i * 0.9) * 60 }));
  const turn = Array.from({ length: 13 }, (_, i) => ({ time: i / 6, value: Math.sin(i) * 70 }));
  const scale = Array.from({ length: 13 }, (_, i) => ({ time: i / 6, x: 1 + Math.sin(i * 0.7) * 0.4 }));
  return {
    skeleton: { spine: "4.3.0", fps: 30 },
    bones: [
      { name: "root" }, { name: "carrier", parent: "root", x: 10 },
      { name: "tail", parent: "carrier", x: 30, length: 60, rotation: 20 },
      { name: "tip", parent: "tail", x: 60, length: 40, rotation: -10 },
    ],
    constraints: [
      { type: "physics", name: "p", bone: "tail", ...c.pc },
      ...(c.second ? [{ type: "physics", name: "q", bone: "tip", ...c.second }] : []),
    ],
    animations: {
      throw: {
        bones: { carrier: { translate: move, rotate: turn, scale } },
        ...(c.keys ? { physics: c.keys } : {}),
      },
    },
  };
}

const PHYSICS_CASES: PhysicsCase[] = [
  { name: "x", pc: { x: 1 } },
  { name: "y", pc: { y: 1 } },
  { name: "x and y, partly", pc: { x: 0.6, y: 0.3 } },
  { name: "rotate", pc: { rotate: 1 } },
  { name: "rotate, partly", pc: { rotate: 0.4 } },
  { name: "scale x", pc: { scaleX: 1 } },
  { name: "shear x", pc: { shearX: 1 } },
  { name: "rotate and shear x", pc: { rotate: 0.7, shearX: 0.5 } },
  { name: "rotate and scale x", pc: { rotate: 1, scaleX: 0.6 } },
  { name: "everything", pc: { x: 1, y: 1, rotate: 1, scaleX: 1, shearX: 0.3 } },
  { name: "a low limit", pc: { x: 1, y: 1, rotate: 1, limit: 300 } },
  { name: "wind and gravity", pc: { x: 1, y: 1, rotate: 1, scaleX: 1, wind: 8, gravity: 15 } },
  { name: "soft, heavy, slow to settle", pc: { rotate: 1, scaleX: 1, strength: 30, mass: 3, damping: 0.97, inertia: 0.9 } },
  { name: "half mixed", pc: { x: 1, rotate: 1, mix: 0.5 } },
  { name: "30 steps a second", pc: { x: 1, rotate: 1, fps: 30 } },
  { name: "a second constraint down the chain", pc: { rotate: 1, x: 1 }, second: { rotate: 1, scaleX: 0.5 } },
  {
    name: "keyed values, a global wind and a reset", pc: { rotate: 1, x: 1, y: 1, windGlobal: true, gravityGlobal: true },
    keys: {
      p: {
        strength: [{ value: 100 }, { time: 1, value: 40 }], damping: [{ value: 0.85 }, { time: 1.5, value: 0.95 }],
        mass: [{ value: 1 }, { time: 1, value: 2.5 }], inertia: [{ value: 0.5 }, { time: 1, value: 0.9, curve: "stepped" }],
        mix: [{ value: 1 }, { time: 1.8, value: 0.3 }],
        reset: [{ time: 1.2 }],
      },
      "": { wind: [{ value: 0 }, { time: 1, value: 20 }], gravity: [{ value: 5 }, { time: 2, value: -5 }] },
    },
  },
];

describe("physics against spine-core, built rigs", () => {
  for (const c of PHYSICS_CASES) {
    it(c.name, () => {
      const rig = physicsRig(c);
      expect(simulate(c.name, rig, "", "throw", 300)).toBeGreaterThan(0);
      simulate(c.name, rig, "", "throw", 300, true);
    });
  }
});
