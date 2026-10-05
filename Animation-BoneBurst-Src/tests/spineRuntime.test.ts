import { describe, expect, it } from "vitest";
import { atlasText } from "@/core/boneburst/atlas";
import { readAtlas } from "@/core/boneburst/runtime/atlasRead";
import { readRig } from "@/core/boneburst/runtime/rigData";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { loadFixture } from "./fixtures/realProject";
import { loadStickman } from "./fixtures/stickman";
import { sampleRigs } from "./fixtures/spineSamples";
import { type Counts, type Json, compare, trimmedPage } from "./fixtures/runtimeOracle";

/**
 * The BoneBurst runtime (docs/PREVIEW-RUNTIME-PLAN.md) against spine-core
 * 4.3.13, frame by frame (`fixtures/runtimeOracle.ts`): our exports and
 * spine-unity's samples (skipped without the samples folder), each sample
 * also y down and under each of its skins. What the runtime does not solve
 * yet is taken out of the file both read (`NOT_YET` there).
 */

describe("BoneBurst runtime vs spine-core", () => {
  it("the stickman export", async () => {
    const { project } = await loadStickman();
    const exported = exportBoneBurst(project, project.rootSymbolId);
    const r = compare("stickman", JSON.parse(boneburstJson(exported.skeleton)), atlasText([trimmedPage(project, exported.usedImages)]));
    expect(r.bones).toBeGreaterThan(100);
    expect(r.regions).toBeGreaterThan(100);
  });

  it("the frog export", async () => {
    const { project } = await loadFixture();
    const exported = exportBoneBurst(project, project.rootSymbolId);
    const r = compare("frog", JSON.parse(boneburstJson(exported.skeleton)), atlasText([trimmedPage(project, exported.usedImages)]));
    expect(r.regions).toBeGreaterThan(10);
  });

  const samples = sampleRigs();
  for (const rig of samples) {
    it(`sample ${rig.name}`, () => {
      const r = compare(rig.name, JSON.parse(rig.json), rig.atlas);
      expect(r.frames).toBeGreaterThan(0);
    });
    // As the preview poses it: y down.
    it(`sample ${rig.name}, y down`, () => {
      expect(compare(rig.name, JSON.parse(rig.json), rig.atlas, undefined, undefined, true).frames).toBeGreaterThan(0);
    });
    // Each other skin over the default one, through the first animation:
    // skin attachments, linked meshes and the bones a skin enables.
    const skins = ((JSON.parse(rig.json) as Json).skins as Json[] ?? []).map((s) => String(s.name)).filter((s) => s !== "default");
    if (skins.length) {
      it(`sample ${rig.name}, each skin`, () => {
        for (const skin of skins) compare(rig.name, JSON.parse(rig.json), rig.atlas, skin, 1);
      });
    }
  }

  it("the samples exercise meshes, linked meshes, deform keys and sequences", () => {
    if (!samples.length) return;
    const total: Counts = { frames: 0, bones: 0, regions: 0, meshes: 0, deformed: 0, sequences: 0, darks: 0, clips: 0, boxes: 0, points: 0 };
    for (const rig of samples) {
      const r = compare(rig.name, JSON.parse(rig.json), rig.atlas);
      for (const k of Object.keys(total) as Array<keyof Counts>) total[k] += r[k];
    }
    expect(total.regions).toBeGreaterThan(1000);
    expect(total.meshes).toBeGreaterThan(1000);
    expect(total.deformed).toBeGreaterThan(100);
    expect(total.clips).toBeGreaterThan(10);
    expect(total.points).toBeGreaterThan(10);
    expect(total.sequences).toBeGreaterThan(10);
  });
});

describe("linked meshes, as Format-Json-Atlas.md §8.4 and §9 read them", () => {
  const ATLAS = "p.png\nsize: 64,64\nfilter: Linear,Linear\nimg\nbounds: 0,0,32,32\n";
  const mesh = { type: "mesh", path: "img", uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 2, 3, 0], vertices: [-10, -10, 10, -10, 10, 10, -10, 10], hull: 4 };
  /** A mesh in slot "a" with deform keys, and `linked` in slot "c" on another bone. */
  const rig = (linked: Json): Json => ({
    skeleton: { spine: "4.3.0", hash: "x", fps: 30 },
    bones: [{ name: "root" }, { name: "b", parent: "root", x: 20 }],
    slots: [{ name: "a", bone: "root", attachment: "m" }, { name: "c", bone: "b", attachment: "l" }],
    skins: [{ name: "default", attachments: { a: { m: mesh }, c: { l: linked } } }],
    animations: { anim: { attachments: { default: { a: { m: { deform: [{ time: 0 }, { time: 1, vertices: [5, 0, 5, 0, 5, 0, 5, 0] }] } } } } } },
  });
  it.each([
    ["its source in another slot, the source's deform keys playing in both", { type: "linkedmesh", path: "img", source: "m", slot: "a" }, 62],
    ["typed mesh, linked by naming a source", { type: "mesh", path: "img", source: "m", slot: "a" }, 62],
    ["not taking its source's keys", { type: "linkedmesh", path: "img", source: "m", slot: "a", timelines: false }, 31],
  ] as const)("%s", (_name, linked, deformed) => {
    const r = compare("linked", rig(linked), ATLAS);
    expect(r.meshes).toBe(62);
    expect(r.deformed).toBe(deformed);
  });
});

describe("what the runtime does not play, it says", () => {
  it("4.3 draw order folders are listed as unsupported, not dropped silently", () => {
    const rig = readRig({
      skeleton: { spine: "4.3.0" }, bones: [{ name: "root" }], slots: [{ name: "a", bone: "root" }, { name: "b", bone: "root" }],
      animations: { walk: { drawOrderFolder: [{ slots: ["a", "b"], keys: [{ offsets: [{ slot: "a", offset: 1 }] }] }] } },
    }, readAtlas(""));
    expect(rig.unsupported).toEqual(["drawOrderFolder keys"]);
  });
});
