import { CONSTRAINT_CHANNELS, bakedChannelKeys, channelKeysFromBoneBurst, withChannelKeys } from "@/core/doc/constraintKeys";
import { editableMeshes, tintOf } from "./importEditable";
import { type Outline, outlineOf, sequenceDisplayOf } from "./importAttachments";
import { bakedSequenceKeys, SEQUENCE_MODES } from "@/core/doc/sequence";
import type { AssetId, CnId, IkId, NodeId, TcId } from "@/core/doc/ids";
import { eventDefsFromBoneBurst } from "@/core/doc/events";
import { newCnId } from "@/core/doc/ids";
import type { BlendMode, SequenceKey, DisplayRef, ImageItem, Layer, Node, Project, SkinDef, BoneBurstAttachmentRef, SymbolItem } from "@/core/doc/types";
import { isDefaultColor } from "@/core/doc/types";
import { createAnimation, createImageItem, createLayer, createNode, createProject } from "@/core/doc/defaults";
import { matrixOf } from "@/core/math/Transform";
import { mat, mul, type Matrix2D } from "@/core/math/Matrix2D";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { bonesToNames, regionsOf, SKIN_CONSTRAINT_KINDS } from "./carry";
import { PATH_FIELDS, pathFromBoneBurst, PHYSICS_FIELDS, physicsFromBoneBurst, SLIDER_FIELDS, sliderFromBoneBurst } from "@/core/doc/constraints";
import { frameOf, SHEAR_TIMELINES, slotColor } from "./importKeys";
import { fromBoneBurstLocal, type BoneBurstLocal } from "./transform";
import { BONEBURST_VERSION, type BoneBurstInherit, type BoneBurstRaw } from "./types";
import { obj, str, num, displayNames, pick } from "./importRead";
import { ikOf, localSourceBones, transformOf } from "./importConstraints";
import { type AnimationImport, importAnimation } from "./importAnimation";

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

/** Only what the editor models is read off a bone; the rest rides along. */
const BONE_FIELDS = new Set(["name", "parent", "length", "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "inherit", "color", "icon"]);
const SLOT_FIELDS = new Set(["name", "bone", "color", "dark", "attachment", "blend"]);
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
  const ctx: AnimationImport = { sym, rate, toFrame, switchFrame, boneNode, boneSetup, shearKept, slotNode, slotsIn, warn };
  for (const [animName, animRaw] of Object.entries(animsIn)) {
    if (!obj(animRaw)) continue;
    const made = importAnimation(ctx, animName, animRaw);
    baked += made.baked;
    sym.animations.push(made.anim);
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

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** The image a default-skin or skin attachment shows as a display: a region,
 *  mesh or linked mesh drawing one region the atlas has, not a sequence. */
function displayItemOf(itemByRegion: Map<string, ImageItem>, att: BoneBurstRaw, key: string): ImageItem | undefined {
  if (att.sequence || !(att.type === undefined || att.type === "region" || att.type === "mesh" || att.type === "linkedmesh")) return undefined;
  const regions = regionsOf(att, key);
  return regions.length === 1 ? itemByRegion.get(regions[0]!) : undefined;
}

