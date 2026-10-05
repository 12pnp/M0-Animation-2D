import { keyChannelAt, unwrapTurns } from "./propertyKeys";
import { sameValues, valuesOf } from "./keyed";
import { sampleTransformRaw } from "./timeline";
import { type Node, TIMELINE_PROPS, type TimelineProp, type Track } from "./types";

/**
 * The timeline's Key button (ARCHITECTURE ▸ Key buttons), pure: which
 * properties a press keys, and the track with them keyed. Spine keys each
 * property group on its own; "changed" is every property whose value at the
 * frame is not the setup pose's, so a first pose can be keyed without keying
 * what was left alone.
 */

export type KeyGroup = "rotate" | "translate" | "scale" | "shear";

export const KEY_GROUPS: Record<KeyGroup, readonly TimelineProp[]> = {
  rotate: ["rotate"], translate: ["x", "y"], scale: ["scale"], shear: ["shear"],
};

/** The properties of `node` whose value at `frame` is not its setup pose's. */
export function changedProps(track: Track | undefined, node: Node, frame: number): TimelineProp[] {
  if (!track) return [];
  const now = sampleTransformRaw(unwrapTurns(track), frame);
  if (!now) return [];
  return TIMELINE_PROPS.filter((p) => !sameValues(valuesOf(p, now), valuesOf(p, node.bind)));
}

/** `track` with each of `props` keyed at `frame` (`keyChannelAt`); the same
 *  track when every one already has a key there. */
export function keyProps(track: Track, node: Node, props: readonly TimelineProp[], frame: number): Track {
  return props.reduce((t, p) => keyChannelAt(t, node, p, frame), track);
}
