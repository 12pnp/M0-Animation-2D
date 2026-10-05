import type { CnId } from "@/core/doc/ids";
import { keyedConstraint, setupValue, valueAt } from "@/core/doc/constraintKeys";
import { orderAt } from "@/core/doc/drawOrder";
import { ikPoseAt } from "@/core/doc/ikKeys";
import { tcMixAt } from "@/core/doc/transformKeys";
import type { ItemId, NodeId } from "@/core/doc/ids";
import type { Animation, ColorTransform, Project, SymbolItem } from "@/core/doc/types";
import { isImage } from "@/core/doc/types";
import { displaysOf } from "@/core/doc/displays";
import { stageSkinOf } from "@/core/doc/skins";
import { docEpoch } from "@/core/doc/revision";
import { inheritAt, runtimePosed } from "@/core/doc/inherit";
import { evaluateSymbol, type Pose, type PoseEntry } from "@/core/doc/pose";
import { matOf } from "@/core/math/Matrix2D";
import type { PackedPage } from "@/core/atlas/packed";
import { atlasText } from "./atlas";
import { exportSpine } from "./exportSpine";
import { toSpineLocal } from "./transform";
import { readAtlas } from "./runtime/atlasRead";
import { type AttachmentData, readRig } from "./runtime/rigData";
import { Rig as Runtime } from "./runtime/rig";
import type { PhysicsMode } from "./runtime/physics";

/**
 * A symbol opened from a Spine file, posed by the BoneBurst runtime
 * (`./runtime/`, docs/PREVIEW-RUNTIME-PLAN.md P3b), which plays Spine 4.3 as
 * spine-core does.
 *
 * Such a rig relies on what the editor's own pose does not do: meshes and
 * their weights and deform keys, inherit modes, transform, path, physics
 * and slider constraints, clipping, draw order keys. So the stage hands the
 * runtime the document's pose and draws what comes back:
 *
 *   in   each bone's local transform and each slot's attachment and colour,
 *        exactly as the editor evaluates them (`evaluateSymbol`), then the
 *        carried timelines of the animation at that frame
 *   out  world matrices, the attachment each slot shows, its colour, the
 *        draw order, and the world vertices of every region and mesh
 *
 * The skeleton comes from `exportSpine` (`setupOnly`), the file the export
 * would write, so what the stage draws is what the export plays; keys are
 * the editor's, sampled as the parity tests prove the runtime plays them.
 * It is rebuilt only when the rig's STRUCTURE changes (`structureKey`):
 * moving a bone or keying a colour sets values on the same skeleton.
 * `tests/spinePose.test.ts` holds the stage to spine-core playing the export.
 *
 * Physics is posed at rest ("reset"): a simulation needs the frames before
 * it, and a seek has none; while the stage plays it steps on (`livePhysics`).
 * The Preview plays it.
 */

interface Rig {
  rt: Runtime;
  /** Bones by the node that makes them (index in the runtime's bones). */
  bones: Map<NodeId, number>;
  /** Slots by the node that makes them, and back. */
  slots: Map<NodeId, number>;
  slotNode: Map<number, NodeId>;
  /** The skin key each display index shows, per slot node. */
  displayNames: Map<NodeId, Map<number, string>>;
  /** Carried shear, per bone node: Spine's own (see `importSpine`). */
  keepsShear: Set<NodeId>;
  images: Map<string, ItemId>;
  /** Constraints by name (index in the runtime's constraints). */
  constraints: Map<string, number>;
  /** The frame physics last stepped to, while frames come in order. */
  physicsAt: { animation: string; frame: number } | null;
}

const bySymbol = new WeakMap<SymbolItem, Map<string, { key: string; epoch: number; rig: Rig | null; error?: string }>>();
const byKey = new Map<string, { rig: Rig | null; error?: string }>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function idOf(o: object | undefined): number {
  if (!o) return 0;
  let id = objectIds.get(o);
  if (!id) objectIds.set(o, (id = nextObjectId++));
  return id;
}

/**
 * What the skeleton depends on, and nothing it does not: not the setup
 * pose, colours or keys, which are set on it every frame. Carried JSON is
 * never edited in place, so its identity stands for its content.
 */
function structureKey(project: Project, sym: SymbolItem): string {
  const nodes = Object.values(sym.nodes).map((n) => [
    n.id, n.name, n.kind, n.parentId, n.slotBone, n.inherit, n.setupDisplay, n.blendMode, n.boneLength,
    displaysOf(n).map((d) => [d.itemId, project.items[d.itemId]?.name, idOf(d.attachment?.data), d.attachment?.name ?? d.key, idOf(d.mesh), idOf(d.sequence), idOf(d.linked), idOf(d.region), d.name, d.tint, !!d.skinOnly]),
    idOf(n.spine?.bone), idOf(n.spine?.slot), idOf(n.box), idOf(n.path), idOf(n.point),
  ]);
  const layers = sym.layers.map((l) => [l.nodeId, l.excludeFromExport, l.isMask, l.maskedBy]);
  const ik = sym.ik.map((k) => [k.name, k.boneId, k.targetId, k.chain, k.bendPositive, k.weight, k.softness, k.stretch, k.compress, k.scaleY, idOf(k.spine)]);
  const tcs = (sym.transforms ?? []).map((k) => JSON.stringify(k));
  // A slider's animation is in the rig whole (`setupOnly`): its keys are structure.
  // Deform and sequence keys are in the rig too.
  const anims = sym.animations.map((a) => [a.name, idOf(a.spine), sym.sliders?.some((k) => k.animId === a.id) ? JSON.stringify(a) : 0, JSON.stringify([a.deforms, a.displayDeforms, a.sequences])]);
  const others = [idOf(sym.physics), idOf(sym.sliders), idOf(sym.paths), sym.constraintOrder ?? null];
  return JSON.stringify([idOf(sym.spine), idOf(sym.skins), project.frameRate, nodes, layers, ik, tcs, anims, others]);
}

function rigFor(project: Project, sym: SymbolItem, skins: readonly string[]): { rig: Rig | null; error?: string } {
  let perSkin = bySymbol.get(sym);
  if (!perSkin) bySymbol.set(sym, (perSkin = new Map()));
  const skinKey = JSON.stringify(skins);
  const cached = perSkin.get(skinKey);
  // Edits change the symbol in place: after one, the structure is read again.
  if (cached?.epoch === docEpoch.n) return cached;
  const key = JSON.stringify([skins, structureKey(project, sym)]);
  if (cached?.key === key) { cached.epoch = docEpoch.n; return cached; }
  let built = byKey.get(key);
  if (!built) {
    built = buildRig(project, sym, skins);
    byKey.set(key, built);
    // A handful of structures at most: undo and redo flip between a few.
    if (byKey.size > 8) byKey.delete(byKey.keys().next().value!);
  }
  const out = { key, epoch: docEpoch.n, ...built };
  perSkin.set(skinKey, out);
  return out;
}

export { skinsOf, stageSkinOf, toggledSkins } from "@/core/doc/skins";

function buildRig(project: Project, sym: SymbolItem, skins: readonly string[]): { rig: Rig | null; error?: string } {
  const exported = exportSpine(project, sym.id, { setupOnly: true });
  const errors = exported.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) return { rig: null, error: errors[0]!.message };

  // Every image whole and untrimmed, one per region: world vertices do not
  // depend on where a region sits in a page, and mesh UVs span the
  // untrimmed image, which is what the library holds.
  const images = new Map<string, ItemId>();
  let y = 0, width = 1;
  const regions = exported.usedImages.map((id) => {
    const item = project.items[id];
    if (!isImage(item)) throw new Error("not an image");
    images.set(item.name, id);
    const r = {
      name: item.name, x: 0, y, width: item.width, height: item.height,
      offsetX: 0, offsetY: 0, originalWidth: item.width, originalHeight: item.height, rotated: false,
    };
    y += item.height;
    width = Math.max(width, item.width);
    return r;
  });
  const page: PackedPage = { name: "stage", imagePath: "stage.png", width, height: Math.max(1, y), scale: 1, regions };

  let rt: Runtime;
  try {
    rt = new Runtime(readRig(exported.skeleton, readAtlas(atlasText([page]))));
    // The skins as one, as a game combines them: a later skin's attachment
    // wins where two fill the same slot key. The preview page does the same.
    const named = skins.filter((n) => n !== "default");
    const missing = named.find((n) => !rt.data.skins.some((s) => s.name === n));
    if (missing) return { rig: null, error: `There is no skin "${missing}".` };
    rt.setSkins(named);
  } catch (err) {
    return { rig: null, error: err instanceof Error ? err.message : String(err) };
  }

  const boneIndex = new Map(rt.data.bones.map((b) => [b.name, b.index]));
  const slotIndex = new Map(rt.data.slots.map((s) => [s.name, s.index]));
  const bones = new Map<NodeId, number>();
  const slots = new Map<NodeId, number>();
  const slotNode = new Map<number, NodeId>();
  const displayNames = new Map<NodeId, Map<number, string>>();
  const keepsShear = new Set<NodeId>();
  for (const [path, name] of exported.paths) {
    if (path.includes(">")) continue;
    const bone = boneIndex.get(name);
    if (bone !== undefined) bones.set(path as NodeId, bone);
    const node = sym.nodes[path as NodeId];
    if (node?.spine?.bone && ("shearX" in node.spine.bone || "shearY" in node.spine.bone)) keepsShear.add(node.id);
  }
  for (const [path, name] of exported.slots) {
    if (path.includes(">")) continue;
    const slot = slotIndex.get(name);
    if (slot === undefined) continue;
    slots.set(path as NodeId, slot);
    slotNode.set(slot, path as NodeId);
    displayNames.set(path as NodeId, exported.displayKeys.get(path) ?? new Map());
  }
  const constraints = new Map(rt.data.constraints.map((k, i) => [k.name, i]));
  return { rig: { rt, bones, slots, slotNode, displayNames, keepsShear, images, constraints, physicsAt: null } };
}

/**
 * `evaluateSymbol`, posed by the runtime when the symbol came from a Spine
 * file. Anything else, or a rig the runtime refuses (a carried name the
 * edits broke, which the export would refuse too), is the editor's own pose;
 * `spinePoseError` says why.
 */
export function posedSymbol(
  project: Project, sym: SymbolItem, animation: Animation | null, frame: number, mode: "setup" | "animate",
  skins: readonly string[] = stageSkinOf(sym),
): Pose {
  const pose = evaluateSymbol(sym, animation, frame, mode, skins);
  if (!sym.spine && !runtimePosed(sym)) return pose;
  const { rig } = rigFor(project, sym, skins);
  if (rig) applyRig(rig, sym, pose, animation, frame, mode, project.frameRate);
  return pose;
}

/** Why an opened symbol is drawn with the editor's own pose, or null. */
export function spinePoseError(project: Project, sym: SymbolItem, skins: readonly string[] = stageSkinOf(sym)): string | null {
  return sym.spine || runtimePosed(sym) ? rigFor(project, sym, skins).error ?? null : null;
}

function applyRig(
  rig: Rig, sym: SymbolItem, pose: Pose, animation: Animation | null, frame: number, mode: "setup" | "animate", fps: number,
): void {
  const rt = rig.rt, L = rt.local;
  rt.setupPose();
  for (const [nodeId, bone] of rig.bones) {
    const e = pose.byNode.get(nodeId);
    if (!e) continue;
    const l = toSpineLocal(e.local), at = bone * 7;
    L[at] = l.x; L[at + 1] = l.y; L[at + 2] = l.rotation; L[at + 3] = l.scaleX; L[at + 4] = l.scaleY;
    if (!rig.keepsShear.has(nodeId)) { L[at + 5] = l.shearX; L[at + 6] = l.shearY; }
  }
  for (const [nodeId, slot] of rig.slots) {
    const e = pose.byNode.get(nodeId);
    if (!e) continue;
    // A box, point or path has no display: its one attachment is key 0.
    const outline = e.node.kind === "box" || e.node.kind === "point" || e.node.kind === "path";
    const onStage = e.displayIndex >= 0 && (e.display !== null || outline);
    const name = onStage ? rig.displayNames.get(nodeId)?.get(e.displayIndex) : undefined;
    const att = name ? rt.lookup(slot, name) : null;
    // A slot whose setup attachment is not a display keeps the runtime's.
    if (att || e.displayIndex !== -1 || sym.nodes[nodeId]?.setupDisplay !== -1) rt.setAttachment(slot, att ? name! : null);
    setColor(rt, slot, e.color);
  }
  // The document's inherit keys (`Animation.inherits`), stepped.
  if (mode === "animate" && animation?.inherits) {
    for (const [nodeId, bone] of rig.bones) {
      const node = sym.nodes[nodeId];
      if (node && animation.inherits[nodeId]?.length) rt.inherit[bone] = inheritAt(node, animation, frame);
    }
  }
  if (mode === "animate" && animation) {
    const anim = rt.animation(animation.name);
    if (anim) rt.apply(anim, frame / fps, false);
  }
  // The document's IK keys (`Animation.ik`), applied over the setup pose like
  // the draw order below. The bend is written inverted, as the exporter does.
  if (mode === "animate" && animation?.ik) {
    for (const k of sym.ik) {
      if (!animation.ik[k.id]?.length) continue;
      const i = rig.constraints.get(k.name), p = i === undefined ? null : rt.ik[i];
      if (!p) continue;
      const { mix, bendPositive, softness } = ikPoseAt(k, animation, frame);
      p.mix = mix;
      p.bendPositive = !bendPositive;
      p.softness = softness;
    }
  }
  // The document's transform constraint keys, likewise.
  if (mode === "animate" && animation?.transforms) {
    for (const k of sym.transforms ?? []) {
      if (!animation.transforms[k.id]?.length) continue;
      const i = rig.constraints.get(k.name), p = i === undefined ? null : rt.transform[i];
      if (p) Object.assign(p, tcMixAt(k, animation, frame));
    }
  }
  // The document's physics, slider and path keys, likewise (`constraintKeys`).
  if (mode === "animate" && animation?.constraintKeys) {
    for (const [id, channels] of Object.entries(animation.constraintKeys)) {
      const c = keyedConstraint(sym, id as CnId);
      const i = c ? rig.constraints.get(c.k.name) : undefined;
      if (!c || i === undefined) continue;
      const p = (rt.physics[i] ?? rt.slider[i] ?? rt.path[i]) as unknown as Record<string, number> | null;
      if (!p) continue;
      for (const [channel, keys] of Object.entries(channels)) {
        if (!keys.length) continue;
        const v = valueAt(keys, frame, setupValue(c, channel));
        if (c.kind === "physics" && channel === "mass") p.massInverse = 1 / v;
        else if (c.kind === "path" && channel === "mix") { p.mixRotate = v; p.mixX = v; p.mixY = v; }
        else p[channel] = v;
      }
    }
  }
  // The document's draw order keys (`Animation.drawOrder`): the rig is built
  // once per structure, so they are applied here rather than baked into it,
  // the slots that have a place in the order taking those places.
  if (mode === "animate" && animation?.drawOrder?.length) {
    const rank = new Map(orderAt(sym, animation, frame).map((id, i) => [id, i]));
    const order = [...rt.drawOrder];
    const at = order.map((sl, i) => (rank.has(rig.slotNode.get(sl)!) ? i : -1)).filter((i) => i >= 0);
    const ranked = at.map((i) => order[i]!).sort((a, b) => rank.get(rig.slotNode.get(a)!)! - rank.get(rig.slotNode.get(b)!)!);
    at.forEach((i, n) => { order[i] = ranked[n]!; });
    rt.drawOrder = order;
  }
  rt.updateWorld(physicsStep(rig, animation, frame, mode, fps));

  // Worlds, y flipped into the editor's space.
  const W = rt.world;
  const worldOf = (bone: number) => {
    const w = bone * 6;
    return matOf(W[w]!, -W[w + 2]!, -W[w + 1]!, W[w + 3]!, W[w + 4]!, -W[w + 5]!);
  };
  for (const [nodeId, bone] of rig.bones) {
    const e = pose.byNode.get(nodeId);
    if (e) e.world = worldOf(bone);
  }
  const flipped = (slot: number, att: AttachmentData & { vertexCount: number }) => {
    const v = new Array<number>(att.vertexCount * 2);
    rt.vertexWorld(slot, att as never, 0, v.length, v, 0);
    for (let i = 1; i < v.length; i += 2) v[i] = -v[i]!;
    return v;
  };

  // Slots in the runtime's draw order, bones first (they draw nothing).
  const slotEntries: PoseEntry[] = [];
  const clips: Array<{ entry: PoseEntry; end: number }> = [];
  for (const slot of rt.drawOrder) {
    const nodeId = rig.slotNode.get(slot);
    const e = nodeId ? pose.byNode.get(nodeId) : undefined;
    if (!e) continue;
    e.world = worldOf(rt.data.slots[slot]!.bone);
    const layerVisible = sym.layers.find((l) => l.nodeId === e.nodeId)?.visible !== false;
    const att = rt.attachmentOf(slot);
    delete e.spine;
    delete e.clip;
    e.color = colorOf(rt, slot, att);
    let shown = -1;
    // By the attachment the key finds, as an attachment's own name need not be its key.
    for (const [index, key] of rig.displayNames.get(e.nodeId) ?? []) if (att && rt.lookup(slot, key) === att) shown = index;
    e.displayIndex = shown;
    e.display = shown >= 0 ? displaysOf(e.node)[shown] ?? null : null;
    e.spine = drawOf(rig, slot, att) ?? undefined;
    if (att?.kind === "clipping") {
      e.clip = { polygon: flipped(slot, att), until: null };
      clips.push({ entry: e, end: att.end });
    }
    // Boxes, points and paths draw nothing; the overlay outlines them, a
    // box's or path's points where the runtime puts them (weights, deform).
    const outlined = att?.kind === "box" || att?.kind === "point" || att?.kind === "path";
    delete e.outline;
    if (att?.kind === "box" || att?.kind === "path") e.outline = flipped(slot, att);
    e.visible = layerVisible && (!!e.spine || !!e.clip || outlined);
    slotEntries.push(e);
  }
  for (const { entry, end } of clips) entry.clip!.until = end >= 0 ? rig.slotNode.get(end) ?? null : null;
  const rest = pose.entries.filter((e) => !slotEntries.includes(e));
  pose.entries.length = 0;
  pose.entries.push(...rest, ...slotEntries);
  pose.entries.forEach((e, i) => { e.drawIndex = i; });
}

/** Set by the stage around its own draw while playing: only then does
 *  physics simulate; every other pose (paths, tools, tests) is at rest. */
export const livePhysics = { on: false };

/**
 * How physics poses this call: at rest (`Physics.reset`), as a seek has no
 * frames before it to simulate from; while the stage plays (`livePhysics`), a
 * step on from the frame before when the frames come in order, held at a
 * frame drawn again.
 */
function physicsStep(rig: Rig, animation: Animation | null, frame: number, mode: "setup" | "animate", fps: number): PhysicsMode {
  const rt = rig.rt;
  if (!livePhysics.on || !rt.data.constraints.some((k) => k.kind === "physics") || mode !== "animate" || !animation) {
    rig.physicsAt = null;
    return "reset";
  }
  const last = rig.physicsAt;
  rig.physicsAt = { animation: animation.name, frame };
  if (last?.animation !== animation.name) return "reset";
  if (frame === last.frame) return "pose";
  // On from the last frame, across the loop's wrap, up to half a second: a
  // slow redraw still simulates, a seek does not.
  const delta = frame > last.frame ? frame - last.frame : animation.duration - last.frame + frame;
  if (delta > fps / 2) return "reset";
  rt.update(delta / fps);
  return "update";
}

/** The editor's colour as the slot's light and dark: light M + O, dark O
 *  (`lightHex` / `darkHex`, unrounded), each channel clamped to 0..1. */
function setColor(rt: Runtime, slot: number, c: ColorTransform): void {
  const k = slot * 7, C = rt.color, cl = (v: number) => Math.min(1, Math.max(0, v));
  C[k] = cl(c.rM / 100 + c.rO / 255); C[k + 1] = cl(c.gM / 100 + c.gO / 255);
  C[k + 2] = cl(c.bM / 100 + c.bO / 255); C[k + 3] = cl(c.aM / 100);
  if (rt.data.slots[slot]!.dark) { C[k + 4] = cl(c.rO / 255); C[k + 5] = cl(c.gO / 255); C[k + 6] = cl(c.bO / 255); }
}

/** What the runtime draws with, back as the editor's colour: light times the
 *  attachment's own colour, dark as the offset (`toColor` in the importer). */
function colorOf(rt: Runtime, slot: number, att: AttachmentData | null): ColorTransform {
  const k = slot * 7, C = rt.color;
  const tint = att?.kind === "region" || att?.kind === "mesh" ? att.color : null;
  const r = C[k]! * (tint?.[0] ?? 1), g = C[k + 1]! * (tint?.[1] ?? 1), b = C[k + 2]! * (tint?.[2] ?? 1), a = C[k + 3]! * (tint?.[3] ?? 1);
  const dark = !!rt.data.slots[slot]!.dark;
  const dr = dark ? C[k + 4]! : 0, dg = dark ? C[k + 5]! : 0, db = dark ? C[k + 6]! : 0;
  return { rM: (r - dr) * 100, gM: (g - dg) * 100, bM: (b - db) * 100, aM: a * 100, rO: dr * 255, gO: dg * 255, bO: db * 255, aO: 0 };
}

function drawOf(rig: Rig, slot: number, att: AttachmentData | null): PoseEntry["spine"] | null {
  if (att?.kind !== "region" && att?.kind !== "mesh") return null;
  // The region showing now: a sequence's current frame, or the one.
  const region = rig.rt.frameOf(slot, att).region;
  const itemId = region ? rig.images.get(region.name) : undefined;
  if (!itemId || !region) return null;
  const w = region.originalWidth, h = region.originalHeight;
  if (att.kind === "region") {
    const c = new Array<number>(8);
    rig.rt.regionWorld(slot, att, c);
    // Ours run bottom-left, bottom-right, top-right, top-left; the stage takes
    // left-bottom, left-top, right-top, right-bottom, y flipped.
    const v = [0, 3, 2, 1].flatMap((i) => [c[i * 2]!, -c[i * 2 + 1]!]);
    return { itemId, vertices: v, uvs: [0, h, 0, 0, w, 0, w, h], triangles: [0, 1, 2, 2, 3, 0], quad: true };
  }
  const v = new Array<number>(att.vertexCount * 2);
  rig.rt.meshWorld(slot, att, v);
  for (let i = 1; i < v.length; i += 2) v[i] = -v[i]!;
  const uvs = Array.from(att.regionUVs, (u, i) => u * (i % 2 ? h : w));
  return { itemId, vertices: v, uvs, triangles: Array.from(att.triangles), quad: false };
}

/** What an opened symbol draws in its setup pose, boxed in its own space;
 *  null when it draws nothing. */
export function spineBounds(project: Project, sym: SymbolItem, skins: readonly string[] = stageSkinOf(sym)): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of posedSymbol(project, sym, null, 0, "setup", skins).entries) {
    const v = e.spine?.vertices;
    if (!v || !e.visible) continue;
    for (let i = 0; i < v.length; i += 2) {
      x0 = Math.min(x0, v[i]!); x1 = Math.max(x1, v[i]!);
      y0 = Math.min(y0, v[i + 1]!); y1 = Math.max(y1, v[i + 1]!);
    }
  }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
