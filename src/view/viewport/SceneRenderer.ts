import { invert, mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";
import type { Animation, SymbolItem } from "@/core/doc/types";
import { type BlendMode, type ColorTransform, isImage, isSymbol, type Project } from "@/core/doc/types";
import {
    childFrame,
    displayContext,
    evaluateSymbol,
    type FrameContext,
    innerContext,
    type Pose,
    type PoseEntry,
    SETUP_CONTEXT,
} from "@/core/doc/pose";
import { maskGroups } from "@/core/doc/layerTree";
import { posedSymbol } from "@/core/spine/spinePose";
import type { AssetStore } from "@/app/AssetStore";

/**
 * Draws an evaluated pose with Canvas2D.
 *
 * `drawEntry` is deliberately the smallest possible unit — matrix, pivot,
 * image, colour in, pixels out — because the parity harness calls it
 * directly to compare against the DragonBones runtime.
 */
/**
 * Where a symbol instance's CONTENTS sit in the parent's space: its world
 * matrix, shifted by -pivot the way `drawEntry` shifts them. Edit-in-place
 * uses the same matrix, which is what makes descending into an instance leave
 * the artwork exactly where it was drawn.
 */
export function contentMatrixOf(
  world: Matrix2D, pivot: { x: number; y: number },
): Matrix2D {
  return mul(mat(), world, matOf(1, 0, 0, 1, -pivot.x, -pivot.y));
}

export class SceneRenderer {
  constructor(
    private readonly project: () => Project,
    private readonly assets: AssetStore,
  ) {}

  /**
   * Tinted copies, per decoded bitmap and then per colour transform. Keyed by
   * the bitmap object, not by `AssetId`: ids restart with every new or opened
   * project, and the library's renderer — thumbnails, Export as .png — is
   * never told the project changed, so an id key served the previous
   * project's pixels.
   */
  private tintCache = new WeakMap<object, Map<string, HTMLCanvasElement>>();

  clearCaches(): void { this.tintCache = new WeakMap(); }

  /**
   * `view` maps WORLD to DEVICE pixels — it must already fold in the device
   * pixel ratio and the ruler gutter, because drawEntry uses
   * `ctx.setTransform`, which replaces the context transform outright rather
   * than composing with it.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    symbol: SymbolItem,
    animation: Animation | null,
    frame: number,
    mode: "setup" | "animate",
    view: Matrix2D,
    opts: { alpha?: number; hiddenLayers?: Set<string> } = {},
  ): Pose {
    const pose = posedSymbol(this.project(), symbol, animation, frame, mode);
    const when: FrameContext = { animationName: animation?.name ?? null, frame, mode };

    ctx.save();
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
    this.drawEntries(ctx, symbol, pose.entries, view, 0, when, opts.hiddenLayers);
    ctx.restore();
    return pose;
  }

  /**
   * One symbol's entries in paint order, honouring its mask layers.
   *
   * Shared by the top level and by every nested instance, because a mask
   * inside a symbol is the ordinary case — an eye whose circular mask clips a
   * moving eyelid keeps working when the whole eye moves, and drawing the
   * inner entries flat would show the eyelid outside the eye.
   */
  private drawEntries(
    ctx: CanvasRenderingContext2D,
    symbol: SymbolItem,
    entries: PoseEntry[],
    base: Matrix2D,
    depth: number,
    when: FrameContext,
    hiddenLayers?: Set<string>,
  ): void {
    const world = mat();
    if (symbol.spine && entries.some((e) => e.spine || e.clip)) {
      this.drawSpineEntries(ctx, entries, base, hiddenLayers);
      return;
    }
    const groups = maskGroups(symbol);

    if (groups.size === 0) {
      for (const e of entries) {
        if (!e.visible || hiddenLayers?.has(e.nodeId)) continue;
        mul(world, base, e.world);
        this.drawEntry(ctx, e, world, depth, when);
      }
      return;
    }

    // Layer id -> node id, so a pose entry can be matched to a mask link.
    const nodeOfLayer = new Map<string, string>();
    for (const l of symbol.layers) nodeOfLayer.set(l.id, l.nodeId);
    const maskNodeOf = new Map<string, string>();   // masked node -> mask node
    const maskNodes = new Set<string>();
    for (const [maskLayerId, masked] of groups) {
      const maskNode = nodeOfLayer.get(maskLayerId);
      if (!maskNode) continue;
      maskNodes.add(maskNode);
      for (const l of masked) maskNodeOf.set(l.nodeId, maskNode);
    }

    const byNode = new Map(entries.map((e) => [e.nodeId as string, e]));
    const done = new Set<string>();

    for (const e of entries) {
      // A mask's own artwork is never drawn — it only clips, as in Flash.
      if (maskNodes.has(e.nodeId) || done.has(e.nodeId)) continue;

      const maskNode = maskNodeOf.get(e.nodeId);
      if (!maskNode) {
        if (!e.visible || hiddenLayers?.has(e.nodeId)) continue;
        mul(world, base, e.world);
        this.drawEntry(ctx, e, world, depth, when);
        continue;
      }

      // The whole group is contiguous in paint order, so it is gathered once
      // and drawn into a scratch layer that the mask then punches out of.
      const group = entries.filter((g) => maskNodeOf.get(g.nodeId) === maskNode);
      group.forEach((g) => done.add(g.nodeId));
      const maskEntry = byNode.get(maskNode);
      const visible = group.filter((g) => g.visible && !hiddenLayers?.has(g.nodeId));
      if (visible.length === 0) continue;

      // Hiding the mask layer reveals the group unmasked, which is both what
      // Flash does while authoring and, as it happens, what Pixi does when a
      // mask display has `visible = false`. `hiddenLayers` is not that: it
      // leaves a layer's ARTWORK out (a locked layer from the onion skin), and
      // a mask's artwork is never drawn anyway — it still clips.
      if (!maskEntry || !maskEntry.visible) {
        for (const g of visible) {
          mul(world, base, g.world);
          this.drawEntry(ctx, g, world, depth, when);
        }
        continue;
      }

      const scratch = this.scratchFor(depth, ctx.canvas.width, ctx.canvas.height);
      if (!scratch) continue;
      const sctx = scratch.getContext("2d")!;
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, scratch.width, scratch.height);

      for (const g of visible) {
        mul(world, base, g.world);
        this.drawEntry(sctx, g, world, depth, when);
      }

      // Keep only what the mask's own alpha covers.
      sctx.save();
      sctx.globalCompositeOperation = "destination-in";
      mul(world, base, maskEntry.world);
      this.drawEntry(sctx, maskEntry, world, depth, when);
      sctx.restore();

      // Composited under the caller's globalAlpha, so a group's alpha is
      // applied once to the flattened result rather than per layer.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(scratch, 0, 0);
      ctx.restore();
    }
  }

  /**
   * A symbol the Spine runtime posed (`spinePose.ts`): its slots in the
   * runtime's draw order, each the geometry the runtime computed. A clipping
   * attachment clips from the next slot through its end slot, one at a time,
   * as `SkeletonClipping` does: a clip met while another is on is ignored.
   */
  private drawSpineEntries(
    ctx: CanvasRenderingContext2D, entries: PoseEntry[], base: Matrix2D, hiddenLayers?: Set<string>,
  ): void {
    let clipUntil: string | null | undefined;   // undefined: not clipping
    for (const e of entries) {
      if (e.clip && e.visible && clipUntil === undefined && !hiddenLayers?.has(e.nodeId)) {
        ctx.save();
        ctx.beginPath();
        const p = e.clip.polygon;
        for (let i = 0; i < p.length; i += 2) {
          const x = base.a * p[i]! + base.c * p[i + 1]! + base.tx, y = base.b * p[i]! + base.d * p[i + 1]! + base.ty;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clip();
        clipUntil = e.clip.until;
      } else if (e.spine && e.visible && !hiddenLayers?.has(e.nodeId)) {
        this.drawSpine(ctx, e, base);
      }
      if (clipUntil !== undefined && clipUntil === e.nodeId) { ctx.restore(); clipUntil = undefined; }
    }
    if (clipUntil !== undefined) ctx.restore();
  }

  /** One region or mesh as the runtime placed it, `base` taking the
   *  symbol's space to the screen. */
  private drawSpine(ctx: CanvasRenderingContext2D, e: PoseEntry, base: Matrix2D): void {
    const draw = e.spine!;
    const item = this.project().items[draw.itemId];
    if (!isImage(item)) return;
    const asset = this.assets.get(item.assetId);
    if (!asset) return;
    const source = this.sourceFor(asset.bitmap as CanvasImageSource, item.width, item.height, e.color);
    const v = draw.vertices, n = v.length / 2;
    const sx = new Float64Array(n), sy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sx[i] = base.a * v[i * 2]! + base.c * v[i * 2 + 1]! + base.tx;
      sy[i] = base.b * v[i * 2]! + base.d * v[i * 2 + 1]! + base.ty;
    }
    const alpha = Math.max(0, Math.min(1, e.color.aM / 100));
    const blend = e.node.blendMode ? COMPOSITE[e.node.blendMode] : "source-over";

    if (draw.quad) {
      // Bottom-left, top-left, top-right: the image's y and x axes.
      const w = item.width, h = item.height;
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.globalCompositeOperation = blend;
      ctx.imageSmoothingQuality = "high";
      ctx.setTransform((sx[2]! - sx[1]!) / w, (sy[2]! - sy[1]!) / w, (sx[0]! - sx[1]!) / h, (sy[0]! - sy[1]!) / h, sx[1]!, sy[1]!);
      ctx.drawImage(source, 0, 0, w, h);
      ctx.restore();
      return;
    }

    // Triangle by triangle, each its own affine image clipped to it. Their
    // edges are pushed out half a pixel so no seam shows; where that would
    // double a translucent or blended edge, the mesh is flattened first.
    const flat = alpha < 1 || blend !== "source-over";
    const target = flat ? this.meshScratch(ctx.canvas.width, ctx.canvas.height) : ctx;
    if (!target) return;
    if (flat) { target.setTransform(1, 0, 0, 1, 0, 0); target.clearRect(0, 0, target.canvas.width, target.canvas.height); }
    const uv = draw.uvs, tri = draw.triangles;
    for (let t = 0; t < tri.length; t += 3) {
      const i0 = tri[t]!, i1 = tri[t + 1]!, i2 = tri[t + 2]!;
      const u0 = uv[i0 * 2]!, v0 = uv[i0 * 2 + 1]!, u1 = uv[i1 * 2]!, v1 = uv[i1 * 2 + 1]!, u2 = uv[i2 * 2]!, v2 = uv[i2 * 2 + 1]!;
      const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      if (Math.abs(det) < 1e-9) continue;
      const x0 = sx[i0]!, y0 = sy[i0]!, x1 = sx[i1]!, y1 = sy[i1]!, x2 = sx[i2]!, y2 = sy[i2]!;
      const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
      const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
      const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
      const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
      const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
      const grow = (x: number, y: number): [number, number] => {
        const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy) || 1;
        return [x + (dx / len) * 0.5, y + (dy / len) * 0.5];
      };
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.beginPath();
      target.moveTo(...grow(x0, y0));
      target.lineTo(...grow(x1, y1));
      target.lineTo(...grow(x2, y2));
      target.closePath();
      target.clip();
      target.setTransform(a, b, c, d, x0 - a * u0 - c * v0, y0 - b * u0 - d * v0);
      target.drawImage(source, 0, 0, item.width, item.height);
      target.restore();
    }
    if (flat) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha *= alpha;
      ctx.globalCompositeOperation = blend;
      ctx.drawImage(target.canvas, 0, 0);
      ctx.restore();
    }
  }

  private meshCanvas: HTMLCanvasElement | null = null;

  private meshScratch(w: number, h: number): CanvasRenderingContext2D | null {
    if (w === 0 || h === 0) return null;
    const c = (this.meshCanvas ??= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c.getContext("2d");
  }

  /**
   * One scratch canvas per nesting depth, reused across frames.
   *
   * Masks compose through nested symbols, so depth 0's layer must survive
   * while depth 1 is being built — a single shared canvas would be cleared
   * out from under it.
   */
  private scratch: HTMLCanvasElement[] = [];

  private scratchFor(depth: number, w: number, h: number): HTMLCanvasElement | null {
    if (w === 0 || h === 0) return null;
    let c = this.scratch[depth];
    if (!c) { c = document.createElement("canvas"); this.scratch[depth] = c; }
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  /** One display, already composed to screen space. */
  drawEntry(
    ctx: CanvasRenderingContext2D, e: PoseEntry, screen: Matrix2D, depth: number,
    when: FrameContext = SETUP_CONTEXT,
  ): void {
    const display = e.display;
    if (!display) return;
    const item = this.project().items[display.itemId];

    // A mesh: its world vertices are the pose's; `screen` is base · world.
    if (e.spine && isImage(item)) {
      const inv = mat();
      if (invert(inv, e.world)) this.drawSpine(ctx, e, mul(mat(), screen, inv));
      return;
    }

    if (isImage(item)) {
      const asset = this.assets.get(item.assetId);
      if (!asset) return;
      const source = this.sourceFor(asset.bitmap as CanvasImageSource, item.width, item.height, e.color);
      ctx.save();
      ctx.setTransform(screen.a, screen.b, screen.c, screen.d, screen.tx, screen.ty);
      ctx.globalAlpha *= Math.max(0, Math.min(1, e.color.aM / 100));
      // Blend applies to the FINAL draw, not to the tint bake in `sourceFor`.
      // Symbol instances deliberately get none: the runtime's
      // `_updateBlendMode` is guarded by `instanceof PIXI.Sprite`, so a child
      // armature's Container never receives one and the stage must not either.
      if (e.node.blendMode) ctx.globalCompositeOperation = COMPOSITE[e.node.blendMode];
      ctx.imageSmoothingQuality = "high";
      // The pivot is the transform origin, so the artwork is offset by -pivot.
      ctx.drawImage(source, -display.pivot.x, -display.pivot.y, item.width, item.height);
      ctx.restore();
      return;
    }

    if (isSymbol(item) && depth < 10) {
      // A nested symbol instance draws its own contents under this transform,
      // at ITS OWN frame: a child armature has its own looping timeline, and
      // the runtime plays it whatever the parent is doing.
      const at = displayContext(when, e.displaySince);
      const here = childFrame(item, at);
      const inner = evaluateSymbol(item, here.animation, here.frame, when.mode);

      // The transform point sits on the bone origin, so the contents hang off
      // it by -pivot — the same offset an image display gets, expressed for a
      // child armature as the display's own transform on export.
      const base = mul(mat(), screen, matOf(1, 0, 0, 1, -display.pivot.x, -display.pivot.y));
      ctx.save();
      ctx.globalAlpha *= Math.max(0, Math.min(1, e.color.aM / 100));
      this.drawEntries(ctx, item, inner.entries, base, depth + 1, innerContext(item, at));
      ctx.restore();
    }
  }

  /**
   * Returns either the raw bitmap or a cached tinted copy. Canvas2D has no
   * multiply-tint primitive, so a non-default colour transform is baked into
   * an offscreen canvas once and reused.
   */
  /**
   * Note only the RGB channels are baked, never `aO`. Alpha is applied as
   * `globalAlpha` from `aM` alone, because `PixiSlot._updateColor` reads
   * `alphaMultiplier` into `display.alpha` and ignores every offset — baking
   * `aO` here would draw something the runtime cannot reproduce. The exporter
   * warns when a document carries offsets at all.
   */
  private sourceFor(
    bitmap: CanvasImageSource, w: number, h: number, color: ColorTransform,
  ): CanvasImageSource {
    const needsTint =
      color.rM !== 100 || color.gM !== 100 || color.bM !== 100 ||
      color.rO !== 0 || color.gO !== 0 || color.bO !== 0;
    if (!needsTint) return bitmap;

    const key = `${color.rM},${color.gM},${color.bM},${color.rO},${color.gO},${color.bO}`;
    let tints = this.tintCache.get(bitmap);
    if (!tints) { tints = new Map(); this.tintCache.set(bitmap, tints); }
    const hit = tints.get(key);
    if (hit) return hit;

    const c = document.createElement("canvas");
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    const cx = c.getContext("2d", { willReadFrequently: true });
    if (!cx) return bitmap;
    cx.drawImage(bitmap, 0, 0, w, h);
    const img = cx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i]     = clamp255(d[i]!     * (color.rM / 100) + color.rO);
      d[i + 1] = clamp255(d[i + 1]! * (color.gM / 100) + color.gO);
      d[i + 2] = clamp255(d[i + 2]! * (color.bM / 100) + color.bO);
    }
    cx.putImageData(img, 0, 0);

    // Bound the cache; tints churn while a colour slider is being dragged.
    if (tints.size > 64) tints.clear();
    tints.set(key, c);
    return c;
  }
}

/** Our BlendMode -> Canvas2D, matching what `PixiSlot._updateBlendMode` applies. */
const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  add: "lighter",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
  hardlight: "hard-light",
};

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
