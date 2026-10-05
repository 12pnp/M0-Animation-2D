import { CONSTRAINT_CHANNELS, bakedChannelKeys, channelKeysFromBoneBurst, withChannelKeys } from "@/core/doc/constraintKeys";
import { inheritKeysFromBoneBurst } from "@/core/doc/inherit";
import { evaluateSymbol } from "@/core/doc/pose";
import { displaysOf } from "@/core/doc/displays";
import { deformKeysFromBoneBurst, meshFromBoneBurst, type MeshContext } from "./importMesh";
import { assignDeforms, type DeformTarget, withDeformKeysOf } from "@/core/mesh/deform";
import { type Outline, outlineOf, sequenceDisplayOf } from "./importAttachments";
import { bakedSequenceKeys, SEQUENCE_MODES } from "@/core/doc/sequence";
import type { AssetId, CnId, IkId, NodeId, TcId } from "@/core/doc/ids";
import { fromOffsets } from "@/core/doc/drawOrder";
import { eventDefsFromBoneBurst, eventValues } from "@/core/doc/events";
import { newAnimId, newCnId, newIkId, newTcId } from "@/core/doc/ids";
import type { TcChannel, TcFrom, TcTo } from "@/core/doc/types";
import type {
  MeshData,  Animation, BlendMode, DeformKey, DrawOrderKey, SequenceKey, ColorTransform, DisplayRef, EventDef, EventKey, IkConstraint, IkKey, ImageItem, TcKey, TransformConstraint, Keyframe, Layer, Node, Project,
  SkinDef, BoneBurstAttachmentRef, SymbolItem, Track,
} from "@/core/doc/types";
import { isDefaultColor, isImage } from "@/core/doc/types";
import { createAnimation, createImageItem, createLayer, createNode, createProject } from "@/core/doc/defaults";
import { sampleColorRaw, sampleTransformRaw } from "@/core/doc/timeline";
import { IDENTITY, cloneTf, matrixOf, type Transform } from "@/core/math/Transform";
import { mat, mul, type Matrix2D } from "@/core/math/Matrix2D";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { bonesToNames, lastTime, regionsOf, SKIN_CONSTRAINT_KINDS } from "./carry";
import { PATH_FIELDS, pathFromBoneBurst, PHYSICS_FIELDS, physicsFromBoneBurst, SLIDER_FIELDS, sliderFromBoneBurst } from "@/core/doc/constraints";
import { type ChannelGroup, type Comp, type CompKey, type KeyTiming, mergeKeys, valueAt } from "./importKeys";
import { fromBoneBurstLocal, type BoneBurstLocal } from "./transform";
import { BONEBURST_VERSION, type BoneBurstInherit, type BoneBurstRaw } from "./types";

/**
 * A Spine 4.3 skeleton JSON opened as a project, for editing.
 *
 * The skeleton becomes the scene symbol:
 *
 *   bone        a bone node, the same name, parent and setup pose
 *   slot        an image node riding its bone (`Node.slotBone`), its layer
 *               in Spine's draw order; the default skin's regions and
 *               meshes are its displays, each keeping its attachment JSON
 *   IK          the editor's IK, where it can hold it
 *   keys        bone transforms, slot colours and attachment switches as
 *               keyframes (`importKeys.ts`); an animation ends AT its last
 *               frame, as Spine's do (`Animation.endsAtLastFrame`)
 *
 * and what the editor does not model is carried to the export as it came
 * (`SymbolItem.spine`, `Animation.spine`, `Node.spine`): other constraints,
 * other skins, bounding boxes, points, paths and clipping attachments,
 * deform and sequence keys, draw order and event keys, inherit and
 * constraint keys. Nothing is dropped without a diagnostic.
 *
 * Pure: the caller parses the atlas and cuts its regions into images
 * (`images`, by region name), which is also where rotated regions are
 * turned upright.
 */

export interface AtlasImage { name: string; width: number; height: number; assetId: AssetId }

export interface BoneBurstImport {
  project: Project;
  diagnostics: ExportDiagnostic[];
  /** Intervals written frame by frame, because no ease of the editor's
   *  plays them as Spine does (see `importKeys.ts`). */
  baked: number;
}

const obj = (v: unknown): v is BoneBurstRaw => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): v is string => typeof v === "string";

/** Only what the editor models is read off a bone; the rest rides along. */
const BONE_FIELDS = new Set(["name", "parent", "length", "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "inherit", "color", "icon"]);
const SLOT_FIELDS = new Set(["name", "bone", "color", "dark", "attachment", "blend"]);
const IK_FIELDS = new Set(["type", "name", "bones", "target", "mix", "bendPositive", "softness", "stretch", "compress", "scaleY"]);
const BLEND: Record<string, BlendMode> = { additive: "add", multiply: "multiply", screen: "screen" };
const INHERIT = new Set<BoneBurstInherit>(["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"]);

export function importBoneBurst(file: unknown, name: string, images: ReadonlyMap<string, AtlasImage>): BoneBurstImport {
  const diagnostics: ExportDiagnostic[] = [];
  const warn = (message: string) => diagnostics.push({ severity: "warning", message });
  if (!obj(file) || !obj(file.skeleton) || !Array.isArray(file.bones)) {
    throw new Error("This is not a Spine skeleton JSON file (no skeleton header or bones).");
  }
  const header = file.skeleton;
  const version = str(header.spine) ? header.spine : "";
  if (version.split(".").slice(0, 2).join(".") !== BONEBURST_VERSION.split(".").slice(0, 2).join(".")) {
    throw new Error(
      `The file was exported by Spine ${version || "(unknown version)"}; only Spine ${BONEBURST_VERSION.split(".").slice(0, 2).join(".")} ` +
      "JSON can be opened. Export it again from Spine 4.3.",
    );
  }

  const animsIn = obj(file.animations) ? file.animations : {};
  const fps = num(header.fps, 30);
  const { rate, snapped } = frameRateFor(fps, Object.values(animsIn));
  if (rate !== fps) warn(`Keys fall between frames at ${fps} fps, so the document runs at ${rate} fps, where every key is on a frame.`);
  if (snapped) {
    warn(`${snapped} key(s) fall between frames at ${rate} fps; the tweens around them are written frame by frame, exact at every frame.`);
  }
  const toFrame = (t: unknown) => Math.round(num(t, 0) * rate);
  // An attachment switch between frames shows from the next frame on.
  const switchFrame = (t: unknown) => Math.ceil(frameOf(num(t, 0), rate) - 1e-9);

  const project = createProject(name, { width: 800, height: 600, frameRate: rate, background: "#ffffff" });
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  sym.name = name;
  sym.animations = [];

  /* ── images ── */
  const itemByRegion = new Map<string, ImageItem>();
  for (const img of images.values()) {
    const item = createImageItem(img.name, img.assetId, img.width, img.height);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
    itemByRegion.set(img.name, item);
  }
  const displayItem = (att: BoneBurstRaw, key: string) => displayItemOf(itemByRegion, att, key);

  /* ── bones ── */
  const bonesIn = file.bones.filter(obj);
  const boneNames = bonesIn.map((b) => String(b.name));
  const boneNode = new Map<string, Node>();
  const boneSetup = new Map<string, BoneBurstLocal>();
  // Each bone's world at the setup pose, for the weighted boxes and paths the
  // slots read (the editor's composition, as `editableMeshes` measures).
  const boneWorld = new Map<string, Matrix2D>();
  const shearKept = new Set<string>();
  const keysShear = (boneName: string) => Object.values(animsIn).some((a) => {
    const t = obj(a) && obj(a.bones) ? a.bones[boneName] : undefined;
    return obj(t) && SHEAR_TIMELINES.some((k) => k in t);
  });
  const localSources = localSourceBones(file.constraints);
  for (const b of bonesIn) {
    const boneName = String(b.name);
    const parent = str(b.parent) ? boneNode.get(b.parent) : undefined;
    if (str(b.parent) && !parent) warn(`Bone "${boneName}" names a parent "${b.parent}" that comes after it or does not exist; it is a root bone now.`);
    const setup: BoneBurstLocal = {
      x: num(b.x, 0), y: num(b.y, 0), rotation: num(b.rotation, 0),
      shearX: num(b.shearX, 0), shearY: num(b.shearY, 0), scaleX: num(b.scaleX, 1), scaleY: num(b.scaleY, 1),
    };
    const node = createNode("bone", boneName, { parentId: parent?.id ?? null });
    node.boneLength = num(b.length, 0);
    if (str(b.inherit) && b.inherit !== "normal") {
      if (INHERIT.has(b.inherit as BoneBurstInherit)) node.inherit = b.inherit as BoneBurstInherit;
      else warn(`Bone "${boneName}": unknown inherit mode "${b.inherit}", read as normal.`);
    }
    if (str(b.color) && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(b.color)) node.boneColor = b.color.toLowerCase();
    if (str(b.icon) && b.icon) node.boneIcon = b.icon;
    const rest = pick(b, (k) => !BONE_FIELDS.has(k) || (k === "color" && !node.boneColor)) ?? {};
    // The editor's transform folds shear x into the rotation, which leaves
    // the local matrix exactly as it was. Under an inherit mode other than
    // normal Spine builds the parent's frame from the rotation alone and
    // shears after, so there the shear stays Spine's own, carried: its
    // setup values here, its keys with the animation. So it does on a bone a
    // local-source transform constraint reads: it takes the rotation and
    // shear y values, not the matrix.
    if ((node.inherit || localSources.has(boneName)) && (setup.shearX || setup.shearY || keysShear(boneName))) {
      shearKept.add(boneName);
      if (setup.shearX) rest.shearX = setup.shearX;
      if (setup.shearY) rest.shearY = setup.shearY;
      setup.shearX = 0;
      setup.shearY = 0;
    }
    node.bind = fromBoneBurstLocal(setup);
    if (Object.keys(rest).length) node.spine = { bone: rest };
    sym.nodes[node.id] = node;
    boneNode.set(boneName, node);
    boneSetup.set(boneName, setup);
    boneWorld.set(boneName, mul(mat(), (parent && boneWorld.get(String(b.parent))) || mat(), matrixOf(node.bind)));
  }

  /* ── skins: the default skin's regions and meshes become displays ── */
  const skinsIn = Array.isArray(file.skins) ? file.skins.filter(obj) : [];
  const defaultSkin = skinsIn.find((s) => s.name === "default");
  const carriedSkins: BoneBurstRaw[] = [];
  const defaultAtts = obj(defaultSkin?.attachments) ? (defaultSkin!.attachments as Record<string, BoneBurstRaw>) : {};
  const carriedDefault: Record<string, Record<string, BoneBurstRaw>> = {};

  /* ── slots ── */
  // The skins' own outlines of slots that became box, point or path nodes, by slot then skin.
  const skinOutlines = new Map<string, Map<string, Outline>>();
  const slotsIn = Array.isArray(file.slots) ? file.slots.filter(obj) : [];
  const slotNode = new Map<string, Node>();
  const slotLayers: Layer[] = [];
  let colorIndex = 0;
  for (const s of slotsIn) {
    const slotName = String(s.name);
    const bone = str(s.bone) ? boneNode.get(s.bone) : undefined;
    if (!bone) throw new Error(`Slot "${slotName}" is on a bone "${String(s.bone)}" that does not exist.`);
    const node = createNode("image", slotName);
    node.slotBone = bone.id;
    const displays: DisplayRef[] = [];
    const byKey = obj(defaultAtts[slotName]) ? defaultAtts[slotName]! : {};
    const setupName = str(s.attachment) ? s.attachment : null;
    // A key only other skins fill is a skin-only display (Spine's skin
    // placeholder, ARCHITECTURE ▸ Skins), the first skin's attachment standing in.
    const skinOnly = new Map<string, BoneBurstRaw>();
    for (const skin of skinsIn) {
      if (skin === defaultSkin || !obj(skin.attachments) || !obj(skin.attachments[slotName])) continue;
      for (const [key, att] of Object.entries(skin.attachments[slotName] as BoneBurstRaw)) {
        if (!(key in byKey) && !skinOnly.has(key) && obj(att) && displayItem(att, key)) skinOnly.set(key, att);
      }
    }
    // A slot holding one box, point or path the model can hold, which no other
    // skin fills, becomes that node (ARCHITECTURE ▸ Boxes and points).
    const sole = Object.entries(byKey);
    const otherSkins = skinsIn.filter((skin) => skin !== defaultSkin && obj(skin.attachments) && obj(skin.attachments[slotName]));
    const outlineBones = {
      node: boneWorld.get(String(s.bone))!,
      bone: (n: string) => (boneNode.has(n) ? { id: boneNode.get(n)!.id, setup: boneWorld.get(n)! } : undefined),
    };
    let outline = sole.length === 1 && !skinOnly.size && obj(sole[0]![1]) ? outlineOf(bonesToNames(sole[0]![1] as BoneBurstRaw, boneNames), outlineBones) : null;
    // Other skins filling the slot hold it only with an outline of the same
    // kind under the same key, each the skin's own (`SkinDef.outlines`).
    const skinned = new Map<string, Outline>();
    for (const skin of outline ? otherSkins : []) {
      const entries = Object.entries((skin.attachments as Record<string, BoneBurstRaw>)[slotName]!);
      const theirs = entries.length === 1 && entries[0]![0] === sole[0]![0] && obj(entries[0]![1]) ? outlineOf(bonesToNames(entries[0]![1] as BoneBurstRaw, boneNames), outlineBones) : null;
      if (theirs?.kind !== outline!.kind) { skinned.clear(); break; }
      skinned.set(String(skin.name), theirs);
    }
    if (outline && skinned.size !== otherSkins.length) outline = null;
    if (outline) {
      node.kind = outline.kind;
      node.key = sole[0]![0];
      if (outline.kind === "box") node.box = outline.box;
      if (outline.kind === "path") node.path = outline.path;
      if (outline.kind === "point" && outline.point) node.point = outline.point;
      if (skinned.size) skinOutlines.set(slotName, skinned);
      if (outline.color) node.attachmentColor = outline.color;
    }
    // The setup attachment first: display 0 is what the bind pose shows.
    const keys = outline ? [] : [...Object.keys(byKey), ...skinOnly.keys()].sort((p, q) => Number(q === setupName) - Number(p === setupName));
    for (const key of keys) {
      const att = byKey[key] ?? skinOnly.get(key);
      if (!obj(att)) continue;
      const regions = regionsOf(att, key);
      const item = displayItem(att, key);
      // A region sequence the model can hold (ARCHITECTURE ▸ Sequences).
      const sequence = !item && key in byKey ? sequenceDisplayOf(att, key, (n) => itemByRegion.get(n)) : null;
      if (sequence) { displays.push(sequence); continue; }
      if (!item) {
        if (regions.length && regions.some((r) => !itemByRegion.has(r))) {
          warn(`"${slotName}" ▸ "${key}" draws ${regions.filter((r) => !itemByRegion.has(r)).map((r) => `"${r}"`).join(", ")}, which the atlas does not have.`);
        }
        (carriedDefault[slotName] ??= {})[key] = bonesToNames(att, boneNames);
        continue;
      }
      // Its colour is the display's tint, written back onto the data (`DisplayRef.tint`).
      const { color: _c, ...data } = bonesToNames(att, boneNames);
      const ref: BoneBurstAttachmentRef = { name: key, data };
      const display: DisplayRef = { itemId: item.id, pivot: { x: item.width / 2, y: item.height / 2 }, attachment: ref, ...tintOf(att) };
      if (!(key in byKey)) display.skinOnly = true;
      displays.push(display);
    }
    if (displays.length) {
      node.itemId = displays[0]!.itemId;
      node.pivot = displays[0]!.pivot;
      node.attachment = displays[0]!.attachment;
      if (displays[0]!.skinOnly) node.skinOnly = true;
      if (displays.length > 1) node.extraDisplays = displays.slice(1);
    }
    if (displays.length) {
      if (displays[0]!.sequence) node.sequence = displays[0]!.sequence;
      if (displays[0]!.region) node.region = displays[0]!.region;
      if (displays[0]!.tint) node.tint = displays[0]!.tint;
      if (displays[0]!.key) node.key = displays[0]!.key;
    }
    const setupIndex = setupName === null ? -1 : outline ? (setupName === node.key ? 0 : -1)
      : displays.findIndex((d) => (d.attachment?.name ?? d.key) === setupName);
    if (setupIndex !== 0) node.setupDisplay = -1;
    const slotRest = pick(s, (k) => !SLOT_FIELDS.has(k)) ?? {};
    if (setupName !== null && setupIndex < 0) slotRest.attachment = setupName;
    if (Object.keys(slotRest).length) node.spine = { slot: slotRest };
    const color = slotColor(s.color, s.dark);
    if (!isDefaultColor(color)) node.color = color;
    if (str(s.blend) && s.blend !== "normal") {
      if (BLEND[s.blend]) node.blendMode = BLEND[s.blend];
      else warn(`Slot "${slotName}": unknown blend mode "${s.blend}", read as normal.`);
    }
    sym.nodes[node.id] = node;
    slotNode.set(slotName, node);
    slotLayers.push(createLayer(node.id, slotName, colorIndex++));
  }
  for (const slotName of Object.keys(defaultAtts)) {
    if (!slotNode.has(slotName)) warn(`The default skin has attachments for a slot "${slotName}" that does not exist; they were dropped.`);
  }
  if (defaultSkin) {
    const rest = pick(defaultSkin, (k) => k !== "attachments") ?? { name: "default" };
    const kept = Object.keys(carriedDefault).length || Object.keys(rest).length > 1;
    if (kept) carriedSkins.push({ ...rest, attachments: carriedDefault });
  }

  /* ── layers: the bone tree, then the slots, front first ── */
  const bonesFirst: Layer[] = [];
  const children = new Map<NodeId | null, Node[]>();
  for (const node of boneNode.values()) {
    const list = children.get(node.parentId);
    if (list) list.push(node); else children.set(node.parentId, [node]);
  }
  const walk = (parent: NodeId | null, depth: number) => {
    for (const n of children.get(parent) ?? []) {
      bonesFirst.push(createLayer(n.id, n.name, colorIndex++, depth));
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  sym.layers = [...bonesFirst, ...slotLayers.reverse()];

  /* ── constraints ── */
  const constraintsIn = Array.isArray(file.constraints) ? file.constraints.filter(obj) : [];
  const carriedConstraints: BoneBurstRaw[] = [];
  for (const c of constraintsIn) {
    const ik = c.type === "ik" ? ikOf(c, boneNode, warn) : null;
    const tc = c.type === "transform" ? transformOf(c, boneNode) : null;
    if (ik) sym.ik.push(ik);
    else if (tc) (sym.transforms ??= []).push(tc);
    else carriedConstraints.push(c);
  }
  for (const legacy of ["ik", "transform", "path", "physics", "slider"]) {
    if (Array.isArray(file[legacy]) && file[legacy].length) {
      warn(`The file has a top-level "${legacy}" list, a layout from before Spine 4.3; those constraints were not read.`);
    }
  }

  /* ── skins: each other skin a model skin; what it cannot hold is carried ── */
  const skinDefs: SkinDef[] = [];
  const ikNamed = new Map(sym.ik.map((k) => [k.name, k.id]));
  const tcNamed = new Map((sym.transforms ?? []).map((k) => [k.name, k.id]));
  for (const skin of skinsIn) {
    if (skin === defaultSkin) continue;
    const def: SkinDef = { name: String(skin.name) };
    // Its colour in Spine's editor (`SkinDef.color`).
    const color = str(skin.color) && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(skin.color) ? (skin.color.length === 6 ? skin.color + "ff" : skin.color).toLowerCase() : null;
    if (color) def.color = color;
    const rest: BoneBurstRaw = pick(skin, (k) => k !== "attachments" && k !== "bones" && !(SKIN_CONSTRAINT_KINDS as readonly string[]).includes(k) && !(k === "color" && color)) ?? {};
    const atts: Record<string, Record<string, BoneBurstRaw>> = {};
    for (const [slot, byKey] of Object.entries(obj(skin.attachments) ? skin.attachments : {})) {
      if (!obj(byKey)) continue;
      const node = slotNode.get(slot);
      const own = skinOutlines.get(slot)?.get(String(skin.name));
      if (node && own) {
        (def.outlines ??= {})[node.id] = own.kind === "box" ? { box: own.box } : own.kind === "path" ? { path: own.path } : { point: own.point ?? { x: 0, y: 0, rotation: 0 } };
        continue;
      }
      const names = node ? displayNames(node) : [];
      for (const [key, att] of Object.entries(byKey)) {
        if (!obj(att)) continue;
        const data = bonesToNames(att as BoneBurstRaw, boneNames);
        const index = names.indexOf(key);
        const item = displayItem(att as BoneBurstRaw, key);
        // Under a key the slot has a display for: that display, in this skin.
        if (node && index >= 0 && item) {
          const { color: _c, ...rest } = data;
          ((def.displays ??= {})[node.id] ??= {})[String(index)] = { itemId: item.id, pivot: { x: item.width / 2, y: item.height / 2 }, attachment: { name: key, data: rest }, ...tintOf(data) };
        } else (atts[slot] ??= {})[key] = data;
      }
    }
    if (Object.keys(atts).length) rest.attachments = atts;
    const bones = Array.isArray(skin.bones) ? skin.bones.filter(str) : [];
    const boneIds = bones.map((b) => boneNode.get(b)?.id).filter((id): id is NodeId => !!id);
    if (boneIds.length) def.bones = boneIds;
    const strayBones = bones.filter((b) => !boneNode.has(b));
    if (strayBones.length) rest.bones = strayBones;
    for (const kind of SKIN_CONSTRAINT_KINDS) {
      const listed = Array.isArray(skin[kind]) ? (skin[kind] as unknown[]).filter(str) : [];
      const model = kind === "ik" ? ikNamed : kind === "transform" ? tcNamed : null;
      const kept = listed.filter((n) => !model?.has(n));
      if (kind === "ik") { const ids = listed.map((n) => ikNamed.get(n)).filter((id): id is IkId => !!id); if (ids.length) def.ik = ids; }
      if (kind === "transform") { const ids = listed.map((n) => tcNamed.get(n)).filter((id): id is TcId => !!id); if (ids.length) def.transforms = ids; }
      if (kept.length) rest[kind] = kept;
    }
    skinDefs.push(def);
    if (Object.keys(rest).length > 1) carriedSkins.push(rest);
  }
  if (skinDefs.length) sym.skins = skinDefs;
  // Spine applies them in the file's order.
  if (constraintsIn.length) sym.constraintOrder = constraintsIn.map((c) => String(c.name));

  sym.spine = {
    header: pick(header, (k) => k !== "spine" && k !== "fps") ?? {},
    constraints: carriedConstraints,
    skins: carriedSkins,
  };
  // The events become the document's (`SymbolItem.events`).
  if (obj(file.events)) {
    const defs = eventDefsFromBoneBurst(file.events);
    if (defs.length) sym.events = defs;
  }

  /* ── animations ── */
  let baked = 0;
  for (const [animName, animRaw] of Object.entries(animsIn)) {
    if (!obj(animRaw)) continue;
    const end = toFrame(lastTime(animRaw));
    const anim: Animation = {
      id: newAnimId(), name: animName, duration: end + 1, playTimes: 0, tracks: {}, endsAtLastFrame: true,
    };
    const carried: BoneBurstRaw = pick(animRaw, (k) => k !== "bones" && k !== "slots") ?? {};

    const bonesAnim = obj(animRaw.bones) ? animRaw.bones : {};
    for (const [boneName, timelines] of Object.entries(bonesAnim)) {
      const node = boneNode.get(boneName);
      if (!node || !obj(timelines)) { warn(`"${animName}" keys a bone "${boneName}" that does not exist; dropped.`); continue; }
      const setup = boneSetup.get(boneName)!;
      const { groups, rest } = boneComps(timelines, setup, rate, shearKept.has(boneName));
      // Inherit keys become the document's when each lands on a frame.
      const inherits = rest && "inherit" in rest ? inheritKeysFromBoneBurst(rest.inherit, rate) : null;
      if (inherits) {
        (anim.inherits ??= {})[node.id] = inherits;
        delete rest!.inherit;
      }
      if (rest && Object.keys(rest).length) ((carried.bones ??= {}) as BoneBurstRaw)[boneName] = rest;
      if (groups.length === 0) continue;
      const frameOf = (f: number): Transform => fromBoneBurstLocal(boneLocalAt(groups, setup, f));
      const made = trackOf(node, groups, [], end, (f) => ({ transform: frameOf(f), displayIndex: 0 }), (track, f) => {
        const got = sampleTransformRaw(track, f)!, want = frameOf(f);
        return close(got.x, want.x, 1e-3) && close(got.y, want.y, 1e-3) && close(got.skewX, want.skewX, 1e-3)
          && close(got.skewY, want.skewY, 1e-3) && close(got.scaleX, want.scaleX, 1e-5) && close(got.scaleY, want.scaleY, 1e-5);
      });
      anim.tracks[node.id] = made.track;
      baked += made.baked;
    }

    const slotsAnim = obj(animRaw.slots) ? animRaw.slots : {};
    for (const [slotName, timelines] of Object.entries(slotsAnim)) {
      const node = slotNode.get(slotName);
      if (!node || !obj(timelines)) { warn(`"${animName}" keys a slot "${slotName}" that does not exist; dropped.`); continue; }
      const setup = slotSetup(slotsIn.find((s) => s.name === slotName)!);
      const { group, rest: colorRest } = colorComps(timelines, setup, rate);
      let rest = colorRest;
      const names = displayNames(node);
      let switches: Array<{ frame: number; name: string | null }> = [];
      if (Array.isArray(timelines.attachment)) {
        const keys = timelines.attachment.filter(obj).map((k) => ({ frame: switchFrame(k.time), name: str(k.name) ? k.name : null }));
        if (keys.every((k) => k.name === null || names.includes(k.name))) switches = keys;
        else (rest ??= {}).attachment = timelines.attachment;
      }
      if (rest) ((carried.slots ??= {}) as BoneBurstRaw)[slotName] = rest;
      if (!group && switches.length === 0) continue;
      const setupDisplay = node.setupDisplay ?? 0;
      const shownAt = (f: number) => {
        let shown = setupDisplay;
        for (const k of switches) if (k.frame <= f) shown = k.name === null ? -1 : names.indexOf(k.name);
        return shown;
      };
      const colorOf = (f: number) => (group ? slotColorAt(group, f) : undefined);
      const made = trackOf(node, group ? [group] : [], switches.map((k) => k.frame), end,
        (f) => ({ transform: cloneTf(IDENTITY), displayIndex: shownAt(f), ...(group ? { color: colorOf(f) } : {}) }),
        (track, f) => {
          if (!group) return true;
          const got = sampleColorRaw(track, f)!, want = colorOf(f)!;
          return (Object.keys(want) as Array<keyof ColorTransform>).every((ch) => close(got[ch], want[ch], ch.endsWith("M") ? 1e-2 : 1e-2));
        });
      anim.tracks[node.id] = made.track;
      baked += made.baked;
    }
    // Draw order keys become the document's (`Animation.drawOrder`) when each
    // lands on a frame and reads as an order of known slots; otherwise the
    // timeline is carried as it came.
    if (Array.isArray(animRaw.drawOrder)) {
      const setup = slotsIn.map((sl) => slotNode.get(String(sl.name))?.id).filter((id): id is NodeId => !!id);
      const keys: DrawOrderKey[] = [];
      for (const k of animRaw.drawOrder) {
        if (!obj(k)) { keys.length = 0; break; }
        const at = num(k.time, 0) * rate;
        if (Math.abs(at - Math.round(at)) > 1e-6) { keys.length = 0; break; }
        const offsets = Array.isArray(k.offsets) ? k.offsets.filter(obj) : [];
        const mapped = offsets.map((o) => ({ item: slotNode.get(String(o.slot))?.id, offset: num(o.offset, 0) }));
        if (mapped.some((o) => !o.item)) { keys.length = 0; break; }
        const order = fromOffsets(mapped as Array<{ item: NodeId; offset: number }>, setup);
        if (!order) { keys.length = 0; break; }
        keys.push(offsets.length ? { frame: Math.round(at), order } : { frame: Math.round(at) });
      }
      if (keys.length === animRaw.drawOrder.length && keys.length) {
        anim.drawOrder = keys;
        delete carried.drawOrder;
      }
    }
    // Event keys become the document's (`Animation.events`) when each lands
    // on a frame and names a known event; otherwise the timeline is carried.
    if (Array.isArray(animRaw.events)) {
      const keys = eventKeysOf(animRaw.events, sym.events ?? [], rate);
      if (keys) {
        if (keys.length) anim.events = keys;
        delete carried.events;
      }
    }
    // Transform constraint keys likewise (`Animation.transforms`).
    if (obj(animRaw.transform)) {
      const rest: BoneBurstRaw = {};
      for (const [name, list] of Object.entries(animRaw.transform)) {
        const k = sym.transforms?.find((c) => c.name === name);
        const keys = k && Array.isArray(list) ? transformKeysOf(list, rate) : null;
        if (keys && k) (anim.transforms ??= {})[k.id] = keys;
        else rest[name] = list;
      }
      if (Object.keys(rest).length) carried.transform = rest;
      else delete carried.transform;
    }
    // IK keys become the document's (`Animation.ik`) per constraint when each
    // lands on a frame and changes only what the editor keys (the mix, the
    // bend); otherwise that constraint's timeline is carried as it came.
    if (obj(animRaw.ik)) {
      const rest: BoneBurstRaw = {};
      for (const [name, list] of Object.entries(animRaw.ik)) {
        const k = sym.ik.find((c) => c.name === name);
        const keys = k && Array.isArray(list) ? ikKeysOf(list, k, rate) : null;
        if (keys && k) (anim.ik ??= {})[k.id] = keys;
        else rest[name] = list;
      }
      if (Object.keys(rest).length) carried.ik = rest;
      else delete carried.ik;
    }
    if (Object.keys(carried).length) anim.spine = carried;
    sym.animations.push(anim);
  }
  if (sym.animations.length === 0) {
    const anim = createAnimation();
    sym.animations.push(anim);
    warn(`The skeleton has no animations; an empty one, "${anim.name}", was added for the timeline.`);
  }

  /* ── physics and sliders the model holds; anything else stays carried ── */
  const carry = sym.spine!;
  carry.constraints = carry.constraints.filter((c) => {
    const keys = Object.keys(c);
    if (c.type === "physics" && keys.every((k) => PHYSICS_FIELDS.has(k)) && str(c.bone) && boneNode.has(c.bone)) {
      (sym.physics ??= []).push(physicsFromBoneBurst(c, newCnId(), boneNode.get(c.bone)!.id));
      return false;
    }
    // A path constraint whose slot holds a path node (ARCHITECTURE ▸ Physics, sliders and paths).
    const pathNode = c.type === "path" && str(c.slot) ? slotNode.get(c.slot) : undefined;
    const pathBones = Array.isArray(c.bones) ? c.bones.map((b) => (str(b) ? boneNode.get(b) : undefined)) : [];
    if (pathNode?.kind === "path" && keys.every((k) => PATH_FIELDS.has(k) || (k === "skin" && c.skin === true)) && pathBones.length && pathBones.every((b) => b)) {
      (sym.paths ??= []).push(pathFromBoneBurst(c, newCnId(), pathBones.map((b) => b!.id), pathNode.id));
      return false;
    }
    const anim = c.type === "slider" && str(c.animation) ? sym.animations.find((a) => a.name === c.animation) : undefined;
    const bone = str(c.bone) ? boneNode.get(c.bone) : undefined;
    if (anim && keys.every((k) => SLIDER_FIELDS.has(k)) && (c.bone === undefined || bone)) {
      (sym.sliders ??= []).push(sliderFromBoneBurst(c, newCnId(), anim.id, bone?.id));
      return false;
    }
    return true;
  });
  // Their keys become the document's channel by channel; what does not fit stays carried.
  type Held = { kind: "physics" | "slider" | "path"; id: CnId };
  const modelled = new Map<string, Held>([
    ...(sym.physics ?? []).map((k) => [k.name, { kind: "physics" as const, id: k.id }] as const),
    ...(sym.sliders ?? []).map((k) => [k.name, { kind: "slider" as const, id: k.id }] as const),
    ...(sym.paths ?? []).map((k) => [k.name, { kind: "path" as const, id: k.id }] as const),
  ]);
  for (const anim of sym.animations) {
    for (const group of ["physics", "slider", "path"] as const) {
      const timelines = anim.spine?.[group];
      if (!obj(timelines)) continue;
      const rest: BoneBurstRaw = {};
      for (const [name, channels] of Object.entries(timelines)) {
        const m = modelled.get(name);
        if (!m || m.kind !== group || !obj(channels)) { rest[name] = channels; continue; }
        const left: BoneBurstRaw = {};
        for (const [channel, list] of Object.entries(channels)) {
          const known = (CONSTRAINT_CHANNELS[group] as readonly string[]).includes(channel);
          // A value a key leaves out: physics' and a path's position and spacing read 0, mixes 1.
          const missing = group !== "slider" && channel !== "mix" ? 0 : 1;
          const pathMix = group === "path" && channel === "mix";
          // A key between frames: the channel written frame by frame instead.
          const exact = known ? channelKeysFromBoneBurst(list, rate, missing, pathMix) : null;
          const keys = exact ?? (known && offFrame(list, rate) ? bakedChannelKeys(list, rate, missing, pathMix) : null);
          if (keys && !exact) baked++;
          if (keys) anim.constraintKeys = withChannelKeys(anim.constraintKeys, m.id, channel, keys);
          else left[channel] = list;
        }
        if (Object.keys(left).length) rest[name] = left;
      }
      const boneburst = { ...anim.spine };
      if (Object.keys(rest).length) boneburst[group] = rest; else delete boneburst[group];
      if (Object.keys(boneburst).length) anim.spine = boneburst; else delete anim.spine;
    }
  }
  // Skins listing the physics and sliders the model now holds have them as members.
  for (const def of sym.skins ?? []) {
    const rest = sym.spine!.skins.find((sk) => sk.name === def.name);
    if (!rest) continue;
    for (const kind of ["physics", "slider", "path"] as const) {
      const listed = Array.isArray(rest[kind]) ? (rest[kind] as unknown[]).filter(str) : [];
      const held = listed.map((n) => modelled.get(n)).filter((m): m is Held => !!m && m.kind === kind);
      if (!held.length) continue;
      def.constraints = [...new Set([...(def.constraints ?? []), ...held.map((m) => m.id)])];
      const left = listed.filter((n) => modelled.get(n)?.kind !== kind);
      if (left.length) rest[kind] = left; else delete rest[kind];
    }
  }
  sym.spine!.skins = sym.spine!.skins.filter((sk) => Object.keys(sk).length > 1);
  if (baked) warn(`${baked} tween(s) were written frame by frame: no single ease of the editor's plays them as Spine does.`);
  editableMeshes(project, sym, slotNode, boneNode, rate);
  sequenceKeys(sym, slotNode, rate);
  return { project, diagnostics, baked };
}

/**
 * The default skin's meshes the model can hold become the document's
 * (ARCHITECTURE ▸ Meshes ▸ Opened meshes): `meshFromBoneBurst`, and each
 * animation's deform timeline as keys. A mesh another display's deform keys,
 * or a timeline that does not convert, stays carried, the whole mesh at once.
 */
function editableMeshes(project: Project, sym: SymbolItem, slotNode: Map<string, Node>, boneNode: Map<string, Node>, rate: number): void {
  const setup = evaluateSymbol(sym, null, 0, "setup", null).byNode;
  const bone = (name: string) => {
    const n = boneNode.get(name);
    const w = n ? setup.get(n.id)?.world : undefined;
    return n && w ? { id: n.id, setup: w } : undefined;
  };
  const setupOf = (id: NodeId) => setup.get(id)?.world;
  /** Each animation's deform timeline of `skin`'s `key` in `slot` as `target`'s
   *  keys, the carried timelines dropped; false (nothing changed) when one
   *  does not convert, and the mesh stays carried. */
  const takeDeforms = (target: DeformTarget, skin: string, slot: string, key: string, mesh: MeshData, ctx: MeshContext): boolean => {
    const deforms = new Map<Animation, DeformKey[]>();
    for (const anim of sym.animations) {
      const raw = deformOf(anim, skin, slot, key);
      if (raw === undefined) continue;
      const keys = deformKeysFromBoneBurst(raw, mesh, ctx, rate);
      if (!keys) return false;
      deforms.set(anim, keys);
    }
    for (const [anim, keys] of deforms) {
      assignDeforms(anim, withDeformKeysOf(anim, target, keys));
      dropCarriedDeform(anim, skin, slot, key);
    }
    return true;
  };
  for (const [slotName, slot] of slotNode) {
    const nodeWorld = setup.get(slot.id)?.world;
    if (!nodeWorld) continue;
    displaysOf(sym.nodes[slot.id]!).forEach((d, index) => {
      const att = d.attachment;
      const item = project.items[d.itemId];
      if (!att || d.skinOnly || att.data.type !== "mesh" || !isImage(item)) return;
      const ctx = { width: item.width, height: item.height, pivot: d.pivot, node: nodeWorld, bone, setupOf };
      const mesh = meshFromBoneBurst(att.data, ctx);
      if (!mesh) return;
      if (!takeDeforms({ nodeId: slot.id, skin: null, index }, "default", slotName, att.name, mesh, ctx)) return;
      replaceDisplay(sym, slot.id, index, { mesh, key: att.name, ...nameOf(att) });
    });
    // Linked meshes whose parent is now the document's mesh, in this slot.
    displaysOf(sym.nodes[slot.id]!).forEach((d, index) => {
      const att = d.attachment;
      if (!att || d.skinOnly || att.data.type !== "linkedmesh") return;
      const data = att.data;
      if (Object.keys(data).some((k) => !LINKED_FIELDS.has(k)) || (data.skin !== undefined && data.skin !== "default")) return;
      if (data.slot !== undefined && data.slot !== slotName) return;
      if (sym.animations.some((anim) => deformOf(anim, "default", slotName, att.name) !== undefined)) return;
      const to = displaysOf(sym.nodes[slot.id]!).findIndex((p) => p.mesh && p.key === data.source);
      if (to < 0) return;
      replaceDisplay(sym, slot.id, index, { linked: data.timelines === false ? { to, deform: false } : { to }, key: att.name, ...nameOf(att) });
    });
  }
  // Other skins' meshes likewise, their deform timelines as the skin's keys.
  const slotName = new Map([...slotNode].map(([name, n]) => [n.id, name]));
  const skinned = (fn: (def: SkinDef, nodeId: NodeId, index: number, ref: DisplayRef, slot: string) => DisplayRef | null) => {
    for (const def of sym.skins ?? []) {
      for (const [nodeId, byIndex] of Object.entries(def.displays ?? {}) as Array<[NodeId, Record<string, DisplayRef>]>) {
        const slot = slotName.get(nodeId);
        if (!slot) continue;
        for (const [index, ref] of Object.entries(byIndex)) {
          const held = ref.attachment ? fn(def, nodeId, Number(index), ref, slot) : null;
          // The tint the carried display had read from its colour stays.
          if (held) byIndex[index] = ref.tint ? { ...held, tint: ref.tint } : held;
        }
      }
    }
  };
  const deformed = (skin: string, slot: string, key: string) => sym.animations.some((anim) => deformOf(anim, skin, slot, key) !== undefined);
  skinned((def, nodeId, index, ref, slot) => {
    const att = ref.attachment!;
    const item = project.items[ref.itemId];
    const nodeWorld = setup.get(nodeId)?.world;
    if (att.data.type !== "mesh" || !isImage(item) || !nodeWorld) return null;
    const ctx = { width: item.width, height: item.height, pivot: ref.pivot, node: nodeWorld, bone, setupOf };
    const mesh = meshFromBoneBurst(att.data, ctx);
    if (!mesh || !takeDeforms({ nodeId, skin: def.name, index }, def.name, slot, att.name, mesh, ctx)) return null;
    return { itemId: ref.itemId, pivot: ref.pivot, mesh, key: att.name, ...nameOf(att) };
  });
  // A skin's linked mesh whose source is a mesh the document now holds: in the
  // skin it names (Spine's `skin`), else in the default skin.
  skinned((def, nodeId, index, ref, slot) => {
    const data = ref.attachment!.data;
    if (data.type !== "linkedmesh" || Object.keys(data).some((k) => !LINKED_FIELDS.has(k))) return null;
    if ((data.slot !== undefined && data.slot !== slot) || deformed(def.name, slot, ref.attachment!.name)) return null;
    const from = str(data.skin) && data.skin !== "default" ? data.skin : null;
    const node = sym.nodes[nodeId]!;
    const count = displaysOf(node).length;
    let to = -1;
    for (let i = 0; i < count && to < 0; i++) {
      const d = from ? sym.skins?.find((x) => x.name === from)?.displays?.[nodeId]?.[i] : displaysOf(node)[i];
      if (d?.mesh && d.key === data.source) to = i;
    }
    if (to < 0 || (to === index && !from)) return null;
    const linked: DisplayRef["linked"] = { to, ...(data.timelines === false ? { deform: false as const } : {}), ...(from ? { skin: from } : {}) };
    return { itemId: ref.itemId, pivot: ref.pivot, linked, key: ref.attachment!.name, ...nameOf(ref.attachment!) };
  });
}

/** An attachment's own colour (Spine's `color`) as a display's tint; white is none. */
function tintOf(data: BoneBurstRaw): { tint?: string } {
  if (!str(data.color) || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(data.color)) return {};
  const t = (data.color.length === 6 ? data.color + "ff" : data.color).toLowerCase();
  return t === "ffffffff" ? {} : { tint: t };
}

/** An attachment's own name, kept where it is not its key. */
const nameOf = (att: BoneBurstAttachmentRef): { name?: string } => (str(att.data.name) && att.data.name !== att.name ? { name: att.data.name } : {});

const LINKED_FIELDS = new Set(["type", "name", "path", "source", "slot", "skin", "timelines", "width", "height", "color"]);

/** Display `index` of the node with its carried attachment replaced by `held`. */
function replaceDisplay(sym: SymbolItem, nodeId: NodeId, index: number, held: Pick<DisplayRef, "mesh" | "key" | "linked" | "name">): void {
  const node = sym.nodes[nodeId]!;
  if (index === 0) {
    const { attachment: _a, ...rest } = node;
    const { name, ...own } = held;
    sym.nodes[nodeId] = { ...rest, ...own, ...(name ? { attachmentName: name } : {}) };
    return;
  }
  const extras = [...node.extraDisplays!];
  const { attachment: _a, ...ref } = extras[index - 1]!;
  extras[index - 1] = { ...ref, ...held };
  sym.nodes[nodeId] = { ...node, extraDisplays: extras };
}

/**
 * Display 0's sequence timelines as the document's keys (ARCHITECTURE ▸
 * Sequences), each animation's when every key lands on a frame and names a
 * mode; the delay in frames. Else the timeline stays carried.
 */
function sequenceKeys(sym: SymbolItem, slotNode: Map<string, Node>, rate: number): void {
  for (const [slotName, slot] of slotNode) {
    const node = sym.nodes[slot.id]!;
    if (!node.sequence || !node.key) continue;
    for (const anim of sym.animations) {
      const atts = anim.spine?.attachments as Record<string, Record<string, Record<string, BoneBurstRaw>>> | undefined;
      const raw = atts?.default?.[slotName]?.[node.key]?.sequence;
      if (!Array.isArray(raw)) continue;
      const read: SequenceKey[] = [];
      for (const k of raw) {
        if (!obj(k)) break;
        const at = num(k.time, 0) * rate;
        const mode = k.mode ?? "hold";
        if (!SEQUENCE_MODES.includes(mode as never)) break;
        const delay = num(k.delay, 0) * rate;
        const frame = Math.abs(at - Math.round(at)) <= 1e-3 ? Math.round(at) : at;
        read.push({ frame, mode: mode as SequenceKey["mode"], index: Math.max(0, Math.trunc(num(k.index, 0))), delay: delay > 0 ? delay : 1 });
      }
      if (read.length !== raw.length) continue;
      // A key between frames: the image Spine shows at every whole frame, held.
      const keys = read.every((k) => Number.isInteger(k.frame)) ? read
        : bakedSequenceKeys(read, anim.duration - 1, node.sequence.items.length, node.sequence.setup ?? 0);
      anim.sequences = { ...anim.sequences, [slot.id]: keys };
      const copy = structuredClone(atts!);
      const att = copy.default![slotName]![node.key]!;
      delete att.sequence;
      if (!Object.keys(att).length) delete copy.default![slotName]![node.key];
      if (!Object.keys(copy.default![slotName]!).length) delete copy.default![slotName];
      if (!Object.keys(copy.default!).length) delete copy.default;
      const boneburst = { ...anim.spine };
      if (Object.keys(copy).length) boneburst.attachments = copy; else delete boneburst.attachments;
      if (Object.keys(boneburst).length) anim.spine = boneburst; else delete anim.spine;
    }
  }
}

function deformOf(anim: Animation, skin: string, slot: string, key: string): unknown {
  const atts = anim.spine?.attachments as Record<string, Record<string, Record<string, BoneBurstRaw>>> | undefined;
  return atts?.[skin]?.[slot]?.[key]?.deform;
}

function dropCarriedDeform(anim: Animation, skin: string, slot: string, key: string): void {
  const atts = structuredClone(anim.spine!.attachments) as Record<string, Record<string, Record<string, BoneBurstRaw>>>;
  const att = atts[skin]![slot]![key]!;
  delete att.deform;
  if (!Object.keys(att).length) delete atts[skin]![slot]![key];
  if (!Object.keys(atts[skin]![slot]!).length) delete atts[skin]![slot];
  if (!Object.keys(atts[skin]!).length) delete atts[skin];
  const boneburst = { ...anim.spine };
  if (Object.keys(atts).length) boneburst.attachments = atts; else delete boneburst.attachments;
  if (Object.keys(boneburst).length) anim.spine = boneburst; else delete anim.spine;
}

/** Whether a timeline has a key between frames at `rate`. */
function offFrame(list: unknown, rate: number): boolean {
  return Array.isArray(list) && list.some((k) => obj(k) && frameOf(num(k.time, 0), rate) % 1 !== 0);
}

/* ── frame rate ──────────────────────────────────────────────────────────── */

/**
 * The document's frame rate: the file's, or the first multiple of it (up to
 * 120) that puts every key on a whole frame; failing that the file's, with
 * the stray keys counted, to be moved.
 */
function frameRateFor(fps: number, anims: unknown[]): { rate: number; snapped: number } {
  const times: number[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!obj(v)) return;
    if (typeof v.time === "number") times.push(v.time);
    for (const x of Object.values(v)) if (typeof x === "object") walk(x);
  };
  for (const a of anims) walk(a);
  const off = (rate: number) => times.filter((t) => frameOf(t, rate) % 1 !== 0).length;
  for (let m = 1; fps * m <= 120; m++) if (off(fps * m) === 0) return { rate: fps * m, snapped: 0 };
  return { rate: fps, snapped: off(fps) };
}

/**
 * A key time in frames: the whole frame it was written for (the editor
 * stores times to seven digits, so 1/3 s is 9.999999 frames at 30 fps), or
 * where it truly falls between two.
 */
function frameOf(t: number, rate: number): number {
  const f = t * rate;
  return Math.abs(f - Math.round(f)) <= 2e-3 ? Math.round(f) : f;
}

/* ── bone keys ───────────────────────────────────────────────────────────── */

type BoneValue = keyof BoneBurstLocal;

/** Which timeline value feeds which pose value, and how its keys add to or
 *  multiply the setup pose. */
const BONE_TIMELINES: Record<string, Array<{ value: BoneValue; field: string }>> = {
  rotate: [{ value: "rotation", field: "value" }],
  translate: [{ value: "x", field: "x" }, { value: "y", field: "y" }],
  translatex: [{ value: "x", field: "value" }],
  translatey: [{ value: "y", field: "value" }],
  scale: [{ value: "scaleX", field: "x" }, { value: "scaleY", field: "y" }],
  scalex: [{ value: "scaleX", field: "value" }],
  scaley: [{ value: "scaleY", field: "value" }],
  shear: [{ value: "shearX", field: "x" }, { value: "shearY", field: "y" }],
  shearx: [{ value: "shearX", field: "value" }],
  sheary: [{ value: "shearY", field: "value" }],
};

const SHEAR_TIMELINES = ["shear", "shearx", "sheary"];

/** The bones local-source transform constraints read. */
export function localSourceBones(constraints: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(constraints)) return out;
  for (const c of constraints) {
    if (obj(c) && c.type === "transform" && c.localSource === true && str(c.source)) out.add(c.source);
  }
  return out;
}

interface BoneGroups extends ChannelGroup { values: BoneValue[] }

/** A bone's keyed values, grouped by the editor's tween channels. */
function boneComps(timelines: BoneBurstRaw, setup: BoneBurstLocal, rate: number, keepShear: boolean): { groups: BoneGroups[]; rest: BoneBurstRaw | null } {
  const comps = new Map<BoneValue, Comp>();
  const rest: BoneBurstRaw = {};
  for (const [timeline, keys] of Object.entries(timelines)) {
    const spec = keepShear && SHEAR_TIMELINES.includes(timeline) ? undefined : BONE_TIMELINES[timeline];
    if (!spec || !Array.isArray(keys)) { rest[timeline] = keys; continue; }
    spec.forEach(({ value, field }, i) => {
      const scale = value === "scaleX" || value === "scaleY";
      const base = setup[value];
      const abs = (v: number) => (scale ? base * v : base + v);
      comps.set(value, compOf(keys.filter(obj), rate, i, (k) => abs(num(k[field], scale ? 1 : 0)), abs, base));
    });
  }
  const group = (
    channel: ChannelGroup["channel"], values: BoneValue[], eps: number,
    parts: Array<[ChannelGroup["channel"], BoneValue[]]> = [],
  ): BoneGroups | null => {
    const cs = values.map((v) => comps.get(v)).filter((c): c is Comp => !!c);
    if (!cs.length) return null;
    const refined = parts.map(([ch, vs]) => group(ch, vs, eps)).filter((p): p is BoneGroups => !!p);
    return { channel, comps: cs, eps, values: values.filter((v) => comps.has(v)), ...(refined.length ? { parts: refined } : {}) };
  };
  // The stage's rotation turns skewY, which is rotation + shearX; its shear
  // is skewY − skewX, shearY − shearX (`fromBoneBurstLocal`).
  const groups = [
    group("position", ["x", "y"], 1e-6, [["x", ["x"]], ["y", ["y"]]]),
    group("rotation", ["rotation", "shearX", "shearY"], 1e-6, [["rotation", ["rotation", "shearX"]], ["shear", ["shearX", "shearY"]]]),
    group("scale", ["scaleX", "scaleY"], 1e-9, [["scaleX", ["scaleX"]], ["scaleY", ["scaleY"]]]),
  ].filter((g): g is BoneGroups => !!g);
  return { groups, rest: Object.keys(rest).length ? rest : null };
}

/** The bone's local pose at a frame: its keyed values, the setup pose for
 *  the rest. */
function boneLocalAt(groups: BoneGroups[], setup: BoneBurstLocal, f: number): BoneBurstLocal {
  const out = { ...setup };
  for (const g of groups) g.values.forEach((v, i) => { out[v] = valueAt(g.comps[i]!, f); });
  return out;
}

/**
 * One value of a Spine timeline as a `Comp`: keys at whole frames, values
 * and curve controls absolute. `index` picks the value's four numbers in
 * each key's curve (x then y for two-value timelines).
 */
function compOf(
  keys: BoneBurstRaw[], rate: number, index: number,
  value: (k: BoneBurstRaw) => number, abs: (v: number) => number, setup: number,
): Comp {
  const out: CompKey[] = [];
  keys.forEach((k, i) => {
    const t = num(k.time, 0), frame = frameOf(t, rate);
    const next = keys[i + 1];
    let curve: CompKey["curve"] = null;
    if (k.curve === "stepped") curve = "stepped";
    else if (Array.isArray(k.curve) && next) {
      const c = k.curve.slice(index * 4, index * 4 + 4).map((x) => num(x, 0));
      const t1 = num(next.time, 0), f1 = frameOf(t1, rate);
      // Times into frames, keeping each control where it sat between the
      // two keys (a key's time is read onto its whole frame).
      const toF = (x: number) => (t1 === t ? frame : frame + ((x - t) / (t1 - t)) * (f1 - frame));
      curve = [toF(c[0]!), abs(c[1]!), toF(c[2]!), abs(c[3]!)];
    }
    out.push({ frame, value: value(k), curve });
  });
  return { setup, keys: out };
}

/* ── slot keys ───────────────────────────────────────────────────────────── */

interface Rgba2 { r: number; g: number; b: number; a: number; dr: number; dg: number; db: number }
const CHANNELS = ["r", "g", "b", "a", "dr", "dg", "db"] as const;

function hexColor(v: unknown, fallback: number[]): number[] {
  if (!str(v)) return fallback;
  const out = fallback.slice();
  for (let i = 0; i * 2 < v.length && i < out.length; i++) out[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16) / 255;
  return out;
}

function slotSetup(s: BoneBurstRaw): Rgba2 {
  const [r, g, b, a] = hexColor(s.color, [1, 1, 1, 1]) as [number, number, number, number];
  const [dr, dg, db] = hexColor(s.dark, [0, 0, 0]) as [number, number, number];
  return { r, g, b, a, dr, dg, db };
}

/** Light and dark as the editor's colour: multipliers light − dark,
 *  offsets dark (`lightHex` / `darkHex` are the way back). */
function toColor(c: Rgba2): ColorTransform {
  return {
    rM: (c.r - c.dr) * 100, gM: (c.g - c.dg) * 100, bM: (c.b - c.db) * 100, aM: c.a * 100,
    rO: c.dr * 255, gO: c.dg * 255, bO: c.db * 255, aO: 0,
  };
}

function slotColor(color: unknown, dark: unknown): ColorTransform {
  return toColor(slotSetup({ color, dark }));
}

/** Which colour values each colour timeline keys, in its curve order. */
const COLOR_TIMELINES: Record<string, Array<{ ch: typeof CHANNELS[number]; read: (k: BoneBurstRaw) => number }>> = {
  rgba: (["r", "g", "b", "a"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.color, [1, 1, 1, 1])[i]! })),
  rgb: (["r", "g", "b"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.color, [1, 1, 1])[i]! })),
  alpha: [{ ch: "a", read: (k: BoneBurstRaw) => num(k.value, 1) }],
  rgba2: [
    ...(["r", "g", "b", "a"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.light, [1, 1, 1, 1])[i]! })),
    ...(["dr", "dg", "db"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.dark, [0, 0, 0])[i]! })),
  ],
  rgb2: [
    ...(["r", "g", "b"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.light, [1, 1, 1])[i]! })),
    ...(["dr", "dg", "db"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.dark, [0, 0, 0])[i]! })),
  ],
};

type ColorGroup = ChannelGroup & { chans: Array<typeof CHANNELS[number]>; setup: Rgba2 };

function colorComps(timelines: BoneBurstRaw, setup: Rgba2, rate: number): { group: ColorGroup | null; rest: BoneBurstRaw | null } {
  const comps = new Map<typeof CHANNELS[number], Comp>();
  const rest: BoneBurstRaw = {};
  for (const [timeline, keys] of Object.entries(timelines)) {
    if (timeline === "attachment") continue;
    const spec = COLOR_TIMELINES[timeline];
    if (!spec || !Array.isArray(keys)) { rest[timeline] = keys; continue; }
    spec.forEach(({ ch, read }, i) => comps.set(ch, compOf(keys.filter(obj), rate, i, read, (v) => v, setup[ch])));
  }
  const chans = CHANNELS.filter((c) => comps.has(c));
  const group: ColorGroup | null = chans.length
    ? { channel: "color", comps: chans.map((c) => comps.get(c)!), eps: 1e-7, chans, setup } : null;
  return { group, rest: Object.keys(rest).length ? rest : null };
}

function slotColorAt(g: ColorGroup, f: number): ColorTransform {
  const c = { ...g.setup };
  g.chans.forEach((ch, i) => { c[ch] = valueAt(g.comps[i]!, f); });
  return toColor(c);
}

function displayNames(node: Node): string[] {
  const out: string[] = [];
  if (node.attachment || node.key) out.push(node.attachment?.name ?? node.key!);
  for (const d of node.extraDisplays ?? []) out.push(d.attachment?.name ?? d.key ?? "");
  return out;
}

/* ── tracks ──────────────────────────────────────────────────────────────── */

/**
 * A node's track from its keyed values: the merged key frames
 * (`mergeKeys`), each key's state from `state(frame)`, every interval
 * checked through the stage's own sampler by `matches`.
 */
function trackOf(
  node: Node, groups: ChannelGroup[], extra: number[], end: number,
  state: (f: number) => Pick<Keyframe, "transform" | "displayIndex" | "color">,
  matches: (track: Track, f: number) => boolean,
): { track: Track; baked: number } {
  const keyAt = (t: KeyTiming): Keyframe => {
    const s = state(t.frame);
    const k: Keyframe = { frame: t.frame, transform: s.transform, displayIndex: s.displayIndex, tween: t.tween };
    if (s.color) k.color = s.color;
    if (t.eases) k.eases = t.eases;
    return k;
  };
  const { keys, baked } = mergeKeys(groups, extra, end, (a, b) => {
    const track: Track = { nodeId: node.id, keys: [keyAt(a), keyAt({ frame: b, tween: { kind: "none" } })], endFrame: b };
    for (let f = a.frame + 1; f < b; f++) if (!matches(track, f)) return false;
    return true;
  });
  return { track: { nodeId: node.id, keys: keys.map(keyAt), endFrame: end }, baked };
}

/* ── constraints ─────────────────────────────────────────────────────────── */

/**
 * An IK constraint as the editor's, when it can hold it: one bone, or a
 * parent and its child, aiming at a bone. The editor's bend is mirrored by
 * the y flip (the exporter's rule, inverted). What it does not solve rides
 * along in `spine` and the Spine pose applies it.
 */
/**
 * A Spine `events` timeline as the document's keys, or null when a key falls
 * between frames or names an event the file does not define. A key keeps
 * only the values that differ from its event's. A key of an event with a
 * sound and no balance played the event's VOLUME as its balance in
 * spine-core 4.3.13; that is the balance it gets.
 */
function eventKeysOf(list: unknown[], defs: readonly EventDef[], rate: number): EventKey[] | null {
  const keys: EventKey[] = [];
  for (const r of list) {
    if (!obj(r) || !str(r.name)) return null;
    const def = defs.find((d) => d.name === r.name);
    if (!def) return null;
    const at = num(r.time, 0) * rate;
    if (Math.abs(at - Math.round(at)) > 1e-6) return null;
    const own = eventValues(def);
    const key: EventKey = { frame: Math.round(at), name: def.name };
    if (typeof r.int === "number" && Math.trunc(r.int) !== own.int) key.int = Math.trunc(r.int);
    if (typeof r.float === "number" && r.float !== own.float) key.float = r.float;
    if (typeof r.string === "string" && r.string !== own.string) key.string = r.string;
    if (def.audio) {
      const volume = num(r.volume, own.volume), balance = num(r.balance, own.volume);
      if (volume !== own.volume) key.volume = volume;
      if (balance !== own.balance) key.balance = balance;
    }
    keys.push(key);
  }
  return keys;
}

/**
 * A Spine `ik` timeline as the document's keys, or null when it holds what
 * the editor does not key: a time off the frames, a compress or stretch
 * other than the constraint's own, or a curve whose mix and softness halves
 * are not one cubic. A softness equal to the constraint's is left off the
 * key. The bend is inverted, as `ikOf` does.
 */
function ikKeysOf(list: unknown[], k: IkConstraint, rate: number): IkKey[] | null {
  const setup = k.softness ?? 0, compress = k.spine?.compress === true, stretch = k.spine?.stretch === true;
  const keys: IkKey[] = [];
  /** One half of a Spine curve as the editor's cubic, from `v0` to `v1`;
   *  undefined when the value does not change (any cubic will do), null when
   *  a constant value is bent. */
  const half = (c: number[], at: number, t0: number, span: number, v0: number, v1: number): number[] | undefined | null => {
    const dv = v1 - v0;
    if (Math.abs(dv) > 1e-9) return [(c[at]! - t0) / span, (c[at + 1]! - v0) / dv, (c[at + 2]! - t0) / span, (c[at + 3]! - v0) / dv];
    return Math.abs(c[at + 1]! - v0) > 1e-6 || Math.abs(c[at + 3]! - v0) > 1e-6 ? null : undefined;
  };
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!obj(r)) return null;
    const at = num(r.time, 0) * rate;
    if (Math.abs(at - Math.round(at)) > 1e-6) return null;
    if ((r.compress === true) !== compress || (r.stretch === true) !== stretch) return null;
    const soft = Math.max(0, num(r.softness, 0));
    const key: IkKey = { frame: Math.round(at), mix: Math.min(1, Math.max(0, num(r.mix, 1))), bendPositive: r.bendPositive === false };
    if (Math.abs(soft - setup) > 1e-9) key.softness = soft;
    const next = list[i + 1];
    if (r.curve === "stepped") key.tween = { kind: "none" };
    else if (Array.isArray(r.curve) && obj(next)) {
      const c = r.curve.map((v) => num(v, 0));
      const t0 = num(r.time, 0), span = num(next.time, 0) - t0;
      if (span <= 0 || c.length < 8) return null;
      const m = half(c, 0, t0, span, key.mix, num(next.mix, 1));
      const sh = half(c, 4, t0, span, soft, Math.max(0, num(next.softness, 0)));
      if (m === null || sh === null) return null;
      if (m && sh && m.some((v, j) => Math.abs(v - sh[j]!) > 1e-4)) return null;
      const curve = m ?? sh;
      if (curve) key.tween = { kind: "curve", curve: curve.map((v) => v + 0) };
    }
    keys.push(key);
  }
  return keys.length && new Set(keys.map((x) => x.frame)).size === keys.length ? keys : null;
}

const TC_FIELDS = new Set([
  "type", "name", "bones", "source", "localSource", "localTarget", "additive", "clamp", "properties",
  "rotation", "x", "y", "scaleX", "scaleY", "shearY", "mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY",
]);
const TC_NAMES: readonly TcChannel[] = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"];
const isTcName = (v: string): v is TcChannel => (TC_NAMES as readonly string[]).includes(v);

/**
 * A Spine 4.3 transform constraint as the document's, or null when a bone
 * it names is not a bone of the file (then it is carried). Mixes as
 * `SkeletonJson` reads them: `mixY` defaults to `mixX`, `mixScaleY` to
 * `mixScaleX`, the rest to 1.
 */
function transformOf(c: BoneBurstRaw, bones: Map<string, Node>): TransformConstraint | null {
  const names = Array.isArray(c.bones) ? c.bones.map(String) : [];
  const source = str(c.source) ? bones.get(c.source) : undefined;
  const targets = names.map((n) => bones.get(n));
  if (!source || !targets.length || targets.some((b) => !b)) return null;
  const properties: TcFrom[] = [];
  for (const [from, rawFrom] of Object.entries(obj(c.properties) ? c.properties : {})) {
    if (!isTcName(from) || !obj(rawFrom)) return null;
    const to: TcTo[] = [];
    for (const [t, rawTo] of Object.entries(obj(rawFrom.to) ? rawFrom.to : {})) {
      if (!isTcName(t)) return null;
      const r = obj(rawTo) ? rawTo : {};
      to.push({ to: t, offset: num(r.offset, 0), max: num(r.max, 1), scale: num(r.scale, 1) });
    }
    if (to.length) properties.push({ from, offset: num(rawFrom.offset, 0), to });
  }
  const mixX = num(c.mixX, 1), mixScaleX = num(c.mixScaleX, 1);
  const tc: TransformConstraint = {
    id: newTcId(), name: String(c.name), boneIds: targets.map((b) => b!.id), sourceId: source.id,
    mix: { rotate: num(c.mixRotate, 1), x: mixX, y: num(c.mixY, mixX), scaleX: mixScaleX, scaleY: num(c.mixScaleY, mixScaleX), shearY: num(c.mixShearY, 1) },
    properties,
  };
  const offsets: Partial<Record<TcChannel, number>> = {};
  const offsetField: Record<TcChannel, string> = { rotate: "rotation", x: "x", y: "y", scaleX: "scaleX", scaleY: "scaleY", shearY: "shearY" };
  for (const ch of TC_NAMES) if (num(c[offsetField[ch]], 0)) offsets[ch] = num(c[offsetField[ch]], 0);
  if (Object.keys(offsets).length) tc.offsets = offsets;
  for (const f of ["localSource", "localTarget", "additive", "clamp"] as const) if (c[f] === true) tc[f] = true;
  const rest = pick(c, (k) => !TC_FIELDS.has(k));
  if (rest) tc.spine = rest;
  return tc;
}

/** A Spine `transform` timeline as the document's keys, or null when a key
 *  falls between frames or a curve's six halves are not one cubic. */
function transformKeysOf(list: unknown[], rate: number): TcKey[] | null {
  const keys: TcKey[] = [];
  const mixesOf = (r: BoneBurstRaw) => {
    const x = num(r.mixX, 1), sx = num(r.mixScaleX, 1);
    return { rotate: num(r.mixRotate, 1), x, y: num(r.mixY, x), scaleX: sx, scaleY: num(r.mixScaleY, 1), shearY: num(r.mixShearY, 1) };
  };
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!obj(r)) return null;
    const at = num(r.time, 0) * rate;
    if (Math.abs(at - Math.round(at)) > 1e-6) return null;
    const key: TcKey = { frame: Math.round(at), mix: mixesOf(r) };
    const next = list[i + 1];
    if (r.curve === "stepped") key.tween = { kind: "none" };
    else if (Array.isArray(r.curve) && obj(next)) {
      const c = r.curve.map((v) => num(v, 0));
      const t0 = num(r.time, 0), span = num(next.time, 0) - t0;
      if (span <= 0 || c.length < 24) return null;
      const to = mixesOf(next);
      let shape: number[] | null = null;
      for (const [n, ch] of TC_NAMES.entries()) {
        const v0 = key.mix[ch], dv = to[ch] - v0, at4 = n * 4;
        if (Math.abs(dv) <= 1e-9) {
          if (Math.abs(c[at4 + 1]! - v0) > 1e-6 || Math.abs(c[at4 + 3]! - v0) > 1e-6) return null;
          continue;
        }
        const h = [(c[at4]! - t0) / span, (c[at4 + 1]! - v0) / dv, (c[at4 + 2]! - t0) / span, (c[at4 + 3]! - v0) / dv].map((v) => v + 0);
        if (shape && shape.some((v, j) => Math.abs(v - h[j]!) > 1e-4)) return null;
        shape ??= h;
      }
      if (shape) key.tween = { kind: "curve", curve: shape };
    }
    keys.push(key);
  }
  return keys.length && new Set(keys.map((x) => x.frame)).size === keys.length ? keys : null;
}

function ikOf(c: BoneBurstRaw, bones: Map<string, Node>, warn: (m: string) => void): IkConstraint | null {
  const names = Array.isArray(c.bones) ? c.bones.map(String) : [];
  const chain = names.map((n) => bones.get(n));
  const target = str(c.target) ? bones.get(c.target) : undefined;
  if (!target || chain.length < 1 || chain.length > 2 || chain.some((b) => !b)) {
    warn(`IK "${String(c.name)}" does not name its bones as Spine 4.3 does; it is carried as it came.`);
    return null;
  }
  if (chain.length === 2 && chain[1]!.parentId !== chain[0]!.id) return null;
  const ik: IkConstraint = {
    id: newIkId(),
    name: String(c.name),
    boneId: chain[chain.length - 1]!.id,
    targetId: target.id,
    chain: chain.length === 2 ? 1 : 0,
    bendPositive: c.bendPositive === false,
    weight: num(c.mix, 1),
  };
  if (num(c.softness, 0) > 0) ik.softness = num(c.softness, 0);
  if (c.stretch === true) ik.stretch = true;
  if (c.compress === true) ik.compress = true;
  // The runtime reads any other scaleY as none.
  if (c.scaleY === "uniform" || c.scaleY === "volume") ik.scaleY = c.scaleY;
  const rest = pick(c, (k) => !IK_FIELDS.has(k));
  if (rest) ik.spine = rest;
  return ik;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** The image a default-skin or skin attachment shows as a display: a region,
 *  mesh or linked mesh drawing one region the atlas has, not a sequence. */
function displayItemOf(itemByRegion: Map<string, ImageItem>, att: BoneBurstRaw, key: string): ImageItem | undefined {
  if (att.sequence || !(att.type === undefined || att.type === "region" || att.type === "mesh" || att.type === "linkedmesh")) return undefined;
  const regions = regionsOf(att, key);
  return regions.length === 1 ? itemByRegion.get(regions[0]!) : undefined;
}

function pick(o: BoneBurstRaw, keep: (k: string) => boolean): BoneBurstRaw | null {
  const out: BoneBurstRaw = {};
  for (const [k, v] of Object.entries(o)) if (keep(k)) out[k] = v;
  return Object.keys(out).length ? out : null;
}

function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(b) * 1e-3);
}
