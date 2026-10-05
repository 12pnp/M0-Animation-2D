/** postMessage contract between the editor and the preview iframe. */

import type { QueueEntry } from "./queue";

/** An atlas page image, by the file name the `.atlas` text gives it. */
export interface PreviewPage {
  name: string;
  png: Blob;
}

export type HostToFrame =
  | { type: "load"; skeleton: unknown; atlas: string; pages: PreviewPage[];
      animation?: string; debugDraw?: boolean;
      /** Start playing straight away. Off by default: an animation looping in
       *  the corner while you work is a distraction, not information. */
      play?: boolean;
      /** Frame to rest on when not playing. */
      frame?: number;
      /** Scene bounds, drawn as an outline so the framing is legible. */
      stage?: { width: number; height: number; background: string };
      /** Content bounds in the symbol's space, so the frame can fit the rig
       *  before anything has been drawn. */
      fit?: { x: number; y: number; w: number; h: number };
      /** The skins the stage shows over the default skin, combined
       *  (`stageSkinOf`). */
      skins?: string[]; }
  /** Take whatever is loaded off the screen: the document has nothing to
   *  show (a new project), and leaving the previous rig up says the editor
   *  and the runtime disagree when they do not. */
  | { type: "clear" }
  | { type: "play" }
  /** Carry on from where `pause` left off. `play` always restarts at frame 0
   *  (`Animation.play` resets the state), which reads as a bug the moment
   *  there is a pause button next to it. */
  | { type: "resume" }
  | { type: "pause" }
  | { type: "setLoop"; on: boolean }
  /** Playback speed, 1 = the skeleton's fps (`timeline.playSpeed`). */
  | { type: "setSpeed"; speed: number }
  /** Redraws a second at most while playing (`timeline.playRate`). */
  | { type: "setFps"; fps: number }
  | { type: "seek"; frame: number }
  | { type: "setAnimation"; name: string }
  /** Play `from` once, then `to` crossfaded in over `duration` seconds
   *  (`AnimationStateData.setMix`), as a game changes animation. */
  /** Play animations one after another, each crossfaded into (`queue.ts`). */
  | { type: "playQueue"; entries: QueueEntry[] }
  | { type: "setDebug"; on: boolean }
  | { type: "setBackground"; color: string }
  | { type: "showStage"; on: boolean }
  /** Used by the parity harness: the runtime's own world matrices, y down
   *  (the preview's Skeleton.yDown), by bone name. */
  | { type: "getMatrices" };

export type FrameToHost =
  | { type: "ready"; version: string }
  /** `animation` is the one loaded, which the transport menus show. */
  | { type: "loaded"; animations: string[]; animation: string; duration: number }
  | { type: "tick"; frame: number; playing: boolean }
  /** An event the runtime fired while playing, with the values it fired. */
  | { type: "event"; animation: string; name: string; int: number; float: number; string: string;
      audio: string | null; volume: number; balance: number }
  | { type: "matrices"; bones: Record<string, number[]>; attachments: Record<string, string | null> }
  | { type: "error"; message: string };

/**
 * The frame a `tick` reports: the one on screen, which is the frame the
 * animation time has reached, never the next one. Rounding reported the next
 * frame for the second half of every frame and, at the end of each loop, one
 * past the last — so a one-frame animation sent the editor's playhead back
 * and forth between frames 1 and 2 a hundred times a second.
 */
export function tickFrame(time: number, frameRate: number, frameCount: number): number {
  const frame = Math.floor(time * frameRate + 1e-6);
  return Math.max(0, Math.min(Math.max(0, frameCount - 1), frame));
}
