import {
  AtlasAttachmentLoader, type Bone, ClippingAttachment, IkConstraint, MeshAttachment, MixFrom, Physics, RegionAttachment, Skeleton,
  SkeletonJson, Skin, type Slot, TextureAtlas, TextureAtlasRegion, type Animation as SpineRuntimeAnimation,
} from "@esotericsoftware/spine-core";
import { orderAt } from "@/core/doc/drawOrder";
import { ikPoseAt } from "@/core/doc/ikKeys";
import type { ItemId, NodeId } from "@/core/doc/ids";
import type { Animation, ColorTransform, Project, SymbolItem } from "@/core/doc/types";
import { isImage } from "@/core/doc/types";
import { displaysOf } from "@/core/doc/displays";
import { evaluateSymbol, type Pose, type PoseEntry } from "@/core/doc/pose";
import { matOf } from "@/core/math/Matrix2D";
import type { PackedPage } from "@/core/atlas/packed";
import { atlasText } from "./atlas";
import { exportSpine } from "./exportSpine";
import { toSpineLocal } from "./transform";

/**
 * A symbol opened from a Spine file, posed by the Spine runtime itself.
 *
 * Such a rig relies on what the editor's own pose does not do: meshes and
 * their weights and deform keys, inherit modes, transform, path, physics
 * and slider constraints, clipping, draw order keys. So the stage hands the
 * runtime (spine-core 4.3.13, the core of the preview's spine-pixi) the
 * document's pose and draws what comes back:
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
 *
 * Physics is posed at rest (`Physics.reset`): a simulation needs the
 * frames before it, and a seek has none. The Preview plays it.
 */

interface Rig {
  skeleton: Skeleton;
  /** Bones by the node that makes them. */
  bones: Map<NodeId, Bone>;
  /** Slots by the node that makes them, and back. */
  slots: Map<NodeId, Slot>;
  slotNode: Map<Slot, NodeId>;
  /** The skin key each display index shows, per slot node. */
  displayNames: Map<NodeId, Map<number, string>>;
  /** Carried shear, per bone node: Spine's own (see `importSpine`). */
  keepsShear: Set<NodeId>;
  images: Map<string, ItemId>;
  animations: Map<string, SpineRuntimeAnimation>;
}

const bySymbol = new WeakMap<SymbolItem, Map<string, { key: string; rig: Rig | null; error?: string }>>();
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
    displaysOf(n).map((d) => [d.itemId, project.items[d.itemId]?.name, idOf(d.attachment?.data), d.attachment?.name]),
    idOf(n.spine?.bone), idOf(n.spine?.slot),
  ]);
  const layers = sym.layers.map((l) => [l.nodeId, l.excludeFromExport, l.isMask, l.maskedBy]);
  const ik = sym.ik.map((k) => [k.name, k.boneId, k.targetId, k.chain, k.bendPositive, k.weight, idOf(k.spine)]);
  const anims = sym.animations.map((a) => [a.name, idOf(a.spine)]);
  return JSON.stringify([idOf(sym.spine), project.frameRate, nodes, layers, ik, anims]);
}

function rigFor(project: Project, sym: SymbolItem, skins: readonly string[]): { rig: Rig | null; error?: string } {
  let perSkin = bySymbol.get(sym);
  if (!perSkin) bySymbol.set(sym, (perSkin = new Map()));
  const skinKey = JSON.stringify(skins);
  const cached = perSkin.get(skinKey);
  if (cached) return cached;
  const key = JSON.stringify([skins, structureKey(project, sym)]);
  let built = byKey.get(key);
  if (!built) {
    built = buildRig(project, sym, skins);
    byKey.set(key, built);
    // A handful of structures at most: undo and redo flip between a few.
    if (byKey.size > 8) byKey.delete(byKey.keys().next().value!);
  }
  const out = { key, ...built };
  perSkin.set(skinKey, out);
  return out;
}

/**
 * The skins the stage shows over the default skin, combined: the symbol's
 * choice (`stageSkins`, less any the file no longer has), else none when
 * the default skin draws anything, else the file's first other skin.
 * Without one the runtime draws only what the default skin holds, and a
 * game picks the rest.
 */
export function stageSkinOf(sym: SymbolItem): string[] {
  const named = skinsOf(sym).filter((n) => n !== "default");
  if (sym.stageSkins) return sym.stageSkins.filter((n) => named.includes(n));
  const skins = (sym.spine?.skins ?? []) as Array<{ name?: string; attachments?: Record<string, Record<string, { type?: string }>> }>;
  const draws = (a: { type?: string }) => a.type === undefined || a.type === "region" || a.type === "mesh" || a.type === "linkedmesh";
  const hasDefault = Object.values(sym.nodes).some((n) => n.attachment)
    || skins.some((s) => s.name === "default" && Object.values(s.attachments ?? {}).some((byKey) => Object.values(byKey).some(draws)));
  return hasDefault || named.length === 0 ? [] : [named[0]!];
}

/**
 * The stage skins after turning `name` on or off: the named skins kept in
 * the rig's own order, as the stage bar's picker and the Skins panel both
 * set them.
 */
export function toggledSkins(named: readonly string[], shown: readonly string[], name: string): string[] {
  const next = shown.includes(name) ? shown.filter((n) => n !== name) : [...shown, name];
  return named.filter((n) => next.includes(n));
}

/** The skins an opened symbol has, "default" first when it has one. */
export function skinsOf(sym: SymbolItem): string[] {
  const names = (sym.spine?.skins ?? []).map((s) => String((s as { name?: unknown }).name));
  return names.includes("default") || Object.values(sym.nodes).some((n) => n.attachment)
    ? ["default", ...names.filter((n) => n !== "default")] : names;
}

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

  let skeleton: Skeleton;
  try {
    const atlas = new TextureAtlas(atlasText([page]));
    skeleton = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(exported.skeleton));
    const combined = combineSkins(skeleton, skins);
    if (typeof combined === "string") return { rig: null, error: combined };
    if (combined) skeleton.setSkin(combined);
  } catch (err) {
    return { rig: null, error: err instanceof Error ? err.message : String(err) };
  }

  const bones = new Map<NodeId, Bone>();
  const slots = new Map<NodeId, Slot>();
  const slotNode = new Map<Slot, NodeId>();
  const displayNames = new Map<NodeId, Map<number, string>>();
  const keepsShear = new Set<NodeId>();
  for (const [path, name] of exported.paths) {
    if (path.includes(">")) continue;
    const bone = skeleton.findBone(name);
    if (bone) bones.set(path as NodeId, bone);
    const node = sym.nodes[path as NodeId];
    if (node?.spine?.bone && ("shearX" in node.spine.bone || "shearY" in node.spine.bone)) keepsShear.add(node.id);
  }
  for (const [path, name] of exported.slots) {
    if (path.includes(">")) continue;
    const slot = skeleton.findSlot(name);
    if (!slot) continue;
    slots.set(path as NodeId, slot);
    slotNode.set(slot, path as NodeId);
    displayNames.set(path as NodeId, exported.displayKeys.get(path) ?? new Map());
  }
  const animations = new Map<string, SpineRuntimeAnimation>();
  for (const a of skeleton.data.animations) animations.set(a.name, a);
  return { rig: { skeleton, bones, slots, slotNode, displayNames, keepsShear, images, animations } };
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
  const pose = evaluateSymbol(sym, animation, frame, mode);
  if (!sym.spine) return pose;
  const { rig } = rigFor(project, sym, skins);
  if (rig) applyRig(rig, sym, pose, animation, frame, mode, project.frameRate);
  return pose;
}

/** Why an opened symbol is drawn with the editor's own pose, or null. */
export function spinePoseError(project: Project, sym: SymbolItem, skins: readonly string[] = stageSkinOf(sym)): string | null {
  return sym.spine ? rigFor(project, sym, skins).error ?? null : null;
}

/**
 * The skins as one, the way a game combines them (`Skin.addSkin`), or null
 * for none (the default skin alone), or why not. A later skin's attachment
 * wins where two fill the same slot key. The preview page does the same.
 */
function combineSkins(skeleton: Skeleton, skins: readonly string[]): Skin | null | string {
  const named = skins.filter((n) => n !== "default");
  if (named.length === 0) return null;
  const combined = new Skin(named.join(" + "));
  for (const name of named) {
    const skin = skeleton.data.findSkin(name);
    if (!skin) return `There is no skin "${name}".`;
    combined.addSkin(skin);
  }
  return combined;
}

function applyRig(
  rig: Rig, sym: SymbolItem, pose: Pose, animation: Animation | null, frame: number, mode: "setup" | "animate", fps: number,
): void {
  const sk = rig.skeleton;
  sk.setupPose();
  for (const [nodeId, bone] of rig.bones) {
    const e = pose.byNode.get(nodeId);
    if (!e) continue;
    const l = toSpineLocal(e.local), p = bone.pose;
    p.x = l.x; p.y = l.y; p.rotation = l.rotation; p.scaleX = l.scaleX; p.scaleY = l.scaleY;
    if (!rig.keepsShear.has(nodeId)) { p.shearX = l.shearX; p.shearY = l.shearY; }
  }
  for (const [nodeId, slot] of rig.slots) {
    const e = pose.byNode.get(nodeId);
    if (!e) continue;
    const onStage = e.displayIndex >= 0 && e.display !== null;
    const name = onStage ? rig.displayNames.get(nodeId)?.get(e.displayIndex) : undefined;
    const att = name ? sk.getAttachment(slot.data.index, name) : null;
    // A slot whose setup attachment is not a display keeps the runtime's.
    if (att || e.displayIndex !== -1 || sym.nodes[nodeId]?.setupDisplay !== -1) slot.pose.setAttachment(att);
    setColor(slot, e.color);
  }
  if (mode === "animate" && animation) {
    rig.animations.get(animation.name)?.apply(sk, 0, frame / fps, false, null, 1, MixFrom.setup, false, false, false);
  }
  // The document's IK keys (`Animation.ik`), applied over the setup pose like
  // the draw order below. The bend is written inverted, as the exporter does.
  if (mode === "animate" && animation?.ik) {
    for (const k of sym.ik) {
      if (!animation.ik[k.id]?.length) continue;
      const c = sk.constraints.find((x) => x instanceof IkConstraint && x.data.name === k.name) as IkConstraint | undefined;
      if (!c) continue;
      const { mix, bendPositive, softness } = ikPoseAt(k, animation, frame);
      c.pose.mix = mix;
      c.pose.bendDirection = bendPositive ? -1 : 1;
      c.pose.softness = softness;
    }
  }
  // The document's draw order keys (`Animation.drawOrder`): the rig is built
  // once per structure, so they are applied here rather than baked into it,
  // the slots that have a place in the order taking those places.
  if (mode === "animate" && animation?.drawOrder?.length) {
    const rank = new Map(orderAt(sym, animation, frame).map((id, i) => [id, i]));
    const order = sk.drawOrder.appliedPose as Slot[];
    const at = order.map((sl, i) => (rank.has(rig.slotNode.get(sl)!) ? i : -1)).filter((i) => i >= 0);
    const ranked = at.map((i) => order[i]!).sort((a, b) => rank.get(rig.slotNode.get(a)!)! - rank.get(rig.slotNode.get(b)!)!);
    at.forEach((i, n) => { order[i] = ranked[n]!; });
  }
  sk.updateWorldTransform(Physics.reset);

  // Worlds, y flipped into the editor's space.
  const worldOf = (bone: Bone) => {
    const w = bone.appliedPose;
    return matOf(w.a, -w.c, -w.b, w.d, w.worldX, -w.worldY);
  };
  for (const [nodeId, bone] of rig.bones) {
    const e = pose.byNode.get(nodeId);
    if (e) e.world = worldOf(bone);
  }

  // Slots in the runtime's draw order, bones first (they draw nothing).
  const slotEntries: PoseEntry[] = [];
  const clips: Array<{ entry: PoseEntry; end: Slot | null }> = [];
  for (const slot of sk.drawOrder.appliedPose) {
    const nodeId = rig.slotNode.get(slot);
    const e = nodeId ? pose.byNode.get(nodeId) : undefined;
    if (!e) continue;
    e.world = worldOf(slot.bone);
    const layerVisible = sym.layers.find((l) => l.nodeId === e.nodeId)?.visible !== false;
    const att = slot.appliedPose.getAttachment();
    delete e.spine;
    delete e.clip;
    e.color = colorOf(slot, att);
    let shown = -1;
    for (const [index, key] of rig.displayNames.get(e.nodeId) ?? []) if (att && key === att.name) shown = index;
    e.displayIndex = shown;
    e.display = shown >= 0 ? displaysOf(e.node)[shown] ?? null : null;
    e.spine = drawOf(rig, sk, slot, att) ?? undefined;
    if (att instanceof ClippingAttachment) {
      const v = new Array<number>(att.worldVerticesLength);
      att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, v, 0, 2);
      for (let i = 1; i < v.length; i += 2) v[i] = -v[i]!;
      e.clip = { polygon: v, until: null };
      clips.push({ entry: e, end: att.endSlot ? sk.slots[att.endSlot.index] ?? null : null });
    }
    e.visible = layerVisible && (!!e.spine || !!e.clip);
    slotEntries.push(e);
  }
  for (const { entry, end } of clips) entry.clip!.until = end ? rig.slotNode.get(end) ?? null : null;
  const rest = pose.entries.filter((e) => !slotEntries.includes(e));
  pose.entries.length = 0;
  pose.entries.push(...rest, ...slotEntries);
  pose.entries.forEach((e, i) => { e.drawIndex = i; });
}

/** The editor's colour as the slot's light and dark: light M + O, dark O
 *  (`lightHex` / `darkHex`, unrounded). */
function setColor(slot: Slot, c: ColorTransform): void {
  const light = slot.pose.color, dark = slot.pose.darkColor;
  light.set(c.rM / 100 + c.rO / 255, c.gM / 100 + c.gO / 255, c.bM / 100 + c.bO / 255, c.aM / 100).clamp();
  dark?.set(c.rO / 255, c.gO / 255, c.bO / 255, 1).clamp();
}

/** What the runtime draws with, back as the editor's colour: light times the
 *  attachment's own colour, dark as the offset (`toColor` in the importer). */
function colorOf(slot: Slot, att: unknown): ColorTransform {
  const l = slot.appliedPose.color, d = slot.appliedPose.darkColor;
  const tint = att instanceof RegionAttachment || att instanceof MeshAttachment ? att.color : null;
  const r = l.r * (tint?.r ?? 1), g = l.g * (tint?.g ?? 1), b = l.b * (tint?.b ?? 1), a = l.a * (tint?.a ?? 1);
  const dr = d?.r ?? 0, dg = d?.g ?? 0, db = d?.b ?? 0;
  return { rM: (r - dr) * 100, gM: (g - dg) * 100, bM: (b - db) * 100, aM: a * 100, rO: dr * 255, gO: dg * 255, bO: db * 255, aO: 0 };
}

function drawOf(rig: Rig, sk: Skeleton, slot: Slot, att: unknown): PoseEntry["spine"] | null {
  if (!(att instanceof RegionAttachment) && !(att instanceof MeshAttachment)) return null;
  // The region showing now: a sequence's current frame, or the one.
  const region = att.sequence.regions[att.sequence.resolveIndex(slot.appliedPose)];
  const itemId = region instanceof TextureAtlasRegion ? rig.images.get(region.name) : undefined;
  if (!itemId || !(region instanceof TextureAtlasRegion)) return null;
  const w = region.originalWidth, h = region.originalHeight;
  if (att instanceof RegionAttachment) {
    const v = new Array<number>(8);
    att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), v, 0, 2);
    for (let i = 1; i < 8; i += 2) v[i] = -v[i]!;
    return { itemId, vertices: v, uvs: [0, h, 0, 0, w, 0, w, h], triangles: [0, 1, 2, 2, 3, 0], quad: true };
  }
  const v = new Array<number>(att.worldVerticesLength);
  att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, v, 0, 2);
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
