/// <reference path="../../vendor/spine-pixi.d.ts" />
import type { QueueStep } from "../queue";

/**
 * What the Preview drives, whichever runtime plays the export: spine-pixi-v8
 * (`spineRig.ts`, the default) or the BoneBurst runtime (`boneburstRig.ts`,
 * behind `animo.previewRuntime` = "boneburst"; docs/PREVIEW-RUNTIME-PLAN.md).
 * One track: an animation set or queued on it, advanced by `advance`.
 */
export interface PreviewRig {
  /** Added to the stage, placed and scaled by the preview's fit. */
  readonly display: PIXI.Container;
  readonly animations: string[];
  /** The skeleton's frames per second, or 0 when the file has none. */
  readonly fps: number;
  /** What the file uses that this runtime does not play; empty for spine-pixi. */
  readonly unsupported: string[];
  /** Seconds. */
  durationOf(name: string): number;
  /** `name` from its start, over the setup pose. */
  start(name: string, loop: boolean): void;
  /** `name` posed at `time` seconds, over the setup pose. */
  seek(name: string, time: number, loop: boolean): void;
  /** Play the steps one after another, each crossfaded in over its `mix`. */
  queue(steps: QueueStep[]): void;
  /** Move the track on `dt` seconds and pose. */
  advance(dt: number): void;
  /** The track: its current animation, where in it the pose is, and how long
   *  the track has run. Null before anything was set. */
  track(): { name: string; time: number; trackTime: number; duration: number; loop: boolean } | null;
  setLoop(on: boolean): void;
  setDebug(on: boolean): void;
  /** World matrices y down, [a, b, c, d, x, y] by bone, and each slot's attachment. */
  matrices(): { bones: Record<string, number[]>; attachments: Record<string, string | null> };
  destroy(): void;
}

export interface RigEvent {
  animation: string; name: string; int: number; float: number; string: string;
  audio: string | null; volume: number; balance: number;
}

export interface RigSource {
  skeleton: unknown;
  atlas: string;
  /** Each atlas page's texture, by the file name the atlas gives it. */
  textures: Map<string, PIXI.Texture>;
  /** The skins over the default one, combined in order. */
  skins: string[];
  debug: boolean;
  /** Fired while playing only (a seek must not sound what it lands on). */
  onEvent(e: RigEvent): void;
  /** Whether the track is playing, for `onEvent`. */
  playing(): boolean;
}
