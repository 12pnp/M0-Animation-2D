/**
 * The globals of the preview page's classic scripts, `public/vendor/pixi.js`
 * (PixiJS 8.21.0) and `public/vendor/spine-pixi-v8.js` (4.3.13), declared
 * only as far as `src/preview/previewClient.ts` calls them.
 */

declare namespace PIXI {
  interface TextureSource { readonly width: number; readonly height: number }
  class Texture {
    static from(source: ImageBitmap): Texture;
    readonly source: TextureSource;
    destroy(destroySource?: boolean): void;
  }
  class Container {
    x: number;
    y: number;
    readonly scale: { x: number; y: number; set(x: number, y?: number): void };
    addChild<T extends Container>(child: T): T;
    removeChildren(): Container[];
    destroy(options?: boolean | { children?: boolean }): void;
  }
  class Graphics extends Container {
    rect(x: number, y: number, w: number, h: number): this;
    fill(style: { color: number; alpha?: number }): this;
    stroke(style: { color: number; alpha?: number; width?: number }): this;
  }
  interface Ticker { readonly deltaMS: number; add(fn: (ticker: Ticker) => void): void }
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
  interface SkeletonData {
    readonly animations: Animation[];
    readonly fps: number;
    findAnimation(name: string): Animation | null;
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
  }
  interface TrackEntry {
    loop: boolean;
    trackTime: number;
    readonly animation: Animation;
    getAnimationTime(): number;
  }
  interface AnimationState {
    setAnimation(track: number, name: string, loop: boolean): TrackEntry;
    getTrack(track: number): TrackEntry | null;
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
