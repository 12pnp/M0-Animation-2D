import type { ItemId } from "@/core/doc/ids";
import type { Animation, SymbolItem, Node } from "@/core/doc/types";

/** The bone every top-level node hangs from. Spine does not require one,
 *  but spine-unity's tooling and most game code assume it. */

export const ROOT_BONE = "root";
/** The deepest nesting the stage draws (`SceneRenderer.drawEntry`). */
export const MAX_DEPTH = 10;
/**
 * Where in time a symbol's contents are, at each frame of one exported
 * (root) animation: its own animation and frame, or null where it is not
 * on screen. The root symbol is at its own frame throughout; a nested one
 * follows the stage's rules (`localAt`, `displayContext`, `childFrame`).
 */
export type FrameAt = { anim: Animation | null; frame: number; } | null;
/** Consecutive root frames where a symbol's frame advances one per frame:
 *  [start, end) in root frames, `local0` the symbol's frame at `start`. */

export interface Run { start: number; end: number; anim: Animation | null; local0: number; }
/** One symbol's contents inside the export: the root, or a nested instance. */
export interface Scope {
  sym: SymbolItem;
  depth: number;
  /** The path of this scope's nodes (see `BoneBurstExport.paths`), "" at the root. */
  key: string;
  /** Prefix of every bone name here, "" at the root. */
  prefix: string;
  /** The bone this symbol's top-level nodes hang from. */
  parentBone: string;
  /** Per exported animation, the frames of `FrameAt`. */
  frames: Map<string, FrameAt[]>;
  /** Per exported animation, the instances' alpha multiplied down to here. */
  alpha: Map<string, number[]>;
  /** Shown in the setup pose (every instance above shows it as display 0). */
  setupVisible: boolean;
  setupAlpha: number;
  /** Symbols above, for the cycle guard. */
  path: ItemId[];
}
/** One slot's worth of bookkeeping for the animation pass. */
export interface SlotPlan {
  scope: Scope; node: Node; name: string; displays: Map<number, string>; setupName: string | null;
  /** Colour offsets somewhere: Spine's two-colour tint (`dark`, `rgba2`). */
  twoColor: boolean;
  /** A mask's clip slot: attachments only, no colour. */
  clip?: boolean;
}
