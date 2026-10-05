import { sanitizeInherits } from "./inherit";
import { sanitizeConstraintKeys } from "./constraintKeys";
import type { DeformKey, DisplayRef, EventDef, EventKey, IkKey, LibraryFolder, MeshData, Node, PathConstraint, PhysicsConstraint, Project, SequenceKey, SkinDef, SliderConstraint, TcKey, TransformConstraint } from "./types";
import { SEQUENCE_MODES } from "./sequence";
import { PHYSICS_SETTINGS, SLIDER_PROPERTIES } from "./constraints";
import type { AnimId, CnId, NodeId } from "./ids";
import { eventDefsFromSpine, withEventDefValues } from "./events";
import { DEFAULT_MOTION_BLUR, DOC_VERSION, type MotionBlurSettings, TIMELINE_PROPS } from "./types";
import { observeId } from "./ids";
import { isDefaultExport, sanitizeExportSettings } from "@/core/export/settings";
import { normalizeMasks } from "./layerTree";
import { displaysOf } from "./displays";
import { CURVE_Y_LIMIT, EASE_FAMILIES, TWEEN_CHANNELS, TWEEN_LINEAR, type TweenSpec, } from "@/core/math/easing";

export interface Diagnostic {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  project: Project;
  diagnostics: Diagnostic[];
}

/**
 * Validate and repair a project loaded from disk.
 *
 * The guiding rule is that a damaged file should open with a warning and its
 * broken parts quarantined, not fail to open at all: losing a whole afternoon
 * of work to one dangling reference is far worse than losing the one layer
 * that reference belonged to.
 */
export function validateProject(raw: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const fail = (path: string, message: string): never => {
    throw new Error(`${path}: ${message}`);
  };

  if (!raw || typeof raw !== "object") fail("project", "not an object");
  const p = raw as Project;

  if (typeof p.version !== "number") fail("version", "missing");
  if (p.version > DOC_VERSION) {
    fail("version", `file is version ${p.version}, this build understands up to ${DOC_VERSION}`);
  }
  if (!p.items || typeof p.items !== "object") fail("items", "missing");
  if (!p.rootSymbolId || !p.items[p.rootSymbolId]) fail("rootSymbolId", "does not name a symbol");

  p.name = typeof p.name === "string" && p.name ? p.name : "Untitled";
  p.frameRate = clampInt(p.frameRate, 1, 120, 24);
  p.stage = {
    width: clampInt(p.stage?.width, 1, 16384, 800),
    height: clampInt(p.stage?.height, 1, 16384, 600),
    background: typeof p.stage?.background === "string" ? p.stage.background : "#ffffff",
  };
  if (p.motionBlur !== undefined) {
    const mb = p.motionBlur as Partial<MotionBlurSettings> | null;
    p.motionBlur = {
      enabled: mb?.enabled === true,
      shutter: clampInt(mb?.shutter, 0, 360, DEFAULT_MOTION_BLUR.shutter),
      maxLength: clampInt(mb?.maxLength, 1, 4096, DEFAULT_MOTION_BLUR.maxLength),
    };
  }
  if (p.exportSettings !== undefined) {
    const settings = sanitizeExportSettings(p.exportSettings);
    if (isDefaultExport(settings)) delete p.exportSettings;
    else p.exportSettings = settings;
  }
  p.folders = repairFolders(p, diagnostics);
  p.itemOrder = Array.isArray(p.itemOrder) ? p.itemOrder.filter((id) => !!p.items[id]) : [];
  for (const id of Object.keys(p.items)) {
    observeId(id);
    if (!p.itemOrder.includes(id as never)) p.itemOrder.push(id as never);
  }

  for (const item of Object.values(p.items)) {
    if (item.folderId !== undefined && (typeof item.folderId !== "string" || !p.folders[item.folderId])) {
      delete item.folderId;
    }
  }

  for (const [itemId, item] of Object.entries(p.items)) {
    if (item.kind === "image") {
      item.width = clampInt(item.width, 1, 16384, 1);
      item.height = clampInt(item.height, 1, 16384, 1);
      continue;
    }
    if (item.kind !== "symbol") {
      diagnostics.push({ path: `items.${itemId}`, message: "unknown item kind, ignored", severity: "warning" });
      continue;
    }

    item.nodes ??= {};
    item.layers ??= [];
    item.ik ??= [];
    item.animations ??= [];

    for (const nodeId of Object.keys(item.nodes)) observeId(nodeId);

    if (item.constraintOrder !== undefined) {
      const order = Array.isArray(item.constraintOrder) ? [...new Set(item.constraintOrder.filter((n): n is string => typeof n === "string"))] : [];
      if (order.length) item.constraintOrder = order; else delete item.constraintOrder;
    }

    if (item.stageSkins !== undefined) {
      const skins = Array.isArray(item.stageSkins) ? item.stageSkins.filter((n): n is string => typeof n === "string") : null;
      if (skins && (item.spine || Array.isArray(item.skins))) item.stageSkins = [...new Set(skins)];
      else delete item.stageSkins;
    }

    // Drop layers whose node vanished, and nodes with no layer: the one-node
    // one-layer rule is what makes slot ordering unambiguous.
    const before = item.layers.length;
    item.layers = item.layers.filter((l) => {
      observeId(l.id);
      return !!item.nodes[l.nodeId];
    });
    if (item.layers.length !== before) {
      diagnostics.push({
        path: `items.${itemId}.layers`,
        message: `${before - item.layers.length} layer(s) referenced a missing object and were removed`,
        severity: "warning",
      });
    }
    const layered = new Set(item.layers.map((l) => l.nodeId));
    const remapped = new Map<string, Map<number, number>>();
    for (const nodeId of Object.keys(item.nodes)) {
      if (!layered.has(nodeId as never)) delete item.nodes[nodeId as never];
    }

    // Break parent links that point nowhere or close a loop.
    for (const node of Object.values(item.nodes)) {
      if (node.parentId && !item.nodes[node.parentId]) node.parentId = null;
      if (node.parentId && hasCycle(item.nodes, node.id)) {
        node.parentId = null;
        diagnostics.push({
          path: `items.${itemId}.nodes.${node.id}`,
          message: "parent chain looped back on itself; the link was cut",
          severity: "warning",
        });
      }
      if (node.itemId && !p.items[node.itemId]) {
        diagnostics.push({
          path: `items.${itemId}.nodes.${node.id}`,
          message: `"${node.name}" points at a library item that is not in the file`,
          severity: "warning",
        });
      }
      node.pivot ??= { x: 0, y: 0 };
      if (node.extraDisplays !== undefined) {
        const extras = node.itemId && Array.isArray(node.extraDisplays)
          ? node.extraDisplays.filter((d) => d && !!p.items[d.itemId]) : [];
        const dropped = (Array.isArray(node.extraDisplays) ? node.extraDisplays.length : 0) - extras.length;
        if (dropped > 0) {
          diagnostics.push({
            path: `items.${itemId}.nodes.${node.id}`,
            message: `"${node.name}" had ${dropped} display(s) without a library item; they were dropped`,
            severity: "warning",
          });
        }
        for (const d of extras) {
          d.pivot = { x: finiteOr(d.pivot?.x, 0), y: finiteOr(d.pivot?.y, 0) };
        }
        // Keys are remapped below, once the tracks are read: the old indices
        // are needed to tell which display each one meant.
        if (dropped > 0) remapped.set(node.id, remapFor(node, extras));
        if (extras.length) node.extraDisplays = extras;
        else delete node.extraDisplays;
      }
      if (node.slotBone !== undefined && (node.slotBone === node.id || item.nodes[node.slotBone]?.kind !== "bone")) {
        delete node.slotBone;
        diagnostics.push({
          path: `items.${itemId}.nodes.${node.id}`,
          message: `"${node.name}" was a slot on a bone that is not in the file; it has its own transform now`,
          severity: "warning",
        });
      }
      if (node.setupDisplay !== undefined) {
        const d = Number(node.setupDisplay);
        if (!Number.isInteger(d) || d < -1 || d >= Math.max(1, displaysOf(node).length) || d === 0) delete node.setupDisplay;
      }
      if (node.pathDrag !== undefined && node.pathDrag !== "parent") delete node.pathDrag;
      if (node.primary !== undefined && (node.primary !== true || node.kind !== "bone")) delete node.primary;
      if (node.motionBlur !== undefined) {
        const m = Number(node.motionBlur);
        if (!Number.isFinite(m) || m === 1) delete node.motionBlur;
        else node.motionBlur = Math.max(0, Math.min(2, m));
      }
    }

    if (item.animations.length === 0) {
      diagnostics.push({
        path: `items.${itemId}.animations`,
        message: "no animations; an empty one was added so the armature can play",
        severity: "warning",
      });
      item.animations.push({
        id: `a_recovered_${itemId}` as never,
        name: "animation", duration: 1, playTimes: 0, tracks: {},
      });
    }

    for (const anim of item.animations) {
      observeId(anim.id);
      anim.duration = clampInt(anim.duration, 1, 100000, 1);
      anim.playTimes = clampInt(anim.playTimes, 0, 10000, 0);
      anim.tracks ??= {};
      if (anim.reference !== undefined) {
        const r = anim.reference as unknown as Record<string, unknown>;
        const finite = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
        const frames = Array.isArray(r?.frames) ? (r.frames as unknown[]).filter((f): f is string => typeof f === "string") : [];
        if (frames.length === 0) delete anim.reference;
        else {
          for (const f of frames) observeId(f);
          const hold = clampInt(r.hold, 1, 1000, 1), start = clampInt(r.start, 0, 100000, 0);
          // `at` is the timing's source of truth; anything malformed falls
          // back to the even spacing the older shape describes.
          const atRaw = Array.isArray(r.at) ? (r.at as unknown[]) : [];
          const at = atRaw.length === frames.length
            ? atRaw.map((v) => clampInt(v, 0, 100000, start))
            : frames.map((_, i) => start + i * hold);
          anim.reference = {
            frames: frames as never,
            width: clampInt(r.width, 1, 16384, 1), height: clampInt(r.height, 1, 16384, 1),
            at: at as never,
            hold, start,
            x: finite(r.x, 0), y: finite(r.y, 0), scale: Math.max(1e-4, finite(r.scale, 1)),
          };
        }
      }
      if (anim.poses !== undefined) {
        const raw = Array.isArray(anim.poses) ? anim.poses : [];
        const poses = [...new Set(raw.map((f) => clampInt(f, 0, 100000, 0)))].sort((a, b) => a - b);
        if (poses.length) (anim as { poses?: number[] }).poses = poses;
        else delete anim.poses;
      }
      if (anim.drawOrder !== undefined) {
        // One key per frame, in order; an order lists layers of this symbol
        // once each (`withOrder` fills in the rest when it is read).
        const raw = Array.isArray(anim.drawOrder) ? (anim.drawOrder as unknown[]) : [];
        const byFrame = new Map<number, { frame: number; order?: string[] }>();
        for (const k of raw) {
          if (!k || typeof k !== "object") continue;
          const r = k as { frame?: unknown; order?: unknown };
          const frame = clampInt(r.frame, 0, 100000, 0);
          const order = Array.isArray(r.order)
            ? [...new Set(r.order.filter((id): id is string => typeof id === "string" && !!item.nodes[id as never]))]
            : undefined;
          byFrame.set(frame, order ? { frame, order } : { frame });
        }
        const keys = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
        if (keys.length) anim.drawOrder = keys as never;
        else delete anim.drawOrder;
      }
      for (const [nodeId, track] of Object.entries(anim.tracks)) {
        if (!item.nodes[nodeId as never] || !track?.keys?.length) {
          delete anim.tracks[nodeId as never];
          continue;
        }
        track.keys.sort((a, b) => a.frame - b.frame);
        // Two keys on one frame break every lookup in the frame algebra. An
        // older build wrote them when a keyframe was dropped onto another.
        const unique = track.keys.filter((k, i, all) => i === 0 || k.frame !== all[i - 1]!.frame);
        if (unique.length !== track.keys.length) {
          diagnostics.push({
            path: `items.${itemId}.animations.${anim.id}.tracks.${nodeId}`,
            message: `${track.keys.length - unique.length} keyframe(s) shared the same frame as another and were dropped`,
            severity: "warning",
          });
          track.keys = unique;
        }
        track.endFrame = Math.max(track.endFrame ?? 0, track.keys[track.keys.length - 1]!.frame);
        const node = item.nodes[nodeId as never]!;
        const displays = displaysOf(node).length;
        const remap = remapped.get(node.id);
        let blanked = 0;
        for (const k of track.keys) {
          const d = Number(k.displayIndex ?? 0);
          k.displayIndex = Number.isInteger(d) && d >= -1 ? d : 0;
          if (remap && k.displayIndex > 0) k.displayIndex = remap.get(k.displayIndex) ?? -1;
          if (k.displayIndex >= Math.max(1, displays)) { k.displayIndex = -1; blanked++; }
          k.tween = sanitizeTween(k.tween) ?? TWEEN_LINEAR;
          if (k.eases !== undefined) {
            const eases: Record<string, unknown> = {};
            for (const ch of TWEEN_CHANNELS) {
              const e = sanitizeTween((k.eases as Record<string, unknown>)?.[ch]);
              if (e && e.kind !== "none") eases[ch] = e;
            }
            if (Object.keys(eases).length) k.eases = eases as typeof k.eases;
            else delete k.eases;
          }
          if (k.rotateDir !== undefined && k.rotateDir !== "cw" && k.rotateDir !== "ccw") delete k.rotateDir;
          if (k.keyed !== undefined) {
            const list = Array.isArray(k.keyed) ? k.keyed : [];
            k.keyed = TIMELINE_PROPS.filter((p) => list.includes(p));
          }
          if (k.rotateTurns !== undefined) {
            const turns = Math.round(Number(k.rotateTurns));
            if (Number.isFinite(turns) && turns !== 0) k.rotateTurns = turns;
            else delete k.rotateTurns;
          }
        }
        if (blanked) {
          diagnostics.push({
            path: `items.${itemId}.animations.${anim.id}.tracks.${nodeId}`,
            message: `${blanked} keyframe(s) showed a display the layer does not have; they are blank now`,
            severity: "warning",
          });
        }
      }
      // The exporter's frame durations add up to `duration`, so a span that
      // runs past it would leave the file claiming a shorter animation than
      // its own timelines.
      const reach = Math.max(-1, ...Object.values(anim.tracks).map((t) => t?.endFrame ?? -1)) + 1;
      if (reach > anim.duration) {
        diagnostics.push({
          path: `items.${itemId}.animations.${anim.id}`,
          message: `"${anim.name}" was ${anim.duration} frame(s) long but keyed to frame ${reach - 1}; it now lasts ${reach}`,
          severity: "warning",
        });
        anim.duration = reach;
      }
    }

    // An IK constraint pointing at a missing bone would crash the exporter.
    item.ik = item.ik.filter((k) => !!item.nodes[k.boneId] && !!item.nodes[k.targetId]);
    for (const k of item.ik) {
      observeId(k.id);
      const soft = finiteOr(k.softness, 0);
      if (soft > 0) k.softness = soft;
      else delete k.softness;
      // Opened before the editor solved them: carried, now the model's.
      if (k.spine && typeof k.spine === "object") {
        const { stretch, compress, scaleY, ...rest } = k.spine as Record<string, unknown>;
        if (stretch === true) k.stretch = true;
        if (compress === true) k.compress = true;
        if (scaleY === "uniform" || scaleY === "volume") k.scaleY = scaleY;
        if (Object.keys(rest).length) k.spine = rest; else delete k.spine;
      }
      if (k.stretch !== true) delete k.stretch;
      if (k.compress !== true) delete k.compress;
      if (k.scaleY !== "uniform" && k.scaleY !== "volume") delete k.scaleY;
    }
    // IK keys of constraints the symbol has: one key per frame, in order, the
    // mix in 0..1, a tween the timeline writes (linear, stepped, one cubic).
    const ikIds = new Set<string>(item.ik.map((k) => k.id));
    for (const anim of item.animations) {
      if (anim.ik === undefined) continue;
      const raw = anim.ik && typeof anim.ik === "object" ? (anim.ik as Record<string, unknown>) : {};
      const out: Record<string, IkKey[]> = {};
      for (const [id, list] of Object.entries(raw)) {
        if (!ikIds.has(id) || !Array.isArray(list)) continue;
        const byFrame = new Map<number, IkKey>();
        for (const k of list as unknown[]) {
          if (!k || typeof k !== "object") continue;
          const r = k as Record<string, unknown>;
          const frame = clampInt(r.frame, 0, 100000, 0);
          const key: IkKey = { frame, mix: Math.min(1, Math.max(0, finiteOr(r.mix, 1))), bendPositive: r.bendPositive === true };
          if (typeof r.softness === "number" && Number.isFinite(r.softness)) key.softness = Math.max(0, r.softness);
          const tween = sanitizeTween(r.tween);
          if (tween?.kind === "none" || (tween?.kind === "curve" && tween.curve.length === 4)) key.tween = tween;
          byFrame.set(frame, key);
        }
        const keys = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
        if (keys.length) out[id] = keys;
      }
      if (Object.keys(out).length) anim.ik = out as never;
      else delete anim.ik;
    }
    // Meshes: points, triangles and the outline consistent; weights of bones
    // the symbol has. Deform keys of mesh nodes, one offset pair per point.
    for (const node of Object.values(item.nodes)) {
      if (node.key !== undefined && (typeof node.key !== "string" || !node.key)) delete node.key;
      for (const d of node.extraDisplays ?? []) if (d.key !== undefined && (typeof d.key !== "string" || !d.key)) delete d.key;
      // A linked mesh points at another display of the node that has a mesh.
      const all = displaysOf(node);
      const linkOk = (l: unknown, self: number) => {
        const r = l as { to?: unknown; deform?: unknown } | undefined;
        return !!r && Number.isInteger(r.to) && r.to !== self && !!all[r.to as number]?.mesh;
      };
      if (node.linked !== undefined) {
        if (linkOk(node.linked, 0)) node.linked = node.linked.deform === false ? { to: node.linked.to, deform: false } : { to: node.linked.to }; else delete node.linked;
      }
      (node.extraDisplays ?? []).forEach((d, i) => {
        if (d.linked === undefined) return;
        if (linkOk(d.linked, i + 1)) d.linked = d.linked.deform === false ? { to: d.linked.to, deform: false } : { to: d.linked.to }; else delete d.linked;
      });
      if (node.mesh !== undefined) {
        const m = sanitizeMesh(node.mesh, item.nodes as Record<string, unknown>);
        if (m) node.mesh = m; else delete node.mesh;
      }
      for (const d of node.extraDisplays ?? []) {
        if (d.mesh === undefined) continue;
        const m = sanitizeMesh(d.mesh, item.nodes as Record<string, unknown>);
        if (m) d.mesh = m; else delete d.mesh;
      }
    }
    for (const anim of item.animations) {
      if (anim.deforms === undefined) continue;
      const raw = anim.deforms && typeof anim.deforms === "object" ? (anim.deforms as Record<string, unknown>) : {};
      const out: Record<string, DeformKey[]> = {};
      for (const [id, list] of Object.entries(raw)) {
        const node = item.nodes[id as never];
        const count = node?.mesh?.points.length ?? node?.extraDisplays?.find((d) => d.mesh)?.mesh?.points.length;
        if (!count || !Array.isArray(list)) continue;
        const byFrame = new Map<number, DeformKey>();
        for (const k of list as unknown[]) {
          if (!k || typeof k !== "object") continue;
          const r = k as Record<string, unknown>;
          const offsets = Array.isArray(r.offsets) ? r.offsets.map((v) => num(v, 0)) : [];
          const key: DeformKey = { frame: clampInt(r.frame, 0, 100000, 0), offsets: Array.from({ length: count }, (_, i) => offsets[i] ?? 0) };
          const tween = sanitizeTween(r.tween);
          if (tween?.kind === "none" || (tween?.kind === "curve" && tween.curve.length === 4)) key.tween = tween;
          byFrame.set(key.frame, key);
        }
        const keys = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
        if (keys.length) out[id] = keys;
      }
      if (Object.keys(out).length) anim.deforms = out as never;
      else delete anim.deforms;
    }
    // Physics, sliders and paths: bones, paths and animations the symbol has,
    // names unique among every constraint, values finite (Spine's defaults absent).
    {
      const names = new Set<string>([...item.ik.map((k) => k.name), ...(item.transforms ?? []).map((k) => k.name)]);
      const fresh = (r: Record<string, unknown>) => {
        const name = typeof r.name === "string" ? r.name.trim() : "";
        if (!name || names.has(name) || typeof r.id !== "string") return null;
        names.add(name);
        observeId(r.id);
        return { name, id: r.id as CnId };
      };
      const list = <T,>(raw: unknown, make: (r: Record<string, unknown>) => T | null): T[] =>
        (Array.isArray(raw) ? raw : []).map((r) => (r && typeof r === "object" ? make(r as Record<string, unknown>) : null)).filter((k): k is T => !!k);
      const isNode = (id: unknown, kind?: string) => typeof id === "string" && !!item.nodes[id as never] && (!kind || item.nodes[id as never]!.kind === kind);
      const nums = <K extends string>(r: Record<string, unknown>, fields: readonly K[]) => {
        const out: Partial<Record<K, number>> = {};
        for (const f of fields) if (typeof r[f] === "number" && Number.isFinite(r[f])) out[f] = r[f] as number;
        return out;
      };
      if (item.physics !== undefined) {
        const out = list<PhysicsConstraint>(item.physics, (r) => {
          if (!isNode(r.boneId)) return null;
          const head = fresh(r);
          return head && { ...head, boneId: r.boneId as NodeId, ...nums(r, PHYSICS_SETTINGS), ...(r.scaleY === "uniform" || r.scaleY === "volume" ? { scaleY: r.scaleY } : {}) };
        });
        if (out.length) item.physics = out; else delete item.physics;
      }
      if (item.paths !== undefined) {
        const out = list<PathConstraint>(item.paths, (r) => {
          const bones = Array.isArray(r.boneIds) ? r.boneIds.filter((id) => isNode(id)) as NodeId[] : [];
          if (!bones.length || !isNode(r.pathId, "path")) return null;
          const head = fresh(r);
          if (!head) return null;
          const k: PathConstraint = { ...head, boneIds: bones, pathId: r.pathId as NodeId, ...nums(r, ["rotation", "position", "spacing", "mixRotate", "mixX", "mixY"] as const) };
          if (r.positionMode === "fixed") k.positionMode = "fixed";
          if (["fixed", "percent", "proportional"].includes(r.spacingMode as string)) k.spacingMode = r.spacingMode as PathConstraint["spacingMode"];
          if (r.rotateMode === "chain" || r.rotateMode === "chainScale") k.rotateMode = r.rotateMode;
          return k;
        });
        if (out.length) item.paths = out; else delete item.paths;
      }
      if (item.sliders !== undefined) {
        const animIds = new Set<string>(item.animations.map((a) => a.id));
        const out = list<SliderConstraint>(item.sliders, (r) => {
          if (typeof r.animId !== "string" || !animIds.has(r.animId) || (r.boneId !== undefined && !isNode(r.boneId))) return null;
          const head = fresh(r);
          if (!head) return null;
          const k: SliderConstraint = { ...head, animId: r.animId as AnimId, ...nums(r, ["mix", "from", "to", "scale", "max", "time"] as const) };
          if (r.additive === true) k.additive = true;
          if (r.loop === true) k.loop = true;
          if (r.boneId !== undefined) {
            k.boneId = r.boneId as NodeId;
            k.property = SLIDER_PROPERTIES.includes(r.property as never) ? r.property as SliderConstraint["property"] : "rotate";
            if (r.local === true) k.local = true;
          }
          return k;
        });
        if (out.length) item.sliders = out; else delete item.sliders;
      }
    }
    // Constraint keys of physics, sliders and paths the symbol has, their channels.
    for (const anim of item.animations) {
      if (anim.constraintKeys === undefined) continue;
      const keys = sanitizeConstraintKeys(anim.constraintKeys, item);
      if (keys) anim.constraintKeys = keys; else delete anim.constraintKeys;
    }
    // Inherit keys of nodes the symbol has, known modes.
    for (const anim of item.animations) {
      if (anim.inherits === undefined) continue;
      const keys = sanitizeInherits(anim.inherits, item.nodes);
      if (keys) anim.inherits = keys; else delete anim.inherits;
    }
    // Sequence keys of nodes that show a sequence: known modes, an index, a delay.
    for (const anim of item.animations) {
      if (anim.sequences === undefined) continue;
      const raw = anim.sequences && typeof anim.sequences === "object" ? (anim.sequences as Record<string, unknown>) : {};
      const out: Record<string, SequenceKey[]> = {};
      for (const [id, list] of Object.entries(raw)) {
        const node = item.nodes[id as never];
        if (!node || !displaysOf(node).some((d) => d.sequence) || !Array.isArray(list)) continue;
        const byFrame = new Map<number, SequenceKey>();
        for (const k of list as unknown[]) {
          if (!k || typeof k !== "object") continue;
          const r = k as Record<string, unknown>;
          const mode = SEQUENCE_MODES.includes(r.mode as never) ? r.mode as SequenceKey["mode"] : "hold";
          const delay = num(r.delay, 1);
          const key: SequenceKey = { frame: clampInt(r.frame, 0, 100000, 0), mode, index: clampInt(r.index, 0, 100000, 0), delay: delay > 0 ? delay : 1 };
          byFrame.set(key.frame, key);
        }
        const keys = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
        if (keys.length) out[id] = keys;
      }
      if (Object.keys(out).length) anim.sequences = out as never;
      else delete anim.sequences;
    }
    // Transform constraints: a source and bones the symbol has (bones not the
    // source), unique names, properties of known channels, finite numbers.
    if (item.transforms !== undefined) {
      const raw = Array.isArray(item.transforms) ? (item.transforms as unknown[]) : [];
      const out: TransformConstraint[] = [];
      for (const r of raw) {
        const k = sanitizeTransform(r, item.nodes as Record<string, unknown>);
        if (!k || out.some((o) => o.name === k.name)) continue;
        observeId(k.id);
        out.push(k);
      }
      if (out.length) item.transforms = out;
      else delete item.transforms;
    }
    const tcIds = new Set<string>((item.transforms ?? []).map((k) => k.id));
    // Skins: unique names, never "default"; displays of nodes and indices
    // the symbol has, of images that exist; members it has.
    for (const node of Object.values(item.nodes)) {
      if (node.skinOnly !== undefined && (node.skinOnly !== true || !node.itemId)) delete node.skinOnly;
      // A bone's colour; one an opened file carried in `spine.bone` moves here.
      const carriedColor = node.spine?.bone && typeof node.spine.bone === "object" ? (node.spine.bone as Record<string, unknown>).color : undefined;
      if (node.boneColor === undefined && typeof carriedColor === "string") {
        node.boneColor = carriedColor;
        const { color: _c, ...bone } = node.spine!.bone as Record<string, unknown>;
        if (Object.keys(bone).length) node.spine = { ...node.spine, bone }; else { const { bone: _b, ...rest } = node.spine!; if (Object.keys(rest).length) node.spine = rest; else delete node.spine; }
      }
      if (node.boneColor !== undefined) {
        if (node.kind === "bone" && typeof node.boneColor === "string" && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(node.boneColor)) node.boneColor = node.boneColor.toLowerCase();
        else delete node.boneColor;
      }
      // Sequences: images that exist, a setup index among them.
      const cleanSeq = (raw: unknown) => {
        const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const items = Array.isArray(r.items) ? r.items.filter((id): id is string => typeof id === "string" && p.items[id as never]?.kind === "image") : [];
        if (items.length < 2) return undefined;
        const out: { items: typeof items; setup?: number } = { items };
        const setup = clampInt(r.setup, 0, items.length - 1, 0);
        if (setup) out.setup = setup;
        return out as Node["sequence"];
      };
      if (node.sequence !== undefined) { const q = node.itemId ? cleanSeq(node.sequence) : undefined; if (q) node.sequence = q; else delete node.sequence; }
      for (const d of node.extraDisplays ?? []) if (d.sequence !== undefined) { const q = cleanSeq(d.sequence); if (q) d.sequence = q; else delete d.sequence; }
      if (node.path !== undefined) {
        const r = node.kind === "path" && node.path && typeof node.path === "object" ? node.path as unknown as Record<string, unknown> : null;
        const pts = r && Array.isArray(r.points) ? r.points.map((v) => num(v, NaN)) : [];
        if (r && pts.length >= 12 && pts.length % 6 === 0 && pts.every(Number.isFinite)) {
          node.path = { points: pts, ...(r.closed === true ? { closed: true } : {}), ...(r.constantSpeed === false ? { constantSpeed: false } : {}) };
          const f = r.fileLengths as { points?: unknown; closed?: unknown; lengths?: unknown } | undefined;
          const nums = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
          if (f && nums(f.points) && nums(f.lengths)) node.path.fileLengths = { points: [...f.points as number[]], ...(f.closed === true ? { closed: true } : {}), lengths: [...f.lengths as number[]] };
        } else delete node.path;
      }
      if (node.boneIcon !== undefined && (node.kind !== "bone" || typeof node.boneIcon !== "string" || !node.boneIcon)) delete node.boneIcon;
      if (node.attachmentColor !== undefined && !(typeof node.attachmentColor === "string" && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(node.attachmentColor))) delete node.attachmentColor;
      if (node.box !== undefined) {
        const pts = node.kind === "box" && node.box && Array.isArray(node.box.points) ? node.box.points.map((v) => num(v, NaN)) : [];
        if (pts.length >= 6 && pts.length % 2 === 0 && pts.every(Number.isFinite)) node.box = { points: pts };
        else delete node.box;
      }
      for (const d of node.extraDisplays ?? []) if (d.skinOnly !== undefined && d.skinOnly !== true) delete d.skinOnly;
    }
    if (item.skins !== undefined) {
      const raw = Array.isArray(item.skins) ? (item.skins as unknown[]) : [];
      const skins: SkinDef[] = [];
      const ikIds = new Set<string>(item.ik.map((k) => k.id));
      for (const r of raw) {
        const cnIds = new Set<string>([...(item.physics ?? []), ...(item.sliders ?? []), ...(item.paths ?? [])].map((k) => k.id));
        const def = sanitizeSkin(r, item.nodes, ikIds, tcIds, (id) => p.items[id as never]?.kind === "image", cnIds);
        if (def && !skins.some((x) => x.name === def.name)) skins.push(def);
      }
      if (skins.length) item.skins = skins;
      else delete item.skins;
    }
    for (const anim of item.animations) {
      if (anim.transforms === undefined) continue;
      const raw = anim.transforms && typeof anim.transforms === "object" ? (anim.transforms as Record<string, unknown>) : {};
      const out: Record<string, TcKey[]> = {};
      for (const [id, list] of Object.entries(raw)) {
        if (!tcIds.has(id) || !Array.isArray(list)) continue;
        const byFrame = new Map<number, TcKey>();
        for (const k of list as unknown[]) {
          if (!k || typeof k !== "object") continue;
          const r = k as Record<string, unknown>;
          const frame = clampInt(r.frame, 0, 100000, 0);
          const key: TcKey = { frame, mix: mixOf(r.mix) };
          const tween = sanitizeTween(r.tween);
          if (tween?.kind === "none" || (tween?.kind === "curve" && tween.curve.length === 4)) key.tween = tween;
          byFrame.set(frame, key);
        }
        const keys = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
        if (keys.length) out[id] = keys;
      }
      if (Object.keys(out).length) anim.transforms = out as never;
      else delete anim.transforms;
    }
    // Events: names unique and not empty, values of the right type; keys of
    // known events only, sorted by frame (keys sharing one keep their order).
    if (item.events !== undefined) {
      const raw = Array.isArray(item.events) ? (item.events as unknown[]) : [];
      const defs: EventDef[] = [];
      for (const d of raw) {
        if (!d || typeof d !== "object") continue;
        const r = d as Record<string, unknown>;
        const name = typeof r.name === "string" ? r.name.trim() : "";
        if (!name || defs.some((x) => x.name === name)) continue;
        defs.push(withEventDefValues({ name }, eventFields(r, true)));
      }
      if (defs.length) item.events = defs;
      else delete item.events;
    }
    const eventNames = new Set((item.events ?? []).map((d) => d.name));
    for (const anim of item.animations) {
      if (anim.events === undefined) continue;
      const raw = Array.isArray(anim.events) ? (anim.events as unknown[]) : [];
      const keys = raw
        .filter((k): k is Record<string, unknown> => !!k && typeof k === "object" && typeof (k as { name?: unknown }).name === "string")
        .filter((k) => eventNames.has(k.name as string))
        .map((k, i) => ({ i, key: { frame: clampInt(k.frame, 0, 100000, 0), name: k.name as string, ...eventFields(k, false) } as EventKey }))
        .sort((a, b) => a.key.frame - b.key.frame || a.i - b.i)
        .map((x) => x.key);
      if (keys.length) anim.events = keys;
      else delete anim.events;
    }
    const masks = normalizeMasks(item).masks.size;
    if (masks) {
      diagnostics.push({
        path: `items.${itemId}.layers`,
        message: `${masks} layer(s) had a mask setting that could not work (a missing or misplaced mask, or a mask with nothing to clip); it was cleared`,
        severity: "warning",
      });
    }
  }

  p.version = DOC_VERSION;
  return { project: p, diagnostics };
}

/**
 * True when `start` is ON a parent loop. A chain that merely runs into a loop
 * further up (A → B → C → B) is not: cutting A would lose a valid link, and
 * the loop itself is cut when its own members are checked.
 */
export function hasCycle(nodes: Record<string, { id: string; parentId: string | null }>, start: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = nodes[start]?.parentId ?? null;
  while (cur) {
    if (cur === start) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = nodes[cur]?.parentId ?? null;
  }
  return false;
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Old display index → new, after dropping the extra displays not in `kept`. */
function remapFor(node: Node, kept: DisplayRef[]): Map<number, number> {
  const out = new Map<number, number>();
  (node.extraDisplays ?? []).forEach((d, i) => {
    const j = kept.indexOf(d);
    if (j >= 0) out.set(i + 1, j + 1);
  });
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Version bridge. There is one entry today; it exists from day one so that
 * adding the second is a two-line change rather than a redesign.
 */
const MIGRATIONS: Record<number, (p: Record<string, unknown>) => Record<string, unknown>> = {
  // 0 -> 1: files written before the version field existed.
  0: (p) => ({ ...p, version: 1 }),
  // 1 -> 2: mask layers. Purely additive — an absent `isMask`/`maskedBy`
  // reads as "no masks" — but the version moves so an older build refuses
  // the file rather than opening it and silently drawing without the clip.
  1: (p) => ({ ...p, version: 2 }),
  // 2 -> 3: `Layer.excludeFromExport` and the "empty" node kind. Additive
  // again, and again the version moves: an older build would happily export
  // the very content the user marked as excluded.
  2: (p) => ({ ...p, version: 3 }),
  // 3 -> 4: motion blur (`Project.motionBlur`, `Node.motionBlur`). Additive;
  // an older build would drop the settings on save without saying so.
  3: (p) => ({ ...p, version: 4 }),
  // 4 -> 5: preset and multi-segment eases, per-property `Keyframe.eases`.
  // An older build has no evaluator for either and would tween to NaN.
  4: (p) => ({ ...p, version: 5 }),
  // 5 -> 6: `Node.extraDisplays`, artwork switched per keyframe. An older
  // build would draw display 0 on every key and export it that way.
  5: (p) => ({ ...p, version: 6 }),
  // 6 -> 7: `Project.exportSettings`. Additive; an older build would export
  // at its own defaults and drop the settings on save.
  6: (p) => ({ ...p, version: 7 }),
  // 7 -> 8: Spine files opened for editing (`SymbolItem.spine`, slots on
  // bones, `Animation.endsAtLastFrame`). The DragonBones-era inherit flags,
  // which nothing drew or exported, give way to Spine's `inherit`.
  7: (p) => {
    for (const item of Object.values((p.items ?? {}) as Record<string, { nodes?: Record<string, Record<string, unknown>> }>)) {
      for (const node of Object.values(item?.nodes ?? {})) {
        delete node.inheritRotation;
        delete node.inheritScale;
      }
    }
    return { ...p, version: 8 };
  },
  // 8 -> 9: eases per axis (`Keyframe.eases` x, y, scaleX, scaleY, shear).
  // Additive; an older build would drop them and play both axes on one ease.
  8: (p) => ({ ...p, version: 9 }),
  // 9 -> 10: `Animation.reference`, reference art saved in the file. An
  // older build would keep the field and drop its images on the next save.
  9: (p) => ({ ...p, version: 10 }),
  // 10 -> 11: `AnimationReference.at`, the frame each picture is keyed to.
  // Additive (the reader re-derives it from start/hold when absent), but the
  // version moves: an older build would drop it on save and re-space the
  // pictures evenly.
  10: (p) => ({ ...p, version: 11 }),
  // 11 -> 12: `Animation.poses`, the user's key-pose frames. Additive; an
  // older build would drop the list on save without saying so.
  11: (p) => ({ ...p, version: 12 }),
  // 12 -> 13: `Node.pathDrag`, how dragging a bone's path turns it. Additive;
  // an older build would drop it on save.
  12: (p) => ({ ...p, version: 13 }),
  // 13 -> 14: `Node.primary`, a bone the stage toolbar's Primary row governs.
  // Additive; an older build would drop it on save.
  13: (p) => ({ ...p, version: 14 }),
  // 14 -> 15: `Keyframe.keyed`, which bone properties a key is a key of on
  // the timeline's property rows. Additive; an older build would drop it.
  14: (p) => ({ ...p, version: 15 }),
  // 15 -> 16: `Animation.drawOrder`, draw order keys. Additive; an older
  // build would drop them on save.
  15: (p) => ({ ...p, version: 16 }),
  // 16 -> 17: `Animation.ik`, IK mix and bend keys. Additive; an older build
  // would drop them on save.
  16: (p) => ({ ...p, version: 17 }),
  // 17 -> 18: `IkConstraint.softness` and `IkKey.softness`. An opened
  // constraint carried its softness in `spine`; it moves to the field the
  // solver reads.
  // 20 -> 21: `MeshData` on displays (`Node.mesh`, `DisplayRef.mesh`) and
  // `Animation.deforms`. Additive; an older build would drop them.
  20: (p) => ({ ...p, version: 21 }),
  21: (p) => ({ ...p, version: 22 }),
  22: (p) => ({ ...p, version: 23 }),
  // 23 -> 24: `SymbolItem.constraintOrder`, which an opened file's order
  // moves to from `spine.constraintOrder`.
  23: (p) => {
    const items = (p.items ?? {}) as Record<string, { constraintOrder?: unknown; spine?: Record<string, unknown> }>;
    for (const item of Object.values(items)) {
      if (!item.spine || !("constraintOrder" in item.spine)) continue;
      item.constraintOrder ??= item.spine.constraintOrder;
      delete item.spine.constraintOrder;
    }
    return { ...p, version: 24 };
  },
  // 24 -> 25: `Animation.inherits` and `Animation.constraintKeys`, inherit
  // mode keys and physics, slider and path constraint keys, additive; a bone's
  // carried `icon` moves to `Node.boneIcon`.
  24: (p) => {
    const items = (p.items ?? {}) as Record<string, { nodes?: Record<string, { boneIcon?: unknown; spine?: { bone?: Record<string, unknown> } }> }>;
    for (const item of Object.values(items)) {
      for (const node of Object.values(item.nodes ?? {})) {
        const bone = node.spine?.bone;
        if (!bone || typeof bone.icon !== "string") continue;
        node.boneIcon ??= bone.icon;
        const { icon: _i, ...rest } = bone;
        if (Object.keys(rest).length) node.spine!.bone = rest; else delete node.spine!.bone;
      }
    }
    return { ...p, version: 25 };
  },
  // 19 -> 20: `SymbolItem.transforms` and `Animation.transforms`, transform
  // constraints and their keys. Additive; an older build would drop them.
  19: (p) => ({ ...p, version: 20 }),
  // 18 -> 19: `SymbolItem.events` and `Animation.events`. An opened file's
  // events were carried in `spine.events`; they move to the list the editor
  // edits (an animation's carried keys stay carried, naming them).
  18: (p) => {
    const items = (p.items ?? {}) as Record<string, { events?: unknown; spine?: Record<string, unknown> }>;
    for (const item of Object.values(items)) {
      const carried = item.spine?.events;
      if (!carried || typeof carried !== "object" || item.events) continue;
      item.events = eventDefsFromSpine(carried as Record<string, unknown>);
      delete item.spine!.events;
    }
    return { ...p, version: 19 };
  },
  17: (p) => {
    const items = (p.items ?? {}) as Record<string, { ik?: Array<{ softness?: unknown; spine?: Record<string, unknown> }> }>;
    for (const item of Object.values(items)) {
      for (const k of item.ik ?? []) {
        if (!k.spine || !("softness" in k.spine)) continue;
        const { softness, ...rest } = k.spine;
        k.softness = softness;
        if (Object.keys(rest).length) k.spine = rest;
        else delete k.spine;
      }
    }
    return { ...p, version: 18 };
  },
};

const TC_NAMES = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"] as const;
type TcName = (typeof TC_NAMES)[number];
const isTc = (v: unknown): v is TcName => typeof v === "string" && (TC_NAMES as readonly string[]).includes(v);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** A mesh read from disk, or null when it cannot be one: an even list of
 *  finite points, triangles of existing points, an outline of 3 or more,
 *  weights (when present) per point, of bones the symbol has. */
function sanitizeSkin(
  raw: unknown, nodes: Record<string, Node>, ikIds: Set<string>, tcIds: Set<string>, isImage: (id: string) => boolean, cnIds: Set<string> = new Set(),
): SkinDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || name === "default") return null;
  const def: SkinDef = { name };
  const displays: Record<string, Record<string, DisplayRef>> = {};
  for (const [nodeId, byIndex] of Object.entries(r.displays && typeof r.displays === "object" ? r.displays as Record<string, unknown> : {})) {
    const node = nodes[nodeId];
    if (!node || !byIndex || typeof byIndex !== "object") continue;
    const count = displaysOf(node).length;
    const out: Record<string, DisplayRef> = {};
    for (const [index, ref] of Object.entries(byIndex as Record<string, unknown>)) {
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= count || !ref || typeof ref !== "object") continue;
      const d = ref as Record<string, unknown>;
      if (typeof d.itemId !== "string" || !isImage(d.itemId)) continue;
      const pv = d.pivot && typeof d.pivot === "object" ? d.pivot as Record<string, unknown> : {};
      const clean: DisplayRef = { itemId: d.itemId as DisplayRef["itemId"], pivot: { x: num(pv.x, 0), y: num(pv.y, 0) } };
      const a = d.attachment as Record<string, unknown> | undefined;
      if (a && typeof a === "object" && typeof a.name === "string" && a.data && typeof a.data === "object") clean.attachment = { name: a.name, data: a.data as Record<string, unknown> };
      out[String(i)] = clean;
    }
    if (Object.keys(out).length) displays[nodeId] = out;
  }
  if (Object.keys(displays).length) def.displays = displays as SkinDef["displays"];
  const ids = (v: unknown, keep: (id: string) => boolean) => [...new Set(Array.isArray(v) ? v.filter((id): id is string => typeof id === "string" && keep(id)) : [])];
  const bones = ids(r.bones, (id) => !!nodes[id]);
  const ik = ids(r.ik, (id) => ikIds.has(id));
  const transforms = ids(r.transforms, (id) => tcIds.has(id));
  if (bones.length) def.bones = bones as SkinDef["bones"];
  if (ik.length) def.ik = ik as SkinDef["ik"];
  if (transforms.length) def.transforms = transforms as SkinDef["transforms"];
  const constraints = ids(r.constraints, (id) => cnIds.has(id));
  if (constraints.length) def.constraints = constraints as SkinDef["constraints"];
  return def;
}

function sanitizeMesh(raw: unknown, nodes: Record<string, unknown>): MeshData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const points = Array.isArray(r.points) ? r.points.map((v) => num(v, NaN)) : [];
  if (points.length < 6 || points.length % 2 || points.some((v) => !Number.isFinite(v))) return null;
  const count = points.length / 2;
  const hull = clampInt(r.hull, 3, count, 3);
  const tris = Array.isArray(r.triangles) ? r.triangles.map((v) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < count ? (v as number) : -1)) : [];
  if (!tris.length || tris.length % 3 || tris.some((i) => i < 0)) return null;
  const out: MeshData = { width: Math.max(1, num(r.width, 1)), height: Math.max(1, num(r.height, 1)), points, triangles: tris, hull };
  if (Array.isArray(r.weights) && r.weights.length === count) {
    const weights = r.weights.map((w) => (Array.isArray(w) ? w : [])
      .filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && !!nodes[e[0]] && Number.isFinite(e[1]))
      .map(([b, v]) => [b, Math.max(0, v)] as [string, number]));
    if (weights.some((w) => w.length)) out.weights = weights as never;
  }
  if (out.weights && Array.isArray(r.boneOffsets) && r.boneOffsets.length === count) {
    const offs = r.boneOffsets as unknown[];
    const fits = offs.every((o, i) => Array.isArray(o) && (o.length === 0 || o.length === out.weights![i]!.length)
      && o.every((e) => Array.isArray(e) && e.length === 2 && e.every((v) => Number.isFinite(v))));
    if (fits) out.boneOffsets = offs.map((o) => (o as Array<[number, number]>).map(([x, y]) => [x, y] as [number, number]));
  }
  if (Array.isArray(r.vertices) && r.vertices.length === points.length && r.vertices.every((v) => Number.isFinite(v))) out.vertices = [...r.vertices as number[]];
  if (Array.isArray(r.edges) && r.edges.length % 2 === 0 && r.edges.every((v) => Number.isInteger(v) && (v as number) >= 0)) out.edges = [...r.edges as number[]];
  return out;
}

/** Six mixes read from disk, 0..1; a missing one is 1. */
function mixOf(raw: unknown): Record<TcName, number> {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(TC_NAMES.map((c) => [c, Math.min(1, Math.max(0, num(r[c], 1)))])) as Record<TcName, number>;
}

/** A transform constraint read from disk, or null when its source or every
 *  bone is gone. */
function sanitizeTransform(raw: unknown, nodes: Record<string, unknown>): TransformConstraint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const sourceId = typeof r.sourceId === "string" && nodes[r.sourceId] ? r.sourceId : null;
  if (!name || !sourceId || typeof r.id !== "string") return null;
  const boneIds = [...new Set((Array.isArray(r.boneIds) ? r.boneIds : []).filter((b): b is string => typeof b === "string" && !!nodes[b] && b !== sourceId))];
  if (!boneIds.length) return null;
  const properties = (Array.isArray(r.properties) ? r.properties : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && isTc((p as { from?: unknown }).from))
    .map((p) => ({
      from: p.from as TcName,
      offset: num(p.offset, 0),
      to: (Array.isArray(p.to) ? p.to : [])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && isTc((t as { to?: unknown }).to))
        .map((t) => ({ to: t.to as TcName, offset: num(t.offset, 0), max: num(t.max, 1), scale: num(t.scale, 1) })),
    }))
    .filter((p) => p.to.length);
  const offsetsRaw = r.offsets && typeof r.offsets === "object" ? (r.offsets as Record<string, unknown>) : {};
  const offsets: Partial<Record<TcName, number>> = {};
  for (const c of TC_NAMES) if (num(offsetsRaw[c], 0) !== 0) offsets[c] = num(offsetsRaw[c], 0);
  const out: TransformConstraint = { id: r.id as never, name, boneIds: boneIds as never, sourceId: sourceId as never, mix: mixOf(r.mix), properties };
  if (Object.keys(offsets).length) out.offsets = offsets;
  for (const f of ["localSource", "localTarget", "additive", "clamp"] as const) if (r[f] === true) out[f] = true;
  if (r.spine && typeof r.spine === "object") out.spine = r.spine as Record<string, unknown>;
  return out;
}

/** An event's or a key's values read from disk: the right types only. */
function eventFields(r: Record<string, unknown>, def: boolean): Partial<EventDef> {
  const out: Partial<EventDef> = {};
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (finite(r.int)) out.int = Math.trunc(r.int);
  if (finite(r.float)) out.float = r.float;
  if (typeof r.string === "string") out.string = r.string;
  if (def && typeof r.audio === "string" && r.audio) out.audio = r.audio;
  if (finite(r.volume)) out.volume = Math.max(0, Math.min(1, r.volume));
  if (finite(r.balance)) out.balance = Math.max(-1, Math.min(1, r.balance));
  return out;
}

/** A tween read from disk, or null when it is not one this build knows. */
function sanitizeTween(raw: unknown): TweenSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  switch (t.kind) {
    case "none":   return { kind: "none" };
    case "linear": return { kind: "linear" };
    case "ease":
      return finite(t.value) ? { kind: "ease", value: Math.min(2, Math.max(-1, t.value)) } : null;
    case "curve": {
      const c = t.curve;
      if (!Array.isArray(c) || c.length < 4 || c.length % 6 !== 4 || !c.every(finite)) return null;
      return { kind: "curve", curve: c.map((v, i) => (i % 2 ? Math.min(CURVE_Y_LIMIT, Math.max(-CURVE_Y_LIMIT, v)) : Math.min(1, Math.max(0, v)))) };
    }
    case "preset": {
      const fam = EASE_FAMILIES.find((f) => f.id === t.family);
      if (!fam || (t.dir !== "in" && t.dir !== "out" && t.dir !== "inOut")) return null;
      const spec: TweenSpec = { kind: "preset", family: fam.id, dir: t.dir };
      if (fam.amount && finite(t.amount)) spec.amount = Math.min(fam.amount.max, Math.max(fam.amount.min, t.amount));
      return spec;
    }
    default: return null;
  }
}

export function migrate(raw: unknown): unknown {
  let p = raw as Record<string, unknown>;
  let version = typeof p?.version === "number" ? p.version : 0;
  while (version < DOC_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    p = step(p);
    version = typeof p.version === "number" ? p.version : version + 1;
  }
  return p;
}

/**
 * Library folders: malformed entries dropped, a parent that does not exist
 * or closes a loop cut to the top level. Folders only organise the library,
 * so a repair never touches an item beyond moving it to the top level.
 */
function repairFolders(p: Project, diagnostics: Diagnostic[]): Project["folders"] {
  const raw = (p.folders && typeof p.folders === "object" ? p.folders : {}) as Record<string, unknown>;
  const out: Project["folders"] = {};
  for (const [key, value] of Object.entries(raw)) {
    const f = value as Partial<LibraryFolder> | null;
    if (!f || typeof f !== "object" || f.id !== key || typeof f.name !== "string") {
      diagnostics.push({ path: `folders.${key}`, message: "malformed library folder, removed", severity: "warning" });
      continue;
    }
    observeId(f.id);
    out[f.id] = { id: f.id, name: f.name, parentId: typeof f.parentId === "string" ? f.parentId : null };
  }
  for (const f of Object.values(out)) {
    if (f.parentId && !out[f.parentId]) f.parentId = null;
    let at = f.parentId;
    for (let n = 0; at && n <= Object.keys(out).length; n++) {
      if (at === f.id) {
        f.parentId = null;
        diagnostics.push({
          path: `folders.${f.id}`,
          message: "library folder was inside itself; moved to the top level",
          severity: "warning",
        });
        break;
      }
      at = out[at]?.parentId ?? null;
    }
  }
  return out;
}

