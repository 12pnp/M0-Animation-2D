import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { newIkId, reseed, type AssetId, type ItemId } from "@/core/doc/ids";
import { createAnimation, createImageItem, createLayer, createNode, createProject, createSymbol } from "@/core/doc/defaults";
import { isImage, isSymbol, type Keyframe, type Node, type Project, type SymbolItem } from "@/core/doc/types";
import { childFrame, displayContext, evaluateSymbol, type FrameContext, type PoseEntry } from "@/core/doc/pose";
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
 * IK bones included: the stage's solver is a transcription of DragonBones',
 * and on these rigs it agrees with Spine's once the bend is mirrored with
 * the y flip. Phase 4 ports Spine's own solver for what they do not share
 * (softness, stretch, non-uniform scale).
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

interface Worst { matrix: number; position: number; corner: number; color: number; checks: number }

/** One node as the stage draws it, nested content included. */
interface Drawn {
  key: string;
  world: Matrix2D;
  /** Drawn, ancestors included (a hidden LAYER counts as shown: the export
   *  ignores the editor's eye toggle). */
  shown: boolean;
  entry: PoseEntry;
  /** Alpha multiplied down from the instances above. */
  alpha: number;
}

/**
 * The stage's pose, flattened the way `SceneRenderer.drawEntry` draws it:
 * each shown instance evaluates its symbol at `childFrame(displayContext)`,
 * hangs it off its world at −pivot, multiplies its alpha down, and hands its
 * own animation and frame to the next level (`innerContext`). Paint order;
 * keys are the export's paths (`SpineExport.paths`). Mask layers are left
 * out, as the export leaves them out for now.
 */
function stagePose(project: Project, sym: SymbolItem, ctx: FrameContext, depth = 0, key = "", base = mat(), alpha = 1, shownAbove = true): Drawn[] {
  const here = depth === 0 ? { animation: sym.animations.find((a) => a.name === ctx.animationName) ?? null, frame: ctx.frame } : childFrame(sym, ctx);
  const pose = evaluateSymbol(sym, here.animation, here.frame, "animate");
  const inner: FrameContext = { animationName: here.animation?.name ?? null, frame: here.frame, mode: "animate" };
  const out: Drawn[] = [];
  for (const e of pose.entries) {
    const layer = sym.layers.find((l) => l.nodeId === e.nodeId)!;
    if (layer.isMask) continue;
    const k = key ? `${key}>${e.nodeId}` : e.nodeId;
    const shown = shownAbove && (e.visible || (!layer.visible && e.displayIndex >= 0 && e.display !== null));
    out.push({ key: k, world: mul(mat(), base, e.world), shown, entry: e, alpha });
    const item = e.display ? project.items[e.display.itemId] : undefined;
    if (shown && isSymbol(item) && depth + 1 < 10) {
      const at = displayContext(inner, e.displaySince);
      const content = mul(mat(), mul(mat(), base, e.world), translate(mat(), -e.display!.pivot.x, -e.display!.pivot.y));
      out.push(...stagePose(project, item, at, depth + 1, `${k}#${e.displayIndex}`, content, alpha * e.color.aM / 100, true));
    }
  }
  return out;
}

/**
 * Every frame of every animation of `symbolId`. Throws on the first
 * mismatch with enough context to find it; returns the largest differences.
 */
function checkParity(project: Project, symbolId: ItemId): Worst {
  const sym = project.items[symbolId];
  if (!isSymbol(sym)) throw new Error("not a symbol");
  const { exported, skeleton } = runtimeFor(project, symbolId);
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
      const drawnAll = stagePose(project, sym, { animationName: anim.name, frame: f, mode: "animate" });
      const slotNames = new Set(skeleton.slots.map((sl) => sl.data.name));
      const painted = drawnAll.map((d) => exported.paths.get(d.key)).filter((n): n is string => !!n && slotNames.has(n));
      const drawnOrder = skeleton.drawOrder.appliedPose.map((sl) => sl.data.name);
      // Slots of content not on screen are in the file but not in this
      // frame's stage pose; compare the order of what both have.
      const both = new Set(painted);
      const runtimeOrder = drawnOrder.filter((n) => both.has(n));
      if (runtimeOrder.join("|") !== painted.join("|")) fail(where, `draw order ${runtimeOrder} vs the stage's ${painted}`);

      const byKey = new Map(drawnAll.map((d) => [d.key, d]));
      for (const [key, name] of exported.paths) {
        const d = byKey.get(key);
        const bone = skeleton.findBone(name);
        if (!bone) fail(where, `no bone "${name}"`);
        const slot = skeleton.findSlot(name);
        const attachment = slot?.appliedPose.getAttachment() ?? null;
        if (!d || !d.shown) {
          // Not on the stage at this frame: nothing of it may be drawn.
          if (attachment) fail(where, `slot "${name}" shows ${attachment.name}, the stage nothing`);
          continue;
        }
        const entry = d.entry;
        const p = bone!.appliedPose;
        const actual = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
        const expected = flipped(d.world);
        for (let i = 0; i < 4; i++) {
          const diff = Math.abs(actual[i]! - expected[i]!);
          worst.matrix = Math.max(worst.matrix, diff);
          if (diff > 2e-5) fail(where, `bone "${name}" matrix ${actual} vs ${expected}`);
        }
        for (let i = 4; i < 6; i++) {
          const diff = Math.abs(actual[i]! - expected[i]!);
          worst.position = Math.max(worst.position, diff);
          if (diff > 1e-3) fail(where, `bone "${name}" position ${actual.slice(4)} vs ${expected.slice(4)}`);
        }
        worst.checks++;

        if (!slot) continue;
        const item = entry.display ? project.items[entry.display.itemId] : undefined;
        const expectShown = isImage(item);
        if (!!attachment !== expectShown) {
          fail(where, `slot "${name}" shows ${attachment?.name ?? "nothing"}, the stage ${expectShown ? item!.name : "nothing"}`);
        }

        const c = slot.appliedPose.color;
        const ec = entry.color;
        for (const [got, want] of [[c.r, ec.rM], [c.g, ec.gM], [c.b, ec.bM], [c.a, ec.aM * d.alpha]] as const) {
          const diff = Math.abs(got - want / 100);
          worst.color = Math.max(worst.color, diff);
          if (diff > 0.5 / 255 + 1e-6) fail(where, `slot "${name}" colour ${[c.r, c.g, c.b, c.a]} vs ${[ec.rM, ec.gM, ec.bM, ec.aM * d.alpha]}`);
        }

        if (attachment instanceof RegionAttachment && isImage(item)) {
          const verts = new Array<number>(8);
          attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), verts, 0, 2);
          // `computeUVs` writes left-bottom, left-top, right-top, right-bottom
          // in its y-up space (the "br, bl, ul" comment in computeWorldVertices
          // does not describe it); bottom is the image's y = h in the editor.
          const m = mul(mat(), d.world, translate(mat(), -entry.display!.pivot.x, -entry.display!.pivot.y));
          const w = item.width, h = item.height;
          const corners = [[0, h], [0, 0], [w, 0], [w, h]].map(([x, y]) => apply({ x: 0, y: 0 }, m, x!, y!));
          corners.forEach((pt, i) => {
            const diff = Math.max(Math.abs(verts[i * 2]! - pt.x), Math.abs(verts[i * 2 + 1]! + pt.y));
            worst.corner = Math.max(worst.corner, diff);
            if (diff > 1e-3) fail(where, `slot "${name}" corner ${i}: ${verts.slice(i * 2, i * 2 + 2)} vs ${[pt.x, -pt.y]}`);
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
      // Three segments, so two keys start inside the interval.
      key(10, tf(140, 90, 40, 25, 1.2, 0.9), {
        tween: { kind: "curve", curve: [0.1, 0.4, 0.2, 0.6, 0.3, 0.7, 0.4, 0.8, 0.5, 1.2, 0.6, 1.3, 0.8, 1.1, 0.9, 1] },
      }),
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
      key(28, tf(45, 5), { tween: { kind: "ease", value: 0.7 } }),
      key(29, tf(50, 5)),
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

/**
 * IK where a DragonBones-style solve and Spine's could part ways: a partial
 * weight, a negative bend, a one-bone look-at, non-uniform scale on the
 * chain, a sheared parent — every target keyed across the solve's range.
 */
function ikRig(opts: { weight?: number; bendPositive?: boolean; chain?: 0 | 1; scale?: [number, number]; shear?: number }): Project {
  const project = createProject("IK");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const add = (node: Node): Node => {
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, node.name, sym.layers.length));
    return node;
  };
  const base = add(createNode("bone", "base", { x: 200, y: 200 }));
  base.bind = tf(200, 200, 10 + (opts.shear ?? 0), 10, opts.scale?.[0] ?? 1, opts.scale?.[1] ?? 1);
  const upper = add(createNode("bone", "upper", { parentId: base.id, x: 20, y: 0 }));
  upper.bind = tf(20, 0, 30, 30);
  upper.boneLength = 80;
  const lower = add(createNode("bone", "lower", { parentId: upper.id, x: 80, y: 0 }));
  lower.bind = tf(80, 0, 40, 40);
  lower.boneLength = 60;
  const target = add(createNode("bone", "target", { x: 330, y: 260 }));
  sym.ik.push({
    id: newIkId(), name: "limb", boneId: lower.id, targetId: target.id,
    chain: opts.chain ?? 1, bendPositive: opts.bendPositive ?? true, weight: opts.weight ?? 1,
  });
  const anim = sym.animations[0]!;
  anim.duration = 24;
  anim.tracks[target.id] = {
    nodeId: target.id, endFrame: 23, keys: [
      key(0, tf(330, 260)), key(8, tf(250, 330)), key(16, tf(420, 150)), key(23, tf(330, 260)),
    ],
  };
  return project;
}

/** A random IK rig: every local of the chain random (non-uniform and
 *  negative scales, shear), random lengths, weight, bend and chain, and a
 *  target sweeping through reachable and unreachable positions. */
function randomIkRig(seed: number): Project {
  let st = seed;
  const r = () => ((st = (st * 16807) % 2147483647) / 2147483647);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const scale = () => pick([1, 1, 1.4, 0.7, -1, 1.2]);
  const angle = () => (r() - 0.5) * 300;
  const local = (x: number, y: number): Transform => {
    const skY = angle();
    return tf(x, y, skY + pick([0, 0, 0, 20, -35]), skY, scale(), scale());
  };
  const project = createProject("IK");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const add = (node: Node): Node => {
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, node.name, sym.layers.length));
    return node;
  };
  const base = add(createNode("bone", "base"));
  base.bind = local(300, 300);
  const upper = add(createNode("bone", "upper", { parentId: base.id }));
  upper.bind = local(30 * r(), 20 * (r() - 0.5));
  upper.boneLength = 40 + 80 * r();
  const lower = add(createNode("bone", "lower", { parentId: upper.id }));
  // Off the parent's axis: a non-uniform parent makes the runtime zero it.
  lower.bind = local(upper.boneLength, 20 * (r() - 0.5));
  lower.boneLength = 30 + 70 * r();
  const target = add(createNode("bone", "target"));
  target.bind = tf(300, 300);
  sym.ik.push({
    id: newIkId(), name: "limb", boneId: lower.id, targetId: target.id,
    chain: pick([0, 1, 1] as const), bendPositive: r() < 0.5, weight: pick([1, 1, 0.5, 0.25, 0.8]),
  });
  const anim = sym.animations[0]!;
  anim.duration = 12;
  anim.tracks[target.id] = {
    nodeId: target.id, endFrame: 11,
    keys: Array.from({ length: 4 }, (_, i) => key(i * 4 - (i === 3 ? 1 : 0), tf(300 + (r() - 0.5) * 500, 300 + (r() - 0.5) * 500))),
  };
  return project;
}

/**
 * Nesting, every rule the flattening follows: a child looping several times
 * inside the root animation; an instance blanked then shown again (restarted
 * on its first animation); a symbol reached through an extra display from
 * frame 10; an animated instance alpha (baked) and a constant 50% one
 * (scaled); a grandchild matched by an animation name its parent lacks;
 * IK inside a nested symbol; transform points on every instance.
 */
function nestedRig(): Project {
  const project = createProject("Nested");
  const scene = project.items[project.rootSymbolId] as SymbolItem;
  const image = (name: string, w: number, h: number) => {
    const item = createImageItem(name, `asset_${name}` as AssetId, w, h);
    project.items[item.id] = item;
    return item;
  };
  const symbol = (name: string) => {
    const s = createSymbol(name);
    project.items[s.id] = s;
    return s;
  };
  const add = (s: SymbolItem, node: Node): Node => {
    s.nodes[node.id] = node;
    s.layers.unshift(createLayer(node.id, node.name, s.layers.length));
    return node;
  };
  const lidArt = image("lid", 40, 20), ballArt = image("ball", 30, 30), boxArt = image("box", 50, 40);

  // Blink: "idle" (7 frames) first, then "walk" (12): the scene's "walk"
  // picks the second by name; Spin's "spin" finds nothing and takes "idle".
  const blink = symbol("Blink");
  const lid = add(blink, createNode("image", "lid", { itemId: lidArt.id, x: 5, y: 3, pivotX: 20, pivotY: 10 }));
  blink.animations[0]!.name = "idle";
  blink.animations[0]!.duration = 7;
  blink.animations[0]!.tracks[lid.id] = {
    nodeId: lid.id, endFrame: 6, keys: [key(0, tf(0, 0, 0, 0, 1.5, 1.5)), key(6, tf(0, 0, 45, 45))],
  };
  blink.animations.push({ ...createAnimation("walk", 12) });
  blink.animations[1]!.tracks[lid.id] = {
    nodeId: lid.id, endFrame: 11, keys: [
      key(0, tf(5, 3), { tween: { kind: "ease", value: 2 } }),
      key(5, tf(5, 13, 20, 20, 1, 0.3), { tween: { kind: "curve", curve: [0.2, 0.9, 0.5, 1.2, 0.6, 1.1, 0.8, 1.3, 0.9, 1] } }),
      key(9, tf(8, 3, -10, -10), { tween: { kind: "none" }, color: { rM: 100, gM: 60, bM: 60, aM: 100, rO: 0, gO: 0, bO: 0, aO: 0 } }),
    ],
  };

  // Spin: "spin" (9 frames), a two-bone IK chain, and Blink inside it.
  const spin = symbol("Spin");
  const hub = add(spin, createNode("image", "hub", { itemId: ballArt.id, pivotX: 15, pivotY: 15 }));
  const upper = add(spin, createNode("bone", "upper", { parentId: hub.id, x: 10, y: 0 }));
  upper.boneLength = 30;
  const lower = add(spin, createNode("bone", "lower", { parentId: upper.id, x: 30, y: 0 }));
  lower.boneLength = 25;
  const tip = add(spin, createNode("bone", "tip", { x: 40, y: 20 }));
  spin.ik.push({ id: newIkId(), name: "arm", boneId: lower.id, targetId: tip.id, chain: 1, bendPositive: true, weight: 0.7 });
  const inner = add(spin, createNode("symbol", "inner", { itemId: blink.id, parentId: lower.id, x: 25, y: 0, pivotX: 4, pivotY: 2 }));
  void inner;
  spin.animations[0]!.name = "spin";
  spin.animations[0]!.duration = 9;
  spin.animations[0]!.tracks[hub.id] = {
    nodeId: hub.id, endFrame: 8, keys: [
      key(0, tf(0, 0), { rotateDir: "cw", rotateTurns: 1, eases: { scale: { kind: "preset", family: "bounce", dir: "out" } } }),
      key(8, tf(0, 0, 30, 30, 1.4, 1.4)),
    ],
  };
  spin.animations[0]!.tracks[tip.id] = {
    nodeId: tip.id, endFrame: 8, keys: [key(0, tf(40, 20)), key(8, tf(20, -30))],
  };

  // The scene: "walk", 40 frames.
  const anim = scene.animations[0]!;
  anim.name = "walk";
  anim.duration = 40;
  const a = add(scene, createNode("symbol", "a", { itemId: blink.id, x: 100, y: 100, pivotX: 10, pivotY: 5 }));
  anim.tracks[a.id] = {
    nodeId: a.id, endFrame: 39, keys: [
      key(0, tf(100, 100), { color: { rM: 100, gM: 100, bM: 100, aM: 100, rO: 0, gO: 0, bO: 0, aO: 0 } }),
      key(20, tf(140, 90, 15, 15), { color: { rM: 100, gM: 100, bM: 100, aM: 40, rO: 0, gO: 0, bO: 0, aO: 0 } }),
      key(25, tf(140, 90, 15, 15), { displayIndex: -1, tween: { kind: "none" } }),
      key(30, tf(120, 110), { tween: { kind: "none" } }),
    ],
  };
  const b = add(scene, createNode("image", "b", { itemId: boxArt.id, x: 250, y: 150, pivotX: 25, pivotY: 20 }));
  b.extraDisplays = [{ itemId: spin.id, pivot: { x: -5, y: 8 } }];
  b.color = { rM: 100, gM: 100, bM: 100, aM: 50, rO: 0, gO: 0, bO: 0, aO: 0 };
  anim.tracks[b.id] = {
    nodeId: b.id, endFrame: 39, keys: [
      key(0, tf(250, 150)),
      key(10, tf(260, 150, 10, 10), { displayIndex: 1 }),
      key(33, tf(250, 160), { tween: { kind: "none" } }),
      key(34, tf(250, 160), { displayIndex: 0 }),
    ],
  };
  return project;
}

describe("the Spine runtime plays the export the way the stage draws it", () => {
  it("a rig using every tween, display switch, blank key, partial span and colour the export handles", () => {
    const { project } = featureRig();
    const worst = checkParity(project, project.rootSymbolId);
    expect(worst.checks).toBeGreaterThan(100);
  });

  it("nested symbols: loops, restarts, swaps, alpha, a grandchild and IK inside", () => {
    const project = nestedRig();
    const worst = checkParity(project, project.rootSymbolId);
    expect(worst.checks).toBeGreaterThan(200);
  });

  it("every symbol of the frog fixture", async () => {
    const { project } = await loadFixture();
    let checks = 0;
    for (const item of Object.values(project.items)) {
      if (isSymbol(item)) checks += checkParity(project, item.id).checks;
    }
    expect(checks).toBeGreaterThan(1000);
  });

  it.each([
    ["full weight", {}],
    ["half weight", { weight: 0.5 }],
    ["negative bend", { bendPositive: false }],
    ["one-bone look-at", { chain: 0 as const }],
    ["non-uniform scale on the chain", { scale: [1.5, 0.6] as [number, number] }],
    ["mirrored parent", { scale: [-1, 1] as [number, number] }],
    ["sheared parent", { shear: 25 }],
  ])("IK: %s", (_name, opts) => {
    const project = ikRig(opts);
    expect(checkParity(project, project.rootSymbolId).checks).toBeGreaterThan(50);
  });

  it("IK: 60 random rigs", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const project = randomIkRig(seed * 7919);
      try {
        checkParity(project, project.rootSymbolId);
      } catch (err) {
        const k = (project.items[project.rootSymbolId] as SymbolItem).ik[0]!;
        throw new Error(`seed ${seed * 7919} (chain ${k.chain}, weight ${k.weight}): ${(err as Error).message}`);
      }
    }
  });

  it("the stickman rig, four two-bone IK chains included", async () => {
    const { project } = await loadStickman();
    expect(checkParity(project, project.rootSymbolId).checks).toBeGreaterThanOrEqual(500);
  });
});
