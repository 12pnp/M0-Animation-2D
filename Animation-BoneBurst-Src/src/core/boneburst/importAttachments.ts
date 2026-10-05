import type { ItemId } from "@/core/doc/ids";
import type { DisplayRef, Node, OutlineWeights, PathShape, RegionTurn } from "@/core/doc/types";
import { sequenceNaming } from "@/core/doc/sequence";
import { boundVertices, type MeshContext } from "./importMesh";

/**
 * An opened file's bounding boxes, points, paths and sequences as the
 * editor's (ARCHITECTURE ▸ Boxes and points ▸ Opened ones, Sequences), pure.
 * Null where the model cannot hold the attachment exactly; then it stays carried.
 */

type Raw = Record<string, unknown>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const only = (att: Raw, fields: readonly string[]) => Object.keys(att).every((k) => fields.includes(k));

export type Outline =
  | { kind: "box"; box: { points: number[] } & OutlineWeights; color?: string }
  | { kind: "point"; point?: Node["point"]; color?: string }
  | { kind: "path"; path: PathShape; color?: string };

/** The bones a weighted box or path is read against: the slot bone's world
 *  and each bone's at the setup pose. */
export type OutlineBones = Pick<MeshContext, "node" | "bone">;

/** The vertices in the node's space, y down: unweighted ones flipped,
 *  weighted ones (with `bones`) where the setup pose shows them, with their
 *  weights and the file's offsets. Null when they are neither. */
function verticesOf(att: Raw, count: number, bones?: OutlineBones): ({ points: number[] } & OutlineWeights) | null {
  const v = att.vertices;
  if (!Array.isArray(v)) return null;
  if (v.length === count * 2) return v.every(finite) ? { points: v.map((x, i) => (i % 2 ? 0 - x : x)) } : null;
  const bound = bones ? boundVertices(v, count, { ...bones, pivot: { x: 0, y: 0 } }) : null;
  return bound && { points: bound.positions, weights: bound.weights, boneOffsets: bound.boneOffsets };
}

/** A box, point or path the model can hold: a box or path unweighted, or
 *  weighted when `bones` reads it; a point with its offset. */
export function outlineOf(att: Raw, bones?: OutlineBones): Outline | null {
  const color = typeof att.color === "string" ? att.color : undefined;
  const withColor = <T extends object>(o: T) => (color ? { ...o, color } : o);
  if (att.type === "boundingbox") {
    if (!only(att, ["type", "name", "vertexCount", "vertices", "color"]) || !Number.isInteger(att.vertexCount)) return null;
    const box = verticesOf(att, att.vertexCount as number, bones);
    return box && box.points.length >= 6 ? withColor({ kind: "box" as const, box }) : null;
  }
  if (att.type === "point") {
    if (!only(att, ["type", "name", "x", "y", "rotation", "color"])) return null;
    if ([att.x, att.y, att.rotation].some((v) => v !== undefined && !finite(v))) return null;
    const x = (att.x as number | undefined) ?? 0, y = (att.y as number | undefined) ?? 0, r = (att.rotation as number | undefined) ?? 0;
    // Spine's y up and counterclockwise into the node's y down and clockwise.
    return withColor(x || y || r ? { kind: "point" as const, point: { x, y: 0 - y, rotation: 0 - r } } : { kind: "point" as const });
  }
  if (att.type === "path") {
    if (!only(att, ["type", "name", "vertexCount", "vertices", "lengths", "closed", "constantSpeed", "color"]) || !Number.isInteger(att.vertexCount)) return null;
    const read = verticesOf(att, att.vertexCount as number, bones);
    if (!read || read.points.length < 12 || read.points.length % 6) return null;
    const { points } = read;
    const path: PathShape = { ...read };
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
 * `start`, all in the library and named one after another; the region the
 * image's size, its offset the transform point, a turn or scale kept.
 */
export function sequenceDisplayOf(att: Raw, key: string, itemNamed: (name: string) => { id: ItemId; width: number; height: number } | undefined): DisplayRef | null {
  if ((att.type !== undefined && att.type !== "region") || !only(att, ["type", "name", "path", "sequence", "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "color"])) return null;
  if ([att.rotation, att.scaleX, att.scaleY].some((v) => v !== undefined && !finite(v))) return null;
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
  // Turned or scaled: kept as Spine's (`DisplayRef.region`), the pivot still
  // the unturned centre's.
  const turn: RegionTurn = {};
  if (att.rotation) turn.rotation = att.rotation as number;
  if (att.scaleX !== undefined && att.scaleX !== 1) turn.scaleX = att.scaleX as number;
  if (att.scaleY !== undefined && att.scaleY !== 1) turn.scaleY = att.scaleY as number;
  if (Object.keys(turn).length) ref.region = turn;
  // Its own colour (`DisplayRef.tint`).
  if (typeof att.color === "string" && /^[0-9a-fA-F]{8}$/.test(att.color) && att.color.toLowerCase() !== "ffffffff") ref.tint = att.color.toLowerCase();
  ref.key = key;
  return ref;
}
