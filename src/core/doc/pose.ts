import { applyInverse, clone, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { orderAt } from "./drawOrder";
import { ikPoseAt } from "./ikKeys";
import { tcMixAt, tcSolveOf } from "./transformKeys";
import { meshUvs, meshWorld } from "@/core/mesh/meshPose";
import { deformAt, drawnDeformTarget } from "@/core/mesh/deform";
import { LooseBones } from "@/core/boneburst/runtime/bones";
import { oneBone, twoBones } from "@/core/boneburst/runtime/ik";
import { solveTransform } from "@/core/boneburst/runtime/transform";
import { fromBoneBurstLocal, type BoneBurstLocal, toBoneBurstLocal } from "@/core/boneburst/transform";
import { cloneTf, toMatrix, type Transform } from "@/core/math/Transform";
import type { Animation, ColorTransform, DisplayRef, IkConstraint, Node, Project, SymbolItem, TransformConstraint } from "./types";
import { byOrder } from "./constraintOrder";
import { DEFAULT_COLOR, isImage, isSymbol } from "./types";
import type { ItemId, NodeId } from "./ids";
import { sampleColorRaw, sampleTransformRaw, spanIndexAt } from "./timeline";
import { anchorOf, displayAt, meshOfDisplay } from "./displays";
import { boxNodeBounds, outlineField, outlineWeighted, outlineWorld, skinnedOutline } from "./boxes";
import { sequenceItemAt } from "./sequence";
import { shownDisplay as shownInSkins, skinActivity, skinDisplayOf, skinLookup, skinnedDisplay, stageSkinOf, type SkinActivity } from "./skins";

/**
 * One node, resolved for a given frame. This is the single description that
 * both the editor's renderer AND the exporter reason about, so what you see
 * on the stage and what lands in the JSON cannot drift apart by construction.
 */
export interface PoseEntry {
  nodeId: NodeId;
  node: Node;
  /** Local transform in the parent's space, absolute (Flash-style). */
  local: Transform;
  /** Composed to the symbol's root. */
  world: Matrix2D;
  color: ColorTransform;
  /** -1 = blank keyframe; the slot exists but shows nothing. */
  displayIndex: number;
  /** The item and transform point `displayIndex` resolves to; null for a
   *  blank key and for nodes without artwork. */
  display: DisplayRef | null;
  /** First frame of the run of keys showing this display without a break —
   *  where a nested symbol shown here was (re)started. See `displayContext`. */
  displaySince: number;
  /** False when the layer is hidden or the track does not reach this frame. */
  visible: boolean;
  /** Back-to-front paint order; also the DragonBones slot index. */
  drawIndex: number;
  /** Posed by the Spine runtime (`core/boneburst/boneburstPose.ts`): what the slot
   *  draws, world geometry included. The renderer draws this instead of
   *  `display` about `world`. */
  spine?: BoneBurstDraw;
  /** Posed by the Spine runtime: a clipping attachment, clipping every
   *  slot drawn after it up to and including `until` (to the end when
   *  null). */
  clip?: { polygon: number[]; until: NodeId | null };
  /** A box's or path's points in the world where they follow bones (weighted,
   *  or posed by the runtime); else they are the node's points through `world`
   *  (`entryOutline`). */
  outline?: number[];
}

/**
 * An attachment as the runtime places it: textured triangles over an image.
 * Coordinates are the symbol's (y down).
 */
export interface BoneBurstDraw {
  itemId: ItemId;
  /** World x, y per vertex. */
  vertices: number[];
  /** The image pixel each vertex shows. */
  uvs: number[];
  /** Vertex indices, three per triangle. */
  triangles: number[];
  /** A region: four vertices (bottom-left, top-left, top-right,
   *  bottom-right of the image), one affine image. */
  quad: boolean;
}

export interface Pose {
  entries: PoseEntry[];
  byNode: Map<NodeId, PoseEntry>;
}

/**
 * Where in time a symbol is being looked at.
 *
 * A nested symbol is a CHILD ARMATURE with its own timeline: the runtime
 * starts it with `gotoAndPlay` and loops it on its own clock. So an instance
 * on the stage must be drawn from the child's animation at the playhead —
 * drawing its bind pose instead is how a symbol can look untouched on the
 * stage while the preview plays the edits you just made inside it.
 */
export interface FrameContext {
  /** Matched by name against the child's own animations. */
  animationName?: string | null;
  /** Play the child's default (first) animation instead of matching the
   *  name: what the runtime does for a display swapped in mid-animation. */
  defaultAnimation?: boolean;
  frame: number;
  mode: "setup" | "animate";
}

/** The bind pose, which is what Setup mode and the library thumbnails want. */
export const SETUP_CONTEXT: FrameContext = Object.freeze({ frame: 0, mode: "setup" });

/** Which animation and frame a nested symbol is showing. */
export function childFrame(
  item: SymbolItem, ctx: FrameContext,
): { animation: Animation | null; frame: number } {
  if (ctx.mode === "setup") return { animation: null, frame: 0 };
  const animation =
    (ctx.defaultAnimation ? undefined : item.animations.find((a) => a.name === ctx.animationName))
    ?? item.animations[0] ?? null;
  const duration = animation?.duration ?? 0;
  // The child loops on its own clock (playTimes 0), so the parent's frame
  // wraps into it rather than running off the end.
  return {
    animation,
    frame: duration > 0 ? ((ctx.frame % duration) + duration) % duration : 0,
  };
}

/**
 * The context a nested symbol drawn by `entry` is evaluated in.
 *
 * The runtime builds every armature display up front, but only the CURRENT
 * one follows the parent: `fadeIn` hands the animation name down to it. A
 * display that becomes current later is reset and started with `play()` —
 * its default animation (the exporter's `defaultActions`, the first one),
 * from frame 0, at the frame it was swapped in (`Slot._updateDisplay`). A
 * track that starts late, or a blank key, swaps it out and back in too.
 */
export function displayContext(ctx: FrameContext, since: number): FrameContext {
  if (ctx.mode === "setup" || since <= 0) return ctx;
  return { ...ctx, frame: ctx.frame - since, defaultAnimation: true };
}

/**
 * Where in time a nested symbol's OWN children are looked at: its chosen
 * animation and its wrapped frame. The runtime's `Animation.fadeIn` hands the
 * name an armature is playing down to its children, so a grandchild matches
 * against the child's animation, not the root's — and
 * `previewClient.seekChildren` recurses the same way.
 */
export function innerContext(item: SymbolItem, ctx: FrameContext): FrameContext {
  if (ctx.mode === "setup") return SETUP_CONTEXT;
  const here = childFrame(item, ctx);
  return { animationName: here.animation?.name ?? null, frame: here.frame, mode: ctx.mode };
}

/**
 * Resolve a node's local transform at `frame`.
 *
 * In "setup" mode, and for any node without a track, this is the bind pose —
 * which is also what the exporter writes as the bone's origin.
 */
export function localAt(
  node: Node, animation: Animation | null, frame: number, mode: "setup" | "animate",
): { transform: Transform; displayIndex: number; color: ColorTransform; onTrack: boolean; since: number } {
  // The bind pose carries its own colour, which is what Setup mode and any
  // untracked node show; it exports as `slot.color`.
  const bindColor: ColorTransform = node.color ? { ...node.color } : { ...DEFAULT_COLOR };

  const track = mode === "animate" ? animation?.tracks[node.id] : undefined;
  if (!track) {
    // No track at all: the node is simply static, showing its bind pose at
    // every frame. (A node that HAS a track but whose track has not started
    // yet is a different case, handled below, and is genuinely not on stage.)
    return {
      transform: cloneTf(node.bind),
      displayIndex: node.setupDisplay ?? 0,
      color: bindColor,
      onTrack: true,
      since: 0,
    };
  }

  const sampled = sampleTransformRaw(track, frame);
  if (!sampled) {
    // Before the track's first keyframe: nothing is on stage yet.
    return {
      transform: cloneTf(node.bind),
      displayIndex: -1,
      color: bindColor,
      onTrack: false,
      since: 0,
    };
  }

  const i = spanIndexAt(track, frame);
  const govern = track.keys[i]!;
  let first = i;
  while (first > 0 && track.keys[first - 1]!.displayIndex === govern.displayIndex) first--;
  return {
    transform: { ...sampled },
    displayIndex: govern.displayIndex,
    // Tweened, not stepwise: the exporter emits colorFrame WITH tweenEasing,
    // so a stepwise read here would cut where the runtime fades.
    color: sampleColorRaw(track, frame) ?? bindColor,
    onTrack: frame <= track.endFrame,
    // Before the first key the slot shows nothing, so a run reaching it
    // starts at that key: 0 only for a track keyed from the start.
    since: track.keys[first]!.frame,
  };
}

/**
 * Evaluate a whole symbol at a frame, in paint order.
 *
 * Paint order is the reverse of the layer list: `layers[0]` is the TOP layer
 * in the UI, and DragonBones draws later `slot[]` entries in front, so the
 * bottom layer is painted first and exported first.
 *
 * `skins` are the skins shown (ARCHITECTURE ▸ Skins): what each slot shows
 * and which bones and constraints are on. null ignores skins altogether: the
 * bind pose a weighted mesh is measured against, by the stage and the
 * exporter alike.
 */
export function evaluateSymbol(
  symbol: SymbolItem,
  animation: Animation | null,
  frame: number,
  mode: "setup" | "animate" = "animate",
  skins: readonly string[] | null = stageSkinOf(symbol),
): Pose {
  const byNode = new Map<NodeId, PoseEntry>();
  const entries: PoseEntry[] = [];
  const lookup = skins ? skinLookup(symbol, skins) : null;
  const activity = skinActivity(symbol, skins);

  // Layers bottom-to-top = paint back-to-front.
  const ordered = [...symbol.layers].reverse();

  for (const layer of ordered) {
    const node = symbol.nodes[layer.nodeId];
    if (!node) continue;
    const { transform, displayIndex, color, onTrack, since } = localAt(node, animation, frame, mode);
    const shown = skinnedDisplay(node, displayIndex, lookup);
    // A sequence shows the image its keys pick (ARCHITECTURE ▸ Sequences).
    const display = shown?.sequence
      ? { ...shown, itemId: sequenceItemAt(shown.sequence, mode === "animate" ? animation : null, node.id, frame) }
      : shown;
    entries.push({
      nodeId: node.id,
      // A box, point or path as the shown skins outline it (`skinnedOutline`).
      node: skins && outlineField(node.kind) ? skinnedOutline(symbol, node, skins) : node,
      local: transform,
      world: mat(),
      color,
      displayIndex,
      display,
      displaySince: since,
      // A node with artwork is invisible on an index its list does not have.
      // A bone a skin switches off draws nothing (`skinActivity`).
      visible: layer.visible && onTrack && displayIndex >= 0 && (display !== null || !node.itemId) && !activity.inactive.has(node.id),
      drawIndex: entries.length,
    });
  }

  // Draw order keys: the drawing layers' places in the list take the key's
  // order; groups and bones keep theirs (they draw nothing).
  if (mode === "animate" && animation?.drawOrder?.length) {
    const order = orderAt(symbol, animation, frame);
    const drawing = new Set(order);
    const at = new Map(entries.map((e) => [e.nodeId as NodeId, e]));
    const slots = entries.map((e, i) => (drawing.has(e.nodeId) ? i : -1)).filter((i) => i >= 0);
    slots.forEach((i, n) => { entries[i] = at.get(order[n]!)!; });
    entries.forEach((e, i) => { e.drawIndex = i; });
  }

  for (const e of entries) byNode.set(e.nodeId, e);

  // Compose world matrices. Parenting is by node.parentId and is independent
  // of layer order, so resolve each chain on demand with memoisation rather
  // than assuming the list is already topologically sorted.
  const resolved = new Set<NodeId>();
  const resolving = new Set<NodeId>();

  const resolve = (entry: PoseEntry): void => {
    if (resolved.has(entry.nodeId)) return;
    if (resolving.has(entry.nodeId)) {
      // Cyclic parenting — treat as a root rather than recursing forever.
      toMatrix(entry.world, entry.local);
      resolved.add(entry.nodeId);
      return;
    }
    resolving.add(entry.nodeId);

    const local = toMatrix(mat(), entry.local);
    const parentId = anchorOf(entry.node);
    const parent = parentId ? byNode.get(parentId) : undefined;
    if (parent) {
      resolve(parent);
      mul(entry.world, parent.world, local);
    } else {
      entry.world = local;
    }

    resolving.delete(entry.nodeId);
    resolved.add(entry.nodeId);
  };

  for (const e of entries) resolve(e);

  applyConstraints(symbol, byNode, mode === "animate" ? animation : null, frame, activity);
  applyMeshes(symbol, entries, byNode, mode === "animate" ? animation : null, frame, mode, skins);

  return { entries, byNode };
}

/**
 * Solve the symbol's IK constraints, in place, on the composed world matrices.
 *
 * The editor solves at DISPLAY time and never writes the result into the
 * document, because that is exactly what the runtime does: the file carries
 * the chain's own pose plus its constraints, and the solve happens on
 * playback. Baking solved rotations into keyframes would look identical in
 * the editor and fight the runtime the moment the file was played back.
 *
 * The solve is Spine's (`core/math/ik.ts`), run in Spine's space: each
 * chain bone's local transform through `toBoneBurstLocal`, parent worlds
 * flipped to y up, the result's local rotations back through
 * `fromBoneBurstLocal`. It mirrors the exporter: the bend written inverted (the
 * flip mirrors the chain), a bone length only on bone nodes, and a zero
 * weight skipping the solve, as the runtime does. The weight and bend are the
 * animation's IK keys at the frame (`ikPoseAt`), the constraint's own without.
 */
/**
 * Meshes (ARCHITECTURE ▸ Meshes): each mesh display's world vertices by
 * `meshWorld`, after the constraints, so the renderer draws its triangles.
 * A weighted mesh needs the setup pose, which is this pose in Setup mode.
 */
function applyMeshes(
  symbol: SymbolItem, entries: PoseEntry[], byNode: Map<NodeId, PoseEntry>,
  animation: Animation | null, frame: number, mode: "setup" | "animate", skins: readonly string[] | null,
): void {
  let setup: Map<NodeId, PoseEntry> | null = null;
  // The bind pose ignores skins: a skin constraint must not move what a mesh is bound to.
  const same = mode === "setup" && (skins === null || !symbol.skins?.length);
  const setupOf = () => (setup ??= same ? byNode : evaluateSymbol(symbol, null, 0, "setup", null).byNode);
  const bonesOf = (e: PoseEntry) => ({
    now: (id: NodeId) => byNode.get(id)?.world,
    setup: (id: NodeId) => setupOf().get(id)?.world,
    node: setupOf().get(e.nodeId)?.world ?? e.world,
  });
  for (const e of entries) {
    // A weighted box or path follows its bones by the mesh rule.
    if (outlineWeighted(e.node)) { e.outline = outlineWorld(e.node, e.world, bonesOf(e)); continue; }
    const drawn = e.display ? meshOfDisplay(e.node, e.display, skinDisplayOf(symbol, e.node)) : null;
    if (!drawn) continue;
    // The keys of the display shown, in the skin it comes from (`drawnDeformTarget`).
    const from = shownInSkins(symbol, e.node, e.displayIndex, skins ?? []);
    const target = from ? drawnDeformTarget(e.nodeId, e.display!, from.skin, e.displayIndex) : null;
    const mesh = drawn.mesh;
    const weighted = !!mesh.weights?.some((w) => w.length);
    const bones = weighted ? bonesOf(e) : undefined;
    e.spine = {
      itemId: e.display!.itemId,
      vertices: meshWorld(mesh, drawn.pivot, e.world, target ? deformAt(animation, target, frame) : null, bones),
      uvs: meshUvs(mesh, mesh.width, mesh.height),
      triangles: mesh.triangles,
      quad: false,
    };
  }
}

function applyConstraints(
  symbol: SymbolItem, byNode: Map<NodeId, PoseEntry>, animation: Animation | null, frame: number, activity: SkinActivity,
): void {
  if (symbol.ik.length === 0 && !symbol.transforms?.length) return;

  const children = new Map<NodeId, PoseEntry[]>();
  for (const e of byNode.values()) {
    const parentId = anchorOf(e.node);
    if (!parentId) continue;
    const list = children.get(parentId);
    if (list) list.push(e);
    else children.set(parentId, [e]);
  }

  // Solved local transforms; the pose's own `local` stays what was keyed.
  const solved = new Map<NodeId, Transform>();
  const localOf = (e: PoseEntry): Transform => solved.get(e.nodeId) ?? e.local;
  const parentWorld = (e: PoseEntry): Matrix2D => {
    const parentId = anchorOf(e.node);
    return (parentId ? byNode.get(parentId)?.world : undefined) ?? mat();
  };

  /** Re-compose a subtree after the solver moved its root. */
  const recompose = (id: NodeId): void => {
    const parent = byNode.get(id);
    if (!parent) return;
    for (const child of children.get(id) ?? []) {
      mul(child.world, parent.world, toMatrix(mat(), localOf(child)));
      recompose(child.nodeId);
    }
  };

  const isDescendantOf = (id: NodeId, ancestorId: NodeId): boolean => {
    let cursor: NodeId | null | undefined = id;
    for (let guard = 0; cursor && guard < 64; guard++) {
      if (cursor === ancestorId) return true;
      cursor = byNode.get(cursor)?.node.parentId;
    }
    return false;
  };

  // The runtime's solvers (`core/boneburst/runtime/`) on a few `LooseBones`,
  // in Spine's space: y up, `a b c d` row-major with `(a, c)` the x axis.
  const putWorld = (bones: LooseBones, i: number, m: Matrix2D): void => bones.world.set([m.a, -m.c, -m.b, m.d, m.tx, -m.ty], i * 6);
  const takeWorld = (bones: LooseBones, i: number): Matrix2D => {
    const W = bones.world, w = i * 6;
    return { a: W[w]!, b: -W[w + 2]!, c: -W[w + 1]!, d: W[w + 3]!, tx: W[w + 4]!, ty: -W[w + 5]! };
  };
  const putLocal = (bones: LooseBones, i: number, t: BoneBurstLocal): void =>
    bones.local.set([t.x, t.y, t.rotation, t.scaleX, t.scaleY, t.shearX, t.shearY], i * 7);
  const takeLocal = (bones: LooseBones, i: number): Transform => {
    const L = bones.local, l = i * 7;
    return fromBoneBurstLocal({ x: L[l]!, y: L[l + 1]!, rotation: L[l + 2]!, scaleX: L[l + 3]!, scaleY: L[l + 4]!, shearX: L[l + 5]!, shearY: L[l + 6]! });
  };
  /** `e` as bone `i` under bone `i - 1`, which holds its parent's world. */
  const putBone = (bones: LooseBones, i: number, e: PoseEntry): void => {
    putWorld(bones, i - 1, parentWorld(e));
    putWorld(bones, i, e.world);
    putLocal(bones, i, toBoneBurstLocal(localOf(e)));
  };
  const lengthOf = (e: PoseEntry): number => (e.node.kind === "bone" ? e.node.boneLength ?? 0 : 0);

  const solveIk = (constraint: IkConstraint): void => {
    if (activity.ikOff.has(constraint.id)) return;
    const { mix, bendPositive, softness } = ikPoseAt(constraint, animation, frame);
    if (mix === 0) return;
    const effector = byNode.get(constraint.boneId);
    const target = byNode.get(constraint.targetId);
    if (!effector || !target || effector === target) return;

    // A chain of 2 needs a parent to root it, and falls back to the
    // one-bone solve when there is none (the exporter's rule too).
    const parent = effector.node.parentId ? byNode.get(effector.node.parentId) : undefined;
    const twoBone = constraint.chain > 0 && !!parent;
    const root = twoBone ? parent! : effector;

    // A target inside the chain would chase its own tail.
    if (isDescendantOf(target.nodeId, root.nodeId)) return;

    const tx = target.world.tx, ty = -target.world.ty;
    const rootParentWorld = parentWorld(root);
    const scaleY = constraint.scaleY ?? "none";
    if (twoBone) {
      // 0: the chain's parent, 1: its root, 2: the effector.
      const bones = new LooseBones([{ parent: -1, length: 0 }, { parent: 0, length: lengthOf(root) }, { parent: 1, length: lengthOf(effector) }]);
      putBone(bones, 1, root);
      putWorld(bones, 2, effector.world);
      putLocal(bones, 2, toBoneBurstLocal(localOf(effector)));
      // The exporter writes the stage's bend the other way round (y up).
      twoBones(bones, 1, 2, tx, ty, bendPositive ? -1 : 1, !!constraint.stretch, scaleY, softness, mix);
      solved.set(root.nodeId, takeLocal(bones, 1));
      solved.set(effector.nodeId, takeLocal(bones, 2));
    } else {
      const bones = new LooseBones([{ parent: -1, length: 0 }, { parent: 0, length: lengthOf(root) }]);
      putBone(bones, 1, root);
      oneBone(bones, 1, tx, ty, !!constraint.compress, !!constraint.stretch, scaleY, mix);
      solved.set(root.nodeId, takeLocal(bones, 1));
    }
    mul(root.world, rootParentWorld, toMatrix(mat(), localOf(root)));
    recompose(root.nodeId);
  };

  const solveTc = (constraint: TransformConstraint): void => {
    if (activity.tcOff.has(constraint.id)) return;
    const mix = tcMixAt(constraint, animation, frame);
    if (!mix.rotate && !mix.x && !mix.y && !mix.scaleX && !mix.scaleY && !mix.shearY) return;
    const source = byNode.get(constraint.sourceId);
    if (!source) return;
    // 0: the source's parent, 1: the source, 2: the bone's parent, 3: the bone.
    const k = { ...tcSolveOf(constraint), source: 1, bones: [3] };
    for (const id of constraint.boneIds) {
      const e = byNode.get(id);
      if (!e || e === source) continue;
      const bones = new LooseBones([{ parent: -1, length: 0 }, { parent: 0, length: lengthOf(source) }, { parent: -1, length: 0 }, { parent: 2, length: lengthOf(e) }]);
      putBone(bones, 1, source);
      putBone(bones, 3, e);
      solveTransform(bones, k, mix);
      // A world write derives the bone's local pose at once, as the runtime
      // does: a later change to its parent rebuilds it from that.
      solved.set(id, takeLocal(bones, 3));
      if (k.localTarget) mul(e.world, parentWorld(e), toMatrix(mat(), localOf(e)));
      else e.world = takeWorld(bones, 3);
      recompose(id);
    }
  };

  // In the symbol's constraint order (ARCHITECTURE ▸ Constraint order): by
  // default every IK, then every transform constraint.
  const steps = [
    ...symbol.ik.map((k) => ({ name: k.name, run: () => solveIk(k) })),
    ...(symbol.transforms ?? []).map((k) => ({ name: k.name, run: () => solveTc(k) })),
  ];
  for (const step of byOrder(steps, symbol.constraintOrder, (t) => t.name)) step.run();
}

/**
 * A node's local drawing box, with its transform point at the origin.
 * Lives here rather than in the view layer so both the overlay and the gizmo
 * can use it without importing each other.
 */
export function localBox(
  project: Project, itemId: string | undefined, pivot: { x: number; y: number },
  ctx: FrameContext = SETUP_CONTEXT,
): { x: number; y: number; w: number; h: number } | null {
  if (!itemId) return null;
  const item = project.items[itemId as ItemId];
  if (isImage(item)) {
    return { x: -pivot.x, y: -pivot.y, w: item.width, h: item.height };
  }
  if (isSymbol(item)) {
    const b = symbolBounds(project, item.id, ctx);
    // An empty symbol has no bounds, but it IS on the stage. Giving it a
    // placeholder box keeps hit testing, the gizmo and the bounds cache in
    // agreement, so it can be selected and moved instead of being an
    // invisible thing nothing can reach.
    if (b.w === 0 && b.h === 0) {
      const half = EMPTY_SYMBOL_SIZE / 2;
      return { x: -half - pivot.x, y: -half - pivot.y, w: EMPTY_SYMBOL_SIZE, h: EMPTY_SYMBOL_SIZE };
    }
    return { x: b.x - pivot.x, y: b.y - pivot.y, w: b.w, h: b.h };
  }
  return null;
}

/** The display an entry shows and its transform point; display 0 when it
 *  shows none, which is what Setup mode and the bind pose stand for. */
export function shownDisplay(e: PoseEntry): { index: number; pivot: { x: number; y: number } } {
  return e.display ? { index: e.displayIndex, pivot: e.display.pivot } : { index: 0, pivot: e.node.pivot };
}

/** `localBox` for what a pose entry shows at its frame. */
export function entryBox(
  project: Project, e: PoseEntry, ctx: FrameContext = SETUP_CONTEXT,
): { x: number; y: number; w: number; h: number } | null {
  if (e.spine) return boneburstBox(e);
  if (e.node.kind === "box" || e.node.kind === "point" || e.node.kind === "path") return boxNodeBounds(e.node);
  if (!e.display) return null;
  return localBox(project, e.display.itemId, e.display.pivot, displayContext(ctx, e.displaySince));
}

/** What the runtime drew for an entry, boxed in the entry's own space. */
function boneburstBox(e: PoseEntry): { x: number; y: number; w: number; h: number } | null {
  const v = e.spine!.vertices, p = { x: 0, y: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < v.length; i += 2) {
    if (!applyInverse(p, e.world, v[i]!, v[i + 1]!)) return null;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * The image pixel the runtime drew at a point of the symbol's space, for
 * an entry it posed; null outside its triangles.
 */
export function boneburstPixelAt(e: PoseEntry, x: number, y: number): { x: number; y: number } | null {
  const s = e.spine;
  if (!s) return null;
  const v = s.vertices, uv = s.uvs, t = s.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 2, b = t[i + 1]! * 2, c = t[i + 2]! * 2;
    const d = (v[b + 1]! - v[c + 1]!) * (v[a]! - v[c]!) + (v[c]! - v[b]!) * (v[a + 1]! - v[c + 1]!);
    if (Math.abs(d) < 1e-12) continue;
    const l0 = ((v[b + 1]! - v[c + 1]!) * (x - v[c]!) + (v[c]! - v[b]!) * (y - v[c + 1]!)) / d;
    const l1 = ((v[c + 1]! - v[a + 1]!) * (x - v[c]!) + (v[a]! - v[c]!) * (y - v[c + 1]!)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
    return { x: l0 * uv[a]! + l1 * uv[b]! + l2 * uv[c]!, y: l0 * uv[a + 1]! + l1 * uv[b + 1]! + l2 * uv[c + 1]! };
  }
  return null;
}

/** On-stage footprint of a symbol that has nothing in it yet. */
export const EMPTY_SYMBOL_SIZE = 48;

/** True when this display is an instance of a symbol with no content. */
export function isEmptySymbolInstance(project: Project, display: DisplayRef | null): boolean {
  if (!display) return false;
  const item = project.items[display.itemId];
  if (!isSymbol(item)) return false;
  const b = symbolBounds(project, item.id);
  return b.w === 0 && b.h === 0;
}

/**
 * A point in the symbol's space, expressed where `node`'s own position lives:
 * its parent's space. Placing something at a pointer inside a moved or
 * rotated group has to go through this, or it lands offset by the group.
 */
export function pointInParent(pose: Pose, node: Node, x: number, y: number): { x: number; y: number } {
  const parent = node.parentId ? pose.byNode.get(node.parentId)?.world : undefined;
  const out = { x, y };
  if (parent && !applyInverse(out, parent, x, y)) return { x, y };
  return out;
}

/** World matrix of one node, or null when it is not in the pose. */
export function worldOf(pose: Pose, nodeId: NodeId): Matrix2D | null {
  const e = pose.byNode.get(nodeId);
  return e ? clone(e.world) : null;
}

/**
 * The untrimmed pixel size a node's display draws at: an image's own size,
 * or a symbol's content bounds. Used for pivots, bounds and hit testing.
 */
export function displaySize(project: Project, node: Node, display = 0): { w: number; h: number } {
  const ref = displayAt(node, display) ?? displayAt(node, 0);
  if (!ref) return { w: 0, h: 0 };
  const item = project.items[ref.itemId];
  if (isImage(item)) return { w: item.width, h: item.height };
  if (isSymbol(item)) {
    const b = symbolBounds(project, item.id);
    return { w: b.w, h: b.h };
  }
  return { w: 0, h: 0 };
}

/**
 * Content bounds of a symbol in its own space, memoised. Invalidated by
 * `invalidateBounds` whenever a command touches the symbol — this cache is
 * the real implementation cost of "edit the library item, every instance
 * updates".
 */
const boundsCache = new Map<string, { w: number; h: number; x: number; y: number }>();
/** The cache keys holding each item's bounds, so invalidating one item does
 *  not scan the whole cache. */
const keysByItem = new Map<ItemId, Set<string>>();
/** Library item -> the symbols whose cached bounds were measured through it.
 *  Editing a symbol, or replacing an image, changes the bounds of everything
 *  that contains it. */
const usedBy = new Map<ItemId, Set<ItemId>>();
/** Scrubbing a timeline adds a key per frame; the oldest go first. */
const BOUNDS_CACHE_MAX = 512;

/** Cache key: bounds move with the frame once a symbol animates internally. */
function boundsKey(id: ItemId, ctx: FrameContext): string {
  if (ctx.mode === "setup") return `${id}|setup`;
  const animation = ctx.defaultAnimation ? "default" : `named:${ctx.animationName ?? ""}`;
  return `${id}|${animation}|${ctx.frame}`;
}

function remember(id: ItemId, key: string, bounds: { w: number; h: number; x: number; y: number }): void {
  if (boundsCache.size >= BOUNDS_CACHE_MAX) {
    const oldest = boundsCache.keys().next().value!;
    boundsCache.delete(oldest);
    keysByItem.get(oldest.slice(0, oldest.indexOf("|")) as ItemId)?.delete(oldest);
  }
  boundsCache.set(key, bounds);
  let keys = keysByItem.get(id);
  if (!keys) keysByItem.set(id, (keys = new Set()));
  keys.add(key);
}

/** Drop the cached bounds of `ids` and of every symbol containing them;
 *  everything without `ids`. */
export function invalidateBounds(ids?: ItemId[]): void {
  if (!ids) {
    boundsCache.clear();
    keysByItem.clear();
    usedBy.clear();
    return;
  }
  const queue = [...ids];
  const seen = new Set<ItemId>();
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const key of keysByItem.get(id) ?? []) boundsCache.delete(key);
    keysByItem.delete(id);
    const parents = usedBy.get(id);
    usedBy.delete(id);
    if (parents) queue.push(...parents);
  }
}

export function symbolBounds(
  project: Project, id: ItemId, ctx: FrameContext = SETUP_CONTEXT, depth = 0,
): { x: number; y: number; w: number; h: number } {
  const key = boundsKey(id, ctx);
  const hit = boundsCache.get(key);
  if (hit) return hit;
  const empty = { x: 0, y: 0, w: 0, h: 0 };
  if (depth > 10) return empty;              // depth cap guards hand-edited cycles

  const sym = project.items[id];
  if (!isSymbol(sym)) return empty;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const here = childFrame(sym, ctx);
  const inner = innerContext(sym, ctx);
  // Only the exported symbol's skins reach the export (ARCHITECTURE ▸ Skins).
  const pose = evaluateSymbol(sym, here.animation, here.frame, ctx.mode, depth === 0 ? stageSkinOf(sym) : null);
  for (const e of pose.entries) {
    if (!e.display) continue;
    const item = project.items[e.display.itemId];
    let w = 0, h = 0, ox = 0, oy = 0;
    if (item) {
      let parents = usedBy.get(item.id);
      if (!parents) usedBy.set(item.id, (parents = new Set()));
      parents.add(id);
    }
    if (isImage(item)) { w = item.width; h = item.height; }
    else if (isSymbol(item)) {
      const b = symbolBounds(project, item.id, displayContext(inner, e.displaySince), depth + 1);
      w = b.w; h = b.h; ox = b.x; oy = b.y;
    }
    if (w === 0 && h === 0) continue;

    const px = e.display.pivot.x - ox, py = e.display.pivot.y - oy;
    for (const [cx, cy] of [[-px, -py], [w - px, -py], [w - px, h - py], [-px, h - py]] as const) {
      const x = e.world.a * cx + e.world.c * cy + e.world.tx;
      const y = e.world.b * cx + e.world.d * cy + e.world.ty;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const out = Number.isFinite(minX)
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : empty;
  remember(id, key, out);
  return out;
}
