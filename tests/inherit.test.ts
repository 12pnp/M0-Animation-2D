import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { inheritAt, inheritKeysFromBoneBurst, inheritTimeline, runtimePosed, withInheritKey } from "@/core/doc/inherit";
import { createNode } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import type { Animation, InheritKey, SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";
import { stageAgainstRuntime } from "./fixtures/runtimeCheck";

beforeEach(() => reseed());

const bone = { ...createNode("bone", "b"), inherit: "noScale" as const };
const anim = (keys: InheritKey[]): Animation => ({ id: "a" as never, name: "a", duration: 20, playTimes: 0, tracks: {}, inherits: { [bone.id]: keys } });

describe("the mode at a frame", () => {
  it.each([
    { name: "no animation: the bone's own", a: null, frame: 5, want: "noScale" },
    { name: "before the first key: the bone's own", a: anim([{ frame: 4, inherit: "onlyTranslation" }]), frame: 3, want: "noScale" },
    { name: "on a key", a: anim([{ frame: 4, inherit: "onlyTranslation" }]), frame: 4, want: "onlyTranslation" },
    { name: "held to the next key", a: anim([{ frame: 0, inherit: "normal" }, { frame: 9, inherit: "noScaleOrReflection" }]), frame: 8, want: "normal" },
    { name: "the last key holds", a: anim([{ frame: 0, inherit: "normal" }, { frame: 9, inherit: "noScaleOrReflection" }]), frame: 19, want: "noScaleOrReflection" },
  ])("$name", ({ a, frame, want }) => {
    expect(inheritAt(bone, a, frame)).toBe(want);
  });

  it("a key replaces one on its frame; keys stay in frame order", () => {
    const keys = withInheritKey([{ frame: 6, inherit: "noScale" }, { frame: 2, inherit: "normal" }], 6, "onlyTranslation");
    expect(keys).toEqual([{ frame: 2, inherit: "normal" }, { frame: 6, inherit: "onlyTranslation" }]);
  });
});

describe("Spine's inherit timeline", () => {
  it("time left out at 0 and normal left out; read back the same", () => {
    const keys: InheritKey[] = [{ frame: 0, inherit: "noScale" }, { frame: 6, inherit: "normal" }, { frame: 12, inherit: "onlyTranslation" }];
    const raw = inheritTimeline(keys, 30);
    // Times are float32, as every exported key's (`keyTime`).
    expect(raw.map((k) => ({ ...k, ...(k.time !== undefined ? { time: Math.round((k.time as number) * 1e6) / 1e6 } : {}) })))
      .toEqual([{ inherit: "noScale" }, { time: 0.2 }, { time: 0.4, inherit: "onlyTranslation" }]);
    expect(inheritKeysFromBoneBurst(raw, 30)).toEqual(keys);
  });

  it.each([
    { name: "on the next whole frame, the first it shows on", raw: [{ time: 0.11, inherit: "noScale" }], want: [{ frame: 4, inherit: "noScale" }] },
    { name: "two before one frame: the later", raw: [{ time: 0.11, inherit: "noScale" }, { time: 0.12, inherit: "onlyTranslation" }], want: [{ frame: 4, inherit: "onlyTranslation" }] },
    { name: "one between frames, then one on the frame after: that one", raw: [{ time: 0.11, inherit: "noScale" }, { time: 4 / 30 }], want: [{ frame: 4, inherit: "normal" }] },
  ])("a key between frames: $name", ({ raw, want }) => {
    expect(inheritKeysFromBoneBurst(raw, 30)).toEqual(want);
  });

  it.each([
    { name: "an unknown mode", raw: [{ time: 0, inherit: "sideways" }] },
    { name: "not a list", raw: { inherit: "noScale" } },
  ])("stays carried: $name", ({ raw }) => {
    expect(inheritKeysFromBoneBurst(raw, 30)).toBeNull();
  });
});

describe("in the document", () => {
  it("load: keys of bones that exist, known modes, one per frame", async () => {
    const { project, rig, node } = await loadStickman();
    rig.animations[0]!.inherits = {
      [node("head")]: [{ frame: 3, inherit: "noScale" }, { frame: 3, inherit: "onlyTranslation" }, { frame: 1, inherit: "bad" }, { frame: -2, inherit: "normal" }],
      ["gone" as never]: [{ frame: 0, inherit: "noScale" }],
    } as never;
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 24 })))).project;
    expect((out.items[out.rootSymbolId] as SymbolItem).animations[0]!.inherits).toEqual({ [node("head")]: [{ frame: 3, inherit: "onlyTranslation" }] });
  });

  it("a bone that takes less than its parent, or a key, has the runtime pose the symbol", async () => {
    const { rig, node } = await loadStickman();
    expect(runtimePosed(rig)).toBe(false);
    rig.nodes[node("head")] = { ...rig.nodes[node("head")]!, inherit: "normal" };
    expect(runtimePosed(rig)).toBe(false);
    rig.animations[0]!.inherits = { [node("head")]: [{ frame: 2, inherit: "noScale" }] };
    expect(runtimePosed(rig)).toBe(true);
    delete rig.animations[0]!.inherits;
    rig.nodes[node("head")] = { ...rig.nodes[node("head")]!, inherit: "onlyTranslation" };
    expect(runtimePosed(rig)).toBe(true);
  });
});

describe("the stage poses inherit through the runtime", () => {
  it("a head that keeps its own angle: the stage is the export, and it differs from a full inherit", async () => {
    const { project, rig, node } = await loadStickman();
    rig.nodes[node("head")] = { ...rig.nodes[node("head")]!, inherit: "onlyTranslation" };
    expect(stageAgainstRuntime(project, rig, "head")).toBeGreaterThan(1);
  });

  it("keyed modes: the stage applies the keys as spine-core plays the exported timeline", async () => {
    const { project, rig, node } = await loadStickman();
    for (const a of rig.animations) {
      a.inherits = {
        [node("head")]: [{ frame: 0, inherit: "onlyTranslation" }, { frame: 5, inherit: "normal" }, { frame: 11, inherit: "noRotationOrReflection" }],
        [node("arm_near_fore")]: [{ frame: 3, inherit: "noScale" }],
      };
    }
    expect(stageAgainstRuntime(project, rig, "head")).toBeGreaterThan(1);
  });

  it("export then open: the keys come back as keys, nothing carried", async () => {
    const { project, rig, node } = await loadStickman();
    rig.nodes[node("chest")] = { ...rig.nodes[node("chest")]!, inherit: "noScale" };
    const keys: InheritKey[] = [{ frame: 0, inherit: "onlyTranslation" }, { frame: 6, inherit: "normal" }];
    rig.animations[0]!.inherits = { [node("head")]: keys };
    const opened = importBoneBurst(exportBoneBurst(project).skeleton as never, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    const head = Object.values(sym.nodes).find((n) => n.name === "head")!;
    const chest = Object.values(sym.nodes).find((n) => n.name === "chest")!;
    expect(chest.inherit).toBe("noScale");
    const anim = sym.animations.find((a) => a.name === rig.animations[0]!.name)!;
    expect(anim.inherits?.[head.id]).toEqual(keys);
    expect(JSON.stringify(anim.spine ?? {})).not.toContain("inherit");
  });
});
