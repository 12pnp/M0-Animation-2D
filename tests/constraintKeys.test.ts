import { beforeEach, describe, expect, it } from "vitest";
import { newCnId, reseed, type CnId } from "@/core/doc/ids";
import {
  bakedChannelKeys, channelKeysFromSpine, channelTimeline, constraintKeyFrames, deleteConstraintKeys, moveConstraintKeys, valueAt,
  withChannelKeys, withConstraintTween, withValueKey,
} from "@/core/doc/constraintKeys";
import { newPathConstraint, newPhysics, newSlider, pathThrough } from "@/core/doc/constraints";
import { createLayer, createNode } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportSpine } from "@/core/spine/exportSpine";
import { importSpine } from "@/core/spine/importSpine";
import type { SymbolItem, ValueKey } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";
import { stageAgainstRuntime } from "./fixtures/runtimeCheck";
import { AtlasAttachmentLoader, MixFrom, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";

beforeEach(() => reseed());

const k = (frame: number, value: number, tween?: ValueKey["tween"]): ValueKey => (tween ? { frame, value, tween } : { frame, value });
const C = "c1" as CnId;

describe("a channel's value", () => {
  const keys = [k(4, 10), k(8, 20, { kind: "none" }), k(12, 0, { kind: "curve", curve: [0.42, 0, 0.58, 1] }), k(16, 100)];
  it.each([
    { frame: 0, want: 7 }, { frame: 4, want: 10 }, { frame: 6, want: 15 },
    { frame: 10, want: 20 }, { frame: 14, want: 50 }, { frame: 30, want: 100 },
  ])("at $frame: $want (the constraint's own, 7, before the first key)", ({ frame, want }) => {
    expect(valueAt(keys, frame, 7)).toBeCloseTo(want, 6);
  });
  it("no keys: the constraint's own", () => {
    expect(valueAt(undefined, 3, 0.5)).toBe(0.5);
  });
});

describe("editing keys", () => {
  it("a key replaces one on its frame, keeping its tween", () => {
    expect(withValueKey([k(2, 1, { kind: "none" }), k(5, 2)], 2, 9)).toEqual([k(2, 9, { kind: "none" }), k(5, 2)]);
  });
  it("every channel moves, deletes and tweens together; empty channels and constraints drop out", () => {
    let all = withChannelKeys(undefined, C, "mix", [k(0, 1), k(6, 0)]);
    all = withChannelKeys(all, C, "gravity", [k(6, 30)]);
    expect(constraintKeyFrames({ constraintKeys: all } as never, C)).toEqual([0, 6]);
    const moved = moveConstraintKeys(all, C, [6], 2);
    expect(moved![C]).toEqual({ mix: [k(0, 1), k(8, 0)], gravity: [k(8, 30)] });
    const stepped = withConstraintTween(moved, C, [0], { kind: "none" });
    expect(stepped![C]!.mix![0]).toEqual(k(0, 1, { kind: "none" }));
    expect(deleteConstraintKeys(stepped, C, [8])).toEqual({ [C]: { mix: [k(0, 1, { kind: "none" })] } });
    expect(deleteConstraintKeys(stepped, C, [0, 8])).toBeUndefined();
  });
});

describe("Spine's timelines", () => {
  it("values always written, stepped and curved; read back the same", () => {
    const keys = [k(0, 0.5, { kind: "curve", curve: [0.25, 0.1, 0.75, 0.9] }), k(10, 2, { kind: "none" }), k(15, 0)];
    const raw = channelTimeline(keys, 30);
    expect(raw[0]).toMatchObject({ value: 0.5 });
    expect(raw[1]).toMatchObject({ value: 2, curve: "stepped" });
    expect(raw[2]).toMatchObject({ value: 0 });
    const back = channelKeysFromSpine(raw, 30, 0)!;
    expect(back.map((x) => [x.frame, x.value, x.tween?.kind ?? "linear"])).toEqual([[0, 0.5, "curve"], [10, 2, "none"], [15, 0, "linear"]]);
    (back[0]!.tween as unknown as { curve: number[] }).curve.forEach((v, i) => expect(v).toBeCloseTo([0.25, 0.1, 0.75, 0.9][i]!, 5));
  });
  it("a path's mix: the three mixes, read back when they agree", () => {
    const raw = channelTimeline([k(0, 1, { kind: "curve", curve: [0.3, 0, 0.7, 1] }), k(6, 0.25)], 30, true);
    expect(raw[1]).toMatchObject({ mixRotate: 0.25, mixX: 0.25, mixY: 0.25 });
    expect((raw[0]!.curve as number[]).length).toBe(12);
    expect(channelKeysFromSpine(raw, 30, 1, true)!.map((x) => x.value)).toEqual([1, 0.25]);
    expect(channelKeysFromSpine([{ mixRotate: 1, mixX: 0.5 }], 30, 1, true)).toBeNull();
  });
  it.each([
    { name: "a key between frames", raw: [{ time: 0.11, value: 1 }] },
    { name: "two keys on one frame", raw: [{ value: 1 }, { time: 0, value: 2 }] },
    { name: "a bent constant", raw: [{ value: 1, curve: [0.1, 3, 0.2, 1] }, { time: 0.2, value: 1 }] },
  ])("stays carried: $name", ({ raw }) => {
    expect(channelKeysFromSpine(raw, 30, 0)).toBeNull();
  });
  it.each([
    { name: "linear across a key between frames", raw: [{ time: 0, value: 0 }, { time: 0.05, value: 1.5 }, { time: 0.1, value: 3 }], want: [[0, 0], [1, 1], [2, 2], [3, 3]] },
    { name: "stepped: the value from the frame after the key", raw: [{ time: 0, value: 0, curve: "stepped" }, { time: 0.05, value: 5 }], want: [[0, 0], [1, 0], [2, 5]] },
    { name: "before the first key: no key (the constraint's own holds)", raw: [{ time: 0.05, value: 2 }], want: [[2, 2]] },
  ])("written frame by frame: $name", ({ raw, want }) => {
    expect(bakedChannelKeys(raw, 30, 0)!.map((x) => [x.frame, Math.round(x.value * 1e9) / 1e9])).toEqual(want);
  });
  it("written frame by frame: a bezier as spine-core samples it", () => {
    const raw = [{ time: 0, value: 0, curve: [0.04, 0, 0.06, 1] }, { time: 0.11, value: 1 }];
    const baked = bakedChannelKeys(raw, 30, 0)!;
    expect(baked.map((x) => x.frame)).toEqual([0, 1, 2, 3, 4]);
    expect(baked[4]!.value).toBe(1);
    expect(baked[2]!.value).toBeGreaterThan(0.4);
  });
  it("a missing value reads as the channel's default", () => {
    expect(channelKeysFromSpine([{ time: 0.1 }], 30, 1)).toEqual([k(3, 1)]);
  });
});

describe("in the document", () => {
  it("load: keys of the symbol's constraints and their channels, whole frames, well-formed tweens", async () => {
    const { project, rig, node } = await loadStickman();
    rig.physics = [newPhysics(rig, node("head"), newCnId())];
    const id = rig.physics[0]!.id;
    rig.animations[0]!.constraintKeys = {
      [id]: { gravity: [k(2, 30), k(2, 40), { frame: 5, value: Number.NaN }, k(8, 1, { kind: "curve", curve: [1, 2] } as never)], time: [k(0, 1)] },
      ["gone" as CnId]: { mix: [k(0, 1)] },
    };
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 24 })))).project;
    expect((out.items[out.rootSymbolId] as SymbolItem).animations[0]!.constraintKeys).toEqual({ [id]: { gravity: [k(2, 40), k(8, 1)] } });
  });
});

describe("the stage plays the keys as spine-core plays the export", () => {
  it("a slider keyed in time: the animation it plays moves with the keys", async () => {
    const { project, rig } = await loadStickman();
    const run = rig.animations[1]!;
    const slider = newSlider(rig, run.id, null, newCnId(), 0);
    rig.sliders = [slider];
    rig.animations[0]!.constraintKeys = { [slider.id]: { time: [k(0, 0), k(20, 0.6, { kind: "curve", curve: [0.42, 0, 0.58, 1] })], mix: [k(10, 1), k(25, 0.3)] } };
    expect(stageAgainstRuntime(project, rig, "arm_far_fore")).toBeGreaterThan(1);
  });

  it("a path keyed in position and mix", async () => {
    const { project, rig, node } = await loadStickman();
    const path = createNode("path", "rail", { parentId: node("hips") });
    path.path = pathThrough([0, -60, 40, -120, 0, -180, -30, -220]);
    rig.nodes[path.id] = path;
    rig.layers.unshift(createLayer(path.id, path.name, 0));
    const pc = { ...newPathConstraint(rig, [node("chest"), node("head")], path.id, newCnId()), position: 0.1 };
    rig.paths = [pc];
    for (const a of rig.animations) a.constraintKeys = { [pc.id]: { position: [k(0, 0.1), k(12, 0.6)], mix: [k(4, 1, { kind: "none" }), k(9, 0.4)] } };
    expect(stageAgainstRuntime(project, rig, "head")).toBeGreaterThan(1);
  });

  it("open: a slider channel with keys between frames plays as spine-core plays the file, at every frame", async () => {
    const { project, rig } = await loadStickman();
    const slider = newSlider(rig, rig.animations[1]!.id, null, newCnId(), 0);
    rig.sliders = [slider];
    const file = exportSpine(project).skeleton as unknown as Record<string, Record<string, Record<string, unknown>>>;
    const first = Object.keys(file.animations!)[0]!;
    // Keys at 0.11 s and 0.258 s: on no frame at the rig's rate or a multiple up to 120.
    file.animations![first]!.slider = { [slider.name]: { time: [{ time: 0.11, value: 0.1, curve: [0.15, 0.1, 0.2, 0.5] }, { time: 0.258333, value: 0.5, curve: "stepped" }, { time: 0.4, value: 0.2 }] } };
    const result = importSpine(file as never, "stickman", new Map());
    const sym = result.project.items[result.project.rootSymbolId] as SymbolItem;
    const anim = sym.animations.find((a) => a.name === first)!;
    const keys = anim.constraintKeys?.[sym.sliders![0]!.id]?.time;
    expect(keys?.length).toBeGreaterThan(3);
    expect(anim.spine?.slider).toBeUndefined();
    expect(result.baked).toBeGreaterThan(0);
    // spine-core's slider time at each whole frame of the original file.
    const data = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(""))).readSkeletonData(JSON.stringify({ ...file, skins: [] }));
    const sk = new Skeleton(data);
    const run = data.findAnimation(first)!;
    const fps = result.project.frameRate;
    for (let f = 0; f <= 0.5 * fps; f++) {
      sk.setupPose();
      run.apply(sk, 0, f / fps, false, null, 1, MixFrom.setup, false, false, false);
      const c = sk.constraints.find((x) => x.data.name === slider.name)!;
      expect(valueAt(keys, f, 0)).toBeCloseTo((c.pose as unknown as { time: number }).time, 6);
    }
  });

  it("export then open: physics and slider keys come back as keys; a channel the model lacks stays carried", async () => {
    const { project, rig, node } = await loadStickman();
    rig.physics = [newPhysics(rig, node("head"), newCnId())];
    const run = rig.animations[1]!;
    rig.sliders = [newSlider(rig, run.id, null, newCnId(), 0)];
    const p = rig.physics[0]!, s = rig.sliders[0]!;
    rig.animations[0]!.constraintKeys = {
      [p.id]: { gravity: [k(0, 0, { kind: "none" }), k(10, 80)], mix: [k(5, 0.5)] },
      [s.id]: { time: [k(0, 0), k(8, 0.4)] },
    };
    rig.animations[0]!.spine = { physics: { [p.name]: { reset: [{ time: 0.25 }] } } };
    const opened = importSpine(exportSpine(project).skeleton as never, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    const anim = sym.animations.find((a) => a.name === rig.animations[0]!.name)!;
    const p2 = sym.physics![0]!, s2 = sym.sliders![0]!;
    expect(anim.constraintKeys?.[p2.id]).toEqual({ gravity: [k(0, 0, { kind: "none" }), k(10, 80)], mix: [k(5, 0.5)] });
    expect(anim.constraintKeys?.[s2.id]?.time?.map((x) => [x.frame, x.value])).toEqual([[0, 0], [8, 0.4]]);
    expect(anim.spine).toEqual({ physics: { [p2.name]: { reset: [{ time: 0.25 }] } } });
  });
});
