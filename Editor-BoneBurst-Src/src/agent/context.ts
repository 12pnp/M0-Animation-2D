import type { History } from "@/edit/history";
import type { AtlasImages } from "@/engine/regions";
import type { ConstraintType, Skeleton } from "@/model/skeleton";

/**
 * What the AI tools get from the editor (E5-PLAN steps 2–3): data, and the few things only the
 * editor can do (show, pose, draw). The tools in `src/agent` stay pure; `ui/agent/context.ts`
 * builds this from the session.
 */

/** A call the model can fix: its message says what was wrong. */
export class AgentRefused extends Error {}

/** What the editor shows: an animation (null: the setup pose) at a frame, with a skin over the default. */
export interface AgentView { readonly animation: string | null; readonly frame: number; readonly skin: string | null }

/** One bone as the runtime posed it: world matrix [a, b, c, d, x, y], local pose (7 values), length. */
export interface PosedBone { readonly name: string; readonly active: boolean; readonly world: readonly number[]; readonly local: readonly number[]; readonly length: number }

/** A reference picture (the sidecar's): its place and scale, and its picture's size when it has one. */
export interface AgentReference { readonly path: string; readonly x: number; readonly y: number; readonly scale: number; readonly opacity: number; readonly width: number | null; readonly height: number | null }

/** What `render_frame` asks the editor to draw. */
export interface RenderRequest {
  readonly skin: string | null;
  readonly animation: string | null;
  readonly time: number;
  readonly reference: boolean;
  readonly bones: boolean;
  /** Bones' tips at every frame (skeleton space), joined; `keyed` are indices into `points`. */
  readonly paths: readonly { readonly bone: string; readonly points: readonly (readonly [number, number])[]; readonly keyed: readonly number[] }[];
}

/** The picture, as base64 PNG, and how its pixels map to the skeleton: (x, y) is at (origin[0] + x·scale, origin[1] − y·scale). */
export interface RenderResult {
  readonly png: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly origin: readonly [number, number];
  /** Each active bone's joint and tip in pixels; `outside` when neither is in the picture. */
  readonly bones: readonly { readonly name: string; readonly joint: readonly [number, number]; readonly tip: readonly [number, number]; readonly outside?: true }[];
}

/** What the editor gives the tools: data, and the few things only it can do. */
export interface AgentContext {
  /** The open document's history; null when nothing is open. */
  readonly history: History<Skeleton> | null;
  /** Tell the editor the document or the view changed. */
  changed(): void;
  /** The atlas's regions (pictures and their sizes). */
  readonly images: AtlasImages;
  view(): AgentView;
  show(view: AgentView): void;
  /** Every bone posed: `animation` (null: setup) at `time` seconds, `skin` shown. */
  pose(skin: string | null, animation: string | null, time: number): readonly PosedBone[];
  /** The same for another document (check_preview: the file as written and read back). */
  poseOf(doc: Skeleton, skin: string | null, animation: string | null, time: number): readonly PosedBone[];
  /** A constraint's animatable values in force at `time` of `animation` (null: setup), named as its keys name them; null when the rig has no such constraint. */
  constraintNow(skin: string | null, animation: string | null, time: number, type: ConstraintType, name: string): Record<string, number | boolean> | null;
  references(): readonly AgentReference[];
  /** A reference's picture as base64 PNG, or null when its file was not given. */
  referencePicture(path: string): Promise<string | null>;
  render(request: RenderRequest): Promise<RenderResult>;
  /** An atlas image's alpha at its original size, rows top first; null when its page's pixels are not to hand. */
  pixels(image: string): Promise<ImageAlpha | null>;
  /** Write the rig into the Unity folder chosen in the editor (Export to Unity…); refuses, saying what to press, when none is chosen or allowed. */
  exportToUnity(): Promise<{ folder: string; files: readonly string[] }>;
}

/** Alpha per pixel (0–255), `width` × `height`, rows top first. */
export interface ImageAlpha { readonly width: number; readonly height: number; readonly alpha: Uint8Array }

/** A tool's value may carry pictures under this key; the bridge sends them as images. */
export const IMAGES_KEY = "__images";

