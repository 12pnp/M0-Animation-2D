/** The bone size the person can choose (Properties ▸ Skeleton, Preferences): a multiple of the default. */
export const BONE_SIZE_RANGE = [0.2, 10] as const;

/**
 * The unit bones are drawn in, in skeleton units: 1% of the skeleton's larger side (never under half
 * a unit). A bone's thickness and joint are measured in it, so they stay in proportion to the image
 * at every zoom, and in the picture sent to an AI.
 */
export function boneUnitOf(box: { minX: number; minY: number; maxX: number; maxY: number } | null): number {
  return box ? Math.max(box.maxX - box.minX, box.maxY - box.minY, 50) / 100 : 0.5;
}

/** Half the width of a bone's body on screen, in pixels: never under a pixel, so a bone is never lost. */
export function boneHalfWidth(unit: number, size: number, zoom: number): number {
  return Math.max(1, 0.9 * unit * size * zoom);
}

/** The radius of a bone's joint on screen, in pixels. */
export function jointRadius(unit: number, size: number, zoom: number): number {
  return Math.max(1.5, 0.7 * unit * size * zoom);
}
