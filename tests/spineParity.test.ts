import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { reseed, type AssetId, type ItemId, type NodeId } from "@/core/doc/ids";
import { createImageItem, createLayer, createNode, createProject } from "@/core/doc/defaults";
import { isImage, isSymbol, type Keyframe, type Node, type Project, type SymbolItem } from "@/core/doc/types";
import { evaluateSymbol } from "@/core/doc/pose";
import { apply, type Matrix2D, mat, mul, translate } from "@/core/math/Matrix2D";
import { tf, type Transform } from "@/core/math/Transform";
import type { PackedPage } from "@/core/atlas/packed";
import { atlasText } from "@/core/spine/atlas";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { loadFixture } from "./fixtures/realProject";
import { loadStickman } from "./fixtures/stickman";

/**
 * The export played by the Spine runtime itself (spine-core 4.3.13) must
 * show what the stage shows, at every whole frame of every animation: each
 * bone's world matrix, each slot's attachment and colour, and the four
 * corners of each image. The stage side is `evaluateSymbol`, the function
 * the stage draws with. This is the preview-is-ground-truth rule, checked
 * without a browser.
 *
 * Bones an IK constraint moves are left out until phase 4: the stage still
 * solves IK the DragonBones way.
 */

beforeEach(() => reseed());

/** One untrimmed page holding every image the export uses. */
function pageFor(project: Project, ids: ItemId[]): PackedPage {
  let y = 0, width = 1;
  const regions = ids.map((id) => {
    const item = project.items[id];
    if (!isImage(item)) throw new Error("not an image");
    const r = {
      name: item.name, x: 0, y, width: item.width, height: item.height,
      offsetX: 0, offsetY: 0, originalWidth: item.width, originalHeight: item.height, rotated: false,
    };
    y += item.height;
    width = Math.max(width, item.width);
    return r;
  });
  return { name: "p", imagePath: "p.png", width, height: Math.max(1, y), scale: 1, regions };
}

function runtimeFor(project: Project, symbolId: ItemId) {
  const exported = exportSpine(project, symbolId);
  // Through the text, as a file would go.
  const json = JSON.parse(spineJson(exported.skeleton));
  const atlas = new TextureAtlas(atlasText([pageFor(project, exported.usedImages)]));
  const data = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(json);
  return { exported, skeleton: new Skeleton(data) };
}

/** Editor world matrix, y flipped, in Spine's a b c d x y order. */
function flipped(m: Matrix2D): number[] {
  return [m.a, -m.c, -m.b, m.d, m.tx, -m.ty];
}

function ikMoved(sym: SymbolItem): Set<NodeId> {
  const out = new Set<NodeId>();
  const add = (id: NodeId): void => {
    if (out.has(id)) return;
    out.add(id);
    for (const n of Object.values(sym.nodes)) if (n.parentId === id) add(n.id);
  };
  for (const k of sym.ik) {
    const bone = sym.nodes[k.boneId];
    if (!bone) continue;
    add(bone.id);
    if (k.chain > 0 && bone.parentId) add(bone.parentId);
  }
  return out;
}

interface Worst { matrix: number; position: number; corner: number; color: number; checks: number }

/**
 * Every frame of every animation of `symbolId`. Throws on the first
 * mismatch with enough context to find it; returns the largest differences.
 */
function checkParity(project: Project, symbolId: ItemId): Worst {
  const sym = project.items[symbolId];
  if (!isSymbol(sym)) throw new Error("not a symbol");
  const { exported, skeleton } = runtimeFor(project, symbolId);
  const skipIk = ikMoved(sym);
  const fps = project.frameRate;
  const worst: Worst = { matrix: 0, position: 0, corner: 0, color: 0, checks: 0 };
  const fail = (where: string, what: string) => { throw new Error(`${sym.name} ${where}: ${what}`); };

  for (const anim of sym.animations) {
    const animation = skeleton.data.findAnimation(anim.name);
    if (!animation) fail(anim.name, "animation missing from the export");
    for (let f = 0; f < anim.duration; f++) {
      const where = `"${anim.name}" frame ${f}`;
      skeleton.setupPose();
      animation!.apply(skeleton, 0, f / fps, false, null, 1, MixFrom.setup, false, false, false);
      skeleton.updateWorldTransform(Physics.none);
      const pose = evaluateSymbol(sym, anim, f, "animate");
      const slotNames = new Set(skeleton.slots.map((sl) => sl.data.name));
      const painted = pose.entries.map((e) => exported.names.get(e.nodeId)).filter((n): n is string => !!n && slotNames.has(n));
      const drawn = skeleton.drawOrder.appliedPose.map((sl) => sl.data.name);
      if (drawn.join("|") !== painted.join("|")) fail(where, `draw order ${drawn} vs the stage's ${painted}`);

      for (const [nodeId, name] of exported.names) {
        const entry = pose.byNode.get(nodeId);
        const bone = skeleton.findBone(name);
        if (!entry || !bone) fail(where, `no bone or entry for "${name}"`);
        if (skipIk.has(nodeId)) continue;
        const p = bone!.appliedPose;
        const actual = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
        const expected = flipped(entry!.world);
        for (let i = 0; i < 4; i++) {
          const d = Math.abs(actual[i]! - expected[i]!);
          worst.matrix = Math.max(worst.matrix, d);
          if (d > 2e-5) fail(where, `bone "${name}" matrix ${actual} vs ${expected}`);
        }
        for (let i = 4; i < 6; i++) {
          const d = Math.abs(actual[i]! - expected[i]!);
          worst.position = Math.max(worst.position, d);
          if (d > 1e-3) fail(where, `bone "${name}" position ${actual.slice(4)} vs ${expected.slice(4)}`);
        }
        worst.checks++;

        const slot = skeleton.findSlot(name);
        if (!slot) continue;
        const layer = sym.layers.find((l) => l.nodeId === nodeId)!;
        const shown = entry!.visible || (!layer.visible && entry!.displayIndex >= 0 && entry!.display !== null);
        const attachment = slot.appliedPose.getAttachment();
        const item = entry!.display ? project.items[entry!.display.itemId] : undefined;
        const expectShown = shown && isImage(item);
        if (!!attachment !== expectShown) {
          fail(where, `slot "${name}" shows ${attachment?.name ?? "nothing"}, the stage ${expectShown ? item!.name : "nothing"}`);
        }

        const c = slot.appliedPose.color;
        const ec = entry!.color;
        for (const [got, want] of [[c.r, ec.rM], [c.g, ec.gM], [c.b, ec.bM], [c.a, ec.aM]] as const) {
          const d = Math.abs(got - want / 100);
          worst.color = Math.max(worst.color, d);
          if (d > 0.5 / 255 + 1e-6) fail(where, `slot "${name}" colour ${[c.r, c.g, c.b, c.a]} vs ${[ec.rM, ec.gM, ec.bM, ec.aM]}`);
        }

        if (attachment instanceof RegionAttachment && isImage(item)) {
          const verts = new Array<number>(8);
          attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), verts, 0, 2);
          // `computeUVs` writes left-bottom, left-top, right-top, right-bottom
          // in its y-up space (the "br, bl, ul" comment in computeWorldVertices
          // does not describe it); bottom is the image's y = h in the editor.
          const m = mul(mat(), entry!.world, translate(mat(), -entry!.display!.pivot.x, -entry!.display!.pivot.y));
          const w = item.width, h = item.height;
          const corners = [[0, h], [0, 0], [w, 0], [w, h]].map(([x, y]) => apply({ x: 0, y: 0 }, m, x!, y!));
          corners.forEach((pt, i) => {
            const d = Math.max(Math.abs(verts[i * 2]! - pt.x), Math.abs(verts[i * 2 + 1]! + pt.y));
            worst.corner = Math.max(worst.corner, d);
            if (d > 1e-3) fail(where, `slot "${name}" corner ${i}: ${verts.slice(i * 2, i * 2 + 2)} vs ${[pt.x, -pt.y]}`);
          });
        }
      }
    }
  }
  if (process.env.PARITY_REPORT) console.log(sym.name, JSON.stringify(worst));
  return worst;
}

/* ── a rig built to exercise what the fixtures do not ── */

function key(frame: number, t: Transform, extra: Partial<Keyframe> = {}): Keyframe {
  return { frame, transform: t, displayIndex: 0, tween: { kind: "linear" }, ...extra };
}

function featureRig(): { project: Project; sym: SymbolItem } {
  const project = createProject("Features");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const image = (name: string, w: number, h: number) => {
    const item = createImageItem(name, `asset_${name}` as AssetId, w, h);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
    return item;
  };
  const a = image("a", 60, 40), b = image("b", 30, 30), c = image("c", 20, 50);
  const add = (node: Node): Node => {
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, node.name, sym.layers.length));
    return node;
  };

  const arm = add(createNode("bone", "arm", { x: 100, y: 120 }));
  const hand = add(createNode("image", "hand", { itemId: a.id, parentId: arm.id, x: 40, y: 0, pivotX: 10, pivotY: 20 }));
  hand.extraDisplays = [{ itemId: b.id, pivot: { x: 15, y: 15 } }, { itemId: a.id, pivot: { x: 0, y: 0 } }];
  hand.color = { rM: 90, gM: 80, bM: 100, aM: 100, rO: 0, gO: 0, bO: 0, aO: 0 };
  const late = add(createNode("image", "late", { itemId: c.id, x: 300, y: 50, pivotX: 10, pivotY: 25 }));
  const spin = add(createNode("image", "spin", { itemId: b.id, x: 200, y: 200, pivotX: 15, pivotY: 15 }));
  spin.bind = tf(200, 200, 30, 10, 1.5, 0.8);

  const anim = sym.animations[0]!;
  anim.duration = 30;
  anim.tracks[arm.id] = {
    nodeId: arm.id, endFrame: 29, keys: [
      key(0, tf(100, 120), { tween: { kind: "preset", family: "sine", dir: "inOut" } }),
      key(10, tf(140, 90, 40, 25, 1.2, 0.9), { tween: { kind: "curve", curve: [0.25, 0.1, 0.25, 1] } }),
      key(20, tf(120, 100, -20, -20, -1, 1), { rotateDir: "cw", rotateTurns: 1 }),
      key(29, tf(100, 120, 5, 5), { tween: { kind: "none" } }),
    ],
  };
  anim.tracks[hand.id] = {
    nodeId: hand.id, endFrame: 29, keys: [
      key(0, tf(40, 0), { eases: { position: { kind: "preset", family: "back", dir: "out" }, scale: { kind: "ease", value: 1 } } }),
      key(8, tf(60, 10, 10, 10, 2, 0.5), { displayIndex: 1, tween: { kind: "none" } }),
      key(12, tf(60, 10, 10, 10, 2, 0.5), { displayIndex: -1, tween: { kind: "none" } }),
      key(16, tf(30, -10, -30, -40), {
        displayIndex: 2, color: { rM: 50, gM: 100, bM: 20, aM: 70, rO: 0, gO: 0, bO: 0, aO: 0 },
        eases: { color: { kind: "preset", family: "bounce", dir: "out" } },
      }),
      key(24, tf(40, 0), { color: { rM: 100, gM: 40, bM: 100, aM: 100, rO: 0, gO: 0, bO: 0, aO: 0 }, tween: { kind: "ease", value: -1 } }),
      key(28, tf(45, 5)),
    ],
  };
  anim.tracks[late.id] = {
    nodeId: late.id, endFrame: 20, keys: [
      key(5, tf(300, 50, 0, 0, 0.5, 0.5)),
      key(15, tf(320, 80, 90, 90)),
    ],
  };
  anim.tracks[spin.id] = {
    nodeId: spin.id, endFrame: 29, keys: [
      key(0, tf(200, 200, 30, 10, 1.5, 0.8), { rotateDir: "ccw", rotateTurns: 2 }),
      key(15, tf(210, 190, 60, 40, 1.5, 0.8), { tween: { kind: "ease", value: 2 } }),
      key(29, tf(200, 200, 30, 10, 1.5, 0.8)),
    ],
  };
  return { project, sym };
}

describe("the Spine runtime plays the export the way the stage draws it", () => {
  it("a rig using every tween, display switch, blank key, partial span and colour the export handles", () => {
    const { project } = featureRig();
    const worst = checkParity(project, project.rootSymbolId);
    expect(worst.checks).toBeGreaterThan(100);
  });

  it("every symbol of the frog fixture", async () => {
    const { project } = await loadFixture();
    let checks = 0;
    for (const item of Object.values(project.items)) {
      if (isSymbol(item)) checks += checkParity(project, item.id).checks;
    }
    expect(checks).toBeGreaterThan(1000);
  });

  it("the stickman rig, IK-driven bones aside", async () => {
    const { project } = await loadStickman();
    expect(checkParity(project, project.rootSymbolId).checks).toBeGreaterThanOrEqual(500);
  });
});
