import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type IkId, type ItemId, type NodeId, type TcId } from "@/core/doc/ids";
import {
  skinActivity, skinBoneSet, skinLookup, skinnedDisplay, skinsOf, stageSkinOf, withDescendantBones, withNewSkin,
  withoutSkin, withRenamedSkin, withSkinDisplay, withSkinMembers, type SkinState,
} from "@/core/doc/skins";
import { migrate, validateProject } from "@/core/doc/schema";
import { History } from "@/core/history/History";
import { SetSkinOnly, SetSkins } from "@/core/history/skinCommands";
import { evaluateSymbol } from "@/core/doc/pose";
import { DOC_VERSION, type SkinDef, type SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";
import { AtlasAttachmentLoader, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { newCnId } from "@/core/doc/ids";
import { newPhysics } from "@/core/doc/constraints";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";

beforeEach(() => reseed());

async function rig() {
  const s = await loadStickman();
  const image = (name: string) => Object.values(s.project.items).find((i) => i.kind === "image" && i.name === name)!.id as ItemId;
  return { ...s, image };
}

const state = (sym: SymbolItem, st: SkinState | string): SymbolItem => {
  if (typeof st === "string") throw new Error(st);
  const out: SymbolItem = { ...sym };
  if (st.skins) out.skins = st.skins; else delete out.skins;
  if (st.stageSkins) out.stageSkins = st.stageSkins; else delete out.stageSkins;
  return out;
};

describe("which skins a symbol has and shows", () => {
  it.each([
    { name: "no skins: the default only", skins: undefined, stage: undefined, has: ["default"], shown: [] },
    { name: "skins, none chosen: the default draws, so none", skins: ["a", "b"], stage: undefined, has: ["default", "a", "b"], shown: [] },
    { name: "chosen, in the rig's order", skins: ["a", "b"], stage: ["b", "a"], has: ["default", "a", "b"], shown: ["b", "a"] },
    { name: "a choice of a skin it no longer has is dropped", skins: ["a"], stage: ["gone", "a"], has: ["default", "a"], shown: ["a"] },
  ])("$name", async ({ skins, stage, has, shown }) => {
    const { rig: sym } = await rig();
    if (skins) sym.skins = skins.map((name) => ({ name }));
    if (stage) sym.stageSkins = stage;
    expect(skinsOf(sym)).toEqual(has);
    expect(stageSkinOf(sym)).toEqual(shown);
  });

  it("every display left to skins: the default draws nothing, so the first skin shows", async () => {
    const { rig: sym } = await rig();
    for (const n of Object.values(sym.nodes)) if (n.itemId) sym.nodes[n.id] = { ...n, skinOnly: true };
    sym.skins = [{ name: "a" }, { name: "b" }];
    expect(skinsOf(sym)).toEqual(["a", "b"]);
    expect(stageSkinOf(sym)).toEqual(["a"]);
  });
});

describe("what a node shows under skins", () => {
  it.each([
    { name: "no skin: its own display", shown: [], want: "own" },
    { name: "a skin holding it: the skin's", shown: ["red"], want: "head" },
    { name: "two holding it: the later one", shown: ["red", "blue"], want: "pelvis" },
    { name: "the other way round", shown: ["blue", "red"], want: "head" },
    { name: "skins ignored (a bind pose): its own", shown: null, want: "own" },
  ])("$name", async ({ shown, want }) => {
    const { rig: sym, node, image } = await rig();
    const torso = sym.nodes[node("torso")]!;
    sym.skins = [
      { name: "red", displays: { [torso.id]: { 0: { itemId: image("head"), pivot: { x: 1, y: 2 } } } } as SkinDef["displays"] },
      { name: "blue", displays: { [torso.id]: { 0: { itemId: image("pelvis"), pivot: { x: 3, y: 4 } } } } as SkinDef["displays"] },
    ];
    const ref = skinnedDisplay(torso, 0, shown ? skinLookup(sym, shown) : null)!;
    expect(ref.itemId).toBe(want === "own" ? torso.itemId : image(want));
  });

  it("a display only skins fill: nothing without one, everything when skins are ignored", async () => {
    const { rig: sym, node } = await rig();
    const torso = { ...sym.nodes[node("torso")]!, skinOnly: true as const };
    expect(skinnedDisplay(torso, 0, skinLookup(sym, []))).toBeNull();
    expect(skinnedDisplay(torso, 0, null)!.itemId).toBe(torso.itemId);
  });
});

describe("skin bones and constraints", () => {
  it("a skin's bones in the export: the listed ones and the pictures below them, not bones below", async () => {
    const { rig: sym, node } = await rig();
    const set = skinBoneSet(sym, { name: "s", bones: [node("arm_near_up")] });
    expect([...set].map((id) => sym.nodes[id]!.name).sort()).toEqual(["arm_near_1", "arm_near_up"]);
    expect(withDescendantBones(sym, [node("arm_near_up")]).map((id) => sym.nodes[id]!.name)).toEqual(["arm_near_up", "arm_near_fore"]);
  });

  it.each([
    { name: "no skins: nothing off", skins: [], shown: [], off: [] },
    { name: "a skin bone, not shown: off with its pictures", skins: [["arm_near_up"]], shown: [], off: ["arm_near_1", "arm_near_up"] },
    { name: "shown: on", skins: [["arm_near_up"]], shown: [0], off: [] },
    { name: "a shown skin's bone turns its ancestors on, not their other pictures", skins: [["chest"], ["head"]], shown: [1], off: ["torso"] },
    { name: "ignored: nothing off", skins: [["arm_near_up"]], shown: null, off: [] },
  ])("$name", async ({ skins, shown, off }) => {
    const { rig: sym, node } = await rig();
    sym.skins = skins.map((bones, i) => ({ name: `s${i}`, bones: bones.map(node) }));
    const act = skinActivity(sym, shown === null ? null : shown.map((i) => `s${i}`));
    expect([...act.inactive].map((id) => sym.nodes[id]!.name).sort()).toEqual(off);
  });

  it("a constraint is off without a skin listing it, or when its source is off", async () => {
    const { rig: sym, node } = await rig();
    const [ik0, ik1] = [sym.ik[0]!.id, sym.ik[1]!.id];
    sym.skins = [{ name: "legs", ik: [ik0] }, { name: "target", bones: [sym.ik[1]!.targetId] }];
    expect([...skinActivity(sym, []).ikOff].sort()).toEqual([ik0, ik1].sort());
    expect([...skinActivity(sym, ["legs"]).ikOff]).toEqual([ik1]);
    expect([...skinActivity(sym, ["legs", "target"]).ikOff]).toEqual([]);
    void node;
  });
});

describe("editing skins", () => {
  it.each([
    { name: "", problem: "A skin needs a name." },
    { name: "default", problem: "choose another name" },
    { name: "red", problem: "already a skin" },
  ])("a new skin called '$name' is refused", async ({ name, problem }) => {
    const { rig: sym } = await rig();
    sym.skins = [{ name: "red" }];
    expect(withNewSkin(sym, name)).toContain(problem);
  });

  it("a new skin goes last and is shown alone", async () => {
    const { rig: sym } = await rig();
    sym.skins = [{ name: "red" }];
    const st = withNewSkin(sym, " blue ") as SkinState;
    expect(st.skins!.map((s) => s.name)).toEqual(["red", "blue"]);
    expect(st.stageSkins).toEqual(["blue"]);
  });

  it("renaming takes the stage's choice and the file's carried part with it", async () => {
    const { rig: sym } = await rig();
    sym.skins = [{ name: "red" }];
    sym.stageSkins = ["red"];
    sym.spine = { header: {}, constraints: [], skins: [{ name: "red", path: ["p"] }, { name: "carriedOnly" }] };
    const st = withRenamedSkin(sym, "red", "crimson") as SkinState;
    expect(st.skins!.map((s) => s.name)).toEqual(["crimson"]);
    expect(st.stageSkins).toEqual(["crimson"]);
    expect(st.carried!.map((s) => s.name)).toEqual(["crimson", "carriedOnly"]);
    // A skin only carried becomes the model's.
    expect((withRenamedSkin(sym, "carriedOnly", "c") as SkinState).skins!.map((s) => s.name)).toEqual(["red", "c"]);
    expect(withRenamedSkin(sym, "red", "carriedOnly")).toContain("already");
  });

  it("removing drops it everywhere", async () => {
    const { rig: sym } = await rig();
    sym.skins = [{ name: "red" }, { name: "blue" }];
    sym.stageSkins = ["red", "blue"];
    const st = withoutSkin(sym, "red");
    expect(st.skins!.map((s) => s.name)).toEqual(["blue"]);
    expect(st.stageSkins).toEqual(["blue"]);
    expect(withoutSkin(state(sym, st), "blue").skins).toBeUndefined();
  });

  it("a skin's display set and cleared; members added with the bones below and taken out", async () => {
    const { rig: sym, node, image } = await rig();
    sym.skins = [{ name: "red" }];
    const ref = { itemId: image("head"), pivot: { x: 0, y: 0 } };
    const set = state(sym, withSkinDisplay(sym, "red", node("torso"), 0, ref));
    expect(set.skins![0]!.displays).toEqual({ [node("torso")]: { 0: ref } });
    expect(state(set, withSkinDisplay(set, "red", node("torso"), 0, null)).skins![0]!.displays).toBeUndefined();
    const ik = sym.ik[0]!.id;
    const added = state(sym, withSkinMembers(sym, "red", { bones: [node("leg_near_thigh")], ik: [ik] }, true));
    expect(added.skins![0]!.bones!.map((id) => sym.nodes[id]!.name)).toEqual(["leg_near_thigh", "leg_near_shin"]);
    expect(added.skins![0]!.ik).toEqual([ik]);
    const removed = state(added, withSkinMembers(added, "red", { bones: [node("leg_near_thigh")], ik: [ik] }, false));
    expect(removed.skins![0]).toEqual({ name: "red" });
  });
});

describe("skins in the document", () => {
  it("loads: bad names, duplicates and references to nothing are dropped", async () => {
    const { project, rig: sym, node, image } = await rig();
    sym.skins = [
      { name: "red", displays: {
        [node("torso")]: { 0: { itemId: image("head"), pivot: { x: 1, y: 2 } }, 5: { itemId: image("head"), pivot: { x: 0, y: 0 } } },
        ["nope" as NodeId]: { 0: { itemId: image("head"), pivot: { x: 0, y: 0 } } },
      } as SkinDef["displays"], bones: [node("hips"), "gone" as NodeId], ik: ["x" as IkId, sym.ik[0]!.id], transforms: ["t" as TcId] },
      { name: "red" }, { name: "default" }, { name: "  " },
    ];
    sym.stageSkins = ["red"];
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 21 })))).project;
    const got = out.items[out.rootSymbolId] as SymbolItem;
    expect(out.version).toBe(DOC_VERSION);
    expect(got.skins).toEqual([{
      name: "red", displays: { [node("torso")]: { 0: { itemId: image("head"), pivot: { x: 1, y: 2 } } } },
      bones: [node("hips")], ik: [sym.ik[0]!.id],
    }]);
    expect(got.stageSkins).toEqual(["red"]);
  });

  it("the commands replace and undo, and the stage follows", async () => {
    const { project, rig: sym, node, image } = await rig();
    const history = new History(project);
    const before = evaluateSymbol(sym, null, 0, "setup").byNode.get(node("torso"))!.display!.itemId;
    const st = withSkinDisplay(sym, "red", node("torso"), 0, { itemId: image("head"), pivot: { x: 0, y: 0 } });
    history.apply(new SetSkins("Skin Image", sym.id, { ...st, stageSkins: ["red"] }));
    const live = project.items[sym.id] as SymbolItem;
    expect(evaluateSymbol(live, null, 0, "setup").byNode.get(node("torso"))!.display!.itemId).toBe(image("head"));
    history.apply(new SetSkinOnly("Only in Skins", sym.id, node("head_art"), 0, true));
    expect(evaluateSymbol(live, null, 0, "setup").byNode.get(node("head_art"))!.visible).toBe(false);
    history.undo();
    history.undo();
    const back = project.items[sym.id] as SymbolItem;
    expect(back.skins).toBeUndefined();
    expect(back.nodes[node("head_art")]!.skinOnly).toBeUndefined();
    expect(evaluateSymbol(back, null, 0, "setup").byNode.get(node("torso"))!.display!.itemId).toBe(before);
  });
});

describe("physics, sliders and paths in a skin", () => {
  it("written in the skin's per-kind list and flagged; spine-core leaves it off without the skin; opened again, a member", async () => {
    const { project, rig, node } = await loadStickman();
    const phys = { ...newPhysics(rig, node("head"), newCnId()), gravity: 40 };
    rig.physics = [phys];
    rig.skins = [{ name: "windy", constraints: [phys.id] }];
    const out = exportBoneBurst(project).skeleton;
    expect(out.skins!.find((s) => s.name === "windy")).toMatchObject({ physics: [phys.name] });
    expect(out.constraints!.find((c) => c.name === phys.name)).toMatchObject({ skin: true });
    const data = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(""))).readSkeletonData(JSON.parse(JSON.stringify({ ...out, skins: out.skins!.map((s) => ({ ...s, attachments: {} })) })));
    const sk = new Skeleton(data);
    const c = sk.constraints.find((x) => x.data.name === phys.name)!;
    sk.setSkin(null as never); sk.updateCache();
    expect(c.active).toBe(false);
    sk.setSkin("windy"); sk.updateCache();
    expect(c.active).toBe(true);
    const opened = importBoneBurst(out as never, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    const id = sym.physics!.find((k) => k.name === phys.name)!.id;
    expect(sym.skins!.find((s) => s.name === "windy")!.constraints).toEqual([id]);
    expect(sym.spine!.skins.find((s) => s.name === "windy")?.physics).toBeUndefined();
  });

  it("taken in and out with the other members", async () => {
    const { rig, node } = await loadStickman();
    const phys = newPhysics(rig, node("head"), newCnId());
    rig.physics = [phys];
    const added = withSkinMembers(rig, "windy", { constraints: [phys.id] }, true);
    expect(added.skins!.find((s) => s.name === "windy")!.constraints).toEqual([phys.id]);
    const removed = withSkinMembers({ ...rig, skins: added.skins }, "windy", { constraints: [phys.id] }, false);
    expect(removed.skins!.find((s) => s.name === "windy")!.constraints).toBeUndefined();
  });
});
