/**
 * One image placed on a page, in page pixels with a top-left origin. The
 * format writer (`core/boneburst/atlas.ts`) serialises this; it holds
 * everything a trimmed region needs and names no runtime.
 */
export interface PackedRegion {
  name: string;
  x: number;
  y: number;
  /** The TRIMMED size, as drawn on the page. */
  width: number;
  height: number;
  /** What trimming cut off the left and top edges; 0 when untrimmed. */
  offsetX: number;
  offsetY: number;
  /** The UNTRIMMED size. */
  originalWidth: number;
  originalHeight: number;
  rotated: boolean;
}

export interface PackedPage {
  /** The shared atlas name every page carries. */
  name: string;
  imagePath: string;
  width: number;
  height: number;
  /** Texture resolution; 1 at full size. */
  scale: number;
  regions: PackedRegion[];
}
