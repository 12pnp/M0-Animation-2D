/**
 * A count of document edits, bumped by `History` after each apply, undo and
 * redo. Caches keyed by an object the edits change in place (the stage's
 * runtime rig, `spinePose.ts`) check it before trusting what they hold.
 */
export const docEpoch = { n: 0 };

export function touchDoc(): void {
  docEpoch.n++;
}
