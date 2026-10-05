import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { withoutNonessential } from "@/core/boneburst/nonessential";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { validateProject } from "@/core/doc/schema";
import { migrate } from "@/core/doc/migrations";
import { DEFAULT_EXPORT_SETTINGS } from "@/core/export/settings";
import type { SymbolItem } from "@/core/doc/types";
import type { BoneBurstSkeletonFile } from "@/core/boneburst/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

describe("nonessential data", () => {
  it("strips what spine-core reads only for the editor, keeps a region's tint", () => {
    const file = {
      skeleton: { hash: "h", spine: "4.3.74", fps: 30, images: "./img/", audio: "./a/" },
      bones: [{ name: "root", color: "ff0000ff", icon: "ik", visible: false }],
      slots: [{ name: "s", bone: "root", visible: false, attachment: "r" }],
      skins: [{ name: "default", attachments: { s: {
        r: { width: 4, height: 4, color: "ff0000ff" },
        m: { type: "mesh", width: 4, height: 4, edges: [0, 2], uvs: [], triangles: [], vertices: [], hull: 3, color: "00ff00ff" },
        b: { type: "boundingbox", vertexCount: 3, vertices: [0, 0, 1, 0, 0, 1], color: "60f000ff" },
      } } }],
    } as unknown as BoneBurstSkeletonFile;
    const out = withoutNonessential(file) as unknown as Record<string, any>;
    expect(out.skeleton).toEqual({ hash: "h", spine: "4.3.74" });
    expect(out.bones[0]).toEqual({ name: "root" });
    expect(out.slots[0]).toEqual({ name: "s", bone: "root", attachment: "r" });
    expect(out.skins[0].attachments.s).toEqual({
      r: { width: 4, height: 4, color: "ff0000ff" },
      m: { type: "mesh", uvs: [], triangles: [], vertices: [], hull: 3, color: "00ff00ff" },
      b: { type: "boundingbox", vertexCount: 3, vertices: [0, 0, 1, 0, 0, 1] },
    });
    // The input is left alone.
    expect((file as unknown as Record<string, any>).bones[0].color).toBe("ff0000ff");
  });

  it("the export writes it by default, and leaves it out when the setting is off", async () => {
    const { project, rig, node } = await loadStickman();
    rig.nodes[node("head")] = { ...rig.nodes[node("head")]!, boneColor: "ff8800ff" };
    const on = exportBoneBurst(project).skeleton;
    expect(on.skeleton.fps).toBe(24);
    expect(on.bones.find((b) => b.name === "head")!.color).toBe("ff8800ff");
    project.exportSettings = { ...DEFAULT_EXPORT_SETTINGS, nonessential: false };
    const off = exportBoneBurst(project).skeleton;
    expect(off.skeleton.fps).toBeUndefined();
    expect(off.bones.find((b) => b.name === "head")!.color).toBeUndefined();
    expect(off.skeleton.hash).not.toBe(on.skeleton.hash);
  });
});

describe("bone colours", () => {
  it("open a file's bone colour into the model, write it back", () => {
    const file = { skeleton: { spine: "4.3.74" }, bones: [{ name: "root", color: "FF0000FF" }, { name: "a", parent: "root", color: "nope" }] };
    const { project } = importBoneBurst(file, "x", new Map());
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const root = Object.values(sym.nodes).find((n) => n.name === "root")!;
    const a = Object.values(sym.nodes).find((n) => n.name === "a")!;
    expect(root.boneColor).toBe("ff0000ff");
    expect(root.spine?.bone?.color).toBeUndefined();
    expect(a.boneColor).toBeUndefined();
    expect(a.spine?.bone?.color).toBe("nope");
    const out = exportBoneBurst(project).skeleton.bones;
    expect(out.find((b) => b.name === "root")!.color).toBe("ff0000ff");
  });

  it("load: a carried colour moves to the field; a bad one or a non-bone's goes", async () => {
    const { project, rig, node } = await loadStickman();
    rig.nodes[node("head")] = { ...rig.nodes[node("head")]!, spine: { bone: { color: "00ff00ff", skin: true } } };
    rig.nodes[node("chest")] = { ...rig.nodes[node("chest")]!, boneColor: "red" };
    rig.nodes[node("torso")] = { ...rig.nodes[node("torso")]!, boneColor: "ff0000ff" };
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    const s = out.items[out.rootSymbolId] as SymbolItem;
    expect(s.nodes[node("head")]!.boneColor).toBe("00ff00ff");
    expect(s.nodes[node("head")]!.spine).toEqual({ bone: { skin: true } });
    expect(s.nodes[node("chest")]!.boneColor).toBeUndefined();
    expect(s.nodes[node("torso")]!.boneColor).toBeUndefined();
  });
});

describe("bone icons", () => {
  it("written, left out without nonessential data, and opened again as the bone's", async () => {
    const { project, rig, node } = await loadStickman();
    rig.nodes[node("head")] = { ...rig.nodes[node("head")]!, boneIcon: "star" };
    const out = exportBoneBurst(project).skeleton;
    expect(out.bones.find((b) => b.name === "head")).toMatchObject({ icon: "star" });
    expect(withoutNonessential(out).bones.find((b) => b.name === "head")).not.toHaveProperty("icon");
    const opened = importBoneBurst(out as never, "stickman", new Map()).project;
    const head = Object.values((opened.items[opened.rootSymbolId] as SymbolItem).nodes).find((n) => n.name === "head")!;
    expect(head.boneIcon).toBe("star");
    expect(head.spine?.bone).toBeUndefined();
  });

  it("a version 24 document's carried icon moves to the bone; an icon on a non-bone is dropped", async () => {
    const { project, rig, node } = await loadStickman();
    rig.nodes[node("head")] = { ...rig.nodes[node("head")]!, spine: { bone: { icon: "eye", visible: false } } };
    const torso = Object.values(rig.nodes).find((n) => n.kind === "image")!;
    rig.nodes[torso.id] = { ...torso, boneIcon: "star" };
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 24 })))).project;
    const nodes = (out.items[out.rootSymbolId] as SymbolItem).nodes;
    expect(nodes[node("head")]!.boneIcon).toBe("eye");
    expect(nodes[node("head")]!.spine).toEqual({ bone: { visible: false } });
    expect(nodes[torso.id]!.boneIcon).toBeUndefined();
  });
});
