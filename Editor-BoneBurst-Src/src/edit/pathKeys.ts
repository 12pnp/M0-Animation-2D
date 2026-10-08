import type { Animation, Skeleton } from "@/model/skeleton";
import { keyLists } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { onAnimation, withKeys } from "./keys";

/** A bone's translate keys, counted and deleted (FramePath's ⋮ ▸ Delete FramePath data, docs/FRAMEPATH-SPEED-PLAN.md). */

/** The timelines a bone's translation is keyed on: the combined one and the split ones. */
export const TRANSLATE_TIMELINES = ["translate", "translatex", "translatey"] as const;

/** How many translate keys a bone has in an animation, on any of its translate timelines. */
export function translateKeyCount(a: Animation, bone: string): number {
  return keyLists(a).filter((l) => l.path.section === "bones" && l.path.owner === bone && (TRANSLATE_TIMELINES as readonly string[]).includes(l.path.timeline)).reduce((n, l) => n + l.keys.length, 0);
}

/** The bone's translate keys in an animation deleted (every other timeline kept): FramePath's ⋮ ▸ Delete FramePath data. */
export function deleteTranslateKeys(animation: string, bone: string): Edit<Skeleton> {
  return (s) => {
    if (!s.bones?.some((x) => x.name === bone)) throw new EditRefused(`There is no bone "${bone}".`);
    return onAnimation(animation, (a) => {
      let out = a;
      for (const timeline of TRANSLATE_TIMELINES) out = withKeys(out, { section: "bones", owner: bone, timeline }, []);
      return out;
    })(s);
  };
}
