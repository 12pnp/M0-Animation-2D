import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, ClippingAttachment, MeshAttachment, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson,
  Skin, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { reseed } from "@/core/doc/ids";
import type { Project, SymbolItem } from "@/core/doc/types";
import { createProject } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";
import { History } from "@/core/history/History";
import { SetStageSkins } from "@/core/history/commands";
import { SetIkOptions } from "@/core/history/ikCommands";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { posedSymbol, boneburstPoseError, stageSkinOf } from "@/core/boneburst/boneburstPose";
import { imagesOf, type SampleRig, sampleRigs } from "./fixtures/spineSamples";

/**
 * The stage draws an opened Spine file through the runtime (`boneburstPose.ts`):
 * the document's pose in, the runtime's worlds, attachments, colours, draw
 * order and vertices out. That must be what the EXPORT plays, frame by
 * frame, or the stage would show one thing and the file another. The
 * export is played the way the preview seeks (time f / fps, exactly).
 */

beforeEach(() => reseed());

const found = sampleRigs();

/** Every frame of every animation, the stage against the export played
 *  with the skins the stage shows; how many attachments were compared. */
function compare(rig: SampleRig, project: Project, sym: SymbolItem): number {
  expect(boneburstPoseError(project, sym)).toBeNull();
  const exported = exportBoneBurst(project);
  const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(rig.atlas)))
    .readSkeletonData(JSON.parse(boneburstJson(exported.skeleton))));
  // A rig without a default skin shows ones the stage picks; so must the file.
  const skins = stageSkinOf(sym);
  if (skins.length) {
    const combined = new Skin("stage");
    for (const n of skins) combined.addSkin(sk.data.findSkin(n)!);
    sk.setSkin(combined);
  }
  const fps = project.frameRate;
  let worst = 0, checks = 0;
  const fail = (where: string, what: string) => { throw new Error(`${rig.name} ${where}: ${what}`); };

  for (const anim of sym.animations) {
    const runtimeAnim = sk.data.findAnimation(anim.name)!;
    for (let f = 0; f < anim.duration; f++) {
      const where = `"${anim.name}" frame ${f}`;
      sk.setupPose();
      runtimeAnim.apply(sk, 0, f / fps, false, null, 1, MixFrom.setup, false, false, false);
      sk.updateWorldTransform(Physics.reset);
      const pose = posedSymbol(project, sym, anim, f, "animate");

      for (const [nodeId, name] of exported.names) {
        const e = pose.byNode.get(nodeId)!;
        const bone = sk.findBone(name)!;
        // spine-core leaves an inactive bone where it was: nothing to compare.
        if (!bone.active) continue;
        const w = bone.appliedPose;
        const d = Math.max(Math.abs(e.world.a - w.a), Math.abs(e.world.b + w.c), Math.abs(e.world.c + w.b), Math.abs(e.world.d - w.d));
        const p = Math.max(Math.abs(e.world.tx - w.worldX), Math.abs(e.world.ty + w.worldY));
        worst = Math.max(worst, p);
        if (d > 1e-4 || p > 1e-3) fail(where, `bone "${name}" off by ${d} / ${p}`);
      }
      const drawn = pose.entries.filter((e) => exported.slots.has(e.nodeId)).map((e) => exported.slots.get(e.nodeId));
      const order = sk.drawOrder.appliedPose.map((s) => s.data.name);
      if (drawn.join("|") !== order.join("|")) fail(where, "draw order differs");

      for (const [nodeId, name] of exported.slots) {
        const e = pose.byNode.get(nodeId as never)!;
        const slot = sk.findSlot(name)!;
        // A slot on a bone no shown skin enables is not drawn: Spine's
        // renderers skip it, though spine-core still holds its attachment.
        if (!slot.bone.active) {
          if (e.spine || e.clip) fail(where, `slot "${name}" is drawn on an inactive bone`);
          continue;
        }
        const att = slot.appliedPose.getAttachment();
        const drawsImage = att instanceof RegionAttachment || att instanceof MeshAttachment;
        if (!!e.spine !== drawsImage) fail(where, `slot "${name}": the stage ${e.spine ? "draws" : "draws nothing"}, the runtime shows ${att?.name ?? "nothing"}`);
        if ((att instanceof ClippingAttachment) !== !!e.clip) fail(where, `slot "${name}": clipping differs`);
        const l = slot.appliedPose.color;
        const c = e.color;
        const tint = drawsImage ? (att as RegionAttachment).color : null;
        const dr = slot.appliedPose.darkColor?.r ?? 0;
        // The file holds 8-bit colours: a key the import added inside a
        // tween is rounded to one.
        if (Math.abs((c.rM / 100 + c.rO / 255) - l.r * (tint?.r ?? 1)) > 1 / 255 || Math.abs(c.rO / 255 - dr) > 1 / 255
          || Math.abs(c.aM / 100 - l.a * (tint?.a ?? 1)) > 1 / 255) fail(where, `slot "${name}" colour differs`);
        if (!e.spine) continue;
        const v = new Array<number>(e.spine.vertices.length);
        if (att instanceof RegionAttachment) att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), v, 0, 2);
        else (att as MeshAttachment).computeWorldVertices(sk, slot, 0, v.length, v, 0, 2);
        for (let i = 0; i < v.length; i++) {
          const diff = Math.abs(e.spine.vertices[i]! - (i % 2 ? -v[i]! : v[i]!));
          worst = Math.max(worst, diff);
          if (diff > 2e-3) fail(where, `slot "${name}" vertex ${i >> 1} off by ${diff}`);
        }
        checks++;
      }
    }
  }
  console.log(rig.name, skins.join(" + ") || "default", "worst", worst, "attachments checked", checks);
  return checks;
}

describe.skipIf(found.length === 0)("the stage poses an opened Spine file as its export plays", () => {
  for (const rig of found) {
    it(rig.name, () => {
      const { project } = importBoneBurst(JSON.parse(rig.json), rig.name, imagesOf(rig.atlas));
      expect(compare(rig, project, project.items[project.rootSymbolId] as SymbolItem)).toBeGreaterThan(0);
    });
  }
});

const mix = found.find((r) => r.name === "mix-and-match");

describe.skipIf(!mix)("skins", () => {
  const open = () => {
    const { project } = importBoneBurst(JSON.parse(mix!.json), mix!.name, imagesOf(mix!.atlas));
    return { project, sym: project.items[project.rootSymbolId] as SymbolItem };
  };
  /** What the setup pose draws: each slot's attachment and where. */
  const drawn = (project: Project, sym: SymbolItem) =>
    posedSymbol(project, sym, null, 0, "setup").entries.filter((e) => e.spine).map((e) => `${e.node.name}:${e.spine!.vertices.map((v) => v.toFixed(2)).join(",")}`);

  it("shows several combined, as the export plays them, and the stage changes with the choice", () => {
    const { project, sym } = open();
    expect(stageSkinOf(sym)).toEqual(["skin-base"]);
    const before = drawn(project, sym);
    sym.stageSkins = ["skin-base", "hair/pink", "clothes/hoodie-orange", "legs/pants-jeans", "nose/long", "eyes/violet"];
    expect(compare(mix!, project, sym)).toBeGreaterThan(0);
    const after = drawn(project, sym);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((d) => !before.includes(d)).length).toBeGreaterThan(3);
  });

  it("ignores a chosen skin the file no longer has, and shows the default skin alone for none", () => {
    const { project, sym } = open();
    sym.stageSkins = ["gone", "hair/pink"];
    expect(stageSkinOf(sym)).toEqual(["hair/pink"]);
    sym.stageSkins = [];
    expect(stageSkinOf(sym)).toEqual([]);
    expect(compare(mix!, project, sym)).toBeGreaterThanOrEqual(0);
  });

  it("is kept by the file, and dropped from a symbol that is not an opened rig", () => {
    const { project, sym } = open();
    sym.stageSkins = ["hair/pink", 3 as unknown as string, "hair/pink"];
    const back = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    expect((back.items[back.rootSymbolId] as SymbolItem).stageSkins).toEqual(["hair/pink"]);
    const plain = createProject("T");
    (plain.items[plain.rootSymbolId] as SymbolItem).stageSkins = ["x"];
    const out = validateProject(migrate(JSON.parse(JSON.stringify(plain)))).project;
    expect((out.items[out.rootSymbolId] as SymbolItem).stageSkins).toBeUndefined();
  });

  it("is chosen in one undo step", () => {
    const { project, sym } = open();
    const history = new History(project);
    history.apply(new SetStageSkins(sym.id, ["hair/pink"]));
    expect(stageSkinOf(sym)).toEqual(["hair/pink"]);
    history.undo();
    expect(sym.stageSkins).toBeUndefined();
    expect(stageSkinOf(sym)).toEqual(["skin-base"]);
    history.redo();
    expect(sym.stageSkins).toEqual(["hair/pink"]);
  });
});

describe("the stage's rig follows edits", () => {
  it("an edit to the rig's structure through the history (an IK's bend) reaches the next pose, and undo brings it back", () => {
    const file = {
      skeleton: { spine: "4.3.74", fps: 30 },
      bones: [{ name: "root" }, { name: "a", parent: "root", length: 50 }, { name: "b", parent: "a", x: 50, length: 50 }, { name: "t", parent: "root", x: 60, y: 40 }],
      constraints: [{ type: "ik", name: "k", bones: ["a", "b"], target: "t" }],
    };
    const { project } = importBoneBurst(file as never, "x", new Map());
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const history = new History(project);
    const b = Object.values(sym.nodes).find((n) => n.name === "b")!.id;
    const at = () => { const w = posedSymbol(project, sym, null, 0, "setup").byNode.get(b)!.world; return [Math.round(w.tx), Math.round(w.ty)]; };
    const before = at();
    history.apply(new SetIkOptions(sym.id, sym.ik[0]!.id, { bendPositive: !sym.ik[0]!.bendPositive }));
    const flipped = at();
    expect(flipped).not.toEqual(before);
    history.undo();
    expect(at()).toEqual(before);
  });
});
