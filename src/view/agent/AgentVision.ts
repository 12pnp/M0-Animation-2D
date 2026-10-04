import type { AssetStore } from "@/app/AssetStore";
import type { Store } from "@/app/Store";
import type { AgentImage, AgentVision, BoneMark, PathMark } from "@/app/agent/AgentApi";
import type { AssetId } from "@/core/doc/ids";
import { matOf } from "@/core/math/Matrix2D";
import { SceneRenderer } from "@/view/viewport/SceneRenderer";
import { drawReference } from "@/view/viewport/reference";

/**
 * The AI's eyes (`AgentVision`): pictures painted on canvases of their own,
 * with the stage's renderer and the stage's reference drawing, so the model
 * sees what the user sees. `AgentApi` works out the framing and the bone
 * positions; this paints them and encodes PNG.
 */
export class PageVision implements AgentVision {
  private readonly renderer: SceneRenderer;

  constructor(store: Store, private readonly assets: AssetStore) {
    this.renderer = new SceneRenderer(() => store.project, assets);
  }

  async image(assetId: AssetId, maxSide: number): Promise<AgentImage> {
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error(`The reference image ${assetId} is missing.`);
    const s = Math.min(1, maxSide / Math.max(asset.width, asset.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(asset.width * s));
    canvas.height = Math.max(1, Math.round(asset.height * s));
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(asset.bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    return encode(canvas);
  }

  async render(req: Parameters<AgentVision["render"]>[0]): Promise<AgentImage> {
    const { view } = req;
    const canvas = document.createElement("canvas");
    canvas.width = view.width;
    canvas.height = view.height;
    const ctx = canvas.getContext("2d")!;
    // A light, flat ground: artwork and dark bone marks both read on it.
    ctx.fillStyle = "#d9d9d9";
    ctx.fillRect(0, 0, view.width, view.height);
    const [tx, ty] = view.toPixel(0, 0);
    const m = matOf(view.scale, 0, 0, view.scale, tx, ty);
    // Reference whole, the skeleton see-through over it: both stay readable
    // where they overlap, which is where the comparison is.
    const ref = req.reference ? req.animation?.reference : undefined;
    if (ref) drawReference(ctx, m, ref, req.frame, this.assets, 1);
    if (req.artwork !== false) this.renderer.draw(ctx, req.symbol, req.animation, req.frame, req.animation ? "animate" : "setup", m, ref ? { alpha: 0.55 } : {});
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (req.paths) drawPaths(ctx, req.paths);
    drawBones(ctx, req.bones, view.width, view.height);
    return encode(canvas);
  }
}

/** Paths under the bones: an orange line through the tip at every frame, a
 *  ring on each key, a filled dot on the frame drawn. */
function drawPaths(ctx: CanvasRenderingContext2D, paths: PathMark[]): void {
  ctx.lineJoin = "round";
  for (const p of paths) {
    if (p.points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(...p.points[0]!);
    for (const q of p.points.slice(1)) ctx.lineTo(...q);
    if (p.closed) ctx.closePath();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = "#ff9a1f";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    p.points.forEach((q, i) => {
      ctx.beginPath();
      ctx.arc(q[0], q[1], i === p.current ? 4.5 : p.keys[i] ? 4 : 2, 0, Math.PI * 2);
      if (i === p.current) { ctx.fillStyle = "#ff3b30"; ctx.fill(); }
      else if (p.keys[i]) { ctx.fillStyle = "#000"; ctx.fill(); ctx.strokeStyle = "#ff9a1f"; ctx.lineWidth = 1.5; ctx.stroke(); }
      else { ctx.fillStyle = "#ff9a1f"; ctx.fill(); }
    });
  }
}

/** Bones as the model reads them: a line origin to tip, a dot at the origin
 *  (the joint it rotates about), the name beside it. */
function drawBones(ctx: CanvasRenderingContext2D, bones: BoneMark[], width: number, height: number): void {
  ctx.lineCap = "round";
  // The far (or right) side blue, everything else magenta: overlapping
  // limbs read apart. render_frame's note says so.
  const colour = (b: BoneMark) => (b.side === "far" ? "#2f9bff" : "#ff2fd0");
  for (const b of bones) {
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(...b.from); ctx.lineTo(...b.to); ctx.stroke();
    ctx.strokeStyle = colour(b);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(...b.from); ctx.lineTo(...b.to); ctx.stroke();
  }
  for (const b of bones) {
    ctx.fillStyle = colour(b);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(b.from[0], b.from[1], 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // Names without overlaps, the longest bones (the limbs) first; the rest go
  // unnamed here and are listed in render_frame's text.
  ctx.font = "11px sans-serif";
  ctx.textBaseline = "middle";
  const placed: Array<[number, number, number, number]> = [];
  const hits = (r: [number, number, number, number]) => placed.some((p) => r[0] < p[0] + p[2] && p[0] < r[0] + r[2] && r[1] < p[1] + p[3] && p[1] < r[1] + r[3]);
  const byLength = [...bones].sort((a, b) => Math.hypot(b.to[0] - b.from[0], b.to[1] - b.from[1]) - Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]));
  for (const b of byLength) {
    const w = ctx.measureText(b.name).width + 6;
    // Beside the joint, or across from it, whichever is free.
    const spots: Array<[number, number, number, number]> = [[b.from[0] + 5, b.from[1] - 7, w, 14], [b.from[0] - 5 - w, b.from[1] - 7, w, 14]];
    const at = spots.find((r) => r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= width && r[1] + r[3] <= height && !hits(r));
    if (!at) continue;
    placed.push(at);
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(...at);
    ctx.fillStyle = "#fff";
    ctx.fillText(b.name, at[0] + 3, at[1] + 7);
  }
}

async function encode(canvas: HTMLCanvasElement): Promise<AgentImage> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be encoded."))), "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mimeType: "image/png", data: btoa(bin) };
}
