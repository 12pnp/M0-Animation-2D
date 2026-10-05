import { beforeEach, describe, expect, it } from "vitest";
import { newCnId, reseed } from "@/core/doc/ids";
import {
  newPathConstraint, newPhysics, newSlider, pathFromSpine, pathLengths, pathThrough, pathToSpine, physicsFromSpine, physicsToSpine,
  runtimeSolved, sliderFromSpine, sliderToSpine, uniqueConstraintName, withKnotMoved,
} from "@/core/doc/constraints";
import { createImageItem, createLayer, createNode } from "@/core/doc/defaults";
import { evaluateSymbol } from "@/core/doc/pose";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportSpine } from "@/core/spine/exportSpine";
import { posedSymbol } from "@/core/spine/spinePose";
import type { SymbolItem } from "@/core/doc/types";
import { tf } from "@/core/math/Transform";
import { boxOutline, makeMesh } from "@/core/mesh/makeMesh";
import { loadStickman } from "./fixtures/stickman";
import { stageAgainstRuntime } from "./fixtures/runtimeCheck";

beforeEach(() => reseed());

describe("Spine's JSON both ways", () => {
  it("physics: defaults left out, the rest kept", () => {
    const k = { ...newPhysics({ ...emptySym(), nodes: {} } as SymbolItem, "b" as never, newCnId()), name: "p", inertia: 0.3, scaleY: "volume" as const };
    const json = physicsToSpine(k, "bone");
    expect(json).toEqual({ type: "physics", name: "p", bone: "bone", rotate: 1, inertia: 0.3, scaleY: "volume" });
    expect(physicsFromSpine(json, k.id, k.boneId)).toEqual(k);
  });
  it("slider: a bone's property, or a time", () => {
    const driven = { id: newCnId(), name: "s", animId: "a1" as never, boneId: "b" as never, property: "x" as const, from: 10, to: 0.5, scale: 0.02, loop: true };
    const json = sliderToSpine(driven, "wave", "bone");
    expect(json).toEqual({ type: "slider", name: "s", animation: "wave", loop: true, bone: "bone", property: "x", from: 10, to: 0.5, scale: 0.02 });
    expect(sliderFromSpine(json, driven.id, driven.animId, driven.boneId)).toEqual(driven);
    expect(sliderToSpine({ id: newCnId(), name: "t", animId: "a1" as never, time: 0.25 }, "wave", null)).toEqual({ type: "slider", name: "t", animation: "wave", time: 0.25 });
  });
  it("path: modes and values, mixY read as mixX when absent", () => {
    const k = { id: newCnId(), name: "p", boneIds: ["a" as never], pathId: "n" as never, rotateMode: "chain" as const, spacingMode: "percent" as const, position: 0.2, mixX: 0.5, mixY: 0.5 };
    const json = pathToSpine(k, ["a"], "rail");
    expect(json).toEqual({ type: "path", name: "p", bones: ["a"], slot: "rail", spacingMode: "percent", rotateMode: "chain", position: 0.2, mixX: 0.5, mixY: 0.5 });
    const { mixY: _m, ...noMixY } = json;
    expect(pathFromSpine(noMixY, k.id, k.boneIds, k.pathId)).toEqual(k);
  });
});

function emptySym(): Partial<SymbolItem> {
  return { ik: [], transforms: [], animations: [] };
}

describe("path geometry", () => {
  it("a smooth path through knots: three points each, handles along the neighbours' chord", () => {
    expect(pathThrough([0, 0, 60, 0, 60, 60]).points).toEqual([-10, 0, 0, 0, 10, 0, 50, -10, 60, 0, 70, 10, 60, 50, 60, 60, 60, 70]);
  });
  it("lengths per knot, cumulative; a straight path's are its lengths", () => {
    const straight = { points: [0, 0, 0, 0, 10, 0, 20, 0, 30, 0, 40, 0, 50, 0, 60, 0, 60, 0] };
    expect(pathLengths(straight)).toEqual([30, 60, 60]);
    expect(pathLengths({ ...straight, closed: true })[2]).toBeCloseTo(120, 3);
  });
  it("a knot moved takes its handles; a handle moves alone", () => {
    const p = pathThrough([0, 0, 60, 0]);
    expect(withKnotMoved(p, 1, 5, 5).points.slice(0, 6)).toEqual([-10 + 5, 0 + 5, 5, 5, 10 + 5, 0 + 5]);
    expect(withKnotMoved(p, 2, 5, 5).points.slice(0, 6)).toEqual([-10, 0, 0, 0, 15, 5]);
  });
});

/** The stage (runtime-posed) against the full export in spine-core, every
 *  frame at rest, and how far the constraint moved `bone` off the editor's own pose. */
describe("the stage poses physics, sliders and paths through the runtime", () => {
  it("a slider: the run animation played by the head's rotation moves the far arm", async () => {
    const { project, rig, node } = await loadStickman();
    const wave = rig.animations[1]!;
    rig.sliders = [{ ...newSlider(rig, wave.id, node("head"), newCnId(), 0.6), mix: 1 }];
    rig.animations[0]!.tracks[node("head")] = { nodeId: node("head"), endFrame: rig.animations[0]!.duration - 1, keys: [
      { frame: 0, transform: rig.nodes[node("head")]!.bind, displayIndex: 0, tween: { kind: "linear" } },
      { frame: 20, transform: { ...rig.nodes[node("head")]!.bind, skewX: rig.nodes[node("head")]!.bind.skewX - 60, skewY: rig.nodes[node("head")]!.bind.skewY - 60 }, displayIndex: 0, tween: { kind: "linear" } },
    ] };
    expect(runtimeSolved(rig)).toBe(true);
    expect(stageAgainstRuntime(project, rig, "arm_far_fore")).toBeGreaterThan(1);
  });

  it("a path: the neck and head laid along a curve", async () => {
    const { project, rig, node } = await loadStickman();
    const path = createNode("path", "rail", { parentId: node("hips") });
    path.path = pathThrough([0, -60, 40, -120, 0, -180, -30, -220]);
    rig.nodes[path.id] = path;
    rig.layers.unshift(createLayer(path.id, path.name, 0));
    rig.paths = [{ ...newPathConstraint(rig, [node("chest"), node("head")], path.id, newCnId()), position: 0.1 }];
    expect(stageAgainstRuntime(project, rig, "head")).toBeGreaterThan(1);
  });

  it("physics at rest on a seek: the stage equals the export; the model keeps the settings", async () => {
    const { project, rig, node } = await loadStickman();
    rig.physics = [{ ...newPhysics(rig, node("head"), newCnId()), inertia: 0.8, gravity: 50 }];
    stageAgainstRuntime(project, rig, "head");
    const json = exportSpine(project).skeleton.constraints!.find((c) => c.name === "head_physics");
    expect(json).toEqual({ type: "physics", name: "head_physics", bone: "head", rotate: 1, inertia: 0.8, gravity: 50 });
  });
});

describe("the runtime pose keeps the document's own keys", () => {
  it("a sequence on a rig the runtime poses (it has physics) shows the keyed frames", async () => {
    const { project, rig, node } = await loadStickman();
    const torso = rig.nodes[node("torso")]!;
    const base = project.items[torso.itemId!] as { assetId: string; width: number; height: number };
    const items = ["fx_1", "fx_2", "fx_3"].map((n) => {
      const it = createImageItem(n, base.assetId as never, base.width, base.height);
      project.items[it.id] = it;
      return it.id;
    });
    rig.nodes[torso.id] = { ...torso, itemId: items[0], sequence: { items } };
    rig.animations[0]!.sequences = { [torso.id]: [{ frame: 2, mode: "loop", index: 0, delay: 1 }] };
    rig.physics = [newPhysics(rig, node("head"), newCnId())];
    const shown = [1, 2, 3, 4, 5].map((f) => project.items[posedSymbol(project, rig, rig.animations[0]!, f, "animate").byNode.get(torso.id)!.spine!.itemId]!.name);
    expect(shown).toEqual(["fx_1", "fx_1", "fx_2", "fx_3", "fx_1"]);
  });

  it("deform keys on a rig the runtime poses: the mesh bends as the editor's own pose has it", async () => {
    const { project, rig, node } = await loadStickman();
    const torso = rig.nodes[node("torso")]!;
    const item = project.items[torso.itemId!] as { width: number; height: number };
    const mesh = makeMesh(boxOutline(item.width, item.height), 20, item.width, item.height);
    rig.nodes[torso.id] = { ...torso, mesh };
    const wave = (k: number) => Array.from({ length: mesh.points.length }, (_, i) => Math.sin(i + k) * 6);
    rig.animations[0]!.deforms = { [torso.id]: [{ frame: 0, offsets: wave(0) }, { frame: 10, offsets: wave(3) }] };
    rig.physics = [newPhysics(rig, node("head"), newCnId())];
    for (const f of [0, 4, 10]) {
      const own = evaluateSymbol(rig, rig.animations[0]!, f, "animate").byNode.get(torso.id)!.spine!.vertices;
      const posed = posedSymbol(project, rig, rig.animations[0]!, f, "animate").byNode.get(torso.id)!.spine!.vertices;
      expect(Math.max(...own.map((v, i) => Math.abs(v - posed[i]!))), `frame ${f}`).toBeLessThan(1e-3);
    }
  });
});

describe("in the document", () => {
  it("names unique across every constraint", async () => {
    const { rig } = await loadStickman();
    expect(uniqueConstraintName(rig, rig.ik[0]!.name)).toBe(`${rig.ik[0]!.name} 2`);
  });

  it("load: references to nothing, duplicate names and bad modes dropped", async () => {
    const { project, rig, node } = await loadStickman();
    const path = createNode("path", "rail");
    path.path = pathThrough([0, 0, 10, 0]);
    rig.nodes[path.id] = path;
    rig.layers.push(createLayer(path.id, path.name, 0));
    rig.physics = [
      { id: newCnId(), name: "p", boneId: node("head"), rotate: 1, fps: Number.NaN },
      { id: newCnId(), name: "p", boneId: node("head") },
      { id: newCnId(), name: "gone", boneId: "nope" as never },
    ];
    rig.paths = [{ id: newCnId(), name: "q", boneIds: [node("chest"), "x" as never], pathId: path.id, rotateMode: "spin" as never }];
    rig.sliders = [{ id: newCnId(), name: "s", animId: "none" as never }];
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    const s = out.items[out.rootSymbolId] as SymbolItem;
    expect(s.physics!.map((k) => [k.name, k.fps])).toEqual([["p", undefined]]);
    expect(s.paths).toEqual([{ id: rig.paths[0]!.id, name: "q", boneIds: [node("chest")], pathId: path.id }]);
    expect(s.sliders).toBeUndefined();
    expect(s.nodes[path.id]!.path!.points.length).toBe(12);
  });
});

void tf;
