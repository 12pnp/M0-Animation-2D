import type { AssetId, NodeId } from "@/core/doc/ids";
import { fromOffsets } from "@/core/doc/drawOrder";
import { newAnimId, newIkId } from "@/core/doc/ids";
import type {
  Animation, BlendMode, DrawOrderKey, ColorTransform, DisplayRef, IkConstraint, IkKey, ImageItem, Keyframe, Layer, Node, Project,
  SpineAttachmentRef, SymbolItem, Track,
} from "@/core/doc/types";
import { isDefaultColor } from "@/core/doc/types";
import { createAnimation, createImageItem, createLayer, createNode, createProject } from "@/core/doc/defaults";
import { sampleColorRaw, sampleTransformRaw } from "@/core/doc/timeline";
import { IDENTITY, cloneTf, type Transform } from "@/core/math/Transform";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { bonesToNames, lastTime, regionsOf } from "./carry";
import { type ChannelGroup, type Comp, type CompKey, type KeyTiming, mergeKeys, valueAt } from "./importKeys";
import { fromSpineLocal, type SpineLocal } from "./transform";
import { SPINE_VERSION, type SpineInherit, type SpineRaw } from "./types";

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

export interface SpineImport {
  project: Project;
  diagnostics: ExportDiagnostic[];
  /** Intervals written frame by frame, because no ease of the editor's
   *  plays them as Spine does (see `importKeys.ts`). */
  baked: number;
}

const obj = (v: unknown): v is SpineRaw => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): v is string => typeof v === "string";

/** Only what the editor models is read off a bone; the rest rides along. */
const BONE_FIELDS = new Set(["name", "parent", "length", "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "inherit"]);
const SLOT_FIELDS = new Set(["name", "bone", "color", "dark", "attachment", "blend"]);
const IK_FIELDS = new Set(["type", "name", "bones", "target", "mix", "bendPositive", "softness"]);
const BLEND: Record<string, BlendMode> = { additive: "add", multiply: "multiply", screen: "screen" };
const INHERIT = new Set<SpineInherit>(["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"]);

export function importSpine(file: unknown, name: string, images: ReadonlyMap<string, AtlasImage>): SpineImport {
  const diagnostics: ExportDiagnostic[] = [];
  const warn = (message: string) => diagnostics.push({ severity: "warning", message });
  if (!obj(file) || !obj(file.skeleton) || !Array.isArray(file.bones)) {
    throw new Error("This is not a Spine skeleton JSON file (no skeleton header or bones).");
  }
  const header = file.skeleton;
  const version = str(header.spine) ? header.spine : "";
  if (version.split(".").slice(0, 2).join(".") !== SPINE_VERSION.split(".").slice(0, 2).join(".")) {
    throw new Error(
      `The file was exported by Spine ${version || "(unknown version)"}; only Spine ${SPINE_VERSION.split(".").slice(0, 2).join(".")} ` +
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

  /* ── bones ── */
  const bonesIn = file.bones.filter(obj);
  const boneNames = bonesIn.map((b) => String(b.name));
  const boneNode = new Map<string, Node>();
  const boneSetup = new Map<string, SpineLocal>();
  const shearKept = new Set<string>();
  const keysShear = (boneName: string) => Object.values(animsIn).some((a) => {
    const t = obj(a) && obj(a.bones) ? a.bones[boneName] : undefined;
    return obj(t) && SHEAR_TIMELINES.some((k) => k in t);
  });
  for (const b of bonesIn) {
    const boneName = String(b.name);
    const parent = str(b.parent) ? boneNode.get(b.parent) : undefined;
    if (str(b.parent) && !parent) warn(`Bone "${boneName}" names a parent "${b.parent}" that comes after it or does not exist; it is a root bone now.`);
    const setup: SpineLocal = {
      x: num(b.x, 0), y: num(b.y, 0), rotation: num(b.rotation, 0),
      shearX: num(b.shearX, 0), shearY: num(b.shearY, 0), scaleX: num(b.scaleX, 1), scaleY: num(b.scaleY, 1),
    };
    const node = createNode("bone", boneName, { parentId: parent?.id ?? null });
    node.boneLength = num(b.length, 0);
    if (str(b.inherit) && b.inherit !== "normal") {
      if (INHERIT.has(b.inherit as SpineInherit)) node.inherit = b.inherit as SpineInherit;
      else warn(`Bone "${boneName}": unknown inherit mode "${b.inherit}", read as normal.`);
    }
    const rest = pick(b, (k) => !BONE_FIELDS.has(k)) ?? {};
    // The editor's transform folds shear x into the rotation, which leaves
    // the local matrix exactly as it was. Under an inherit mode other than
    // normal Spine builds the parent's frame from the rotation alone and
    // shears after, so there the shear stays Spine's own, carried: its
    // setup values here, its keys with the animation.
    if (node.inherit && (setup.shearX || setup.shearY || keysShear(boneName))) {
      shearKept.add(boneName);
      if (setup.shearX) rest.shearX = setup.shearX;
      if (setup.shearY) rest.shearY = setup.shearY;
      setup.shearX = 0;
      setup.shearY = 0;
    }
    node.bind = fromSpineLocal(setup);
    if (Object.keys(rest).length) node.spine = { bone: rest };
    sym.nodes[node.id] = node;
    boneNode.set(boneName, node);
    boneSetup.set(boneName, setup);
  }

  /* ── skins: the default skin's regions and meshes become displays ── */
  const skinsIn = Array.isArray(file.skins) ? file.skins.filter(obj) : [];
  const defaultSkin = skinsIn.find((s) => s.name === "default");
  const carriedSkins: SpineRaw[] = [];
  const defaultAtts = obj(defaultSkin?.attachments) ? (defaultSkin!.attachments as Record<string, SpineRaw>) : {};
  const carriedDefault: Record<string, Record<string, SpineRaw>> = {};

  /* ── slots ── */
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
    // The setup attachment first: display 0 is what the bind pose shows.
    const keys = Object.keys(byKey).sort((p, q) => Number(q === setupName) - Number(p === setupName));
    for (const key of keys) {
      const att = byKey[key];
      if (!obj(att)) continue;
      const regions = regionsOf(att, key);
      const item = regions.length === 1 ? itemByRegion.get(regions[0]!) : undefined;
      const displayable = !att.sequence && item && (att.type === undefined || att.type === "region" || att.type === "mesh" || att.type === "linkedmesh");
      if (!displayable) {
        if (regions.length && regions.some((r) => !itemByRegion.has(r))) {
          warn(`"${slotName}" ▸ "${key}" draws ${regions.filter((r) => !itemByRegion.has(r)).map((r) => `"${r}"`).join(", ")}, which the atlas does not have.`);
        }
        (carriedDefault[slotName] ??= {})[key] = bonesToNames(att, boneNames);
        continue;
      }
      const ref: SpineAttachmentRef = { name: key, data: bonesToNames(att, boneNames) };
      displays.push({ itemId: item!.id, pivot: { x: item!.width / 2, y: item!.height / 2 }, attachment: ref });
    }
    if (displays.length) {
      node.itemId = displays[0]!.itemId;
      node.pivot = displays[0]!.pivot;
      node.attachment = displays[0]!.attachment;
      if (displays.length > 1) node.extraDisplays = displays.slice(1);
    }
    const setupIndex = setupName === null ? -1 : displays.findIndex((d) => d.attachment!.name === setupName);
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
  for (const skin of skinsIn) {
    if (skin === defaultSkin) continue;
    const atts: Record<string, Record<string, SpineRaw>> = {};
    for (const [slot, byKey] of Object.entries(obj(skin.attachments) ? skin.attachments : {})) {
      if (!obj(byKey)) continue;
      atts[slot] = Object.fromEntries(Object.entries(byKey).filter(([, a]) => obj(a)).map(([k, a]) => [k, bonesToNames(a as SpineRaw, boneNames)]));
    }
    carriedSkins.push({ ...skin, attachments: atts });
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
  const carriedConstraints: SpineRaw[] = [];
  for (const c of constraintsIn) {
    const ik = c.type === "ik" ? ikOf(c, boneNode, warn) : null;
    if (ik) sym.ik.push(ik);
    else carriedConstraints.push(c);
  }
  for (const legacy of ["ik", "transform", "path", "physics", "slider"]) {
    if (Array.isArray(file[legacy]) && file[legacy].length) {
      warn(`The file has a top-level "${legacy}" list, a layout from before Spine 4.3; those constraints were not read.`);
    }
  }

  sym.spine = {
    header: pick(header, (k) => k !== "spine" && k !== "fps") ?? {},
    constraints: carriedConstraints,
    constraintOrder: constraintsIn.map((c) => String(c.name)),
    skins: carriedSkins,
    ...(obj(file.events) ? { events: file.events } : {}),
  };

  /* ── animations ── */
  let baked = 0;
  for (const [animName, animRaw] of Object.entries(animsIn)) {
    if (!obj(animRaw)) continue;
    const end = toFrame(lastTime(animRaw));
    const anim: Animation = {
      id: newAnimId(), name: animName, duration: end + 1, playTimes: 0, tracks: {}, endsAtLastFrame: true,
    };
    const carried: SpineRaw = pick(animRaw, (k) => k !== "bones" && k !== "slots") ?? {};

    const bonesAnim = obj(animRaw.bones) ? animRaw.bones : {};
    for (const [boneName, timelines] of Object.entries(bonesAnim)) {
      const node = boneNode.get(boneName);
      if (!node || !obj(timelines)) { warn(`"${animName}" keys a bone "${boneName}" that does not exist; dropped.`); continue; }
      const setup = boneSetup.get(boneName)!;
      const { groups, rest } = boneComps(timelines, setup, rate, shearKept.has(boneName));
      if (rest) ((carried.bones ??= {}) as SpineRaw)[boneName] = rest;
      if (groups.length === 0) continue;
      const frameOf = (f: number): Transform => fromSpineLocal(boneLocalAt(groups, setup, f));
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
      if (rest) ((carried.slots ??= {}) as SpineRaw)[slotName] = rest;
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
    // IK keys become the document's (`Animation.ik`) per constraint when each
    // lands on a frame and changes only what the editor keys (the mix, the
    // bend); otherwise that constraint's timeline is carried as it came.
    if (obj(animRaw.ik)) {
      const rest: SpineRaw = {};
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
  if (baked) warn(`${baked} tween(s) were written frame by frame: no single ease of the editor's plays them as Spine does.`);
  return { project, diagnostics, baked };
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

type BoneValue = keyof SpineLocal;

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

interface BoneGroups extends ChannelGroup { values: BoneValue[] }

/** A bone's keyed values, grouped by the editor's tween channels. */
function boneComps(timelines: SpineRaw, setup: SpineLocal, rate: number, keepShear: boolean): { groups: BoneGroups[]; rest: SpineRaw | null } {
  const comps = new Map<BoneValue, Comp>();
  const rest: SpineRaw = {};
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
  // is skewY − skewX, shearY − shearX (`fromSpineLocal`).
  const groups = [
    group("position", ["x", "y"], 1e-6, [["x", ["x"]], ["y", ["y"]]]),
    group("rotation", ["rotation", "shearX", "shearY"], 1e-6, [["rotation", ["rotation", "shearX"]], ["shear", ["shearX", "shearY"]]]),
    group("scale", ["scaleX", "scaleY"], 1e-9, [["scaleX", ["scaleX"]], ["scaleY", ["scaleY"]]]),
  ].filter((g): g is BoneGroups => !!g);
  return { groups, rest: Object.keys(rest).length ? rest : null };
}

/** The bone's local pose at a frame: its keyed values, the setup pose for
 *  the rest. */
function boneLocalAt(groups: BoneGroups[], setup: SpineLocal, f: number): SpineLocal {
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
  keys: SpineRaw[], rate: number, index: number,
  value: (k: SpineRaw) => number, abs: (v: number) => number, setup: number,
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

function slotSetup(s: SpineRaw): Rgba2 {
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
const COLOR_TIMELINES: Record<string, Array<{ ch: typeof CHANNELS[number]; read: (k: SpineRaw) => number }>> = {
  rgba: (["r", "g", "b", "a"] as const).map((ch, i) => ({ ch, read: (k: SpineRaw) => hexColor(k.color, [1, 1, 1, 1])[i]! })),
  rgb: (["r", "g", "b"] as const).map((ch, i) => ({ ch, read: (k: SpineRaw) => hexColor(k.color, [1, 1, 1])[i]! })),
  alpha: [{ ch: "a", read: (k: SpineRaw) => num(k.value, 1) }],
  rgba2: [
    ...(["r", "g", "b", "a"] as const).map((ch, i) => ({ ch, read: (k: SpineRaw) => hexColor(k.light, [1, 1, 1, 1])[i]! })),
    ...(["dr", "dg", "db"] as const).map((ch, i) => ({ ch, read: (k: SpineRaw) => hexColor(k.dark, [0, 0, 0])[i]! })),
  ],
  rgb2: [
    ...(["r", "g", "b"] as const).map((ch, i) => ({ ch, read: (k: SpineRaw) => hexColor(k.light, [1, 1, 1])[i]! })),
    ...(["dr", "dg", "db"] as const).map((ch, i) => ({ ch, read: (k: SpineRaw) => hexColor(k.dark, [0, 0, 0])[i]! })),
  ],
};

type ColorGroup = ChannelGroup & { chans: Array<typeof CHANNELS[number]>; setup: Rgba2 };

function colorComps(timelines: SpineRaw, setup: Rgba2, rate: number): { group: ColorGroup | null; rest: SpineRaw | null } {
  const comps = new Map<typeof CHANNELS[number], Comp>();
  const rest: SpineRaw = {};
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
  if (node.attachment) out.push(node.attachment.name);
  for (const d of node.extraDisplays ?? []) out.push(d.attachment?.name ?? "");
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

function ikOf(c: SpineRaw, bones: Map<string, Node>, warn: (m: string) => void): IkConstraint | null {
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
  const rest = pick(c, (k) => !IK_FIELDS.has(k));
  if (rest) ik.spine = rest;
  return ik;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function pick(o: SpineRaw, keep: (k: string) => boolean): SpineRaw | null {
  const out: SpineRaw = {};
  for (const [k, v] of Object.entries(o)) if (keep(k)) out[k] = v;
  return Object.keys(out).length ? out : null;
}

function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(b) * 1e-3);
}
