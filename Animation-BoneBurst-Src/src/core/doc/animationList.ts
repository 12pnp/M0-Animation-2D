/**
 * Decisions about a symbol's list of animations, shared by the timeline's
 * menu and the Animations & Skins panel.
 */

/** `animation`, then `animation_2`, `animation_3`… whichever is free. */
export function uniqueAnimationName(taken: readonly string[]): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) {
    const name = `animation${i === 1 ? "" : `_${i}`}`;
    if (!set.has(name)) return name;
  }
}

/**
 * The animation to show once `removed` is deleted: the current one if it
 * survives, otherwise the one that took its place in the list (or the one
 * before it, at the end). Null when none is left.
 */
export function animationAfterRemoval<T extends string>(
  ids: readonly T[], removed: T, current: T | null,
): T | null {
  const rest = ids.filter((id) => id !== removed);
  if (rest.length === 0) return null;
  if (current && current !== removed && rest.includes(current)) return current;
  const at = ids.indexOf(removed);
  return rest[Math.min(Math.max(at, 0), rest.length - 1)]!;
}
