import type { Attachment } from "@/model/skeleton";

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A point attachment: a position, and an angle in degrees, in its slot bone's space. */
export function newPointAttachment(x: number, y: number, rotation = 0): Attachment {
  return { type: "point", x: r2(x), y: r2(y), ...(rotation ? { rotation: r2(rotation) } : {}), extra: new Map() };
}

/**
 * A bounding box or a clipping polygon from its corners (x, y in the slot bone's space, in order
 * round the shape). A clipping one clips the slots from its own to `end`.
 */
export function newPolygon(type: "boundingbox" | "clipping", corners: ReadonlyArray<readonly [number, number]>, end?: string): Attachment {
  return {
    type,
    vertexCount: corners.length,
    vertices: corners.flatMap(([x, y]) => [r2(x), r2(y)]),
    ...(type === "clipping" && end !== undefined ? { end } : {}),
    extra: new Map(),
  };
}
