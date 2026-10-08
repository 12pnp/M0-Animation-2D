/**
 * The bones around a bone, by tier (docs/SHOW-STEPPERS-PLAN.md): tier 1 up is its parent, 2 up its grandparent and so on to the
 * root; tier 1 down is its children, 2 down theirs. No DOM: the Motion Path panel draws these sets, and the tests pose nothing.
 * `parents` is each bone's parent index (-1 for a root), in the rig's order.
 */

export interface Tiers {
  /** The bones above, the root-most first, ending with the parent. */
  readonly above: readonly number[];
  /** The bones below, tier by tier, each tier in the rig's order. */
  readonly below: readonly number[];
  /** How many tiers exist above and below, whatever was asked for. */
  readonly maxUp: number;
  readonly maxDown: number;
}

export function tiersAround(parents: readonly number[], bone: number, up: number, down: number): Tiers {
  const chain: number[] = [];
  for (let b = parents[bone] ?? -1, guard = 0; b >= 0 && guard < parents.length; b = parents[b] ?? -1, guard++) chain.push(b);
  // Each bone's depth under `bone` (1: a child), or 0 when it is not under it.
  const depth = parents.map((_, i) => {
    let d = 0;
    for (let b = i, guard = 0; b >= 0 && guard <= parents.length; b = parents[b] ?? -1, guard++) {
      if (b === bone) return d;
      d++;
    }
    return 0;
  });
  const maxDown = depth.reduce((m, d) => Math.max(m, d), 0), u = Math.max(0, Math.min(up, chain.length)), dn = Math.max(0, down);
  const below: number[] = [];
  for (let t = 1; t <= Math.min(dn, maxDown); t++) parents.forEach((_, i) => { if (depth[i] === t) below.push(i); });
  return { above: chain.slice(0, u).reverse(), below, maxUp: chain.length, maxDown };
}

/** The bone and its tiers as one list: the tiers above first, the bone, then the tiers below. */
export function setOf(parents: readonly number[], bone: number, up: number, down: number): number[] {
  const t = tiersAround(parents, bone, up, down);
  return [...t.above, bone, ...t.below];
}
