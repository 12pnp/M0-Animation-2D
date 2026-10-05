import type { Skeleton } from "@/model/skeleton";

/**
 * An empty skeleton the profile accepts: a header (Spine 4.3, a hash) and a root bone. The hash is
 * the caller's (any text; spine-csharp only requires one, BoneBurst-Profile.md §2).
 */
export function newSkeleton(hash: string): Skeleton {
  return {
    header: { hash, spine: "4.3.0", extra: new Map() },
    bones: [{ name: "root", extra: new Map() }],
    extra: new Map(),
  };
}
