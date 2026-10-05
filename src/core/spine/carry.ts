import type { SpineRaw } from "./types";

/**
 * What an opened Spine file carries through the editor untouched: the JSON
 * of meshes, paths, constraints and keys the model does not hold. It refers
 * to bones and slots by NAME, except weighted vertices, which index the
 * skeleton's bone list; the editor may emit its bones in another order, so
 * those indices are turned into names on the way in (`bonesToNames`) and
 * back into the export's own indices on the way out (`bonesToIndices`).
 * `carriedReferences` lists every name the carried JSON relies on, for the
 * export to check against what it writes.
 */

/** How many vertices an attachment has, or 0 when it has none. */
export function vertexCountOf(att: SpineRaw): number {
  const type = att.type ?? "region";
  if (type === "mesh") return Array.isArray(att.uvs) ? att.uvs.length / 2 : 0;
  if (type === "path" || type === "boundingbox" || type === "clipping") return Number(att.vertexCount) || 0;
  return 0;
}

/** Weighted: each vertex lists its bones, `[count, (bone, x, y, weight) × count]`,
 *  rather than one x, y. */
export function isWeighted(att: SpineRaw): boolean {
  const n = vertexCountOf(att);
  return n > 0 && Array.isArray(att.vertices) && att.vertices.length !== n * 2;
}

/** Walks a weighted vertex list, handing each bone entry's position in it. */
function eachBone(vertices: unknown[], count: number, visit: (at: number) => void): void {
  let i = 0;
  for (let v = 0; v < count && i < vertices.length; v++) {
    const bones = Number(vertices[i++]);
    for (let b = 0; b < bones; b++, i += 4) visit(i);
  }
}

/** The attachment with its weighted vertices naming their bones. */
export function bonesToNames(att: SpineRaw, bones: readonly string[]): SpineRaw {
  if (!isWeighted(att)) return att;
  const vertices = [...(att.vertices as unknown[])];
  eachBone(vertices, vertexCountOf(att), (at) => {
    vertices[at] = bones[Number(vertices[at])] ?? `#${String(vertices[at])}`;
  });
  return { ...att, vertices };
}

/** The attachment with its weighted vertices indexing `index`; a name it
 *  does not hold is reported and left out of the result's validity. */
export function bonesToIndices(att: SpineRaw, index: ReadonlyMap<string, number>, missing: (name: string) => void): SpineRaw {
  if (!isWeighted(att)) return att;
  const vertices = [...(att.vertices as unknown[])];
  eachBone(vertices, vertexCountOf(att), (at) => {
    const name = String(vertices[at]);
    const i = index.get(name);
    if (i === undefined) { missing(name); vertices[at] = 0; } else vertices[at] = i;
  });
  return { ...att, vertices };
}

/** The bone names a weighted attachment uses. */
export function weightedBones(att: SpineRaw): string[] {
  if (!isWeighted(att)) return [];
  const out: string[] = [];
  const vertices = att.vertices as unknown[];
  eachBone(vertices, vertexCountOf(att), (at) => out.push(String(vertices[at])));
  return out;
}

/** The atlas regions an attachment draws: its path (or name), or one per
 *  frame of a sequence. None for the types that draw nothing. */
export function regionsOf(att: SpineRaw, key: string): string[] {
  const type = att.type ?? "region";
  if (type !== "region" && type !== "mesh" && type !== "linkedmesh") return [];
  const path = typeof att.path === "string" ? att.path : typeof att.name === "string" ? att.name : key;
  const seq = att.sequence as { count?: number; start?: number; digits?: number } | undefined;
  if (!seq) return [path];
  const out: string[] = [];
  const start = seq.start ?? 1, digits = seq.digits ?? 0;
  for (let i = 0; i < (seq.count ?? 0); i++) out.push(path + String(start + i).padStart(digits, "0"));
  return out;
}

export type RefKind = "bone" | "slot" | "constraint" | "skin" | "attachment" | "event";

/** One name the carried JSON relies on, and where. */
export interface CarriedRef { kind: RefKind; name: string; where: string }

const str = (v: unknown): v is string => typeof v === "string";
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every bone, slot and constraint a carried constraint names. */
export function constraintRefs(c: SpineRaw): CarriedRef[] {
  const out: CarriedRef[] = [];
  const where = `constraint "${String(c.name)}"`;
  if (Array.isArray(c.bones)) for (const b of c.bones) if (str(b)) out.push({ kind: "bone", name: b, where });
  for (const field of ["target", "source", "bone"] as const) {
    if (str(c[field])) out.push({ kind: "bone", name: c[field], where });
  }
  if (str(c.slot)) out.push({ kind: "slot", name: c.slot, where });
  return out;
}

/** How a skin lists the constraints it enables, one list per kind. */
export const SKIN_CONSTRAINT_KINDS = ["ik", "transform", "path", "physics", "slider"] as const;

/** Every name a carried skin relies on: its slots, the bones and
 *  constraints it enables, weighted bones, linked meshes' parents. */
export function skinRefs(skin: SpineRaw): CarriedRef[] {
  const out: CarriedRef[] = [];
  const where = `skin "${String(skin.name)}"`;
  for (const b of (skin.bones as unknown[] | undefined) ?? []) if (str(b)) out.push({ kind: "bone", name: b, where });
  for (const kind of SKIN_CONSTRAINT_KINDS) {
    for (const c of (skin[kind] as unknown[] | undefined) ?? []) if (str(c)) out.push({ kind: "constraint", name: c, where });
  }
  const atts = obj(skin.attachments) ? skin.attachments : {};
  for (const [slot, byKey] of Object.entries(atts)) {
    out.push({ kind: "slot", name: slot, where });
    if (!obj(byKey)) continue;
    for (const [key, att] of Object.entries(byKey)) {
      if (!obj(att)) continue;
      const at = `${where}, "${slot}" ▸ "${key}"`;
      for (const b of weightedBones(att)) out.push({ kind: "bone", name: b, where: at });
      if (att.type === "clipping" && str(att.end)) out.push({ kind: "slot", name: att.end, where: at });
      if (att.type === "linkedmesh" && str(att.skin)) out.push({ kind: "skin", name: att.skin, where: at });
    }
  }
  return out;
}

/** Every name a carried animation relies on. */
export function animationRefs(anim: SpineRaw, animName: string): CarriedRef[] {
  const out: CarriedRef[] = [];
  const where = `animation "${animName}"`;
  const keysOf = (group: unknown, kind: RefKind) => {
    if (obj(group)) for (const name of Object.keys(group)) out.push({ kind, name, where });
  };
  keysOf(anim.bones, "bone");
  keysOf(anim.slots, "slot");
  for (const group of ["ik", "transform", "path", "physics", "slider"]) {
    // Physics keys with an empty name apply to every physics constraint.
    if (obj(anim[group])) for (const name of Object.keys(anim[group])) if (name) out.push({ kind: "constraint", name, where });
  }
  if (obj(anim.attachments)) {
    for (const [skin, slots] of Object.entries(anim.attachments)) {
      out.push({ kind: "skin", name: skin, where });
      if (obj(slots)) for (const slot of Object.keys(slots)) out.push({ kind: "slot", name: slot, where });
    }
  }
  for (const key of (anim.drawOrder as unknown[] | undefined) ?? []) {
    if (!obj(key) || !Array.isArray(key.offsets)) continue;
    for (const o of key.offsets) if (obj(o) && str(o.slot)) out.push({ kind: "slot", name: o.slot, where });
  }
  for (const key of (anim.events as unknown[] | undefined) ?? []) {
    if (obj(key) && str(key.name)) out.push({ kind: "event", name: key.name, where });
  }
  return out;
}

/** The latest key time anywhere in a carried animation, in seconds. */
export function lastTime(anim: unknown): number {
  let t = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!obj(v)) return;
    if (typeof v.time === "number") t = Math.max(t, v.time);
    for (const x of Object.values(v)) if (typeof x === "object") walk(x);
  };
  walk(anim);
  return t;
}
