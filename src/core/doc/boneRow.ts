/** One row of the stage toolbar's visibility table: pick, show, name. */
export interface RowFlags {
  pick: boolean;
  show: boolean;
  name: boolean;
}

/**
 * What the stage does with a bone: a primary one (`Node.primary`) follows the
 * Primary row, every other bone the Bones row. A hidden bone is neither
 * picked nor named, whatever its other two switches say.
 */
export function boneRow(primary: boolean, bones: RowFlags, primaryRow: RowFlags): RowFlags {
  const r = primary ? primaryRow : bones;
  return { show: r.show, pick: r.show && r.pick, name: r.show && r.name };
}
