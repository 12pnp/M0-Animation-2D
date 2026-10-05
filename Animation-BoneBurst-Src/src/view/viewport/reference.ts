import type { AssetStore } from "@/app/AssetStore";
import type { AnimationReference } from "@/core/doc/types";
import { referenceIndexAt } from "@/core/doc/reference";
import { mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";

/**
 * The reference image a frame shows (`Animation.reference`), drawn through
 * `view` (the symbol's space to device pixels): the stage's, and the AI's
 * `render_frame`, draw it the same way.
 */
export function drawReference(
  ctx: CanvasRenderingContext2D, view: Matrix2D, ref: AnimationReference, frame: number, assets: AssetStore, alpha: number,
): void {
  const i = referenceIndexAt(ref, frame);
  const asset = i === null ? undefined : assets.get(ref.frames[i]!);
  if (!asset) return;
  const m = mul(mat(), view, matOf(ref.scale, 0, 0, ref.scale, ref.x, ref.y));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(m.a, m.b, m.c, m.d, m.tx, m.ty);
  ctx.drawImage(asset.bitmap as CanvasImageSource, 0, 0, ref.width, ref.height);
  ctx.restore();
}
