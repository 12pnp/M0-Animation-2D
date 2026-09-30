import type { Animation, ColorTransform, DisplayRef, ImageItem, Layer, Node, Project, SymbolItem, Track } from "@/core/doc/types";
import { DEFAULT_COLOR, isImage, isSymbol, producesSlot } from "@/core/doc/types";
import type { ItemId, NodeId } from "@/core/doc/ids";
import { descendantsOf, maskGroups } from "@/core/doc/layerTree";
import type { Contour } from "@/core/atlas/contour";
import { nz } from "@/core/math/angle";
import { displaysOf } from "@/core/doc/displays";
import { childFrame, displayContext, localAt } from "@/core/doc/pose";
import { rotationDelta, sampleColorRaw, sampleTransformRaw } from "@/core/doc/timeline";
import type { Transform } from "@/core/math/Transform";
import { type EaseSegment, easeOf, easeSegments, type TweenChannel, type TweenSpec } from "@/core/math/easing";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { isAtlasName } from "./atlas";
import { animationRefs, bonesToIndices, type CarriedRef, constraintRefs, lastTime, regionsOf, skinRefs } from "./carry";
import { keyTime, keyValues, regionCentre, type SpineKeyValues, type SpineLocal, toSpineLocal } from "./transform";
import {
  SPINE_VERSION,
  type SpineAnimation,
  type SpineAttachmentKey,
  type SpineBlendMode,
  type SpineBone,
  type SpineAttachment,
  type SpineBoneTimelines,
  type SpineClippingAttachment,
  type SpineConstraint,
  type SpineCurve,
  type SpineDrawOrderKey,
  type SpineIkConstraint,
  type SpineRaw,
  type SpineSkin,
  type SpineRegionAttachment,
  type SpineRgba2Key,
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
  /** Each exported node of the symbol itself: its bone name, which is also
   *  its slot's name. */
  names: Map<NodeId, string>;
  /**
   * Every exported bone, nested content included, by its PATH: a node of the
   * symbol is its id; a node inside an instance is the instance's path, `#`
   * the display index showing the symbol, `>` and the node's id.
   */
  paths: Map<string, string>;
  /** Every exported slot by its node's path. A slot on a bone
   *  (`Node.slotBone`) is here and not in `paths`: it has no bone. */
  slots: Map<string, string>;
  /** Per slot (by its node's path), the skin key each display index was
   *  written under. */
  displayKeys: Map<string, Map<number, string>>;
}

/** The bone every top-level node hangs from. Spine does not require one,
 *  but spine-unity's tooling and most game code assume it. */
export const ROOT_BONE = "root";

/** The deepest nesting the stage draws (`SceneRenderer.drawEntry`). */
const MAX_DEPTH = 10;

/**
 * Where in time a symbol's contents are, at each frame of one exported
 * (root) animation: its own animation and frame, or null where it is not
 * on screen. The root symbol is at its own frame throughout; a nested one
 * follows the stage's rules (`localAt`, `displayContext`, `childFrame`).
 */
type FrameAt = { anim: Animation | null; frame: number } | null;

/** Consecutive root frames where a symbol's frame advances one per frame:
 *  [start, end) in root frames, `local0` the symbol's frame at `start`. */
export interface Run { start: number; end: number; anim: Animation | null; local0: number }

/** One symbol's contents inside the export: the root, or a nested instance. */
interface Scope {
  sym: SymbolItem;
  depth: number;
  /** The path of this scope's nodes (see `SpineExport.paths`), "" at the root. */
  key: string;
  /** Prefix of every bone name here, "" at the root. */
  prefix: string;
  /** The bone this symbol's top-level nodes hang from. */
  parentBone: string;
  /** Per exported animation, the frames of `FrameAt`. */
  frames: Map<string, FrameAt[]>;
  /** Per exported animation, the instances' alpha multiplied down to here. */
  alpha: Map<string, number[]>;
  /** Shown in the setup pose (every instance above shows it as display 0). */
  setupVisible: boolean;
  setupAlpha: number;
  /** Symbols above, for the cycle guard. */
  path: ItemId[];
}

/** One slot's worth of bookkeeping for the animation pass. */
interface SlotPlan {
  scope: Scope; node: Node; name: string; displays: Map<number, string>; setupName: string | null;
  /** Colour offsets somewhere: Spine's two-colour tint (`dark`, `rgba2`). */
  twoColor: boolean;
  /** A mask's clip slot: attachments only, no colour. */
  clip?: boolean;
}

/**
 * One symbol as a Spine 4.3 skeleton: the scene for File ▸ Export, the
 * symbol being edited for the preview.
 *
 * Every node is a bone; every image layer is also a slot on its own bone,
 * named like it. Values are the stage's own: keys come from
 * `sampleTransformRaw` / `sampleColorRaw`, the functions the stage draws
 * with, so the two cannot disagree at a whole frame.
 *
 * A symbol instance is FLATTENED: Spine has no skeleton inside a skeleton.
 * The instance gets a content bone at −pivot for each symbol it shows, the
 * symbol's own bones hang from it (names prefixed with the path), its slots
 * take the instance's place in the draw order, and its timeline — which
 * loops on its own clock and restarts when swapped in — is laid onto the
 * exported animation run by run (`Run`), keys and curves copied, only a run
 * cut in the middle of a tween baked frame by frame. The instance's alpha
 * multiplies down, as on the stage; its tint and blend do not.
 *
 * A mask layer becomes a clip slot before the layers it clips (`clipSlot`);
 * colour offsets become two-colour tint (`lightHex`, `darkHex`). Not
 * carried, said out loud: blend modes Spine lacks, motion blur.
 */
export interface ExportOptions {
  /**
   * The outline a mask image clips with, in its pixels (`traceContour`).
   * The io layer traces the decoded image; without it, the image's
   * rectangle.
   */
  maskShape?: (item: ImageItem) => Contour;
  /** The skeleton without the editor's keys: what the stage's Spine pose
   *  needs (`spinePose.ts`), which sets the keyed pose itself. Carried
   *  timelines are still written. */
  setupOnly?: boolean;
}

function rectangleShape(item: ImageItem): Contour {
  const w = item.width, h = item.height;
  return { points: [0, 0, w, 0, w, h, 0, h], islands: 0, holes: 0, soft: false };
}

export function exportSpine(
  project: Project, symbolId: ItemId = project.rootSymbolId, options: ExportOptions = {},
): SpineExport {
  const diagnostics: ExportDiagnostic[] = [];
  const usedImages = new Set<ItemId>();
  const sym = project.items[symbolId];
  if (!isSymbol(sym)) {
    diagnostics.push({ severity: "error", message: "There is no symbol to export." });
    return { skeleton: { skeleton: { spine: SPINE_VERSION }, bones: [] }, diagnostics, usedImages: [], names: new Map(), paths: new Map(), slots: new Map(), displayKeys: new Map() };
  }
  const fps = project.frameRate;

  // Only the DragonBones runtime extension ever drew it; nothing does now.
  if (project.motionBlur?.enabled) {
    diagnostics.push({
      severity: "warning",
      message: "Motion blur is on for this document, but the Spine export does not carry it: nothing will draw it.",
    });
  }

  // An opened Spine file brings its own root bone, whatever it is called;
  // a bone named "root" at the top is one too. Otherwise one is added.
  const ownRoot = rootBoneOf(sym);
  const bones: SpineBone[] = ownRoot ? [] : [{ name: ROOT_BONE }];
  const slots: SpineSlot[] = [];
  const slotPaths = new Map<string, string>();
  const displayKeys = new Map<string, Map<number, string>>();
  const attachments: Record<string, Record<string, SpineAttachment>> = {};
  const constraints: SpineIkConstraint[] = [];
  const setups = new Map<string, SpineLocal>();
  const paths = new Map<string, string>();
  const plans: SlotPlan[] = [];
  let clipCount = 0;
  const maskShape = options.maskShape ?? rectangleShape;
  const boneNodes: Array<{ scope: Scope; node: Node; name: string }> = [];
  const offsetWarned = new Set<NodeId>();

  const rootFrames = new Map<string, FrameAt[]>();
  const rootAlpha = new Map<string, number[]>();
  for (const anim of sym.animations) {
    rootFrames.set(anim.name, Array.from({ length: anim.duration }, (_, f) => ({ anim, frame: f })));
    rootAlpha.set(anim.name, new Array(anim.duration).fill(1));
  }

  /** Bones, slots, skin entries and constraints of one scope, in draw order,
   *  instances recursing where they sit. */
  const emitScope = (scope: Scope): void => {
    const s = scope.sym;
    const local = uniqueNames(s, diagnostics, scope.depth === 0, scope.depth === 0 ? ownRoot : undefined);
    const nameOf = (id: NodeId) => scope.prefix + local.get(id)!;
    const pathOf = (id: NodeId) => (scope.key ? `${scope.key}>${id}` : id);
    const skipped = excludedNodes(s);
    reportExcluded(s, skipped, diagnostics);

    // A skipped node that still has a KEPT descendant keeps its bone — never
    // a slot — or the descendant would reparent to the root and move.
    const boneOnly = new Set<NodeId>();
    for (const node of Object.values(s.nodes)) {
      if (skipped.has(node.id)) continue;
      for (let p = node.parentId; p; p = s.nodes[p]?.parentId ?? null) {
        if (skipped.has(p)) boneOnly.add(p);
      }
    }
    const dropped = (id: NodeId): boolean => skipped.has(id) && !boneOnly.has(id);

    // Mask layers: their art is never drawn; each clips the layers linked
    // to it (`maskGroups`), drawn together where the first of them is.
    const groups = maskGroups(s);
    const maskIds = new Set(s.layers.filter((l) => l.isMask).map((l) => l.id));

    for (const node of nodesInHierarchyOrder(s)) {
      if (dropped(node.id) || rides(s, node)) continue;
      const setup = toSpineLocal(node.bind);
      const name = nameOf(node.id);
      setups.set(name, setup);
      paths.set(pathOf(node.id), name);
      const parent = node === ownRoot ? undefined
        : node.parentId && !dropped(node.parentId) ? nameOf(node.parentId) : scope.parentBone;
      const bone: SpineBone = parent === undefined ? { name, ...withoutDefaults(setup) } : { name, parent, ...withoutDefaults(setup) };
      if (node.kind === "bone" && node.boneLength) bone.length = node.boneLength;
      if (node.inherit && node.inherit !== "normal") bone.inherit = node.inherit;
      if (node.spine?.bone) Object.assign(bone, node.spine.bone);
      bones.push(bone);
      boneNodes.push({ scope, node, name });
    }

    for (const k of s.ik) {
      const effector = dropped(k.boneId) ? undefined : s.nodes[k.boneId];
      const target = dropped(k.targetId) ? undefined : s.nodes[k.targetId];
      if (!effector || !target) {
        diagnostics.push({ severity: "warning", message: `IK "${k.name}" references a missing bone; skipped.` });
        continue;
      }
      // A chain of 1 on a bone with a parent is the two-bone solve rooted at
      // that parent (the stage's rule, `applyIk`).
      const parent = effector.parentId && !dropped(effector.parentId) ? effector.parentId : null;
      const chain = k.chain > 0 && parent ? [nameOf(parent), nameOf(effector.id)] : [nameOf(effector.id)];
      const ik: SpineIkConstraint = { type: "ik", name: scope.prefix + k.name, bones: chain, target: nameOf(target.id) };
      if (k.weight !== 1) ik.mix = k.weight;
      // The y flip mirrors the rig, and a mirrored two-bone chain bends the
      // other way: the editor's positive bend (y down) is Spine's negative.
      if (k.bendPositive) ik.bendPositive = false;
      if (k.spine) Object.assign(ik, k.spine);
      constraints.push(ik);
    }

    const emitLayer = (layer: Layer): void => {
      const node = s.nodes[layer.nodeId];
      if (!node || !producesSlot(node) || skipped.has(node.id)) return;
      const name = nameOf(node.id);
      const riding = rides(s, node);
      const keys = new Map<number, string>();
      const slotAttachments: Record<string, SpineAttachment> = {};
      const taken = new Set<string>();
      const symbolDisplays: Array<[number, DisplayRef]> = [];
      for (const [index, ref] of exportedDisplays(s, node)) {
        const item = project.items[ref.itemId];
        if (isSymbol(item)) { symbolDisplays.push([index, ref]); continue; }
        if (!isImage(item)) {
          diagnostics.push({ severity: "warning", message: `"${node.name}" points at a library item that no longer exists.` });
          continue;
        }
        usedImages.add(item.id);
        if (ref.attachment) {
          // As the file had it, drawing the image the display names now.
          const key = ref.attachment.name;
          if (taken.has(key)) continue;
          taken.add(key);
          keys.set(index, key);
          const data = { ...ref.attachment.data };
          if ((regionsOf(data, key)[0] ?? key) !== item.name) data.path = item.name;
          slotAttachments[key] = data;
          continue;
        }
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

      if (keys.size || riding) {
        if (keys.size) attachments[name] = slotAttachments;
        slotPaths.set(pathOf(node.id), name);
        displayKeys.set(pathOf(node.id), keys);
        const slot: SpineSlot = { name, bone: riding ? nameOf(node.slotBone!) : name };
        const setupName = scope.setupVisible ? keys.get(node.setupDisplay ?? 0) ?? null : null;
        const twoColor = hasOffsets(node.color)
          || s.animations.some((a) => a.tracks[node.id]?.keys.some((k) => hasOffsets(k.color)));
        const bindColor = scaleAlpha(node.color ?? DEFAULT_COLOR, scope.setupAlpha);
        if (twoColor) {
          slot.color = lightHex(bindColor);
          slot.dark = darkHex(bindColor);
          const colors = [node.color, ...s.animations.flatMap((a) => a.tracks[node.id]?.keys.map((k) => k.color) ?? [])];
          if (colors.some((c) => c && !tintExact(c))) warnOffsets(node, offsetWarned, diagnostics);
        } else {
          const setupColor = colorHex(bindColor);
          if (setupColor) slot.color = setupColor;
        }
        const blend = blendOf(node, diagnostics);
        if (blend) slot.blend = blend;
        if (setupName) slot.attachment = setupName;
        if (node.spine?.slot) Object.assign(slot, node.spine.slot);
        slots.push(slot);
        plans.push({ scope, node, name, displays: keys, setupName, twoColor });
      }

      // Each symbol this node shows is flattened here, in the draw order.
      const taken2 = new Set<string>();
      for (const [index, ref] of symbolDisplays) {
        const child = project.items[ref.itemId] as SymbolItem;
        if (scope.path.includes(child.id)) {
          diagnostics.push({ severity: "error", message: `Symbols contain each other: ${[...scope.path, child.id].map((id) => project.items[id]?.name ?? id).join(" -> ")}` });
          continue;
        }
        if (scope.depth + 1 >= MAX_DEPTH) {
          diagnostics.push({ severity: "warning", message: `"${child.name}" is nested more than ${MAX_DEPTH - 1} deep; the stage does not draw it, and neither does the export.` });
          continue;
        }
        let content = `${name}/${child.name}`;
        for (let n = 2; taken2.has(content); n++) content = `${name}/${child.name} (${n})`;
        taken2.add(content);
        const offset = toSpineLocal({ x: -ref.pivot.x, y: -ref.pivot.y, skewX: 0, skewY: 0, scaleX: 1, scaleY: 1 });
        bones.push({ name: content, parent: name, ...withoutDefaults(offset) });
        setups.set(content, offset);
        const inner = childScope(scope, node, index, child);
        emitScope({ ...inner, prefix: `${content}/`, parentBone: content, key: `${pathOf(node.id)}#${index}` });
      }
    };

    /**
     * A clip slot for the mask, then the layers it clips. Spine clips from
     * the clipping attachment's slot through its `end` slot, so the slot goes
     * right before the group and `end` names the group's last slot, nested
     * content included. The clip follows the mask's bone and, through the
     * attachment timeline, its visibility: a mask not showing clips nothing,
     * as on the stage.
     */
    const emitMasked = (maskLayer: Layer | undefined, members: Layer[]): void => {
      const maskNode = maskLayer ? s.nodes[maskLayer.nodeId] : undefined;
      let clip: { index: number; name: string; atts: SpineClippingAttachment[]; plan: SlotPlan } | null = null;
      if (maskNode && !skipped.has(maskNode.id) && producesSlot(maskNode)) {
        clip = clipSlot(scope, maskNode, nameOf(maskNode.id));
      }
      const before = slots.length, clipsBefore = clipCount;
      for (const m of members) emitLayer(m);
      if (!clip) return;
      if (slots.length === before || clip.atts.length === 0) {
        slots.splice(clip.index, 1);
        delete attachments[clip.name];
        plans.splice(plans.indexOf(clip.plan), 1);
        clipCount--;
        return;
      }
      for (const att of clip.atts) att.end = slots[slots.length - 1]!.name;
      if (clipCount > clipsBefore + 1) {
        diagnostics.push({
          severity: "warning",
          message: `"${maskNode!.name}" clips layers that hold another mask; Spine clips one mask at a time, so the inner one is ignored inside it.`,
        });
      }
    };

    // layers[0] is the TOP layer; Spine draws slot 0 first, at the back.
    const done = new Set<string>();
    for (const layer of [...s.layers].reverse()) {
      if (done.has(layer.id) || maskIds.has(layer.id)) continue;
      const group = layer.maskedBy ? groups.get(layer.maskedBy) : undefined;
      if (!group) { emitLayer(layer); continue; }
      const members = [...group].reverse();
      for (const m of members) done.add(m.id);
      emitMasked(s.layers.find((l) => l.id === layer.maskedBy), members);
    }
  };

  /** The clip slot of a mask node: one clipping attachment per image it
   *  shows, the polygon traced from the image (`maskShape`) and placed in
   *  the bone's space about its transform point. */
  const clipSlot = (scope: Scope, node: Node, name: string) => {
    const keys = new Map<number, string>();
    const slotAtts: Record<string, SpineClippingAttachment> = {};
    const atts: SpineClippingAttachment[] = [];
    const taken = new Set<string>();
    const warn = (message: string) => diagnostics.push({ severity: "warning", message });
    for (const [index, ref] of exportedDisplays(scope.sym, node)) {
      const item = project.items[ref.itemId];
      if (isSymbol(item)) {
        warn(`Mask "${node.name}" shows the symbol "${item.name}" at some keys; Spine clips with an image's outline, so it does not clip there.`);
        continue;
      }
      if (!isImage(item)) continue;
      const shape = maskShape(item);
      if (shape.points.length < 6) {
        warn(`Mask "${node.name}": the image "${item.name}" has nothing opaque enough to clip with.`);
        continue;
      }
      if (shape.soft) warn(`Mask "${node.name}": "${item.name}" has soft edges; Spine clips with a hard outline at half opacity.`);
      if (shape.islands > 0.02) warn(`Mask "${node.name}": "${item.name}" has several separate shapes; Spine clips with one outline, the largest.`);
      if (shape.holes > 0.01) warn(`Mask "${node.name}": "${item.name}" has holes; Spine clips with one outline, so they are filled.`);
      let key = item.name;
      for (let n = 2; taken.has(key); n++) key = `${item.name} (${n})`;
      taken.add(key);
      keys.set(index, key);
      const vertices: number[] = [];
      for (let i = 0; i < shape.points.length; i += 2) {
        vertices.push(nz(shape.points[i]! - ref.pivot.x), nz(-(shape.points[i + 1]! - ref.pivot.y)));
      }
      const att: SpineClippingAttachment = { type: "clipping", end: "", vertexCount: vertices.length / 2, vertices };
      slotAtts[key] = att;
      atts.push(att);
    }
    const colors = [node.color, ...scope.sym.animations.flatMap((a) => a.tracks[node.id]?.keys.map((k) => k.color) ?? [])];
    if (colors.some((c) => c && c.aM < 100)) {
      warn(`Mask "${node.name}" is partly transparent; Spine's clip is all or nothing.`);
    }
    attachments[name] = slotAtts;
    const setupName = scope.setupVisible ? keys.get(0) ?? null : null;
    const slot: SpineSlot = { name, bone: name };
    if (setupName) slot.attachment = setupName;
    slots.push(slot);
    const plan: SlotPlan = { scope, node, name, displays: keys, setupName, twoColor: false, clip: true };
    plans.push(plan);
    clipCount++;
    return { index: slots.length - 1, name, atts, plan };
  };

  /** Where an instance's symbol is, frame by frame, by the stage's rules. */
  const childScope = (parent: Scope, node: Node, displayIndex: number, child: SymbolItem): Omit<Scope, "prefix" | "parentBone" | "key"> => {
    const frames = new Map<string, FrameAt[]>();
    const alpha = new Map<string, number[]>();
    for (const [animName, parentFrames] of parent.frames) {
      const parentAlpha = parent.alpha.get(animName)!;
      const out: FrameAt[] = [];
      const a: number[] = [];
      parentFrames.forEach((pf, f) => {
        if (!pf) { out.push(null); a.push(0); return; }
        const st = localAt(node, pf.anim, pf.frame, "animate");
        if (!st.onTrack || st.displayIndex !== displayIndex) { out.push(null); a.push(0); return; }
        const at = displayContext({ animationName: pf.anim?.name ?? null, frame: pf.frame, mode: "animate" }, st.since);
        const here = childFrame(child, at);
        out.push({ anim: here.animation, frame: here.frame });
        a.push(parentAlpha[f]! * st.color.aM / 100);
      });
      frames.set(animName, out);
      alpha.set(animName, a);
      // A loop longer than the animation it plays in only shows its start,
      // restarted on every loop; the stage does the same, but it is rarely
      // what was meant (DragonBones ran a child on its own clock).
      const played = new Set(out.filter((x): x is NonNullable<FrameAt> => !!x).map((x) => x.anim).filter((x): x is Animation => !!x));
      for (const childAnim of played) {
        const moves = Object.values(childAnim.tracks).some((t) => t.keys.length > 1);
        if (moves && childAnim.duration > out.length) {
          diagnostics.push({
            severity: "warning",
            message:
              `"${node.name}" plays "${child.name}" ▸ "${childAnim.name}" (${childAnim.duration} frames) inside ` +
              `"${animName}", which lasts ${out.length}: only its first ${out.length} reach the file, restarting on ` +
              `every loop. Lengthen "${animName}" to ${childAnim.duration} frames to export all of it.`,
          });
        }
      }
    }
    return {
      sym: child,
      depth: parent.depth + 1,
      frames,
      alpha,
      setupVisible: parent.setupVisible && displayIndex === 0,
      setupAlpha: parent.setupAlpha * (node.color?.aM ?? 100) / 100,
      path: [...parent.path, child.id],
    };
  };

  const root: Scope = {
    // `uniqueNames` names an own root first, so it keeps its name.
    sym, depth: 0, key: "", prefix: "", parentBone: ownRoot ? ownRoot.name.trim() || ownRoot.kind : ROOT_BONE,
    frames: rootFrames, alpha: rootAlpha, setupVisible: true, setupAlpha: 1, path: [sym.id],
  };
  emitScope(root);

  const allNames = new Set<string>();
  for (const b of bones) {
    if (allNames.has(b.name)) diagnostics.push({ severity: "error", message: `Two bones would be called "${b.name}"; rename one of the layers or instances.` });
    allNames.add(b.name);
  }

  /* ── animations ── */
  const animations: Record<string, SpineAnimation> = {};
  for (const anim of sym.animations) {
    const out: SpineAnimation = {};
    let lastFrame = 0;
    if (options.setupOnly) {
      animations[anim.name] = { ...(anim.spine ?? {}) } as SpineAnimation;
      continue;
    }
    for (const { scope, node, name } of boneNodes) {
      const runs = runsOf(scope.frames.get(anim.name)!);
      if (runs.length === 0) continue;
      const bt = boneTimelines(node, runs, setups.get(name)!, fps, diagnostics);
      if (bt) {
        (out.bones ??= {})[name] = bt.timelines;
        lastFrame = Math.max(lastFrame, bt.lastFrame);
      }
    }
    for (const plan of plans) {
      const st = slotTimelines(plan, anim.name, fps);
      if (st) {
        (out.slots ??= {})[plan.name] = st.timelines;
        lastFrame = Math.max(lastFrame, st.lastFrame);
      }
    }
    // Carried timelines (an opened file's) join the generated ones.
    const carried = anim.spine ?? {};
    for (const [group, value] of Object.entries(carried)) {
      if ((group === "bones" || group === "slots") && value && typeof value === "object") {
        const into = (out[group] ??= {}) as Record<string, Record<string, unknown>>;
        for (const [owner, timelines] of Object.entries(value as Record<string, Record<string, unknown>>)) {
          into[owner] = { ...into[owner], ...timelines };
        }
      } else out[group] = value;
    }
    // Spine has no length field: the animation ends at its last key. A key
    // at the end holds it open; a draw order key that changes nothing is
    // the one key that cannot affect anything else. Flash's timing ends
    // after the last frame, Spine's (`endsAtLastFrame`) on it.
    const end = anim.endsAtLastFrame ? anim.duration - 1 : anim.duration;
    const reached = Math.max(lastFrame, Math.round(lastTime(carried) * fps - 1e-6));
    if (end > reached) {
      const order = (out.drawOrder as SpineDrawOrderKey[] | undefined) ?? [];
      const held = order.length ? order[order.length - 1]!.offsets : undefined;
      out.drawOrder = [...order, held ? { time: keyTime(end, fps), offsets: held } : { time: keyTime(end, fps) }];
    }
    if (animations[anim.name]) {
      diagnostics.push({ severity: "error", message: `Two animations in "${sym.name}" are called "${anim.name}".` });
    }
    animations[anim.name] = out;
  }

  reportImageNames(project, [...usedImages], diagnostics);

  const carry = sym.spine;
  const skeleton: SpineSkeletonFile = { skeleton: { ...carry?.header, spine: SPINE_VERSION, fps }, bones };
  if (slots.length) skeleton.slots = slots;
  const allConstraints: SpineConstraint[] = [...constraints, ...(carry?.constraints ?? []) as SpineConstraint[]];
  if (carry) {
    // Spine applies constraints in list order: the file's, new ones last.
    const rank = new Map(carry.constraintOrder.map((n, i) => [n, i]));
    allConstraints.sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity));
  }
  if (allConstraints.length) skeleton.constraints = allConstraints;
  const skins: SpineSkin[] = [{ name: "default", attachments }];
  for (const raw of carry?.skins ?? []) {
    const skin = raw as unknown as SpineSkin;
    // Copied down to the slot maps: the pass below rewrites entries, and the
    // document must not change under an export.
    const own = Object.fromEntries(Object.entries(skin.attachments ?? {}).map(([slot, byKey]) => [slot, { ...byKey }]));
    if (skin.name !== "default") { skins.push({ ...skin, attachments: own }); continue; }
    const merged: Record<string, Record<string, SpineAttachment>> = { ...attachments };
    for (const [slot, byKey] of Object.entries(own)) merged[slot] = { ...byKey, ...merged[slot] };
    skins[0] = { ...skin, attachments: merged };
  }
  // Weighted vertices name their bones in the document; the file indexes
  // the bone list just written. Every image a carried skin draws is packed.
  const boneIndex = new Map(bones.map((bone, i) => [bone.name, i]));
  const imageNamed = new Map<string, ItemId>();
  for (const item of Object.values(project.items)) if (isImage(item)) imageNamed.set(item.name, item.id);
  for (const skin of skins) {
    for (const [slot, byKey] of Object.entries(skin.attachments ?? {})) {
      for (const [key, att] of Object.entries(byKey)) {
        byKey[key] = bonesToIndices(att as SpineRaw, boneIndex, (bone) => diagnostics.push({
          severity: "error",
          message: `"${slot}" ▸ "${key}" in skin "${skin.name}" is weighted to a bone "${bone}" the skeleton no longer has.`,
        }));
        for (const region of regionsOf(att as SpineRaw, key)) {
          const id = imageNamed.get(region);
          if (id) usedImages.add(id);
          else diagnostics.push({ severity: "error", message: `"${slot}" ▸ "${key}" in skin "${skin.name}" draws the image "${region}", which is not in the library.` });
        }
      }
    }
  }
  if (carry?.events) skeleton.events = carry.events as SpineSkeletonFile["events"];
  skeleton.skins = skins;
  if (Object.keys(animations).length) skeleton.animations = animations;
  if (carry) checkCarried(skeleton, sym, diagnostics);
  // spine-csharp refuses a file without one; it is how spine-unity tells a
  // re-exported skeleton changed. Written first, as Spine does.
  if (!options.setupOnly) {
    const { hash: _old, ...header } = skeleton.skeleton;
    skeleton.skeleton = { hash: contentHash(spineJson({ ...skeleton, skeleton: header })), ...header };
  }

  const names = new Map<NodeId, string>();
  for (const [key, name] of paths) if (!key.includes(">")) names.set(key as NodeId, name);
  // A symbol instanced twice reports its own problems twice.
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => !seen.has(d.message) && seen.add(d.message));
  return { skeleton, diagnostics: unique, usedImages: [...usedImages], names, paths, slots: slotPaths, displayKeys };
}

/** Consecutive frames on one animation, advancing one frame per frame. */
function runsOf(frames: FrameAt[]): Run[] {
  const runs: Run[] = [];
  frames.forEach((fa, f) => {
    if (!fa) return;
    const last = runs[runs.length - 1];
    if (last && last.end === f && last.anim === fa.anim && last.local0 + (f - last.start) === fa.frame) last.end = f + 1;
    else runs.push({ start: f, end: f + 1, anim: fa.anim, local0: fa.frame });
  });
  return runs;
}

function scaleAlpha(c: ColorTransform, k: number): ColorTransform {
  return k === 1 ? c : { ...c, aM: c.aM * k };
}

/* ── rows ────────────────────────────────────────────────────────────────── */

/**
 * The bezier leaving a key, as Spine takes it: the segment's control points
 * in the INTERVAL's 0..1 space, and the interval's two ends, so each
 * channel's control values follow from its values there (timelines are
 * linear in their values, so this is exact).
 */
interface RowCurve { seg: EaseSegment; frame0: number; span: number }
/** One key. `sub` marks a curve segment starting inside its interval (not
 *  where an interval starts). */
export type Row<T> = { frame: number; t: T; stepped: boolean; sub?: boolean; curve?: RowCurve & { from: T; to: T } };

/** A channel of one track: its keys, and the stage's value at any frame. */
export interface Channel<T> { rows: Row<T>[]; at: (frame: number) => T }

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
  return segs.map((seg, i) => ({
    frame: frame0 + seg.x0 * span,
    t: seg.y0 === 0 ? from : lerp(from, to, seg.y0),
    stepped: false,
    ...(i > 0 ? { sub: true } : {}),
    curve: { seg, frame0, span, from, to },
  }));
}

/**
 * A transform channel of a track, angles unwrapped across keys so direction
 * and extra turns survive (the stage restarts each interval from the keyed
 * angle, a whole number of turns away: the same matrix, but Spine
 * interpolates the numbers). No track: the bind pose, held.
 */
function transformChannel(track: Track | undefined, bind: Transform, channel: TweenChannel): Channel<Transform> {
  if (!track || track.keys.length === 0) return { rows: [{ frame: 0, t: bind, stepped: false }], at: () => bind };
  const keys = track.keys;
  const turn: number[] = [0];
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1]!, k = keys[i]!;
    const unwrapped = prev.transform.skewY + turn[i - 1]! + rotationDelta(prev, k);
    turn.push(unwrapped - k.transform.skewY);
  }
  const shifted = (t: Transform, by: number): Transform =>
    by === 0 ? t : { ...t, skewX: t.skewX + by, skewY: t.skewY + by };
  const governing = (f: number): number => {
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1]!.frame <= f) i++;
    return i;
  };
  // Before its first key the stage composes the node at its bind pose.
  const at = (f: number): Transform => (f < keys[0]!.frame ? bind : shifted(sampleTransformRaw(track, f)!, turn[governing(f)]!));

  const rows: Row<Transform>[] = [];
  if (keys[0]!.frame > 0) rows.push({ frame: 0, t: bind, stepped: true });
  keys.forEach((k, i) => {
    const next = keys[i + 1];
    const t = shifted(k.transform, turn[i]!);
    if (!next) { rows.push({ frame: k.frame, t, stepped: false }); return; }
    rows.push(...intervalRows(k.frame, next.frame, t, shifted(next.transform, turn[i + 1]!), easeOf(k, channel), at, lerpTransform));
  });
  return { rows, at };
}

/** The colour channel of a track: an AUTHORED colour anywhere means the
 *  timeline governs (`sampleColorRaw`'s rule); otherwise the bind colour. */
function colorChannel(track: Track | undefined, bind: ColorTransform): Channel<ColorTransform> {
  if (!track || !track.keys.some((k) => k.color !== undefined)) {
    return { rows: [{ frame: 0, t: bind, stepped: false }], at: () => bind };
  }
  const keys = track.keys;
  const at = (f: number): ColorTransform => sampleColorRaw(track, f) ?? bind;
  const rows: Row<ColorTransform>[] = [];
  if (keys[0]!.frame > 0) rows.push({ frame: 0, t: bind, stepped: true });
  keys.forEach((k, i) => {
    const next = keys[i + 1];
    const c = k.color ?? DEFAULT_COLOR;
    if (!next) { rows.push({ frame: k.frame, t: c, stepped: false }); return; }
    rows.push(...intervalRows(k.frame, next.frame, c, next.color ?? DEFAULT_COLOR, easeOf(k, "color"), at, lerpColor));
  });
  return { rows, at };
}

function lerpTransform(a: Transform, b: Transform, s: number): Transform {
  const l = (p: number, q: number) => p + (q - p) * s;
  return {
    x: l(a.x, b.x), y: l(a.y, b.y), skewX: l(a.skewX, b.skewX), skewY: l(a.skewY, b.skewY),
    scaleX: l(a.scaleX, b.scaleX), scaleY: l(a.scaleY, b.scaleY),
  };
}

/**
 * A symbol's keys laid onto the exported animation, run by run. Inside a
 * run the keys and their curves are copied, shifted in time. Where a run
 * starts inside an interval, the frames up to the next key are baked (the
 * stage's value per frame, straight between); where one ends inside an
 * interval, its tail is baked the same way, so no curve reaches past the
 * run — except a tween whose end key lands exactly on the run's end with
 * nothing starting there, which keeps its curve and ends on that key (a
 * key at the animation's end is how its length is written anyway). A run's
 * last key is stepped when another run follows: a loop restarting, a swap.
 */
export function sliceRuns<T>(runs: Run[], channelFor: (anim: Animation | null) => Channel<T>): Row<T>[] {
  const out: Row<T>[] = [];
  runs.forEach((run, ri) => {
    const { rows, at } = channelFor(run.anim);
    const l0 = run.local0, l1 = run.local0 + (run.end - run.start);
    const shift = run.start - l0;
    const starts = rows.map((r, i) => (r.sub ? -1 : i)).filter((i) => i >= 0);
    const nextStart = (i: number) => starts.find((j) => j > i);
    const bake = (from: number, to: number) => {
      for (let f = from; f < to; f++) out.push({ frame: f + shift, t: at(f), stepped: false });
    };
    const runOut = out.length;

    // The interval governing l0.
    let g = -1;
    for (const i of starts) if (rows[i]!.frame <= l0) g = i;
    let j: number;
    if (g >= 0 && rows[g]!.frame === l0) j = g;
    else {
      const n = g >= 0 ? nextStart(g) : starts[0];
      const stop = Math.min(l1, n === undefined ? l1 : Math.ceil(rows[n]!.frame));
      bake(l0, stop);
      j = n === undefined || rows[n]!.frame >= l1 ? rows.length : n;
    }
    for (; j < rows.length && rows[j]!.frame < l1; j++) {
      const r = rows[j]!;
      out.push({ ...r, frame: r.frame + shift, ...(r.curve ? { curve: { ...r.curve, frame0: r.curve.frame0 + shift } } : {}) });
    }
    // The last interval started in the run, if it reaches past it.
    let last = -1;
    for (const i of starts) if (rows[i]!.frame < l1 && rows[i]!.frame >= l0) last = i;
    const later = runs[ri + 1];
    if (last >= 0) {
      const n = nextStart(last);
      if (n !== undefined && rows[n]!.frame >= l1 && !rows[last]!.stepped) {
        if (rows[n]!.frame === l1 && later?.start !== run.end) {
          const end = rows[n]!;
          out.push({ frame: end.frame + shift, t: end.t, stepped: false });
        } else {
          const from = rows[last]!.frame + shift;
          while (out.length > runOut && out[out.length - 1]!.frame >= from) out.pop();
          bake(rows[last]!.frame, l1);
        }
      }
    }
    if (later && out.length > runOut) out[out.length - 1] = { ...out[out.length - 1]!, stepped: true, curve: undefined };
  });
  return out;
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

/* ── bone timelines ──────────────────────────────────────────────────────── */

function boneTimelines(
  node: Node, runs: Run[], setup: SpineLocal, fps: number, diags: ExportDiagnostic[],
): { timelines: SpineBoneTimelines; lastFrame: number } | null {
  const out: SpineBoneTimelines = {};
  let lastFrame = 0;
  const kv = (t: Transform) => keyValues(toSpineLocal(t), setup);
  const rowsOf = (channel: TweenChannel) =>
    sliceRuns(runs, (anim) => transformChannel(anim?.tracks[node.id], node.bind, channel)).map((r) => ({ r, v: kv(r.t) }));
  const base = (r: Row<Transform>, channels: (v: SpineKeyValues) => number[]) => {
    lastFrame = Math.max(lastFrame, r.frame);
    return keyBase(r, fps, (t) => channels(kv(t)));
  };
  const moves = (vs: Array<{ v: SpineKeyValues }>, pick: (v: SpineKeyValues) => number[], rest: number) =>
    vs.some(({ v }) => pick(v).some((x) => Math.abs(x - rest) > 1e-9));

  const pos = rowsOf("position");
  if (moves(pos, (v) => [v.x, v.y], 0)) {
    out.translate = pos.map(({ r, v }) => ({ ...base(r, (w) => [w.x, w.y]), ...nonZero({ x: v.x, y: v.y }) }));
  }

  const rot = rowsOf("rotation");
  if (moves(rot, (v) => [v.rotate], 0)) {
    out.rotate = rot.map(({ r, v }) => ({ ...base(r, (w) => [w.rotate]), ...nonZero({ value: v.rotate }) }));
  }
  if (moves(rot, (v) => [v.shearX, v.shearY], 0)) {
    out.shear = rot.map(({ r, v }) => ({ ...base(r, (w) => [w.shearX, w.shearY]), ...nonZero({ x: v.shearX, y: v.shearY }) }));
  }

  const scl = rowsOf("scale");
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

/**
 * Which attachment a slot shows and in what colour, over one exported
 * animation. Attachments frame by frame from the stage's own `localAt`
 * (nothing outside a track's span, nothing while the instance above is not
 * showing its symbol), written where they change. Colour: the slot's own
 * keys, times the alpha of the instances above; while that alpha is one
 * number the keys are scaled exactly, and while it moves the colour is
 * baked frame by frame.
 */
function slotTimelines(
  plan: SlotPlan, animName: string, fps: number,
): { timelines: SpineSlotTimelines; lastFrame: number } | null {
  const { scope, node, displays, setupName } = plan;
  const frames = scope.frames.get(animName)!;
  const alpha = scope.alpha.get(animName)!;
  const out: SpineSlotTimelines = {};
  let lastFrame = 0;
  const time = (frame: number) => {
    lastFrame = Math.max(lastFrame, frame);
    return frame === 0 ? {} : { time: keyTime(frame, fps) };
  };

  const shownAt = (f: number): string | null => {
    const fa = frames[f];
    if (!fa) return null;
    const st = localAt(node, fa.anim, fa.frame, "animate");
    return st.onTrack && st.displayIndex >= 0 ? displays.get(st.displayIndex) ?? null : null;
  };
  const changes: SpineAttachmentKey[] = [];
  let prev: string | null | undefined;
  for (let f = 0; f < frames.length; f++) {
    const name = shownAt(f);
    if (name !== prev) changes.push({ ...time(f), name });
    prev = name;
  }
  if (changes.length > 1 || (changes.length === 1 && changes[0]!.name !== setupName)) out.attachment = changes;

  if (plan.clip) return Object.keys(out).length ? { timelines: out, lastFrame } : null;
  const runs = runsOf(frames);
  const bind = node.color ?? DEFAULT_COLOR;
  const shown = alpha.filter((_, f) => frames[f]);
  const constant = shown.every((a) => Math.abs(a - shown[0]!) < 1e-12) ? (shown[0] ?? scope.setupAlpha) : null;
  let rows: Row<ColorTransform>[];
  if (constant !== null) {
    rows = sliceRuns(runs, (anim) => {
      const ch = colorChannel(anim?.tracks[node.id], bind);
      const scale = (c: ColorTransform) => scaleAlpha(c, constant);
      return {
        rows: ch.rows.map((r) => ({ ...r, t: scale(r.t), ...(r.curve ? { curve: { ...r.curve, from: scale(r.curve.from), to: scale(r.curve.to) } } : {}) })),
        at: (f) => scale(ch.at(f)),
      };
    });
  } else {
    rows = [];
    frames.forEach((fa, f) => {
      if (!fa) return;
      const c = colorChannel(fa.anim?.tracks[node.id], bind).at(fa.frame);
      rows.push({ frame: f, t: scaleAlpha(c, alpha[f]!), stepped: false });
    });
  }
  // The runtime's frame colours are the 8-bit ones the file holds, so a
  // curve's control values are mixed from those.
  const setupBind = scaleAlpha(bind, scope.setupAlpha);
  if (plan.twoColor) {
    const key = (c: ColorTransform) => lightHex(c) + darkHex(c);
    if (rows.some((r) => key(r.t) !== key(setupBind))) {
      lastFrame = Math.max(lastFrame, ...rows.map((r) => r.frame));
      out.rgba2 = rows.map((r): SpineRgba2Key => ({ ...keyBase(r, fps, tintChannels), light: lightHex(r.t), dark: darkHex(r.t) }));
    }
  } else {
    const setupHex = colorHex(setupBind) ?? "ffffffff";
    if (rows.some((r) => (colorHex(r.t) ?? "ffffffff") !== setupHex)) {
      const channels = (c: ColorTransform) => [c.rM, c.gM, c.bM, c.aM].map((m) => byte(m / 100) / 255);
      lastFrame = Math.max(lastFrame, ...rows.map((r) => r.frame));
      out.rgba = rows.map((r): SpineRgbaKey => ({ ...keyBase(r, fps, channels), color: colorHex(r.t) ?? "ffffffff" }));
    }
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

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
const hex2 = (v: number) => byte(v).toString(16).padStart(2, "0");

/**
 * The multipliers as "rrggbbaa", or undefined when neutral. The runtime's
 * slot colour multiplies the texture exactly as the stage's multipliers do,
 * quantised to 8 bits per channel by the format.
 */
export function colorHex(c: ColorTransform | undefined): string | undefined {
  if (!c) return undefined;
  const hex = hex2(c.rM / 100) + hex2(c.gM / 100) + hex2(c.bM / 100) + hex2(c.aM / 100);
  return hex === "ffffffff" ? undefined : hex;
}

/**
 * Colour offsets as Spine's two-colour tint. The stage draws
 * `clamp(c·M + O)` per channel; spine-pixi's dark-tint shader draws
 * `(1 − c)·dark + c·light` (straight colour; the batcher scales dark by the
 * slot's alpha and gives it alpha 1). They are equal for every texel c when
 * `dark = O` and `light = M + O`, as long as O is not negative and M + O
 * does not pass full (`tintExact`). The alpha offset is not drawn by the
 * stage either.
 */
export function lightHex(c: ColorTransform): string {
  return hex2(c.rM / 100 + c.rO / 255) + hex2(c.gM / 100 + c.gO / 255) + hex2(c.bM / 100 + c.bO / 255) + hex2(c.aM / 100);
}

export function darkHex(c: ColorTransform): string {
  return hex2(c.rO / 255) + hex2(c.gO / 255) + hex2(c.bO / 255);
}

/** The seven values an rgba2 curve carries, light rgba then dark rgb. */
function tintChannels(c: ColorTransform): number[] {
  const h = lightHex(c) + darkHex(c);
  return Array.from({ length: 7 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255);
}

export function tintExact(c: ColorTransform): boolean {
  return ([["rM", "rO"], ["gM", "gO"], ["bM", "bO"]] as const).every(([m, o]) =>
    c[o] >= 0 && c[m] / 100 + c[o] / 255 <= 1 + 1e-9);
}

function hasOffsets(c: ColorTransform | undefined): boolean {
  return !!c && (c.rO !== 0 || c.gO !== 0 || c.bO !== 0);
}

function warnOffsets(node: Node, warned: Set<NodeId>, diags: ExportDiagnostic[]): void {
  if (warned.has(node.id)) return;
  warned.add(node.id);
  diags.push({
    severity: "warning",
    message:
      `"${node.name}" uses colour offsets Spine's two-colour tint cannot draw exactly (a negative offset, ` +
      "or multiplier plus offset past full): the export clamps them.",
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
  // An opened slot's skin keeps every attachment, keyed or not.
  if (all.some((d) => d.attachment)) return all.map((d, i) => [i, d]);
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

/**
 * Bones and slots are found by name, so names are unique within a symbol;
 * "root" is taken at the top, where the root bone lives, unless `ownRoot`
 * is that bone. A layer is a bone and a slot of one name; a slot on a bone
 * (`slotBone`) is only a slot, and slots and bones are named apart in
 * Spine, so it only has to differ from the other slots.
 */
function uniqueNames(sym: SymbolItem, diags: ExportDiagnostic[], top: boolean, ownRoot?: Node): Map<NodeId, string> {
  const map = new Map<NodeId, string>();
  const bonesTaken = new Set<string>(top && !ownRoot ? [ROOT_BONE] : []);
  const slotsTaken = new Set<string>();
  const assign = (node: Node): void => {
    const riding = rides(sym, node);
    const bone = !riding, slot = riding || producesSlot(node);
    const free = (n: string) => !(bone && bonesTaken.has(n)) && !(slot && slotsTaken.has(n));
    let name = node.name.trim() || node.kind;
    if (!free(name)) {
      const original = name;
      for (let i = 2; !free(name); i++) name = `${original}_${i}`;
      diags.push({
        severity: "warning",
        message: original === ROOT_BONE && bone
          ? `"${ROOT_BONE}" is the name of the skeleton's root bone in Spine; exported "${node.name}" in "${sym.name}" as "${name}".`
          : `Two objects in "${sym.name}" are called "${original}"; exported the second as "${name}".`,
      });
    }
    if (bone) bonesTaken.add(name);
    if (slot) slotsTaken.add(name);
    map.set(node.id, name);
  };
  if (ownRoot) assign(ownRoot);
  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (node && !map.has(node.id)) assign(node);
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

/**
 * A skeleton's hash: 64-bit FNV-1a over its JSON, as 11 base64 characters,
 * the shape Spine writes. Only equality matters to the runtimes.
 */
export function contentHash(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const bytes = Array.from({ length: 8 }, (_, i) => Number((h >> BigInt(56 - i * 8)) & 0xffn));
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

/** Spine JSON as text. Numbers are written exactly: key times are float32
 *  values chosen to land on their frame (`keyTime`), and rounding them would
 *  move them again. */
export function spineJson(file: SpineSkeletonFile, minify = false): string {
  return JSON.stringify(file, (_k, v) => (typeof v === "number" && Object.is(v, -0) ? 0 : v), minify ? undefined : 2);
}

/** A slot on a bone of its own symbol: exported with no bone of its own. */
function rides(sym: SymbolItem, node: Node): boolean {
  return !!node.slotBone && sym.nodes[node.slotBone]?.kind === "bone";
}

/**
 * Every name the carried JSON of an opened file relies on must still be in
 * the skeleton: a renamed or deleted bone, slot, constraint or skin would
 * otherwise make the runtime throw, or quietly skip it. An error each, so
 * the export refuses.
 */
function checkCarried(file: SpineSkeletonFile, sym: SymbolItem, diags: ExportDiagnostic[]): void {
  const have: Record<CarriedRef["kind"], Set<string>> = {
    bone: new Set(file.bones.map((b) => b.name)),
    slot: new Set((file.slots ?? []).map((sl) => sl.name)),
    constraint: new Set((file.constraints ?? []).map((c) => c.name)),
    skin: new Set((file.skins ?? []).map((sk) => sk.name)),
    attachment: new Set(),
    event: new Set(Object.keys(file.events ?? {})),
  };
  const refs: CarriedRef[] = [];
  for (const c of sym.spine?.constraints ?? []) refs.push(...constraintRefs(c));
  for (const skin of sym.spine?.skins ?? []) refs.push(...skinRefs(skin));
  for (const anim of sym.animations) if (anim.spine) refs.push(...animationRefs(anim.spine, anim.name));
  const reported = new Set<string>();
  for (const r of refs) {
    if (have[r.kind].has(r.name)) continue;
    const message = `${r.where} needs the ${r.kind} "${r.name}", which the skeleton no longer has; rename it back or remove what needs it.`;
    if (!reported.has(message)) diags.push({ severity: "error", message });
    reported.add(message);
  }
}

/** The symbol's own root bone: the one top-level bone of an opened Spine
 *  file, or a top-level bone called "root". */
function rootBoneOf(sym: SymbolItem): Node | undefined {
  const skipped = excludedNodes(sym);
  const tops = Object.values(sym.nodes).filter((n) => n.kind === "bone" && !n.parentId && !skipped.has(n.id));
  if (sym.spine && tops.length === 1) return tops[0];
  return tops.find((n) => n.name === ROOT_BONE);
}
