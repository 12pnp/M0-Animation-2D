import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { reseed, type AssetId } from "@/core/doc/ids";
import type { SymbolItem } from "@/core/doc/types";
import { type AtlasImage, importSpine } from "@/core/spine/importSpine";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { posedSymbol } from "@/core/spine/spinePose";
import type { SpineRaw } from "@/core/spine/types";

/**
 * The importer's own rules, on small hand-made skeletons: what the sample
 * round trip (`spineImport.test.ts`) relies on without isolating.
 */

beforeEach(() => reseed());

const images = (...specs: Array<[string, number, number]>) =>
  new Map<string, AtlasImage>(specs.map(([name, width, height], i) => [name, { name, width, height, assetId: `s${i}` as AssetId }]));

const atlasFor = (specs: Array<[string, number, number]>) =>
  ["p.png", "size:512,512", ...specs.flatMap(([n, w, h], i) => [n, `bounds:0,${i * 10},${w},${h}`])].join("\n");

function skeleton(parts: Partial<Record<string, unknown>>): SpineRaw {
  return { skeleton: { spine: "4.3.74", fps: 30 }, bones: [{ name: "root" }], ...parts };
}

function sym(project: { items: Record<string, unknown>; rootSymbolId: string }): SymbolItem {
  return project.items[project.rootSymbolId] as SymbolItem;
}

describe("frame rate", () => {
  it("runs at the first multiple of the file's rate that puts every key on a frame", () => {
    const file = skeleton({ animations: { a: { bones: { root: { rotate: [{}, { time: 1 / 60, value: 10 }, { time: 0.5, value: 20 }] } } } } });
    const { project, diagnostics } = importSpine(file, "x", images());
    expect(project.frameRate).toBe(60);
    expect(diagnostics.some((d) => d.message.includes("60 fps"))).toBe(true);
  });

  it("keeps the file's rate for keys no rate up to 120 reaches, and says how many", () => {
    const file = skeleton({ animations: { a: { bones: { root: { rotate: [{}, { time: 0.0441, value: 10 }, { time: 0.5, value: 20 }] } } } } });
    const { project, diagnostics } = importSpine(file, "x", images());
    expect(project.frameRate).toBe(30);
    expect(diagnostics.some((d) => d.message.startsWith("1 key(s) fall between frames"))).toBe(true);
  });
});

describe("keys", () => {
  it("keeps an aligned bezier as one curve key, and ends the animation on its last key", () => {
    const file = skeleton({
      animations: { a: { bones: { root: { rotate: [
        { value: 0, curve: [0.2, 0, 0.3, 90] }, { time: 0.5, value: 90 },
      ] } } } },
    });
    const { project, baked } = importSpine(file, "x", images());
    const anim = sym(project).animations[0]!;
    expect(baked).toBe(0);
    expect(anim.endsAtLastFrame).toBe(true);
    expect(anim.duration).toBe(16);
    const keys = Object.values(anim.tracks)[0]!.keys;
    expect(keys.map((k) => k.frame)).toEqual([0, 15]);
    expect(keys[0]!.tween.kind).toBe("curve");
    // The export writes the curve back where it was and ends at 0.5 s.
    const out = exportSpine(project).skeleton.animations!.a!.bones!.root!.rotate!;
    expect(out.length).toBe(2);
    expect(out[0]!.curve).toEqual([expect.closeTo(0.2, 9), expect.closeTo(0, 9), expect.closeTo(0.3, 9), expect.closeTo(90, 9)]);
    expect(exportSpine(project).skeleton.animations!.a!.drawOrder).toBeUndefined();
  });

  it("cuts a bezier where another value is keyed inside it, the short piece a curve", () => {
    // Spine plays the whole curve as 10 chords; a piece of it, played as
    // its own polyline, follows those chords only where few frames fall
    // inside it. Here frames 28-30 (one inside) keep a curve, fitted to
    // what the whole plays; frames 0-28 do not, and are written frame by
    // frame, exact. `spineImport.test.ts` holds each sample rig to the
    // number of such intervals it has today.
    const file = skeleton({
      animations: { a: { bones: { root: {
        rotate: [{ value: 0, curve: [0.3, 0, 0.7, 60] }, { time: 1, value: 60 }],
        translate: [{ x: 0 }, { time: 28 / 30, x: 10 }, { time: 1, x: 20 }],
      } } } },
    });
    const { project, baked } = importSpine(file, "x", images());
    const keys = Object.values(sym(project).animations[0]!.tracks)[0]!.keys;
    expect(baked).toBe(1);
    // Position tweens straight there; rotation's curve is its override.
    const piece = keys.find((k) => k.frame === 28)!;
    expect(piece.tween.kind).toBe("linear");
    expect(piece.eases?.rotation?.kind).toBe("curve");
    expect(keys[keys.length - 1]!.frame).toBe(30);
  });

  it("shows an attachment keyed between two frames from the next one", () => {
    const file = skeleton({
      slots: [{ name: "s", bone: "root", attachment: "a" }],
      skins: [{ name: "default", attachments: { s: { a: { width: 2, height: 2 }, b: { width: 2, height: 2 } } } }],
      animations: { go: { slots: { s: { attachment: [{ time: 0.0441, name: "b" }, { time: 0.2, name: "a" }] } } } },
    });
    const { project } = importSpine(file, "x", images(["a", 2, 2], ["b", 2, 2]));
    const s = sym(project);
    const shown = (f: number) => posedSymbol(project, s, s.animations[0]!, f, "animate").entries.find((e) => e.node.name === "s")!.displayIndex;
    // 0.0441 s is frame 1.32 at 30 fps (no rate up to 120 puts it on a
    // frame): frame 1 still shows "a", frame 2 "b".
    expect([0, 1, 2, 5, 6].map(shown)).toEqual([0, 0, 1, 1, 0]);
  });

  it("writes an interval frame by frame when x and y want different curves", () => {
    const file = skeleton({
      animations: { a: { bones: { root: { translate: [
        { x: 0, y: 0, curve: [0.1, 0, 0.2, 10, 0.1, 0, 0.3, 0] }, { time: 0.5, x: 10, y: 10 },
      ] } } } },
    });
    const { project, baked } = importSpine(file, "x", images());
    expect(baked).toBe(1);
    expect(Object.values(sym(project).animations[0]!.tracks)[0]!.keys.length).toBe(16);
  });

  it("turns light and dark into multiplier and offset, and back to the same bytes", () => {
    const file = skeleton({
      slots: [{ name: "s", bone: "root", color: "c08040ff", dark: "102030" }],
      animations: { a: { slots: { s: { rgba2: [{ light: "ffffffff", dark: "000000" }, { time: 0.2, light: "80a0c0ff", dark: "204060" }] } } } },
    });
    const { project } = importSpine(file, "x", images());
    const node = Object.values(sym(project).nodes).find((n) => n.name === "s")!;
    expect(node.color!.rO).toBeCloseTo(0x10, 9);
    expect(node.color!.rM).toBeCloseTo(((0xc0 - 0x10) / 255) * 100, 9);
    const out = exportSpine(project).skeleton;
    expect(out.slots![0]).toMatchObject({ color: "c08040ff", dark: "102030" });
    expect(out.animations!.a!.slots!.s!.rgba2!.map((k) => [k.light, k.dark])).toEqual([["ffffffff", "000000"], ["80a0c0ff", "204060"]]);
    // The stage hands the runtime the same dark colour, and draws it.
    const e = posedSymbol(project, sym(project), sym(project).animations[0]!, 6, "animate").entries.find((x) => x.node.name === "s")!;
    expect([e.color.rO, e.color.gO, e.color.bO]).toEqual([0x20, 0x40, 0x60]);
  });
});

describe("structure", () => {
  it("keeps a slot and a bone of one name, and a root not called root", () => {
    const file = {
      skeleton: { spine: "4.3.74" },
      bones: [{ name: "Base" }, { name: "head", parent: "Base", y: 10 }],
      slots: [{ name: "head", bone: "head", attachment: "head" }],
      skins: [{ name: "default", attachments: { head: { head: { width: 4, height: 4 } } } }],
    };
    const { project } = importSpine(file, "x", images(["head", 4, 4]));
    const out = exportSpine(project).skeleton;
    expect(out.bones.map((b) => b.name)).toEqual(["Base", "head"]);
    expect(out.bones[0]!.parent).toBeUndefined();
    expect(out.slots).toEqual([{ name: "head", bone: "head", attachment: "head" }]);
    expect(out.skins![0]!.attachments!.head!.head).toEqual({ width: 4, height: 4 });
  });

  it("writes a slot with no setup attachment with none", () => {
    const file = skeleton({
      slots: [{ name: "s", bone: "root" }],
      skins: [{ name: "default", attachments: { s: { a: { width: 2, height: 2 } } } }],
    });
    const { project } = importSpine(file, "x", images(["a", 2, 2]));
    expect(exportSpine(project).skeleton.slots).toEqual([{ name: "s", bone: "root" }]);
  });

  it("re-indexes weighted vertices for the bone order it writes", () => {
    // "b" comes before "a2" here; the export walks the tree (a, a2, b), so
    // every index past "a" moves.
    const verts = [2, 3, 1, 1, 0.5, 2, 1, 1, 0.5, 1, 1, 0, 0, 1, 1, 2, 5, 5, 1];
    const file = {
      skeleton: { spine: "4.3.74" },
      bones: [{ name: "root" }, { name: "a", parent: "root" }, { name: "b", parent: "root", x: 50 }, { name: "a2", parent: "a", y: 20 }],
      slots: [{ name: "m", bone: "root", attachment: "m" }],
      skins: [{ name: "default", attachments: { m: { m: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], vertices: verts, width: 4, height: 4 } } } }],
    };
    const { project } = importSpine(file, "x", images(["m", 4, 4]));
    const out = exportSpine(project).skeleton;
    const order = out.bones.map((b) => b.name);
    expect(order).not.toEqual(["root", "a", "b", "a2"]);
    const written = (out.skins![0]!.attachments!.m!.m as SpineRaw).vertices as number[];
    const names = ["root", "a", "b", "a2"];
    // Every bone entry names the same bone as before.
    const read = (v: number[], bones: string[]) => {
      const out: string[] = [];
      for (let i = 0; i < v.length;) { const n = v[i++]!; for (let k = 0; k < n; k++, i += 4) out.push(bones[v[i]!]!); }
      return out;
    };
    expect(read(written, order)).toEqual(read(verts, names));
    // And the runtime places them where the original does.
    const atlas = atlasFor([["m", 4, 4]]);
    const place = (json: unknown) => {
      const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlas))).readSkeletonData(json));
      sk.setupPose();
      sk.updateWorldTransform(Physics.none);
      const slot = sk.findSlot("m")!;
      const att = slot.appliedPose.getAttachment() as MeshAttachment;
      const v = new Array<number>(att.worldVerticesLength);
      att.computeWorldVertices(sk, slot, 0, v.length, v, 0, 2);
      return v;
    };
    expect(place(JSON.parse(spineJson(out)))).toEqual(place(file));
  });

  it("carries other constraints as they came, in the file's order", () => {
    const path = { type: "path", name: "p", slot: "s", bones: ["a"], spacing: 0.5 };
    const physics = { type: "physics", name: "q", bone: "a", inertia: 0.5 };
    const file = {
      skeleton: { spine: "4.3.74" },
      bones: [{ name: "root" }, { name: "a", parent: "root" }, { name: "t", parent: "root" }],
      slots: [{ name: "s", bone: "root" }],
      constraints: [physics, { type: "ik", name: "k", bones: ["a"], target: "t", softness: 3 }, path],
    };
    const { project } = importSpine(file, "x", images());
    expect(sym(project).ik.map((k) => k.name)).toEqual(["k"]);
    const out = exportSpine(project).skeleton.constraints!;
    expect(out.map((c) => c.name)).toEqual(["q", "k", "p"]);
    expect(out[0]).toEqual(physics);
    expect(out[2]).toEqual(path);
    expect(out[1]).toMatchObject({ type: "ik", bones: ["a"], target: "t", softness: 3 });
  });

  it("refuses to export when an edit breaks a name the carried JSON needs", () => {
    const file = {
      skeleton: { spine: "4.3.74" },
      bones: [{ name: "root" }, { name: "a", parent: "root" }],
      constraints: [{ type: "physics", name: "q", bone: "a" }],
    };
    const { project } = importSpine(file, "x", images());
    const a = Object.values(sym(project).nodes).find((n) => n.name === "a")!;
    a.name = "renamed";
    const errors = exportSpine(project).diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('needs the bone "a"')]);
  });

  it("does not change the document, and writes the same file twice", () => {
    const file = {
      skeleton: { spine: "4.3.74" },
      bones: [{ name: "root" }, { name: "a", parent: "root" }],
      slots: [{ name: "m", bone: "root", attachment: "m" }],
      skins: [
        { name: "default", attachments: { m: { m: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], vertices: [1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1], width: 4, height: 4 } } } },
        { name: "other", attachments: { m: { m2: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], vertices: [1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1], width: 4, height: 4 } } } },
      ],
    };
    const { project } = importSpine(file, "x", images(["m", 4, 4], ["m2", 4, 4]));
    const before = JSON.stringify(project);
    const first = spineJson(exportSpine(project).skeleton);
    expect(JSON.stringify(project)).toBe(before);
    expect(spineJson(exportSpine(project).skeleton)).toBe(first);
  });

  it("keeps Spine's own shear on a bone that does not inherit everything", () => {
    const file = {
      skeleton: { spine: "4.3.74" },
      bones: [{ name: "root", scaleX: 2 }, { name: "a", parent: "root", inherit: "noScale", rotation: 30, shearX: 20 }],
      animations: { go: { bones: { a: { shear: [{ x: 5 }, { time: 1, x: 40 }] } } } },
    };
    const { project } = importSpine(file, "x", images());
    const out = JSON.parse(spineJson(exportSpine(project).skeleton));
    const pose = (json: unknown) => {
      const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(""))).readSkeletonData(json));
      sk.setupPose();
      sk.data.findAnimation("go")!.apply(sk, 0, 0.5, false, null, 1, MixFrom.setup, false, false, false);
      sk.updateWorldTransform(Physics.none);
      const w = sk.findBone("a")!.appliedPose;
      return [w.a, w.b, w.c, w.d];
    };
    pose(out).forEach((v, i) => expect(v).toBeCloseTo(pose(file)[i]!, 9));
    // The stage too, where no key sets the shear: the setup pose carries it.
    const setupWorld = (json: unknown) => {
      const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(""))).readSkeletonData(json));
      sk.setupPose();
      sk.updateWorldTransform(Physics.none);
      const w = sk.findBone("a")!.appliedPose;
      return [w.a, -w.c, -w.b, w.d];
    };
    const e = posedSymbol(project, sym(project), null, 0, "setup").entries.find((x) => x.node.name === "a")!;
    [e.world.a, e.world.b, e.world.c, e.world.d].forEach((v, i) => expect(v).toBeCloseTo(setupWorld(file)[i]!, 9));
  });
});
