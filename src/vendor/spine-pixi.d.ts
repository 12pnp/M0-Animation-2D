/**
 * The globals of the preview page's classic scripts, `public/vendor/pixi.js`
 * (PixiJS 8.21.0) and `public/vendor/spine-pixi-v8.js` (4.3.13), declared
 * only as far as `src/preview/` calls them.
 */

declare namespace PIXI {
  interface TextureSource {
    readonly width: number;
    readonly height: number;
    alphaMode: "no-premultiply-alpha" | "premultiply-alpha-on-upload" | "premultiplied-alpha";
  }
  class Texture {
    static from(source: ImageBitmap): Texture;
    readonly source: TextureSource;
    destroy(destroySource?: boolean): void;
  }
  class Container {
    setMask(options: { mask: Container; inverse?: boolean }): void;
    x: number;
    y: number;
    readonly scale: { x: number; y: number; set(x: number, y?: number): void };
    addChild<T extends Container>(child: T): T;
    removeChildren(): Container[];
    destroy(options?: boolean | { children?: boolean }): void;
  }
  /** The BoneBurst runtime's slots (`src/preview/runtime/boneburstRig.ts`). */
  class MeshGeometry {
    constructor(options: { positions: Float32Array; uvs: Float32Array; indices: Uint32Array });
    getBuffer(id: "aPosition" | "aUV"): { update(): void };
  }
  /** Uniforms for the two-colour tint shader (`src/preview/runtime/twoColor.ts`). */
  class UniformGroup {
    constructor(structures: Record<string, { value: Float32Array; type: string }>);
    readonly uniforms: Record<string, Float32Array>;
    update(): void;
  }
  class Shader {
    static from(options: { gl: { vertex: string; fragment: string }; resources: Record<string, unknown> }): Shader;
    readonly resources: Record<string, unknown>;
  }
  class Mesh extends Container {
    constructor(options: { geometry: MeshGeometry; texture: Texture; shader?: Shader });
    texture: Texture;
    tint: number;
    alpha: number;
    visible: boolean;
    blendMode: "normal" | "add" | "multiply" | "screen";
  }
  class Graphics extends Container {
    clear(): this;
    poly(points: number[], close?: boolean): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    circle(x: number, y: number, r: number): this;
    rect(x: number, y: number, w: number, h: number): this;
    fill(style: { color: number; alpha?: number }): this;
    stroke(style: { color: number; alpha?: number; width?: number }): this;
  }
  interface Ticker { readonly deltaMS: number; maxFPS: number; add(fn: (ticker: Ticker) => void): void }
  class Application {
    init(options: Record<string, unknown>): Promise<void>;
    readonly canvas: HTMLCanvasElement;
    readonly stage: Container;
    readonly ticker: Ticker;
    readonly renderer: { background: { color: number } };
  }
  const VERSION: string;
}

declare namespace spine {
  class TextureAtlasPage {
    readonly name: string;
    setTexture(texture: SpineTexture): void;
  }
  class TextureAtlas {
    constructor(text: string);
    readonly pages: TextureAtlasPage[];
  }
  class SpineTexture {
    static from(source: PIXI.TextureSource): SpineTexture;
  }
  class AtlasAttachmentLoader { constructor(atlas: TextureAtlas) }
  class SkeletonJson {
    constructor(loader: AtlasAttachmentLoader);
    readSkeletonData(json: unknown): SkeletonData;
  }
  interface Animation { readonly name: string; readonly duration: number }
  class Skin {
    constructor(name: string);
    addSkin(skin: Skin): void;
  }
  interface SkeletonData {
    readonly animations: Animation[];
    readonly fps: number;
    findAnimation(name: string): Animation | null;
    findSkin(name: string): Skin | null;
  }
  interface BonePose { a: number; b: number; c: number; d: number; worldX: number; worldY: number }
  interface Bone { readonly data: { readonly name: string }; readonly appliedPose: BonePose }
  interface Slot {
    readonly data: { readonly name: string };
    readonly appliedPose: { getAttachment(): { readonly name: string } | null; readonly color: { r: number; g: number; b: number; a: number } };
  }
  interface Skeleton {
    readonly data: SkeletonData;
    readonly bones: Bone[];
    readonly slots: Slot[];
    readonly drawOrder: { readonly appliedPose: Slot[] };
    setupPose(): void;
    setSkin(skin: string | Skin): void;
  }
  interface TrackEntry {
    loop: boolean;
    trackTime: number;
    readonly animation: Animation;
    getAnimationTime(): number;
    /** The crossfade into this entry; a `delay` <= 0 starts it that long before the previous ends. */
    setMixDuration(mixDuration: number, delay: number): void;
  }
  interface SpineEvent {
    readonly data: { readonly name: string; readonly audioPath: string | null };
    readonly time: number;
    intValue: number;
    floatValue: number;
    stringValue: string;
    volume: number;
    balance: number;
  }
  interface AnimationStateListener {
    event?(entry: TrackEntry, event: SpineEvent): void;
  }
  interface AnimationStateData {
    setMix(from: string, to: string, duration: number): void;
  }
  interface AnimationState {
    readonly data: AnimationStateData;
    setAnimation(track: number, name: string, loop: boolean): TrackEntry;
    addAnimation(track: number, name: string, loop: boolean, delay: number): TrackEntry;
    getTrack(track: number): TrackEntry | null;
    addListener(listener: AnimationStateListener): void;
  }
  class SpineDebugRenderer {}
  class Spine extends PIXI.Container {
    constructor(options: { skeletonData: SkeletonData; autoUpdate?: boolean });
    readonly skeleton: Skeleton;
    readonly state: AnimationState;
    debug: SpineDebugRenderer | undefined;
    update(dt: number): void;
  }
}
