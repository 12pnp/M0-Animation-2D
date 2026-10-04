import type { BonePathsDraw } from "./Overlay";

/**
 * Each path as a line through one dot per frame, in screen space so the
 * marks keep their size at any zoom. The part already played is in the
 * onion skin's past colour, the part to come in its future colour; keys get
 * a larger hollow ring, the playhead's frame a filled dot. Dots far apart
 * mean fast, bunched mean slow.
 */
export function drawBonePaths(
  ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number },
  d: BonePathsDraw, colors: { core: string; handle: string },
): void {
  ctx.save();
  ctx.lineJoin = "round";
  for (const path of d.paths) {
    const pts = path.points.map((p) => ({ ...toScreen(p.x, p.y), p }));
    if (pts.length < 2) continue;
    const at = pts.findIndex((q) => q.p.frame === d.frame);
    const segment = (from: number, to: number, color: string) => {
      if (to <= from) return;
      ctx.beginPath();
      ctx.moveTo(pts[from]!.x, pts[from]!.y);
      for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i % pts.length]!.x, pts[i % pts.length]!.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.stroke();
    };
    const last = pts.length - 1 + (path.closed ? 1 : 0);
    if (at < 0) segment(0, last, d.future);
    else {
      segment(0, at, d.past);
      segment(at, last, d.future);
    }

    ctx.globalAlpha = 1;
    for (const q of pts) {
      const current = q.p.frame === d.frame;
      ctx.beginPath();
      if (current) {
        ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = d.current;
        ctx.fill();
        ctx.strokeStyle = colors.core;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (q.p.key) {
        ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.core;
        ctx.fill();
        ctx.strokeStyle = at >= 0 && pts.indexOf(q) < at ? d.past : d.future;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.arc(q.x, q.y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = at >= 0 && pts.indexOf(q) < at ? d.past : d.future;
        ctx.fill();
      }
    }
  }

  // Handles: a thin line from the key's dot, and a square to drag.
  ctx.globalAlpha = 1;
  for (const h of d.handles) {
    const a = toScreen(h.anchorX, h.anchorY), p = toScreen(h.x, h.y);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = colors.handle;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = colors.core;
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
    ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
  }
  ctx.restore();
}
