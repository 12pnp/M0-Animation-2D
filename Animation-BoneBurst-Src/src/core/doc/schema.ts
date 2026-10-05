import { sanitizeInherits } from "./inherit";
import { sanitizeConstraintKeys } from "./constraintKeys";
import type { DeformKey, DisplayRef, EventDef, EventKey, IkKey, LibraryFolder, Node, PathConstraint, PhysicsConstraint, Project, SequenceKey, SkinDef, SliderConstraint, TcKey, TransformConstraint } from "./types";
import { SEQUENCE_MODES } from "./sequence";
import { PHYSICS_SETTINGS, SLIDER_PROPERTIES } from "./constraints";
import type { AnimId, CnId, NodeId } from "./ids";
import { withEventDefValues } from "./events";
import { BLEND_MODES, DOC_VERSION, TIMELINE_PROPS } from "./types";
import { observeId } from "./ids";
import { isDefaultExport, sanitizeExportSettings } from "@/core/export/settings";
import { normalizeMasks } from "./layerTree";
import { displaysOf, meshOfDisplay } from "./displays";
import { TWEEN_CHANNELS, TWEEN_LINEAR, } from "@/core/math/easing";
import { sanitizeTween, sanitizeMesh, deformKeysRead, num, sanitizeTransform, weightsOf, regionOf, tintRead, sanitizeSkin, mixOf, eventFields, clampInt } from "./schemaSanitize";

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
      if (node.blendMode !== undefined && !BLEND_MODES.has(node.blendMode)) delete node.blendMode;
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
      if (node.attachmentName !== undefined && (typeof node.attachmentName !== "string" || !node.attachmentName)) delete node.attachmentName;
      for (const d of node.extraDisplays ?? []) if (d.name !== undefined && (typeof d.name !== "string" || !d.name)) delete d.name;
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
        const keys = deformKeysRead(list, count);
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
          node.path = { points: pts, ...(r.closed === true ? { closed: true } : {}), ...(r.constantSpeed === false ? { constantSpeed: false } : {}), ...weightsOf(r, pts.length / 2, item.nodes) };
          const f = r.fileLengths as { points?: unknown; closed?: unknown; lengths?: unknown } | undefined;
          const nums = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
          if (f && nums(f.points) && nums(f.lengths)) node.path.fileLengths = { points: [...f.points as number[]], ...(f.closed === true ? { closed: true } : {}), lengths: [...f.lengths as number[]] };
        } else delete node.path;
      }
      if (node.boneIcon !== undefined && (node.kind !== "bone" || typeof node.boneIcon !== "string" || !node.boneIcon)) delete node.boneIcon;
      if (node.attachmentColor !== undefined && !(typeof node.attachmentColor === "string" && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(node.attachmentColor))) delete node.attachmentColor;
      if (node.box !== undefined) {
        const pts = node.kind === "box" && node.box && Array.isArray(node.box.points) ? node.box.points.map((v) => num(v, NaN)) : [];
        if (pts.length >= 6 && pts.length % 2 === 0 && pts.every(Number.isFinite)) node.box = { points: pts, ...weightsOf(node.box as unknown as Record<string, unknown>, pts.length / 2, item.nodes) };
        else delete node.box;
      }
      if (node.point !== undefined) {
        const r = node.kind === "point" && node.point && typeof node.point === "object" ? node.point as unknown as Record<string, unknown> : null;
        const pt = r ? { x: num(r.x, 0), y: num(r.y, 0), rotation: num(r.rotation, 0) } : null;
        if (pt && (pt.x || pt.y || pt.rotation)) node.point = pt; else delete node.point;
      }
      if (node.region !== undefined) { const t = node.itemId ? regionOf(node.region) : undefined; if (t) node.region = t; else delete node.region; }
      if (node.tint !== undefined) { const t = node.itemId ? tintRead(node.tint) : undefined; if (t) node.tint = t; else delete node.tint; }
      for (const d of node.extraDisplays ?? []) if (d.tint !== undefined) { const t = tintRead(d.tint); if (t) d.tint = t; else delete d.tint; }
      for (const d of node.extraDisplays ?? []) if (d.region !== undefined) { const t = regionOf(d.region); if (t) d.region = t; else delete d.region; }
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
      // A link stands only while it reaches a mesh (`meshOfDisplay`).
      const inSkin = (nodeId: string) => (skin: string, i: number) => skins.find((x) => x.name === skin)?.displays?.[nodeId as never]?.[i];
      for (const def of skins) {
        for (const [nodeId, byIndex] of Object.entries(def.displays ?? {})) {
          for (const [i, d] of Object.entries(byIndex)) {
            if (d.linked && (Number(i) === d.linked.to && !d.linked.skin || !meshOfDisplay(item.nodes[nodeId as never]!, d, inSkin(nodeId)))) delete d.linked;
          }
        }
      }
      if (skins.length) item.skins = skins;
      else delete item.skins;
    }
    // Deform keys of other displays: a skin's ("default" a node's own past 0)
    // display that is a mesh, one offset pair per point.
    for (const anim of item.animations) {
      if (anim.displayDeforms === undefined) continue;
      const raw = anim.displayDeforms && typeof anim.displayDeforms === "object" ? anim.displayDeforms as Record<string, unknown> : {};
      const out: NonNullable<typeof anim.displayDeforms> = {};
      for (const [skin, byNode] of Object.entries(raw)) {
        if (!byNode || typeof byNode !== "object") continue;
        for (const [id, byIndex] of Object.entries(byNode as Record<string, unknown>)) {
          const node = item.nodes[id as never];
          if (!node || !byIndex || typeof byIndex !== "object") continue;
          for (const [index, list] of Object.entries(byIndex as Record<string, unknown>)) {
            const i = Number(index);
            const mesh = skin === "default" ? (i > 0 ? node.extraDisplays?.[i - 1]?.mesh : undefined) : item.skins?.find((d) => d.name === skin)?.displays?.[id as never]?.[i]?.mesh;
            if (!Number.isInteger(i) || !mesh || !Array.isArray(list)) continue;
            const keys = deformKeysRead(list, mesh.points.length);
            if (keys.length) ((out[skin] ??= {})[id as never] ??= {})[String(i)] = keys;
          }
        }
      }
      if (Object.keys(out).length) anim.displayDeforms = out; else delete anim.displayDeforms;
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
function hasCycle(nodes: Record<string, { id: string; parentId: string | null }>, start: string): boolean {
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

