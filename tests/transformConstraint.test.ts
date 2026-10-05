import { describe, expect, it } from "vitest";
import {
  deleteTcKeys, FULL_MIX, identityProperties, isIdentityMap, moveTcKeys, NEW_MAPPING, tcMixAt, tcSolveOf, tcTweenOf, transformPlan, usedMixes,
  withMapping, withoutMapping, withSourceOffset, withTcKey, withTcTween,
} from "@/core/doc/transformKeys";
import { LooseBones } from "@/core/spine/runtime/bones";
import { solveTransform } from "@/core/spine/runtime/transform";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { importSpine } from "@/core/spine/importSpine";
import { History } from "@/core/history/History";
import { RemoveNodes } from "@/core/history/commands";
import { DOC_VERSION, type Animation, type SymbolItem, type TcKey, type TransformConstraint } from "@/core/doc/types";
import type { TcId } from "@/core/doc/ids";
import { loadStickman } from "./fixtures/stickman";

const k: TransformConstraint = {
  id: "t1" as TcId, name: "follow", boneIds: ["b" as never], sourceId: "s" as never,
  mix: { rotate: 0.8, x: 1, y: 1, scaleX: 1, scaleY: 1, shearY: 1 }, properties: identityProperties(["rotate", "x"]),
};
const half = { rotate: 0.5, x: 0.5, y: 0.5, scaleX: 0.5, scaleY: 0.5, shearY: 0.5 };
const anim = (keys: TcKey[]): Animation => ({ id: "a", name: "a", duration: 30, playTimes: 0, tracks: {}, transforms: { [k.id]: keys } }) as unknown as Animation;

describe("transform constraint keys", () => {
  const keys: TcKey[] = [
    { frame: 4, mix: { ...FULL_MIX } },
    { frame: 8, mix: { ...half, rotate: 0 }, tween: { kind: "none" } },
    { frame: 12, mix: { ...FULL_MIX } },
  ];
  it.each([
    ["before the first key: the constraint's own", 1, 0.8],
    ["linear between keys", 6, 0.5],
    ["a stepped key holds", 10, 0],
    ["past the last key", 20, 1],
  ] as const)("%s", (_, frame, rotate) => {
    expect(tcMixAt(k, anim(keys), frame).rotate).toBeCloseTo(rotate, 9);
  });
  it("key, move (replacing, not before 0), delete, ease", () => {
    expect(withTcKey(keys, 8, FULL_MIX)[1]).toEqual({ frame: 8, mix: FULL_MIX, tween: { kind: "none" } });
    expect(moveTcKeys(keys, [8], 4).map((x) => x.frame)).toEqual([4, 12]);
    expect(moveTcKeys(keys, [4, 8], -10).map((x) => x.frame)).toEqual([0, 12]);
    expect(deleteTcKeys(keys, [4]).map((x) => x.frame)).toEqual([8, 12]);
    expect(withTcTween(keys, [4], "smooth").map(tcTweenOf)).toEqual(["smooth", "stepped", "linear"]);
  });
});

describe("the property map, edited", () => {
  const id = identityProperties(["rotate", "x"]);
  it.each([
    { name: "a new mapping from a source already mapped: added after its own", props: withMapping(id, "rotate", "y"), want: [["rotate", ["rotate", "y"]], ["x", ["x"]]] },
    { name: "from a new source: the source goes last", props: withMapping(id, "scaleX", "shearY"), want: [["rotate", ["rotate"]], ["x", ["x"]], ["scaleX", ["shearY"]]] },
    { name: "removing one leaves the source's others", props: withoutMapping(withMapping(id, "rotate", "y"), "rotate", "rotate"), want: [["rotate", ["y"]], ["x", ["x"]]] },
    { name: "a source driving nothing goes", props: withoutMapping(id, "x", "x"), want: [["rotate", ["rotate"]]] },
  ])("$name", ({ props, want }) => {
    expect(props.map((p) => [p.from, p.to.map((t) => t.to)])).toEqual(want);
  });
  it("a new mapping starts at its defaults; a patch changes only what it names; the source's offset is its own", () => {
    expect(withMapping(id, "rotate", "y")[0]!.to[1]).toEqual({ to: "y", ...NEW_MAPPING });
    const scaled = withMapping(id, "rotate", "rotate", { scale: 0.5 });
    expect(scaled[0]!.to[0]).toEqual({ to: "rotate", offset: 0, max: 1, scale: 0.5 });
    expect(withSourceOffset(scaled, "rotate", 15)[0]!.offset).toBe(15);
    expect([isIdentityMap(id), isIdentityMap(scaled), isIdentityMap(withMapping(id, "x", "y"))]).toEqual([true, false, false]);
    expect(usedMixes({ ...k, properties: withMapping(id, "rotate", "shearY") })).toEqual(["rotate", "x", "shearY"]);
  });
});

describe("a new constraint", () => {
  it("makes the bones follow the source with every property at full mix; refuses the source as its own bone", async () => {
    const { rig, node } = await loadStickman();
    const plan = transformPlan(rig, [node("head"), node("chest")], node("chest"), "t9" as TcId);
    expect(plan).toMatchObject({ name: "chest_transform", boneIds: [node("head")], sourceId: node("chest"), mix: FULL_MIX });
    expect(usedMixes(plan as TransformConstraint)).toEqual(["rotate", "x", "y", "scaleX", "scaleY", "shearY"]);
    expect(transformPlan(rig, [node("chest")], node("chest"), "t9" as TcId)).toEqual({ refused: "chest cannot follow itself." });
    expect(transformPlan(rig, [], node("chest"), "t9" as TcId)).toMatchObject({ refused: expect.stringContaining("Select the bones") });
  });

  it("world, full mix, identity map: a bone takes the source's world matrix", () => {
    // 0: the source, 1: the bone, both roots; the source turned and moved.
    const bones = new LooseBones([{ parent: -1, length: 0 }, { parent: -1, length: 0 }]);
    const sw = [0.6, -0.8, 0.8, 0.6, 10, 20];
    bones.world.set(sw, 0);
    bones.worldChanged(0);
    bones.setBone(1, 0, 0, 0, 1, 1, 0, 0);
    solveTransform(bones, { ...tcSolveOf({ ...k, properties: identityProperties(), mix: { ...FULL_MIX } }), source: 0, bones: [1] }, FULL_MIX);
    sw.forEach((v, i) => expect(bones.world[6 + i]).toBeCloseTo(v, 5));
  });
});

describe("transform constraints in files", () => {
  it("a file keeps constraints whose source and some bones exist, known properties only, mixes 0..1", async () => {
    const { project, rig, node } = await loadStickman();
    rig.transforms = [
      { ...k, id: "t1" as TcId, sourceId: node("chest"), boneIds: [node("head"), "gone" as never, node("chest")], mix: { ...FULL_MIX, x: 7 },
        properties: [{ from: "rotate", offset: 0, to: [{ to: "x", offset: 0, max: 1, scale: 2 }, { to: "wing", offset: 0, max: 1, scale: 1 }] }] } as never,
      { ...k, id: "t2" as TcId, name: "orphan", sourceId: "gone" as never, boneIds: [node("head")] },
    ];
    rig.animations[0]!.transforms = { t1: [{ frame: 3, mix: { rotate: 2 } }], t2: [{ frame: 1, mix: {} }] } as never;
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 19 })))).project;
    const sym = out.items[out.rootSymbolId] as SymbolItem;
    expect(out.version).toBe(DOC_VERSION);
    expect(sym.transforms).toHaveLength(1);
    expect(sym.transforms![0]).toMatchObject({ boneIds: [node("head")], mix: { x: 1 }, properties: [{ from: "rotate", to: [{ to: "x", scale: 2 }] }] });
    expect(sym.animations[0]!.transforms).toEqual({ t1: [{ frame: 3, mix: { ...FULL_MIX } }] });
  });

  it("export then open gives the constraint and its keys back", async () => {
    const { project, rig, node } = await loadStickman();
    const tc: TransformConstraint = {
      id: "t1" as TcId, name: "follow", boneIds: [node("head")], sourceId: node("chest"),
      localTarget: true, additive: true, offsets: { rotate: 15, x: -4 },
      mix: { rotate: 0.5, x: 0.25, y: 1, scaleX: 1, scaleY: 0.75, shearY: 0 }, properties: identityProperties(),
    };
    rig.transforms = [tc];
    rig.animations[0]!.transforms = { [tc.id]: [
      { frame: 0, mix: { ...FULL_MIX }, tween: { kind: "curve", curve: [0.42, 0, 0.58, 1] } },
      { frame: 6, mix: { ...half }, tween: { kind: "none" } },
      { frame: 12, mix: { ...FULL_MIX, shearY: 0 } },
    ] };
    const file = JSON.parse(spineJson(exportSpine(project).skeleton));
    const opened = importSpine(file, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    const back = sym.transforms!.find((c) => c.name === "follow")!;
    const { id: _a, boneIds: _b, sourceId: _c, ...rest } = back;
    const { id: _d, boneIds: _e, sourceId: _f, ...want } = tc;
    expect(rest).toEqual(want);
    const keys = sym.animations.find((a) => a.name === rig.animations[0]!.name)!.transforms![back.id]!;
    expect(keys.map((x) => ({ ...x, ...(x.tween?.kind === "curve" ? { tween: { kind: "curve", curve: x.tween.curve.map((v) => Math.round(v * 1e4) / 1e4) } } : {}) })))
      .toEqual(rig.animations[0]!.transforms[tc.id]);
  });
});

describe("deleting nodes", () => {
  it("drops a constraint whose source goes, trims one that loses a bone, and undo brings both back", async () => {
    const { project, rig, node } = await loadStickman();
    const before = [
      { ...k, id: "t1" as TcId, name: "a", sourceId: node("chest"), boneIds: [node("head")] },
      { ...k, id: "t2" as TcId, name: "b", sourceId: node("hips"), boneIds: [node("head"), node("arm_far_up")] },
    ];
    rig.transforms = before;
    const history = new History(project);
    history.apply(new RemoveNodes(rig.id, [node("chest")]));
    const sym = () => project.items[rig.id] as SymbolItem;
    // chest takes its subtree (head, arms) with it.
    expect(sym().transforms).toBeUndefined();
    history.undo();
    expect(sym().transforms).toEqual(before);
    history.apply(new RemoveNodes(rig.id, [node("arm_far_up")]));
    expect(sym().transforms!.map((c) => [c.name, c.boneIds])).toEqual([["a", [node("head")]], ["b", [node("head")]]]);
  });
});
