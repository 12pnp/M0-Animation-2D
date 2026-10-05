import type { ItemId } from "@/core/doc/ids";
import type { DisplayRef, PathShape } from "@/core/doc/types";
import { sequenceNaming } from "@/core/doc/sequence";

/**
 * An opened file's bounding boxes, points, paths and sequences as the
 * editor's (ARCHITECTURE ▸ Boxes and points ▸ Opened ones, Sequences), pure.
 * Null where the model cannot hold the attachment exactly; then it stays carried.
 */

type Raw = Record<string, unknown>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const only = (att: Raw, fields: readonly string[]) => Object.keys(att).every((k) => fields.includes(k));

export type Outline =
  | { kind: "box"; box: { points: number[] }; color?: string }
  | { kind: "point"; color?: string }
  | { kind: "path"; path: PathShape; color?: string };

/** Unweighted vertices, y flipped into the node's space, or null. */
function plain(att: Raw, count: number): number[] | null {
  const v = att.vertices;
  if (!Array.isArray(v) || v.length !== count * 2 || !v.every(finite)) return null;
  return v.map((x, i) => (i % 2 ? 0 - x : x));
}

/** A box, point or path the model can hold: a box or path unweighted, a
 *  point with no offset (the model's point is its node's origin). */
export function outlineOf(att: Raw): Outline | null {
  const color = typeof att.color === "string" ? att.color : undefined;
  const withColor = <T extends object>(o: T) => (color ? { ...o, color } : o);
  if (att.type === "boundingbox") {
    if (!only(att, ["type", "name", "vertexCount", "vertices", "color"]) || !Number.isInteger(att.vertexCount)) return null;
    const points = plain(att, att.vertexCount as number);
    return points && points.length >= 6 ? withColor({ kind: "box" as const, box: { points } }) : null;
  }
  if (att.type === "point") {
    if (!only(att, ["type", "name", "x", "y", "rotation", "color"])) return null;
    if ([att.x, att.y, att.rotation].some((v) => v !== undefined && v !== 0)) return null;
    return withColor({ kind: "point" as const });
  }
  if (att.type === "path") {
    if (!only(att, ["type", "name", "vertexCount", "vertices", "lengths", "closed", "constantSpeed", "color"]) || !Number.isInteger(att.vertexCount)) return null;
    const points = plain(att, att.vertexCount as number);
    if (!points || points.length < 12 || points.length % 6) return null;
    const path: PathShape = { points };
    if (att.closed === true) path.closed = true;
    if (att.constantSpeed === false) path.constantSpeed = false;
    // The file's lengths, while the shape is the one they were measured on.
    if (Array.isArray(att.lengths) && att.lengths.every(finite)) path.fileLengths = { points: [...points], ...(path.closed ? { closed: true } : {}), lengths: [...att.lengths] as number[] };
    return withColor({ kind: "path" as const, path });
  }
  return null;
}

/** The lengths to write for `shape`: the file's while it is unchanged. */
export function fileLengthsOf(shape: PathShape): number[] | null {
  const f = shape.fileLengths;
  if (!f || !!f.closed !== !!shape.closed || f.points.length !== shape.points.length) return null;
  return f.points.every((v, i) => v === shape.points[i]) ? f.lengths : null;
}

/**
 * A region sequence as a display: the images named `path` + the numbers from
 * `start`, all in the library and named one after another; the region
 * unrotated, unscaled and the image's size, its offset the transform point.
 */
export function sequenceDisplayOf(att: Raw, key: string, itemNamed: (name: string) => { id: ItemId; width: number; height: number } | undefined): DisplayRef | null {
  if ((att.type !== undefined && att.type !== "region") || !only(att, ["type", "name", "path", "sequence", "x", "y", "width", "height"])) return null;
  const seq = att.sequence as Raw | undefined;
  if (!seq || typeof seq !== "object" || !only(seq, ["count", "start", "digits", "setup"])) return null;
  const count = seq.count, start = seq.start ?? 1, digits = seq.digits ?? 0, setup = seq.setup ?? 0;
  if (!Number.isInteger(count) || (count as number) < 2 || !Number.isInteger(start) || !Number.isInteger(digits) || !Number.isInteger(setup)) return null;
  const path = typeof att.path === "string" ? att.path : key;
  const names = Array.from({ length: count as number }, (_, i) => path + String((start as number) + i).padStart(digits as number, "0"));
  const items = names.map(itemNamed);
  if (items.some((i) => !i) || !sequenceNaming(names)) return null;
  const first = items[0]!;
  if (items.some((i) => i!.width !== first.width || i!.height !== first.height)) return null;
  if ((att.width !== undefined && att.width !== first.width) || (att.height !== undefined && att.height !== first.height)) return null;
  const x = finite(att.x) ? att.x : 0, y = finite(att.y) ? att.y : 0;
  // `regionCentre` inverted: the region's centre sits at (x, y) from the bone.
  const ref: DisplayRef = { itemId: items[setup as number]?.id ?? first.id, pivot: { x: first.width / 2 - x, y: first.height / 2 + y }, sequence: { items: items.map((i) => i!.id) } };
  if (setup) ref.sequence!.setup = setup as number;
  ref.key = key;
  return ref;
}
