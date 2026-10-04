import { onionSpan, type OnionSpan } from "@/core/doc/onion";
import { seamFrame } from "@/core/doc/cycle";
import type { Animation } from "@/core/doc/types";
import type { GizmoPrefs } from "@/core/prefs/prefs";
import type { PathPanelSpace } from "./PathPanel";

/** Each Path panel's onion preferences, apart from the stage's and each other's. */
export const PATH_ONION_KEYS = {
  local: {
    on: "localPathOnion", before: "localPathOnionBefore", after: "localPathOnionAfter",
    opacity: "localPathOnionOpacity", past: "localPathOnionPast", future: "localPathOnionFuture",
  },
  world: {
    on: "worldPathOnion", before: "worldPathOnionBefore", after: "worldPathOnionAfter",
    opacity: "worldPathOnionOpacity", past: "worldPathOnionPast", future: "worldPathOnionFuture",
  },
} as const satisfies Record<PathPanelSpace, Record<"on" | "before" | "after" | "opacity" | "past" | "future", keyof GizmoPrefs>>;

/**
 * A Path panel's onion frames: `before` and `after` frames either side of the
 * playhead, always following it (the timeline's anchored markers are the
 * stage's), and wrapping round a cycle's join as the stage's do.
 */
export function pathOnionSpan(frame: number, anim: Animation, before: number, after: number): OnionSpan {
  const maxFrame = Math.max(1, anim.duration) - 1;
  return onionSpan(frame, maxFrame, { onionBefore: before, onionAfter: after }, null, seamFrame(anim));
}
