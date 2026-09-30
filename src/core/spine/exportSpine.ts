import type { ColorTransform, DisplayRef, Keyframe, Layer, Node, Project, SymbolItem, Track } from "@/core/doc/types";
import { DEFAULT_COLOR, isImage, isSymbol, producesSlot } from "@/core/doc/types";
import type { ItemId, NodeId } from "@/core/doc/ids";
import { descendantsOf } from "@/core/doc/layerTree";
import { displaysOf } from "@/core/doc/displays";
import { rotationDelta, sampleColorRaw, sampleTransformRaw } from "@/core/doc/timeline";
import type { Transform } from "@/core/math/Transform";
import { type EaseSegment, easeOf, easeSegments, type TweenChannel, type TweenSpec } from "@/core/math/easing";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { isAtlasName } from "./atlas";
import { keyTime, keyValues, regionCentre, type SpineKeyValues, type SpineLocal, toSpineLocal } from "./transform";
import {
  SPINE_VERSION,
  type SpineAnimation,
  type SpineAttachmentKey,
  type SpineBlendMode,
  type SpineBone,
  type SpineBoneTimelines,
  type SpineCurve,
  type SpineIkConstraint,
  type SpineRegionAttachment,
  type SpineRgbaKey,
  type SpineSkeletonFile,
  type SpineSlot,
  type SpineSlotTimelines,
} from "./types";

export interface SpineExport {
  skeleton: SpineSkeletonFile;
  diagnostics: ExportDiagnostic[];
  /** Library images the skeleton draws, so the atlas packs only those. */
  usedImages: ItemId[];
  /** Each exported node's bone name, which is also its slot's name. */
  names: Map<NodeId, string>;
}

/** The bone every top-level node hangs from. Spine does not require one,
 *  but spine-unity's tooling and most game code assume it. */
export const ROOT_BONE = "root";

/**
 * One symbol as a Spine 4.3 skeleton: the scene for File ▸ Export, the
 * symbol being edited for the preview.
 *
 * Every node is a bone; every image layer is also a slot on its own bone,
 * named like it. Values are the stage's own: keys come from
 * `sampleTransformRaw` / `sampleColorRaw`, the functions the stage draws
 * with, so the two cannot disagree at a whole frame. A hold is a stepped
 * key, a linear tween one linear key, and an eased interval a linear key on
 * every frame (exact at every frame whatever the ease; Spine curves are a
 * later refinement).
 *
 * Not yet carried, each said out loud: nested symbol instances (phase 5),
 * mask layers and colour offsets (phase 6).
 */
export function exportSpine(project: Project, symbolId: ItemId = project.rootSymbolId): SpineExport {
  const diagnostics: ExportDiagnostic[] = [];
  const usedImages = new Set<ItemId>();
  const sym = project.items[symbolId];
  if (!isSymbol(sym)) {
    diagnostics.push({ severity: "error", message: "There is no symbol to export." });
    return { skeleton: { skeleton: { spine: SPINE_VERSION }, bones: [] }, diagnostics, usedImages: [], names: new Map() };
  }

  const fps = project.frameRate;
  const names = uniqueNames(sym, diagnostics);
  const skipped = excludedNodes(sym);
  reportExcluded(sym, skipped, diagnostics);

  // A skipped node that still has a KEPT descendant keeps its bone — never a
  // slot — or the descendant would reparent to the root and move.
  const boneOnly = new Set<NodeId>();
  for (const node of Object.values(sym.nodes)) {
    if (skipped.has(node.id)) continue;
    for (let p = node.parentId; p; p = sym.nodes[p]?.parentId ?? null) {
      if (skipped.has(p)) boneOnly.add(p);
    }
  }
  const dropped = (id: NodeId): boolean => skipped.has(id) && !boneOnly.has(id);

  const maskLayers = sym.layers.filter((l) => l.isMask && !skipped.has(l.nodeId));
  reportMasks(sym, maskLayers, diagnostics);
  const noSlot = new Set<NodeId>(maskLayers.map((l) => l.nodeId));

  // Only the DragonBones runtime extension ever drew it; nothing does now.
  if (project.motionBlur?.enabled) {
    diagnostics.push({
      severity: "warning",
      message: "Motion blur is on for this document, but the Spine export does not carry it: nothing will draw it.",
    });
  }

  const nested = Object.values(sym.nodes).filter((n) => n.kind === "symbol" && !skipped.has(n.id));
  if (nested.length) {
    diagnostics.push({
      severity: "warning",
      message:
        `"${sym.name}" contains symbol instances (${nested.map((n) => `"${n.name}"`).join(", ")}), ` +
        "which the Spine export does not carry yet: they are left out of the file and the Preview.",
    });
  }

  /* ── bones ── */
  const bones: SpineBone[] = [{ name: ROOT_BONE }];
  const setups = new Map<NodeId, SpineLocal>();
  const ignoredInherit: string[] = [];
  for (const node of nodesInHierarchyOrder(sym)) {
    if (dropped(node.id)) continue;
    const setup = toSpineLocal(node.bind);
    setups.set(node.id, setup);
    const parent = node.parentId && !dropped(node.parentId) ? names.get(node.parentId)! : ROOT_BONE;
    const bone: SpineBone = { name: names.get(node.id)!, parent, ...withoutDefaults(setup) };
    if (node.kind === "bone" && node.boneLength) bone.length = node.boneLength;
    if (node.inheritRotation === false || node.inheritScale === false) ignoredInherit.push(node.name);
    bones.push(bone);
  }
  if (ignoredInherit.length) {
    diagnostics.push({
      severity: "warning",
      message:
        `${ignoredInherit.map((n) => `"${n}"`).join(", ")} ${ignoredInherit.length === 1 ? "has" : "have"} ` +
        "inheritance switched off in the file. The stage always inherits, so the export does too.",
    });
  }

  /* ── slots, skin ── */
  const slots: SpineSlot[] = [];
  const attachments: Record<string, Record<string, SpineRegionAttachment>> = {};
  // Per slot node: a key's displayIndex → attachment key (absent: hidden).
  const slotDisplays = new Map<NodeId, Map<number, string>>();
  const offsetWarned = new Set<NodeId>();

  // layers[0] is the TOP layer; Spine draws slot 0 first, at the back.
  const drawOrder: Layer[] = [...sym.layers].reverse();
  for (const layer of drawOrder) {
    const node = sym.nodes[layer.nodeId];
    if (!node || !producesSlot(node) || skipped.has(node.id) || noSlot.has(node.id)) continue;
    if (node.kind === "symbol") continue;          // reported above
    const name = names.get(node.id)!;

    const exported = exportedDisplays(sym, node);
    const keys = new Map<number, string>();
    const slotAttachments: Record<string, SpineRegionAttachment> = {};
    const taken = new Set<string>();
    for (const [index, ref] of exported) {
      const item = project.items[ref.itemId];
      if (isSymbol(item)) {
        diagnostics.push({
          severity: "warning",
          message: `"${node.name}" switches to the symbol "${item.name}" at some keys; symbols are not exported yet, so it shows nothing there.`,
        });
        continue;
      }
      if (!isImage(item)) {
        diagnostics.push({ severity: "warning", message: `"${node.name}" points at a library item that no longer exists.` });
        continue;
      }
      usedImages.add(item.id);
      let key = item.name;
      for (let n = 2; taken.has(key); n++) key = `${item.name} (${n})`;
      taken.add(key);
      keys.set(index, key);
      const centre = regionCentre(item.width, item.height, ref.pivot);
      const region: SpineRegionAttachment = { width: item.width, height: item.height };
      if (key !== item.name) region.path = item.name;
      if (centre.x !== 0) region.x = centre.x;
      if (centre.y !== 0) region.y = centre.y;
      slotAttachments[key] = region;
    }
    slotDisplays.set(node.id, keys);
    if (Object.keys(slotAttachments).length) attachments[name] = slotAttachments;

    const slot: SpineSlot = { name, bone: name };
    const setupColor = colorHex(node.color);
    if (setupColor) slot.color = setupColor;
    if (hasOffsets(node.color)) warnOffsets(node, offsetWarned, diagnostics);
    const blend = blendOf(node, diagnostics);
    if (blend) slot.blend = blend;
    const shown = keys.get(0);
    if (shown) slot.attachment = shown;
    slots.push(slot);
  }

  /* ── IK ── */
  const constraints: SpineIkConstraint[] = [];
  for (const k of sym.ik) {
    const effector = dropped(k.boneId) ? undefined : sym.nodes[k.boneId];
    const target = dropped(k.targetId) ? undefined : sym.nodes[k.targetId];
    if (!effector || !target) {
      diagnostics.push({ severity: "warning", message: `IK "${k.name}" references a missing bone; skipped.` });
      continue;
    }
    // The stage's rule (the runtime's, in DragonBones): a chain of 1 on a
    // bone with a parent is the two-bone solve rooted at that parent.
    const parent = effector.parentId && !dropped(effector.parentId) ? effector.parentId : null;
    const chain = k.chain > 0 && parent ? [names.get(parent)!, names.get(effector.id)!] : [names.get(effector.id)!];
    const ik: SpineIkConstraint = { type: "ik", name: k.name, bones: chain, target: names.get(target.id)! };
    if (k.weight !== 1) ik.mix = k.weight;
    // The y flip mirrors the rig, and a mirrored two-bone chain bends the
    // other way: the editor's positive bend (y down) is Spine's negative
    // (y up). Written as keyed, every chain bent backwards in the runtime.
    if (k.bendPositive) ik.bendPositive = false;
    constraints.push(ik);
  }

  /* ── animations ── */
  const animations: Record<string, SpineAnimation> = {};
  for (const anim of sym.animations) {
    const out: SpineAnimation = {};
    let lastFrame = 0;
    for (const node of Object.values(sym.nodes)) {
      const track = anim.tracks[node.id];
      if (!track || track.keys.length === 0 || dropped(node.id)) continue;
      const name = names.get(node.id)!;

      const bt = boneTimelines(track, setups.get(node.id)!, fps, node, diagnostics);
      if (bt) {
        (out.bones ??= {})[name] = bt.timelines;
        lastFrame = Math.max(lastFrame, bt.lastFrame);
      }
      const displays = slotDisplays.get(node.id);
      if (displays) {
        const st = slotTimelines(track, anim.duration, displays, node, fps, offsetWarned, diagnostics);
        if (st) {
          (out.slots ??= {})[name] = st.timelines;
          lastFrame = Math.max(lastFrame, st.lastFrame);
        }
      }
    }
    // Spine has no length field: the animation ends at its last key. A key
    // at the end holds it open; an unchanged draw order is the one timeline
    // that key cannot affect.
    if (anim.duration > lastFrame) out.drawOrder = [{ time: keyTime(anim.duration, fps) }];
    if (animations[anim.name]) {
      diagnostics.push({ severity: "error", message: `Two animations in "${sym.name}" are called "${anim.name}".` });
    }
    animations[anim.name] = out;
  }

  reportImageNames(project, [...usedImages], diagnostics);

  const skeleton: SpineSkeletonFile = {
    skeleton: { spine: SPINE_VERSION, fps },
    bones,
  };
  if (slots.length) skeleton.slots = slots;
  if (constraints.length) skeleton.constraints = constraints;
  skeleton.skins = [{ name: "default", attachments }];
  if (Object.keys(animations).length) skeleton.animations = animations;
  const exportedNames = new Map([...names].filter(([id]) => !dropped(id)));
  return { skeleton, diagnostics, usedImages: [...usedImages], names: exportedNames };
}

/* ── bone timelines ──────────────────────────────────────────────────────── */

/**
 * The bezier leaving a key, as Spine takes it: the segment's control points
 * in the INTERVAL's 0..1 space, and the interval's two ends, so each
 * channel's control values follow from its values there (timelines are
 * linear in their values, so this is exact).
 */
interface RowCurve { seg: EaseSegment; frame0: number; span: number }
type Row<T> = { frame: number; t: T; stepped: boolean; curve?: RowCurve & { from: T; to: T } };

/**
 * The keys an interval needs, per channel ease: a hold one stepped key, a
 * linear tween one key, an ease or custom curve one key per bezier segment
 * carrying its curve, and a preset (no cubic holds it) one key per frame of
 * the stage's own values. `at(f)` is the stage's value at frame f,
 * `lerp(a, b, s)` a value part way (a segment starting inside the interval).
 */
function intervalRows<T>(
  frame0: number, next: number, from: T, to: T, ease: TweenSpec,
  at: (f: number) => T, lerp: (a: T, b: T, s: number) => T,
): Row<T>[] {
  if (ease.kind === "none") return [{ frame: frame0, t: from, stepped: true }];
  if (ease.kind === "linear") return [{ frame: frame0, t: from, stepped: false }];
  const span = next - frame0;
  const segs = easeSegments(ease);
  if (!segs) {
    return Array.from({ length: span }, (_, i) => ({ frame: frame0 + i, t: at(frame0 + i), stepped: false }));
  }
  return segs.map((seg) => ({
    frame: frame0 + seg.x0 * span,
    t: seg.y0 === 0 ? from : lerp(from, to, seg.y0),
    stepped: false,
    curve: { seg, frame0, span, from, to },
  }));
}

/**
 * The keys a channel needs, with angles unwrapped across keys so direction
 * and extra turns survive (the stage restarts each interval from the keyed
 * angle, a whole number of turns away: the same matrix, but Spine
 * interpolates the numbers).
 */
function channelRows(track: Track, bind: Transform, channel: TweenChannel): Row<Transform>[] {
  const keys = track.keys;
  const turn: number[] = [0];
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1]!, k = keys[i]!;
    const unwrapped = prev.transform.skewY + turn[i - 1]! + rotationDelta(prev, k);
    turn.push(unwrapped - k.transform.skewY);
  }
  const shifted = (t: Transform, by: number): Transform =>
    by === 0 ? t : { ...t, skewX: t.skewX + by, skewY: t.skewY + by };

  const rows: Row<Transform>[] = [];
  // Before its first key the stage composes the node at its bind pose.
  if (keys[0]!.frame > 0) rows.push({ frame: 0, t: bind, stepped: true });
  keys.forEach((k, i) => {
    const next = keys[i + 1];
    const t = shifted(k.transform, turn[i]!);
    if (!next) { rows.push({ frame: k.frame, t, stepped: false }); return; }
    rows.push(...intervalRows(
      k.frame, next.frame, t, shifted(next.transform, turn[i + 1]!), easeOf(k, channel),
      (f) => shifted(sampleTransformRaw(track, f)!, turn[i]!), lerpTransform,
    ));
  });
  return rows;
}

function lerpTransform(a: Transform, b: Transform, s: number): Transform {
  const l = (p: number, q: number) => p + (q - p) * s;
  return {
    x: l(a.x, b.x), y: l(a.y, b.y), skewX: l(a.skewX, b.skewX), skewY: l(a.skewY, b.skewY),
    scaleX: l(a.scaleX, b.scaleX), scaleY: l(a.scaleY, b.scaleY),
  };
}

/**
 * A key's time and curve. `channels` gives the timeline's values, in its
 * order, for any row value; a bezier's control values are those at the
 * interval's ends, mixed by the control's y.
 */
function keyBase<T>(r: Row<T>, fps: number, channels: (t: T) => number[]): { time?: number; curve?: SpineCurve } {
  const k: { time?: number; curve?: SpineCurve } = {};
  if (r.frame !== 0) k.time = keyTime(r.frame, fps);
  if (r.stepped) k.curve = "stepped";
  else if (r.curve) {
    const { seg, frame0, span, from, to } = r.curve;
    const a = channels(from), b = channels(to);
    const t1 = (frame0 + seg.c1x * span) / fps, t2 = (frame0 + seg.c2x * span) / fps;
    k.curve = a.flatMap((v, i) => [t1, v + (b[i]! - v) * seg.c1y, t2, v + (b[i]! - v) * seg.c2y]);
  }
  return k;
}

function boneTimelines(
  track: Track, setup: SpineLocal, fps: number, node: Node, diags: ExportDiagnostic[],
): { timelines: SpineBoneTimelines; lastFrame: number } | null {
  const out: SpineBoneTimelines = {};
  let lastFrame = 0;
  const kv = (t: Transform) => keyValues(toSpineLocal(t), setup);
  const values = (rows: Row<Transform>[]) => rows.map((r) => ({ r, v: kv(r.t) }));
  const base = (r: Row<Transform>, channels: (v: SpineKeyValues) => number[]) => {
    lastFrame = Math.max(lastFrame, r.frame);
    return keyBase(r, fps, (t) => channels(kv(t)));
  };
  const moves = (vs: Array<{ v: SpineKeyValues }>, pick: (v: SpineKeyValues) => number[], rest: number) =>
    vs.some(({ v }) => pick(v).some((x) => Math.abs(x - rest) > 1e-9));

  const pos = values(channelRows(track, node.bind, "position"));
  if (moves(pos, (v) => [v.x, v.y], 0)) {
    out.translate = pos.map(({ r, v }) => ({ ...base(r, (w) => [w.x, w.y]), ...nonZero({ x: v.x, y: v.y }) }));
  }

  const rot = values(channelRows(track, node.bind, "rotation"));
  if (moves(rot, (v) => [v.rotate], 0)) {
    out.rotate = rot.map(({ r, v }) => ({ ...base(r, (w) => [w.rotate]), ...nonZero({ value: v.rotate }) }));
  }
  if (moves(rot, (v) => [v.shearX, v.shearY], 0)) {
    out.shear = rot.map(({ r, v }) => ({ ...base(r, (w) => [w.shearX, w.shearY]), ...nonZero({ x: v.shearX, y: v.shearY }) }));
  }

  const scl = values(channelRows(track, node.bind, "scale"));
  if (scl.some(({ v }) => v.scaleX === null || v.scaleY === null)) {
    diags.push({
      severity: "error",
      message: `"${node.name}" is keyed away from a setup scale of 0, which Spine cannot animate (its scale keys multiply the setup scale).`,
    });
  } else if (moves(scl, (v) => [v.scaleX!, v.scaleY!], 1)) {
    out.scale = scl.map(({ r, v }) => {
      const k: { time?: number; curve?: SpineCurve; x?: number; y?: number } = base(r, (w) => [w.scaleX!, w.scaleY!]);
      if (v.scaleX !== 1) k.x = v.scaleX!;
      if (v.scaleY !== 1) k.y = v.scaleY!;
      return k;
    });
  }

  return Object.keys(out).length ? { timelines: out, lastFrame } : null;
}

/* ── slot timelines ──────────────────────────────────────────────────────── */

function slotTimelines(
  track: Track, duration: number, displays: Map<number, string>, node: Node, fps: number,
  offsetWarned: Set<NodeId>, diags: ExportDiagnostic[],
): { timelines: SpineSlotTimelines; lastFrame: number } | null {
  const keys = track.keys;
  const out: SpineSlotTimelines = {};
  let lastFrame = 0;
  const time = (frame: number) => {
    lastFrame = Math.max(lastFrame, frame);
    return frame === 0 ? {} : { time: keyTime(frame, fps) };
  };

  // Outside its span the stage shows nothing (`localAt`): before the first
  // key, and after `endFrame`.
  const startsLate = keys[0]!.frame > 0;
  const endsEarly = track.endFrame + 1 < duration;
  const shows = (k: Keyframe): string | null => (k.displayIndex < 0 ? null : displays.get(k.displayIndex) ?? null);
  if (startsLate || endsEarly || keys.some((k) => shows(k) !== displays.get(0))) {
    const rows: SpineAttachmentKey[] = [];
    if (startsLate) rows.push({ ...time(0), name: null });
    for (const k of keys) rows.push({ ...time(k.frame), name: shows(k) });
    if (endsEarly) rows.push({ ...time(track.endFrame + 1), name: null });
    out.attachment = rows;
  }

  // An AUTHORED colour anywhere means the timeline governs, even a neutral
  // one (the rule `sampleColorRaw` applies on the stage).
  if (keys.some((k) => k.color !== undefined)) {
    if (!offsetWarned.has(node.id) && keys.some((k) => hasOffsets(k.color))) warnOffsets(node, offsetWarned, diags);
    // The runtime's frame colours are the 8-bit ones the file holds, so a
    // curve's control values are mixed from those.
    const channels = (c: ColorTransform) => [c.rM, c.gM, c.bM, c.aM].map((m) => Math.max(0, Math.min(255, Math.round((m / 100) * 255))) / 255);
    const rows: Row<ColorTransform>[] = [];
    if (startsLate) rows.push({ frame: 0, t: node.color ?? DEFAULT_COLOR, stepped: true });
    keys.forEach((k, i) => {
      const next = keys[i + 1];
      const c = k.color ?? DEFAULT_COLOR;
      if (!next) { rows.push({ frame: k.frame, t: c, stepped: false }); return; }
      rows.push(...intervalRows(
        k.frame, next.frame, c, next.color ?? DEFAULT_COLOR, easeOf(k, "color"),
        (f) => sampleColorRaw(track, f)!, lerpColor,
      ));
    });
    lastFrame = Math.max(lastFrame, ...rows.map((r) => r.frame));
    out.rgba = rows.map((r): SpineRgbaKey => ({ ...keyBase(r, fps, channels), color: colorHex(r.t) ?? "ffffffff" }));
  }

  return Object.keys(out).length ? { timelines: out, lastFrame } : null;
}

function lerpColor(a: ColorTransform, b: ColorTransform, s: number): ColorTransform {
  const l = (p: number, q: number) => p + (q - p) * s;
  return {
    rM: l(a.rM, b.rM), gM: l(a.gM, b.gM), bM: l(a.bM, b.bM), aM: l(a.aM, b.aM),
    rO: l(a.rO, b.rO), gO: l(a.gO, b.gO), bO: l(a.bO, b.bO), aO: l(a.aO, b.aO),
  };
}

/* ── colour and blend ────────────────────────────────────────────────────── */

/**
 * The multipliers as "rrggbbaa", or undefined when neutral. The runtime's
 * slot colour multiplies the texture exactly as the stage's multipliers do,
 * quantised to 8 bits per channel by the format.
 */
export function colorHex(c: ColorTransform | undefined): string | undefined {
  if (!c) return undefined;
  const ch = (m: number) => Math.max(0, Math.min(255, Math.round((m / 100) * 255))).toString(16).padStart(2, "0");
  const hex = ch(c.rM) + ch(c.gM) + ch(c.bM) + ch(c.aM);
  return hex === "ffffffff" ? undefined : hex;
}

function hasOffsets(c: ColorTransform | undefined): boolean {
  return !!c && (c.aO !== 0 || c.rO !== 0 || c.gO !== 0 || c.bO !== 0);
}

function warnOffsets(node: Node, warned: Set<NodeId>, diags: ExportDiagnostic[]): void {
  if (warned.has(node.id)) return;
  warned.add(node.id);
  diags.push({
    severity: "warning",
    message: `"${node.name}" uses colour offsets, which the Spine export does not carry yet: only the multipliers reach the file.`,
  });
}

const BLEND: Partial<Record<NonNullable<Node["blendMode"]>, SpineBlendMode>> = {
  add: "additive", multiply: "multiply", screen: "screen",
};

function blendOf(node: Node, diags: ExportDiagnostic[]): SpineBlendMode | undefined {
  const mode = node.blendMode;
  if (!mode || mode === "normal") return undefined;
  const mapped = BLEND[mode];
  if (!mapped) {
    diags.push({
      severity: "warning",
      message: `"${node.name}" uses the blend mode "${mode}", which Spine does not have (only normal, add, multiply and screen): it exports as normal.`,
    });
  }
  return mapped;
}

/* ── structure ───────────────────────────────────────────────────────────── */

/**
 * Display 0 always (the setup pose shows it), and the extra displays some
 * key still uses, by their index in the node's display list.
 */
function exportedDisplays(sym: SymbolItem, node: Node): Array<[number, DisplayRef]> {
  const all = displaysOf(node);
  const used = new Set<number>([0]);
  for (const anim of sym.animations) {
    for (const k of anim.tracks[node.id]?.keys ?? []) {
      if (k.displayIndex > 0 && k.displayIndex < all.length) used.add(k.displayIndex);
    }
  }
  return [...used].sort((a, b) => a - b).filter((i) => all[i]).map((i) => [i, all[i]!]);
}

/**
 * Nodes that never reach the file: excluded layers with their whole
 * subtree (a child left behind would reparent to the root and move), and
 * the "empty" placeholders that hold empty layers open.
 */
function excludedNodes(sym: SymbolItem): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const layer of sym.layers) {
    if (!layer.excludeFromExport) continue;
    out.add(layer.nodeId);
    for (const id of descendantsOf(sym, layer.nodeId)) out.add(id);
  }
  for (const node of Object.values(sym.nodes)) if (node.kind === "empty") out.add(node.id);
  return out;
}

function reportExcluded(sym: SymbolItem, skipped: Set<NodeId>, diags: ExportDiagnostic[]): void {
  const named = sym.layers.filter((l) => l.excludeFromExport && skipped.has(l.nodeId));
  if (named.length === 0) return;
  diags.push({
    severity: "warning",
    message:
      `Excluded from "${sym.name}": ${named.map((l) => `"${l.name}"`).join(", ")}. Marked "Exclude from Export", ` +
      `so ${named.length === 1 ? "it is" : "they are"} left out of the exported files and the Preview.`,
  });
}

function reportMasks(sym: SymbolItem, masks: Layer[], diags: ExportDiagnostic[]): void {
  if (masks.length === 0) return;
  diags.push({
    severity: "warning",
    message:
      `"${sym.name}" has mask layers (${masks.map((l) => `"${l.name}"`).join(", ")}), which the Spine export ` +
      "does not carry yet: the mask artwork is left out and the layers it clips draw unclipped.",
  });
}

/**
 * The runtime finds atlas regions by name, so two images with one name
 * would both draw the first's pixels; and the atlas is line based.
 */
function reportImageNames(project: Project, ids: ItemId[], diags: ExportDiagnostic[]): void {
  const count = new Map<string, number>();
  for (const id of ids) {
    const name = project.items[id]!.name;
    count.set(name, (count.get(name) ?? 0) + 1);
    if (!isAtlasName(name)) {
      diags.push({
        severity: "error",
        message: `The image name ${JSON.stringify(name)} cannot go in a Spine atlas: remove leading or trailing spaces and line breaks.`,
      });
    }
  }
  for (const [name, n] of count) {
    if (n < 2) continue;
    diags.push({
      severity: "error",
      message: `${n} images in the library are called "${name}". Spine finds each texture by name, so all but one would show the wrong one. Give them different names.`,
    });
  }
}

/** Parents before children: the parser silently roots a bone whose parent
 *  comes later. Layer order first, so siblings keep a stable order. */
function nodesInHierarchyOrder(sym: SymbolItem): Node[] {
  const out: Node[] = [];
  const emitted = new Set<NodeId>();
  const emit = (node: Node, depth: number): void => {
    if (emitted.has(node.id) || depth > 64) return;
    if (node.parentId) {
      const parent = sym.nodes[node.parentId];
      if (parent && !emitted.has(parent.id)) emit(parent, depth + 1);
    }
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    out.push(node);
  };
  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (node) emit(node, 0);
  }
  for (const node of Object.values(sym.nodes)) emit(node, 0);
  return out;
}

/** Bones and slots are found by name, so names are unique; "root" is taken. */
function uniqueNames(sym: SymbolItem, diags: ExportDiagnostic[]): Map<NodeId, string> {
  const map = new Map<NodeId, string>();
  const taken = new Set<string>([ROOT_BONE]);
  const assign = (node: Node): void => {
    let name = node.name.trim() || node.kind;
    if (taken.has(name)) {
      const original = name;
      for (let i = 2; taken.has(name); i++) name = `${original}_${i}`;
      diags.push({
        severity: "warning",
        message: original === ROOT_BONE
          ? `"${ROOT_BONE}" is the name of the skeleton's root bone in Spine; exported "${node.name}" in "${sym.name}" as "${name}".`
          : `Two objects in "${sym.name}" are called "${original}"; exported the second as "${name}".`,
      });
    }
    taken.add(name);
    map.set(node.id, name);
  };
  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (node) assign(node);
  }
  for (const node of Object.values(sym.nodes)) if (!map.has(node.id)) assign(node);
  return map;
}

function withoutDefaults(s: SpineLocal): Partial<SpineLocal> {
  const out: Partial<SpineLocal> = {};
  if (s.x !== 0) out.x = s.x;
  if (s.y !== 0) out.y = s.y;
  if (s.rotation !== 0) out.rotation = s.rotation;
  if (s.shearX !== 0) out.shearX = s.shearX;
  if (s.shearY !== 0) out.shearY = s.shearY;
  if (s.scaleX !== 1) out.scaleX = s.scaleX;
  if (s.scaleY !== 1) out.scaleY = s.scaleY;
  return out;
}

function nonZero<T extends Record<string, number>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] !== 0) out[k] = o[k];
  return out;
}

/** Spine JSON as text. Numbers are written exactly: key times are float32
 *  values chosen to land on their frame (`keyTime`), and rounding them would
 *  move them again. */
export function spineJson(file: SpineSkeletonFile, minify = false): string {
  return JSON.stringify(file, (_k, v) => (typeof v === "number" && Object.is(v, -0) ? 0 : v), minify ? undefined : 2);
}
