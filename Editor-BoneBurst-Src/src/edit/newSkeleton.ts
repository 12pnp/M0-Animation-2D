import type { Skeleton } from "@/model/skeleton";

/**
 * An empty skeleton the profile accepts: a header (Spine 4.3, a hash) and a root bone. The hash is
 * the caller's (any text; spine-csharp only requires one, BoneBurst-Profile.md §2).
 */
export function newSkeleton(hash: string, fps?: number): Skeleton {
  return {
    // The frame rate is written only when it is not Spine's 30, as Spine writes it.
    header: { hash, spine: "4.3.0", ...(fps !== undefined && fps !== 30 ? { fps } : {}), extra: new Map() },
    bones: [{ name: "root", extra: new Map() }],
    extra: new Map(),
  };
}
