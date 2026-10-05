import type { AnimId, CnId, NodeId } from "./ids";
import type { PathConstraint, PathShape, PhysicsConstraint, SliderConstraint, SliderProperty, SymbolItem } from "./types";

/**
 * Physics, slider and path constraints (ARCHITECTURE ▸ Physics, sliders and
 * paths), pure: Spine 4.3's defaults, the JSON both ways, path geometry and
 * where a new one goes. The runtime solves them: a symbol that has any is
 * posed by spine-core (`spinePose.ts`), so the stage plays what the export
 * plays.
 */

/** Spine's values for what a constraint leaves out (`SkeletonJson`). */
export const PHYSICS_DEFAULTS = {
  x: 0, y: 0, rotate: 0, scaleX: 0, shearX: 0, limit: 5000, fps: 60,
  inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1,
} as const;
export type PhysicsSetting = keyof typeof PHYSICS_DEFAULTS;
export const PHYSICS_SETTINGS = Object.keys(PHYSICS_DEFAULTS) as PhysicsSetting[];

export const SLIDER_PROPERTIES: readonly SliderProperty[] = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"];

export const PATH_DEFAULTS = {
  positionMode: "percent", spacingMode: "length", rotateMode: "tangent",
  rotation: 0, position: 0, spacing: 0, mixRotate: 1, mixX: 1, mixY: 1,
} as const;

/** The symbol has a constraint only the runtime solves. */
export function runtimeSolved(sym: SymbolItem): boolean {
  return !!(sym.physics?.length || sym.sliders?.length || sym.paths?.length);
}

/* ── to and from Spine ── */

type Raw = Record<string, unknown>;

export function physicsToSpine(k: PhysicsConstraint, bone: string): Raw {
  const out: Raw = { type: "physics", name: k.name, bone };
  for (const s of PHYSICS_SETTINGS) if (k[s] !== undefined && k[s] !== PHYSICS_DEFAULTS[s]) out[s] = k[s];
  if (k.scaleY) out.scaleY = k.scaleY;
  return out;
}

export function physicsFromSpine(c: Raw, id: CnId, boneId: NodeId): PhysicsConstraint {
  const k: PhysicsConstraint = { id, name: String(c.name), boneId };
  for (const s of PHYSICS_SETTINGS) {
    const v = c[s];
    if (typeof v === "number" && Number.isFinite(v) && v !== PHYSICS_DEFAULTS[s]) k[s] = v;
  }
  if (c.scaleY === "uniform" || c.scaleY === "volume") k.scaleY = c.scaleY;
  return k;
}

/** The physics fields this model holds; the rest of a file's constraint is carried. */
export const PHYSICS_FIELDS = new Set(["type", "name", "bone", "scaleY", ...PHYSICS_SETTINGS]);

export function sliderToSpine(k: SliderConstraint, animation: string, bone: string | null): Raw {
  const out: Raw = { type: "slider", name: k.name, animation };
  if (k.additive) out.additive = true;
  if (k.loop) out.loop = true;
  if (k.mix !== undefined && k.mix !== 1) out.mix = k.mix;
  if (bone) {
    out.bone = bone;
    out.property = k.property ?? "rotate";
    for (const f of ["from", "to", "max"] as const) if (k[f]) out[f] = k[f];
    if (k.scale !== undefined && k.scale !== 1) out.scale = k.scale;
    if (k.local) out.local = true;
  } else if (k.time) out.time = k.time;
  return out;
}

export function sliderFromSpine(c: Raw, id: CnId, animId: AnimId, boneId: NodeId | undefined): SliderConstraint {
  const k: SliderConstraint = { id, name: String(c.name), animId };
  if (c.additive === true) k.additive = true;
  if (c.loop === true) k.loop = true;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  if (n(c.mix, 1) !== 1) k.mix = n(c.mix, 1);
  if (boneId) {
    k.boneId = boneId;
    k.property = SLIDER_PROPERTIES.includes(c.property as SliderProperty) ? c.property as SliderProperty : "rotate";
    for (const f of ["from", "to", "max"] as const) if (n(c[f], 0)) k[f] = n(c[f], 0);
    if (n(c.scale, 1) !== 1) k.scale = n(c.scale, 1);
    if (c.local === true) k.local = true;
  } else if (n(c.time, 0)) k.time = n(c.time, 0);
  return k;
}

export const SLIDER_FIELDS = new Set(["type", "name", "animation", "additive", "loop", "mix", "bone", "property", "from", "to", "scale", "max", "local", "time"]);

export function pathToSpine(k: PathConstraint, bones: string[], slot: string): Raw {
  const out: Raw = { type: "path", name: k.name, bones, slot };
  for (const [f, d] of Object.entries(PATH_DEFAULTS)) {
    const v = k[f as keyof typeof PATH_DEFAULTS];
    if (v !== undefined && v !== d) out[f] = v;
  }
  return out;
}

export function pathFromSpine(c: Raw, id: CnId, boneIds: NodeId[], pathId: NodeId): PathConstraint {
  const k: PathConstraint = { id, name: String(c.name), boneIds, pathId };
  const modes = { positionMode: ["fixed", "percent"], spacingMode: ["length", "fixed", "percent", "proportional"], rotateMode: ["tangent", "chain", "chainScale"] } as const;
  for (const [f, allowed] of Object.entries(modes)) {
    const v = c[f];
    if (typeof v === "string" && (allowed as readonly string[]).includes(v) && v !== PATH_DEFAULTS[f as keyof typeof modes]) (k as unknown as Raw)[f] = v;
  }
  for (const f of ["rotation", "position", "spacing", "mixRotate", "mixX"] as const) {
    const v = c[f];
    if (typeof v === "number" && Number.isFinite(v) && v !== PATH_DEFAULTS[f]) k[f] = v;
  }
  // The runtime reads a missing mixY as mixX.
  const mixY = typeof c.mixY === "number" ? c.mixY : k.mixX ?? 1;
  if (mixY !== 1) k.mixY = mixY;
  return k;
}

export const PATH_FIELDS = new Set(["type", "name", "bones", "slot", ...Object.keys(PATH_DEFAULTS)]);

/* ── path geometry ── */

/** The cubic from knot `i` to the next: knot, handle out, next handle in, next knot. */
function curve(p: readonly number[], i: number, n: number): number[] {
  const at = (v: number) => [p[v * 2]!, p[v * 2 + 1]!];
  const j = (i + 1) % n;
  return [...at(i * 3 + 1), ...at(i * 3 + 2), ...at(j * 3), ...at(j * 3 + 1)];
}

/** Points along the path, `steps` per curve, for drawing and lengths. */
export function pathPolyline(shape: PathShape, steps = 24): number[] {
  const n = shape.points.length / 6;
  const curves = shape.closed ? n : n - 1;
  const out: number[] = [];
  for (let c = 0; c < curves; c++) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = curve(shape.points, c, n) as [number, number, number, number, number, number, number, number];
    for (let s = c === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      out.push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
  }
  return out;
}

/** Spine's `lengths`: the path's length at the end of each curve, cumulative. */
export function pathLengths(shape: PathShape): number[] {
  const n = shape.points.length / 6;
  const curves = shape.closed ? n : n - 1;
  const out: number[] = [];
  let total = 0;
  for (let c = 0; c < curves; c++) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = curve(shape.points, c, n) as [number, number, number, number, number, number, number, number];
    let px = x0, py = y0;
    for (let s = 1; s <= 64; s++) {
      const t = s / 64, u = 1 - t;
      const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
      const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
      total += Math.hypot(x - px, y - py);
      px = x; py = y;
    }
    out.push(Math.round(total * 1000) / 1000);
  }
  // An open path's last knot ends no curve, but Spine writes a length per knot.
  while (out.length < n) out.push(out[out.length - 1] ?? 0);
  return out;
}

/** A smooth path through `knots` (x, y pairs): each handle a third of the
 *  way to the neighbouring knots along their chord (Catmull-Rom). */
export function pathThrough(knots: readonly number[], closed = false): PathShape {
  const n = knots.length / 2;
  const at = (i: number) => {
    const k = closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i));
    return [knots[k * 2]!, knots[k * 2 + 1]!] as const;
  };
  const points: number[] = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = at(i - 1), [x, y] = at(i), [nx, ny] = at(i + 1);
    const tx = (nx - px) / 6, ty = (ny - py) / 6;
    points.push(x - tx, y - ty, x, y, x + tx, y + ty);
  }
  return { points: points.map((v) => Math.round(v * 100) / 100), ...(closed ? { closed: true } : {}) };
}

/** Knot `i` moved by (dx, dy), its handles with it. */
export function withKnotMoved(shape: PathShape, vertex: number, dx: number, dy: number): PathShape {
  const points = [...shape.points];
  const knot = Math.floor(vertex / 3);
  const moved = vertex % 3 === 1 ? [knot * 3, knot * 3 + 1, knot * 3 + 2] : [vertex];
  for (const v of moved) { points[v * 2] = points[v * 2]! + dx; points[v * 2 + 1] = points[v * 2 + 1]! + dy; }
  return { ...shape, points };
}

/* ── new constraints ── */

/** `base`, else `base 2`, …: a name no constraint of `sym` has (Spine keeps
 *  every kind of constraint in one list, by name). */
export function uniqueConstraintName(sym: SymbolItem, base: string): string {
  const taken = new Set([...sym.ik, ...(sym.transforms ?? []), ...(sym.physics ?? []), ...(sym.sliders ?? []), ...(sym.paths ?? [])].map((k) => k.name));
  for (const c of (sym.spine?.constraints ?? []) as Array<{ name?: unknown }>) taken.add(String(c.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

/** A bone's new physics: its rotation sways (Spine's usual start). */
export function newPhysics(sym: SymbolItem, boneId: NodeId, id: CnId): PhysicsConstraint {
  return { id, name: uniqueConstraintName(sym, `${sym.nodes[boneId]?.name ?? "bone"}_physics`), boneId, rotate: 1 };
}

/** A slider: `animId` played by the rotation of `boneId` (from 0° to 90°
 *  across the animation), or at time 0 without a bone. */
export function newSlider(sym: SymbolItem, animId: AnimId, boneId: NodeId | null, id: CnId, seconds: number): SliderConstraint {
  const name = uniqueConstraintName(sym, `${sym.animations.find((a) => a.id === animId)?.name ?? "slider"}_slider`);
  if (!boneId) return { id, name, animId };
  return { id, name, animId, boneId, property: "rotate", to: 0, scale: seconds > 0 ? seconds / 90 : 1 };
}

/**
 * Bones made to follow a new path (Spine's path constraint): a smooth path
 * through their origins and the last one's tip (`knots`, in the space of the
 * path node's parent), laid by length and turned along the chain.
 */
export function newPathConstraint(sym: SymbolItem, boneIds: readonly NodeId[], pathId: NodeId, id: CnId): PathConstraint {
  return { id, name: uniqueConstraintName(sym, `${sym.nodes[boneIds[0]!]?.name ?? "bones"}_path`), boneIds: [...boneIds], pathId, rotateMode: "chain" };
}
