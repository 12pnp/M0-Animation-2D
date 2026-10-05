import { fileLengthsOf } from "./importAttachments";
import type { Animation, DisplayRef, MeshData, OutlineWeights, ImageItem, Layer, Node, Project, SymbolItem } from "@/core/doc/types";
import { outlineAsMesh, pointToBoneBurst, skinnedOutline } from "@/core/doc/boxes";
import type { DeformTarget } from "@/core/mesh/deform";
import { byOrder } from "@/core/doc/constraintOrder";
import { inheritTimeline } from "@/core/doc/inherit";
import { DEFAULT_COLOR, isImage, isSymbol, producesSlot } from "@/core/doc/types";
import type { CnId, IkId, ItemId, NodeId, TcId } from "@/core/doc/ids";
import { maskGroups } from "@/core/doc/layerTree";
import { type MeshBones, meshUvs, boneburstVertices } from "@/core/mesh/meshPose";
import type { Contour } from "@/core/atlas/contour";
import { nz } from "@/core/math/angle";
import { mat, type Matrix2D } from "@/core/math/Matrix2D";
import { meshOfDisplay } from "@/core/doc/displays";
import { skinDisplayOf } from "@/core/doc/skins";
import { sequenceNaming } from "@/core/doc/sequence";
import { withoutNonessential } from "./nonessential";
import { sanitizeExportSettings } from "@/core/export/settings";
import { pathLengths, pathToBoneBurst, physicsToBoneBurst, runtimeSolved, sliderToBoneBurst } from "@/core/doc/constraints";
import { childFrame, displayContext, evaluateSymbol, localAt } from "@/core/doc/pose";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { bonesToIndices, lastTime, regionsOf, SKIN_CONSTRAINT_KINDS } from "./carry";
import { keyTime, regionCentre, type BoneBurstLocal, toBoneBurstLocal } from "./transform";
import {
  BONEBURST_VERSION,
  type BoneBurstAnimation,
  type BoneBurstBone,
  type BoneBurstAttachment,
  type BoneBurstClippingAttachment,
  type BoneBurstConstraint,
  type BoneBurstDrawOrderKey,
  type BoneBurstIkConstraint,
  type BoneBurstTransformConstraint,
  type BoneBurstRaw,
  type BoneBurstSkin,
  type BoneBurstRegionAttachment,
  type BoneBurstSkeletonFile,
  type BoneBurstSlot,
} from "./types";
import { ROOT_BONE, type SlotPlan, type Scope, type FrameAt, MAX_DEPTH } from "./exportTypes";
import { hasOffsets, lightHex, darkHex, tintExact, warnOffsets, colorHex, blendOf } from "./exportColor";
import { scaleAlpha, runsOf } from "./exportChannels";
import { transformConstraintOf, deformTimelines, boneTimelines, slotTimelines, drawOrderTimeline, ikTimelines, transformTimelines, eventTimeline, constraintKeyTimelines, omitKey, eventDefsOf } from "./exportTimelines";
import { uniqueNames, excludedNodes, reportExcluded, nodesInHierarchyOrder, withoutDefaults, exportedDisplays, reportImageNames, skinsOfModel } from "./exportStructure";
import { rootBoneOf, mergeAttachmentTimelines, checkCarried } from "./exportCarry";
import { rides } from "./exportStructure";

export interface BoneBurstExport {
  skeleton: BoneBurstSkeletonFile;
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
 * colour offsets become two-colour tint (`lightHex`, `darkHex`).
 */
export interface ExportOptions {
  /**
   * The outline a mask image clips with, in its pixels (`traceContour`).
   * The io layer traces the decoded image; without it, the image's
   * rectangle.
   */
  maskShape?: (item: ImageItem) => Contour;
  /** The skeleton without the editor's keys: what the stage's Spine pose
   *  needs (`boneburstPose.ts`), which sets the keyed pose itself. Carried
   *  timelines are still written, and a slider's animation whole. */
  setupOnly?: boolean;
}

function rectangleShape(item: ImageItem): Contour {
  const w = item.width, h = item.height;
  return { points: [0, 0, w, 0, w, h, 0, h], islands: 0, holes: 0, soft: false };
}

export function exportBoneBurst(
  project: Project, symbolId: ItemId = project.rootSymbolId, options: ExportOptions = {},
): BoneBurstExport {
  const diagnostics: ExportDiagnostic[] = [];
  const usedImages = new Set<ItemId>();
  const sym = project.items[symbolId];
  if (!isSymbol(sym)) {
    diagnostics.push({ severity: "error", message: "There is no symbol to export." });
    return { skeleton: { skeleton: { spine: BONEBURST_VERSION }, bones: [] }, diagnostics, usedImages: [], names: new Map(), paths: new Map(), slots: new Map(), displayKeys: new Map() };
  }
  const fps = project.frameRate;

  // An opened Spine file brings its own root bone, whatever it is called;
  // a bone named "root" at the top is one too. Otherwise one is added.
  const ownRoot = rootBoneOf(sym);
  const bones: BoneBurstBone[] = ownRoot ? [] : [{ name: ROOT_BONE }];
  const slots: BoneBurstSlot[] = [];
  const slotPaths = new Map<string, string>();
  const displayKeys = new Map<string, Map<number, string>>();
  const attachments: Record<string, Record<string, BoneBurstAttachment>> = {};
  const constraints: Array<BoneBurstIkConstraint | BoneBurstTransformConstraint> = [];
  /** The exported symbol's constraints as written, for its IK keys. */
  const rootIk = new Map<IkId, BoneBurstIkConstraint>();
  const rootTc = new Map<TcId, BoneBurstTransformConstraint>();
  /** The exported symbol's physics, slider and path constraints as written, for its skins. */
  const rootCn = new Map<CnId, Record<string, unknown>>();
  /** The exported symbol's skins' attachments: skin → slot → key. */
  const skinAttachments = new Map<string, Record<string, Record<string, BoneBurstAttachment>>>();
  const skinsWarned = new Set<ItemId>();
  const runtimeWarned = new Set<ItemId>();
  const tcKeysWarned = new Set<ItemId>();
  const ikKeysWarned = new Set<ItemId>();
  /** The exported symbol's mesh displays, for their deform keys. */
  /** The exported symbol's sequence displays, for their sequence keys. */
  const rootSequences: Array<{ nodeId: NodeId; slot: string; key: string }> = [];
  const rootMeshes: Array<{ target: DeformTarget; slot: string; key: string; mesh: MeshData; pivot: { x: number; y: number }; bones: MeshBones | null }> = [];
  const setupPoses = new Map<ItemId, Map<NodeId, { world: Matrix2D }>>();
  const setupOf = (sym: SymbolItem) => setupPoses.get(sym.id) ?? setupPoses.set(sym.id, evaluateSymbol(sym, null, 0, "setup", null).byNode).get(sym.id)!;
  const eventKeysWarned = new Set<ItemId>();
  const setups = new Map<string, BoneBurstLocal>();
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
  /** The top-level layers' runs of slots, in setup order (`drawOrderTimeline`). */
  const slotBlocks: Array<{ ids: NodeId[]; start: number; end: number }> = [];

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
      const setup = toBoneBurstLocal(node.bind);
      const name = nameOf(node.id);
      setups.set(name, setup);
      paths.set(pathOf(node.id), name);
      const parent = node === ownRoot ? undefined
        : node.parentId && !dropped(node.parentId) ? nameOf(node.parentId) : scope.parentBone;
      const bone: BoneBurstBone = parent === undefined ? { name, ...withoutDefaults(setup) } : { name, parent, ...withoutDefaults(setup) };
      if (node.kind === "bone" && node.boneLength) bone.length = node.boneLength;
      if (node.inherit && node.inherit !== "normal") bone.inherit = node.inherit;
      if (node.kind === "bone" && node.boneColor) bone.color = node.boneColor;
      if (node.kind === "bone" && node.boneIcon) (bone as unknown as Record<string, unknown>).icon = node.boneIcon;
      if (node.spine?.bone) Object.assign(bone, node.spine.bone);
      bones.push(bone);
      boneNodes.push({ scope, node, name });
    }

    const firstConstraint = constraints.length;
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
      const ik: BoneBurstIkConstraint = { type: "ik", name: scope.prefix + k.name, bones: chain, target: nameOf(target.id) };
      if (k.weight !== 1) ik.mix = k.weight;
      // The y flip mirrors the rig, and a mirrored two-bone chain bends the
      // other way: the editor's positive bend (y down) is Spine's negative.
      if (k.bendPositive) ik.bendPositive = false;
      if (k.softness) ik.softness = k.softness;
      if (k.compress) ik.compress = true;
      if (k.stretch) ik.stretch = true;
      if (k.scaleY) ik.scaleY = k.scaleY;
      if (k.spine) Object.assign(ik, k.spine);
      constraints.push(ik);
      if (scope.depth === 0) rootIk.set(k.id, ik);
    }
    if (scope.depth > 0 && !ikKeysWarned.has(s.id) && s.animations.some((a) => a.ik && Object.keys(a.ik).length)) {
      ikKeysWarned.add(s.id);
      diagnostics.push({ severity: "warning", message: `"${s.name}" keys its IK, but only the exported symbol's IK keys are written; a nested symbol's play its constraints' own mix and bend.` });
    }
    for (const k of s.transforms ?? []) {
      const source = dropped(k.sourceId) ? undefined : s.nodes[k.sourceId];
      const bones = k.boneIds.filter((id) => !dropped(id) && s.nodes[id]).map((id) => nameOf(id));
      if (!source || !bones.length) {
        diagnostics.push({ severity: "warning", message: `Transform constraint "${k.name}" references a missing bone; skipped.` });
        continue;
      }
      const tc = transformConstraintOf(k, scope.prefix + k.name, bones, nameOf(source.id));
      constraints.push(tc);
      if (scope.depth === 0) rootTc.set(k.id, tc);
    }
    // Physics, sliders and paths (ARCHITECTURE ▸ Physics, sliders and paths):
    // the exported symbol's own, a nested one's warned about.
    if (scope.depth === 0) {
      const named = (id: NodeId | undefined) => (id && s.nodes[id] && !dropped(id) ? nameOf(id) : null);
      const skip = (kind: string, name: string) => diagnostics.push({ severity: "warning", message: `${kind} "${name}" references a missing bone, path or animation; skipped.` });
      const add = (id: CnId, c: Record<string, unknown>) => { constraints.push(c as never); rootCn.set(id, c); };
      for (const k of s.physics ?? []) {
        const bone = named(k.boneId);
        if (bone) add(k.id, physicsToBoneBurst(k, bone)); else skip("Physics constraint", k.name);
      }
      for (const k of s.paths ?? []) {
        const bones = k.boneIds.map(named).filter((n): n is string => !!n);
        const slot = s.nodes[k.pathId]?.kind === "path" ? named(k.pathId) : null;
        if (bones.length && slot) add(k.id, pathToBoneBurst(k, bones, slot)); else skip("Path constraint", k.name);
      }
      for (const k of s.sliders ?? []) {
        const anim = s.animations.find((a) => a.id === k.animId);
        const bone = k.boneId ? named(k.boneId) : null;
        if (anim && (!k.boneId || bone)) add(k.id, sliderToBoneBurst(k, anim.name, bone)); else skip("Slider", k.name);
      }
    } else if (runtimeSolved(s) && !runtimeWarned.has(s.id)) {
      runtimeWarned.add(s.id);
      diagnostics.push({ severity: "warning", message: `"${s.name}" has physics, slider or path constraints, but only the exported symbol's are written.` });
    }
    // Spine applies them in list order: the scope's own order (ARCHITECTURE ▸ Constraint order).
    if (s.constraintOrder?.length) {
      const own = constraints.splice(firstConstraint);
      constraints.push(...byOrder(own, s.constraintOrder, (c) => c.name.slice(scope.prefix.length)));
    }
    if (scope.depth > 0 && !tcKeysWarned.has(s.id) && s.animations.some((a) => a.transforms && Object.keys(a.transforms).length)) {
      tcKeysWarned.add(s.id);
      diagnostics.push({ severity: "warning", message: `"${s.name}" keys its transform constraints, but only the exported symbol's keys are written.` });
    }
    if (scope.depth > 0 && !eventKeysWarned.has(s.id) && s.animations.some((a) => a.events?.length)) {
      eventKeysWarned.add(s.id);
      diagnostics.push({ severity: "warning", message: `"${s.name}" fires events, but only the exported symbol's events are written.` });
    }

    const emitLayer = (layer: Layer): void => {
      const node = s.nodes[layer.nodeId];
      if (!node || !producesSlot(node) || skipped.has(node.id)) return;
      const name = nameOf(node.id);
      const riding = rides(s, node);
      const keys = new Map<number, string>();
      const slotAttachments: Record<string, BoneBurstAttachment> = {};
      const taken = new Set<string>();
      const symbolDisplays: Array<[number, DisplayRef]> = [];
      /** The attachment a display writes under `key`: as an opened file had
       *  it, a mesh, or a region. Only the default skin's meshes take deform keys. */
      /** `skin` null: the node's own display `index`. */
      const attachmentOf = (ref: DisplayRef, item: ImageItem, key: string, index: number, skin: string | null): BoneBurstAttachment => {
        const att = attachmentBody(ref, item, key, index, skin);
        // The attachment's own colour (`DisplayRef.tint`).
        if (ref.tint) (att as unknown as Record<string, unknown>).color = ref.tint;
        return att;
      };
      const attachmentBody = (ref: DisplayRef, item: ImageItem, key: string, index: number, skin: string | null): BoneBurstAttachment => {
        const own = skin === null;
        if (ref.attachment) {
          // As the file had it, drawing the image the display names now.
          const data = { ...ref.attachment.data };
          if ((regionsOf(data, key)[0] ?? key) !== item.name) data.path = item.name;
          return data;
        }
        if (ref.linked) {
          // A linked mesh (ARCHITECTURE ▸ Meshes ▸ Linked meshes): Spine 4.3 names
          // its source mesh by key, in this slot when `slot` is left out.
          const source = keys.get(ref.linked.to);
          if (!source || !meshOfDisplay(node, ref, skinDisplayOf(s, node))) {
            diagnostics.push({ severity: "error", message: `"${node.name}" ▸ "${key}" is linked to a display that is not a mesh in the file.` });
          }
          const linked: Record<string, unknown> = { type: "linkedmesh", source: source ?? key, width: item.width, height: item.height };
          if (ref.linked.skin) linked.skin = ref.linked.skin;
          if (ref.name) linked.name = ref.name;
          if ((ref.name ?? key) !== item.name) linked.path = item.name;
          if (ref.linked.deform === false) linked.timelines = false;
          return linked as unknown as BoneBurstAttachment;
        }
        if (ref.mesh) {
          // A mesh (ARCHITECTURE ▸ Meshes): `boneburstVertices` in the slot bone's
          // space, or per bone at the setup pose for a weighted one.
          const setupPose = setupOf(s);
          const bones: MeshBones | null = ref.mesh.weights?.some((w) => w.length) ? {
            now: (id) => (dropped(id) ? undefined : setupPose.get(id)?.world),
            setup: (id) => (dropped(id) ? undefined : setupPose.get(id)?.world),
            node: setupPose.get(node.id)?.world ?? mat(),
          } : null;
          const mesh: Record<string, unknown> = {
            type: "mesh", uvs: meshUvs(ref.mesh, ref.mesh.width, ref.mesh.height), triangles: [...ref.mesh.triangles],
            vertices: boneburstVertices(ref.mesh, ref.pivot, bones, (id) => nameOf(id), node.slotBone ?? node.id), hull: ref.mesh.hull,
            width: ref.mesh.width, height: ref.mesh.height,
          };
          if (ref.mesh.edges?.length) mesh.edges = [...ref.mesh.edges];
          // The path defaults to the name, which defaults to the key.
          if (ref.name) mesh.name = ref.name;
          if ((ref.name ?? key) !== item.name) mesh.path = item.name;
          // Its deform keys, in its skin at its display (`deformKeysOf`).
          if (scope.depth === 0) rootMeshes.push({ target: { nodeId: node.id, skin, index }, slot: name, key, mesh: ref.mesh, pivot: ref.pivot, bones });
          return mesh as unknown as BoneBurstAttachment;
        }
        const centre = regionCentre(item.width, item.height, ref.pivot);
        const region: BoneBurstRegionAttachment = { width: item.width, height: item.height };
        if (key !== item.name) region.path = item.name;
        if (ref.sequence) {
          // A sequence (ARCHITECTURE ▸ Sequences): the regions are path + number.
          const frames = ref.sequence.items.map((id) => project.items[id]).filter(isImage);
          const naming = frames.length === ref.sequence.items.length ? sequenceNaming(frames.map((f) => f.name)) : null;
          if (naming) {
            for (const f of frames) usedImages.add(f.id);
            region.path = naming.path;
            const seq: Record<string, number> = { count: frames.length, start: naming.start, digits: naming.digits };
            if (ref.sequence.setup) seq.setup = ref.sequence.setup;
            (region as unknown as Record<string, unknown>).sequence = seq;
            if (own && scope.depth === 0) rootSequences.push({ nodeId: node.id, slot: name, key });
          } else {
            diagnostics.push({ severity: "error", message: `"${node.name}"'s sequence images are not named one number after another (fire_01, fire_02, …); Spine finds them by name.` });
          }
        }
        if (centre.x !== 0) region.x = centre.x;
        if (centre.y !== 0) region.y = centre.y;
        // An opened region's turn, about its centre (`DisplayRef.region`).
        if (ref.region) {
          const r = region as unknown as Record<string, number>;
          if (ref.region.rotation) r.rotation = ref.region.rotation;
          if (ref.region.scaleX !== undefined && ref.region.scaleX !== 1) r.scaleX = ref.region.scaleX;
          if (ref.region.scaleY !== undefined && ref.region.scaleY !== 1) r.scaleY = ref.region.scaleY;
        }
        return region;
      };
      // A box or point node (ARCHITECTURE ▸ Boxes and points): one attachment,
      // under the node's name, at the slot bone, which is the node itself.
      if (node.kind === "box" || node.kind === "point" || node.kind === "path") {
        const key = node.key ?? node.name;
        const colored = (att: Record<string, unknown>) => (node.attachmentColor ? { ...att, color: node.attachmentColor } : att) as BoneBurstAttachment;
        // A weighted box or path is written per bone, as a weighted mesh is.
        const outlineVertices = (o: { points: number[] } & OutlineWeights): Array<number | string> => {
          if (!o.weights?.some((w) => w.length)) return o.points.map((v, i) => nz(i % 2 ? -v : v));
          const setupPose = setupOf(s);
          const bones: MeshBones = {
            now: (id) => (dropped(id) ? undefined : setupPose.get(id)?.world),
            setup: (id) => (dropped(id) ? undefined : setupPose.get(id)?.world),
            node: setupPose.get(node.id)?.world ?? mat(),
          };
          return boneburstVertices(outlineAsMesh(o), { x: 0, y: 0 }, bones, (id) => nameOf(id), node.slotBone ?? node.id);
        };
        /** The attachment of `n` (the node, or as a skin outlines it); null, left out. */
        const outlineAttachment = (n: Node, where: string): BoneBurstAttachment | null => {
          if (n.kind === "path") {
            const shape = n.path;
            if (!shape || shape.points.length < 12) { diagnostics.push({ severity: "warning", message: `Path "${node.name}"${where} has fewer than two knots; it is left out.` }); return null; }
            const att: Record<string, unknown> = { type: "path" };
            if (shape.closed) att.closed = true;
            if (shape.constantSpeed === false) att.constantSpeed = false;
            att.vertexCount = shape.points.length / 2;
            att.vertices = outlineVertices(shape);
            att.lengths = fileLengthsOf(shape) ?? pathLengths(shape);
            return colored(att);
          }
          if (n.kind === "point") return colored({ type: "point", ...pointToBoneBurst(n) });
          if ((n.box?.points.length ?? 0) < 6) { diagnostics.push({ severity: "warning", message: `Bounding box "${node.name}"${where} has fewer than three points; it is left out.` }); return null; }
          return colored({ type: "boundingbox", vertexCount: n.box!.points.length / 2, vertices: outlineVertices(n.box!) });
        };
        const own = outlineAttachment(node, "");
        if (own) { keys.set(0, key); slotAttachments[key] = own; }
        // Each skin's own outline under the same key (`SkinDef.outlines`), at the top only.
        if (scope.depth === 0) {
          for (const def of s.skins ?? []) {
            if (!def.outlines?.[node.id]) continue;
            const att = outlineAttachment(skinnedOutline(s, node, [def.name]), ` in skin "${def.name}"`);
            if (!att) continue;
            keys.set(0, key);
            let bySlot = skinAttachments.get(def.name);
            if (!bySlot) skinAttachments.set(def.name, bySlot = {});
            (bySlot[name] ??= {})[key] = att;
          }
        }
      }
      // Skins (ARCHITECTURE ▸ Skins) only at the top: a nested symbol's are not written.
      const skinned = scope.depth === 0;
      // Every key first: a linked mesh names its parent's.
      const written: Array<[DisplayRef, ImageItem, string, number]> = [];
      for (const [index, ref] of exportedDisplays(s, node, skinned)) {
        const item = project.items[ref.itemId];
        if (isSymbol(item)) { symbolDisplays.push([index, ref]); continue; }
        if (!isImage(item)) {
          diagnostics.push({ severity: "warning", message: `"${node.name}" points at a library item that no longer exists.` });
          continue;
        }
        let key = ref.attachment?.name ?? ref.key ?? item.name;
        if (ref.attachment || ref.key) { if (taken.has(key)) continue; }
        else for (let n = 2; taken.has(key); n++) key = `${item.name} (${n})`;
        taken.add(key);
        keys.set(index, key);
        // A display only skins fill keeps its key out of the default skin.
        if (skinned && ref.skinOnly) continue;
        usedImages.add(item.id);
        written.push([ref, item, key, index]);
      }
      for (const [ref, item, key, index] of written) slotAttachments[key] = attachmentOf(ref, item, key, index, null);
      if (skinned) {
        for (const def of s.skins ?? []) {
          for (const [index, ref] of Object.entries(def.displays?.[node.id] ?? {})) {
            const key = keys.get(Number(index));
            const item = project.items[ref.itemId];
            if (!key || !isImage(item)) continue;
            usedImages.add(item.id);
            let bySlot = skinAttachments.get(def.name);
            if (!bySlot) skinAttachments.set(def.name, bySlot = {});
            (bySlot[name] ??= {})[key] = attachmentOf(ref, item, key, Number(index), def.name);
          }
        }
      } else if (s.skins?.length && !skinsWarned.has(s.id)) {
        skinsWarned.add(s.id);
        diagnostics.push({ severity: "warning", message: `"${s.name}" has skins, but only the exported symbol's skins are written; its default skin is.` });
      }

      if (keys.size || riding) {
        if (Object.keys(slotAttachments).length) attachments[name] = slotAttachments;
        slotPaths.set(pathOf(node.id), name);
        displayKeys.set(pathOf(node.id), keys);
        const slot: BoneBurstSlot = { name, bone: riding ? nameOf(node.slotBone!) : name };
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
        const blend = blendOf(node);
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
        const offset = toBoneBurstLocal({ x: -ref.pivot.x, y: -ref.pivot.y, skewX: 0, skewY: 0, scaleX: 1, scaleY: 1 });
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
      let clip: { index: number; name: string; atts: BoneBurstClippingAttachment[]; plan: SlotPlan } | null = null;
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
    // At the top, each layer's run of slots (its own, and a nested symbol's
    // flattened under it) is recorded: draw order keys move them as one block.
    const done = new Set<string>();
    const block = (ids: NodeId[], emit: () => void) => {
      const start = slots.length;
      emit();
      if (scope.depth === 0 && slots.length > start) slotBlocks.push({ ids, start, end: slots.length });
    };
    for (const layer of [...s.layers].reverse()) {
      if (done.has(layer.id) || maskIds.has(layer.id)) continue;
      const group = layer.maskedBy ? groups.get(layer.maskedBy) : undefined;
      if (!group) { block([layer.nodeId], () => emitLayer(layer)); continue; }
      const members = [...group].reverse();
      for (const m of members) done.add(m.id);
      // A mask's clip spans its layers: they move together, or the clip would
      // end in the wrong place.
      const maskLayer = s.layers.find((l) => l.id === layer.maskedBy);
      block([...(maskLayer ? [maskLayer.nodeId] : []), ...members.map((m) => m.nodeId)], () => emitMasked(maskLayer, members));
    }
  };

  /** The clip slot of a mask node: one clipping attachment per image it
   *  shows, the polygon traced from the image (`maskShape`) and placed in
   *  the bone's space about its transform point. */
  const clipSlot = (scope: Scope, node: Node, name: string) => {
    const keys = new Map<number, string>();
    const slotAtts: Record<string, BoneBurstClippingAttachment> = {};
    const atts: BoneBurstClippingAttachment[] = [];
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
      const att: BoneBurstClippingAttachment = { type: "clipping", end: "", vertexCount: vertices.length / 2, vertices };
      slotAtts[key] = att;
      atts.push(att);
    }
    const colors = [node.color, ...scope.sym.animations.flatMap((a) => a.tracks[node.id]?.keys.map((k) => k.color) ?? [])];
    if (colors.some((c) => c && c.aM < 100)) {
      warn(`Mask "${node.name}" is partly transparent; Spine's clip is all or nothing.`);
    }
    attachments[name] = slotAtts;
    const setupName = scope.setupVisible ? keys.get(0) ?? null : null;
    const slot: BoneBurstSlot = { name, bone: name };
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
  const animations: Record<string, BoneBurstAnimation> = {};
  /** The sequence keys of `anim` into `out`'s attachment timelines; the last keyed frame. */
  const sequenceTimelines = (anim: Animation, out: BoneBurstAnimation): number => {
    let last = 0;
    for (const sq of rootSequences) {
      const keys = anim.sequences?.[sq.nodeId];
      if (!keys?.length) continue;
      const bySlot = ((out.attachments ??= {}) as Record<string, Record<string, Record<string, Record<string, unknown>>>>);
      ((bySlot.default ??= {})[sq.slot] ??= {})[sq.key] = {
        ...bySlot.default[sq.slot]![sq.key],
        sequence: keys.map((k) => {
          const o: Record<string, unknown> = {};
          const time = keyTime(k.frame, fps);
          if (time) o.time = time;
          if (k.mode !== "hold") o.mode = k.mode;
          if (k.index) o.index = k.index;
          o.delay = k.delay / fps;
          return o;
        }),
      };
      last = Math.max(last, keys[keys.length - 1]!.frame);
    }
    return last;
  };
  for (const anim of sym.animations) {
    const out: BoneBurstAnimation = {};
    let lastFrame = 0;
    // A slider plays an animation inside the runtime: the stage's rig needs its
    // keys. Deform and sequence keys it needs always: the stage sets neither.
    if (options.setupOnly && !sym.sliders?.some((k) => k.animId === anim.id)) {
      const own: BoneBurstAnimation = {};
      const deforms = deformTimelines(anim, rootMeshes, fps);
      if (deforms) own.attachments = deforms.timelines;
      sequenceTimelines(anim, own);
      animations[anim.name] = mergeAttachmentTimelines(own, anim.spine ?? {});
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
    // Inherit keys: the exported symbol's bones (a nested symbol's warn).
    for (const { scope, node, name } of boneNodes) {
      const keys = anim.inherits?.[node.id];
      if (!keys?.length || scope.depth > 0) continue;
      ((out.bones ??= {})[name] ??= {}).inherit = inheritTimeline(keys, fps) as never;
      lastFrame = Math.max(lastFrame, keys[keys.length - 1]!.frame);
    }
    for (const plan of plans) {
      const st = slotTimelines(plan, anim.name, fps);
      if (st) {
        (out.slots ??= {})[plan.name] = st.timelines;
        lastFrame = Math.max(lastFrame, st.lastFrame);
      }
    }
    const order = drawOrderTimeline(sym, anim, slots.map((sl) => sl.name), slotBlocks, fps);
    if (order) out.drawOrder = order;
    const ikKeys = ikTimelines(sym, anim, rootIk, fps);
    if (ikKeys) {
      out.ik = ikKeys;
      for (const keys of Object.values(anim.ik ?? {})) lastFrame = Math.max(lastFrame, keys[keys.length - 1]?.frame ?? 0);
    }
    const deforms = deformTimelines(anim, rootMeshes, fps);
    if (deforms) {
      out.attachments = deforms.timelines;
      lastFrame = Math.max(lastFrame, deforms.lastFrame);
    }
    lastFrame = Math.max(lastFrame, sequenceTimelines(anim, out));
    const tcKeys = transformTimelines(sym, anim, rootTc, fps);
    if (tcKeys) {
      out.transform = tcKeys;
      for (const keys of Object.values(anim.transforms ?? {})) lastFrame = Math.max(lastFrame, keys[keys.length - 1]?.frame ?? 0);
    }
    const events = eventTimeline(sym, anim, fps);
    if (events) {
      out.events = events;
      lastFrame = Math.max(lastFrame, anim.events![anim.events!.length - 1]!.frame);
    }
    const cKeys = constraintKeyTimelines(sym, anim, fps);
    for (const [group, byName] of Object.entries(cKeys.timelines)) (out as Record<string, unknown>)[group] = byName;
    lastFrame = Math.max(lastFrame, cKeys.lastFrame);
    // Carried timelines (an opened file's) join the generated ones; draw
    // order and event keys the document holds replace a carried timeline.
    let carried = order ? omitKey(anim.spine ?? {}, "drawOrder") : anim.spine ?? {};
    if (events) carried = omitKey(carried, "events");
    for (const [group, value] of Object.entries(carried)) {
      if ((group === "bones" || group === "slots" || group === "ik" || group === "transform" || group === "physics" || group === "slider" || group === "path") && value && typeof value === "object") {
        const into = (out[group] ??= {}) as Record<string, Record<string, unknown>>;
        for (const [owner, timelines] of Object.entries(value as Record<string, Record<string, unknown>>)) {
          // A constraint keyed in the document replaces the file's timeline.
          if (group === "ik" || group === "transform") { if (!into[owner]) into[owner] = timelines; continue; }
          // Physics, slider and path keys: the document's channels win, the file's others stay.
          if (group !== "bones" && group !== "slots") { into[owner] = { ...timelines, ...into[owner] }; continue; }
          into[owner] = { ...into[owner], ...timelines };
        }
      } else if (group === "attachments" && out.attachments && value && typeof value === "object") {
        // Skin -> slot -> attachment: the document's deform keys win.
        const into = out.attachments as Record<string, Record<string, Record<string, unknown>>>;
        for (const [skin, slots] of Object.entries(value as Record<string, Record<string, Record<string, unknown>>>)) {
          for (const [slot, atts] of Object.entries(slots)) {
            const target = ((into[skin] ??= {})[slot] ??= {});
            for (const [att, timelines] of Object.entries(atts)) if (!target[att]) target[att] = timelines;
          }
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
      const order = (out.drawOrder as BoneBurstDrawOrderKey[] | undefined) ?? [];
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
  const skeleton: BoneBurstSkeletonFile = { skeleton: { ...carry?.header, spine: BONEBURST_VERSION, fps }, bones };
  if (slots.length) skeleton.slots = slots;
  const allConstraints: BoneBurstConstraint[] = [...constraints, ...(carry?.constraints ?? []) as BoneBurstConstraint[]];
  // The carried ones take their place in the order; a nested symbol's go last.
  const ordered = carry ? byOrder(allConstraints, sym.constraintOrder ?? [], (c) => c.name) : allConstraints;
  if (ordered.length) skeleton.constraints = ordered;
  const skins: BoneBurstSkin[] = [{ name: "default", attachments }];
  const modelSkins = new Map(skinsOfModel(sym, bones, boneNodes, rootIk, rootTc, rootCn, skinAttachments).map((sk) => [sk.name, sk]));
  for (const sk of modelSkins.values()) skins.push(sk);
  for (const raw of carry?.skins ?? []) {
    const skin = raw as unknown as BoneBurstSkin;
    // Copied down to the slot maps: the pass below rewrites entries, and the
    // document must not change under an export.
    const own = Object.fromEntries(Object.entries(skin.attachments ?? {}).map(([slot, byKey]) => [slot, { ...byKey }]));
    const model = modelSkins.get(skin.name);
    if (model) {
      // What the model holds wins a key both have; the rest is the file's.
      const merged: BoneBurstSkin = { ...skin, ...model };
      const atts: Record<string, Record<string, BoneBurstAttachment>> = own;
      for (const [slot, byKey] of Object.entries(model.attachments ?? {})) atts[slot] = { ...atts[slot], ...byKey };
      if (Object.keys(atts).length) merged.attachments = atts; else delete merged.attachments;
      for (const field of ["bones", ...SKIN_CONSTRAINT_KINDS] as const) {
        const u = [...new Set([...(skin[field] ?? []), ...(model[field] ?? [])])];
        if (u.length) merged[field] = u; else delete merged[field];
      }
      skins[skins.indexOf(model)] = merged;
      continue;
    }
    if (skin.name !== "default") { skins.push({ ...skin, attachments: own }); continue; }
    const merged: Record<string, Record<string, BoneBurstAttachment>> = { ...attachments };
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
        byKey[key] = bonesToIndices(att as BoneBurstRaw, boneIndex, (bone) => diagnostics.push({
          severity: "error",
          message: `"${slot}" ▸ "${key}" in skin "${skin.name}" is weighted to a bone "${bone}" the skeleton no longer has.`,
        }));
        for (const region of regionsOf(att as BoneBurstRaw, key)) {
          const id = imageNamed.get(region);
          if (id) usedImages.add(id);
          else diagnostics.push({ severity: "error", message: `"${slot}" ▸ "${key}" in skin "${skin.name}" draws the image "${region}", which is not in the library.` });
        }
      }
    }
  }
  const eventDefs = { ...(carry?.events as BoneBurstSkeletonFile["events"]), ...eventDefsOf(sym) };
  if (Object.keys(eventDefs).length) skeleton.events = eventDefs;
  skeleton.skins = skins;
  if (Object.keys(animations).length) skeleton.animations = animations;
  if (carry) checkCarried(skeleton, sym, diagnostics);
  // spine-csharp refuses a file without one; it is how spine-unity tells a
  // re-exported skeleton changed. Written first, as Spine does.
  if (!options.setupOnly) {
    if (!sanitizeExportSettings(project.exportSettings).nonessential) Object.assign(skeleton, withoutNonessential(skeleton));
    const { hash: _old, ...header } = skeleton.skeleton;
    skeleton.skeleton = { hash: contentHash(boneburstJson({ ...skeleton, skeleton: header })), ...header };
  }

  const names = new Map<NodeId, string>();
  for (const [key, name] of paths) if (!key.includes(">")) names.set(key as NodeId, name);
  // A symbol instanced twice reports its own problems twice.
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => !seen.has(d.message) && seen.add(d.message));
  return { skeleton, diagnostics: unique, usedImages: [...usedImages], names, paths, slots: slotPaths, displayKeys };
}

/**
 * A skeleton's hash: 64-bit FNV-1a over its JSON, as 11 base64 characters,
 * the shape Spine writes. Only equality matters to the runtimes.
 */
function contentHash(text: string): string {
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
export function boneburstJson(file: BoneBurstSkeletonFile, minify = false): string {
  return JSON.stringify(file, (_k, v) => (typeof v === "number" && Object.is(v, -0) ? 0 : v), minify ? undefined : 2);
}

