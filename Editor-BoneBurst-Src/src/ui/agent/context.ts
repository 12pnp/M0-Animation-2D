import type { AgentContext, AgentReference, PosedBone, RenderRequest, RenderResult } from "@/agent/context";
import type { AtlasImages } from "@/engine/regions";
import type { Skeleton } from "@/model/skeleton";
import type { Session } from "../session";
import { type Camera, fit, type Size, toScreen } from "../stage/camera";
import { drawnVertices } from "@/engine/draw";
import { boneMatrix, boneTip, bounds, constraintNow, type Posed, Poser } from "../stage/posed";
import { type Backdrop, Renderer } from "../stage/renderer";
import { referenceQuad } from "../stage/references";

/**
 * The AI tools' context from the editor's session (E5-PLAN step 3): the document, the view, the
 * stage's own `Poser` for poses, and an offscreen copy of the stage's renderer for pictures.
 */

/** Every bone of a pose as the tools read it. */
export function posedBones(p: Posed): PosedBone[] {
  return p.rig.data.bones.map((b) => ({
    name: b.name, active: !!p.rig.active[b.index], world: [...boneMatrix(p, b.index)],
    local: Array.from(p.local.subarray(b.index * 7, b.index * 7 + 7)), length: b.length,
  }));
}

/** A poser per document and atlas: built once, posed as often as the tools ask. */
export function poserCache(): (doc: Skeleton, images: AtlasImages) => Poser {
  let last: { doc: Skeleton; images: AtlasImages; poser: Poser } | null = null;
  return (doc, images) => {
    if (last?.doc !== doc || last.images !== images) last = { doc, images, poser: new Poser(doc, images) };
    return last.poser;
  };
}

/** The largest side of a `render_frame` picture, and the space kept around what it shows. */
const SIDE = 768, MARGIN = 24;
let offscreen: { canvas: HTMLCanvasElement; renderer: Renderer } | null = null;

function base64(c: HTMLCanvasElement): string {
  return c.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

export function sessionContext(session: Session): AgentContext {
  const poser = poserCache();
  // Posed at the float32 time, as the playhead is: keys are stored as float32, and a frame's
  // float64 time can fall just before the key written at it.
  const pose = (skin: string | null, animation: string | null, time: number) => poser(session.doc!, session.images).pose(skin, animation, Math.fround(time));
  const refs = (): AgentReference[] => session.sidecar.references.map((r) => {
    const b = session.referenceImages.get(r.path);
    return { path: r.path, x: r.x, y: r.y, scale: r.scale, opacity: r.opacity, width: b?.width ?? null, height: b?.height ?? null };
  });
  return {
    get history() { return session.history; },
    changed: () => session.changed(),
    get images() { return session.images; },
    view: () => ({ animation: session.animation?.name ?? null, frame: session.frame, skin: session.skin }),
    show: (v) => {
      session.skin = v.skin;
      session.showAnimation(v.animation);
      session.seek(v.frame);
    },
    pose: (skin, animation, time) => posedBones(pose(skin, animation, time)),
    constraintNow: (skin, animation, time, type, name) => {
      const p = pose(skin, animation, time), i = p.rig.data.constraints.findIndex((k) => k.kind === type && k.name === name);
      return i < 0 ? null : constraintNow(p, i);
    },
    references: refs,
    referencePicture: async (path) => {
      const b = session.referenceImages.get(path);
      if (!b) return null;
      const c = document.createElement("canvas");
      c.width = b.width;
      c.height = b.height;
      c.getContext("2d")!.drawImage(b, 0, 0);
      return base64(c);
    },
    render: async (req) => render(session, pose(req.skin, req.animation, req.time), req),
  };
}

/** The skeleton as the stage draws it, the references behind at half strength, bones and paths over it. */
function render(session: Session, p: Posed, req: RenderRequest): RenderResult {
  // Framed on what is drawn (and the bones on it): a root left at the origin, far from the
  // pictures, would otherwise shrink the figure the model must read joints from.
  const box = drawnBox(p) ?? bounds(p) ?? { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const grow = (x: number, y: number) => { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y); };
  const backdrops: Backdrop[] = [];
  if (req.reference) {
    for (const r of session.sidecar.references) {
      const bitmap = session.referenceImages.get(r.path);
      if (!bitmap) continue;
      const q = referenceQuad(r, bitmap.width, bitmap.height);
      backdrops.push({ bitmap, ...q, opacity: 0.5 });
      for (let i = 0; i < 8; i += 2) grow(q.xy[i]!, q.xy[i + 1]!);
    }
  }
  for (const d of req.paths) for (const [x, y] of d.points) grow(x, y);
  // The picture keeps the box's proportions, its longer side SIDE pixels.
  const w = Math.max(box.maxX - box.minX, 1), h = Math.max(box.maxY - box.minY, 1);
  const k = (SIDE - 2 * MARGIN) / Math.max(w, h);
  const size: Size = { width: Math.round(w * k + 2 * MARGIN), height: Math.round(h * k + 2 * MARGIN) };
  const cam: Camera = fit(size, box, MARGIN);
  if (!offscreen) { const canvas = document.createElement("canvas"); offscreen = { canvas, renderer: new Renderer(canvas) }; }
  const gl = offscreen.canvas;
  gl.width = size.width;
  gl.height = size.height;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--stage-bg").trim();
  offscreen.renderer.draw(p, session.pages, cam, size, 1, rgb(bg), backdrops);
  const out = document.createElement("canvas");
  out.width = size.width;
  out.height = size.height;
  const g = out.getContext("2d")!;
  // Copied in the same task as the draw, before the WebGL buffer is cleared.
  g.drawImage(gl, 0, 0);
  const at = (x: number, y: number) => toScreen(cam, size, x, y);
  const bones: { name: string; joint: [number, number]; tip: [number, number]; outside?: true }[] = [];
  const inside = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x <= size.width && y <= size.height;
  for (const b of p.rig.data.bones) {
    if (!p.rig.active[b.index]) continue;
    const m = boneMatrix(p, b.index), joint = at(m[4], m[5]), [tx, ty] = boneTip(p, b.index), tip = at(tx, ty);
    bones.push({ name: b.name, joint, tip, ...(inside(joint) || inside(tip) ? {} : { outside: true as const }) });
  }
  if (req.bones) {
    g.lineWidth = 2;
    g.font = "11px Inter, system-ui, sans-serif";
    g.textBaseline = "middle";
    for (const b of bones) {
      const colour = /far|right/i.test(b.name) ? "#2f6fff" : "#d0249f";
      g.strokeStyle = g.fillStyle = colour;
      g.beginPath(); g.moveTo(b.joint[0], b.joint[1]); g.lineTo(b.tip[0], b.tip[1]); g.stroke();
      g.beginPath(); g.arc(b.joint[0], b.joint[1], 3, 0, Math.PI * 2); g.fill();
      g.lineWidth = 3; g.strokeStyle = "rgba(255,255,255,0.85)";
      const lx = (b.joint[0] + b.tip[0]) / 2 + 4, ly = (b.joint[1] + b.tip[1]) / 2;
      g.strokeText(b.name, lx, ly); g.fillText(b.name, lx, ly);
      g.lineWidth = 2;
    }
  }
  for (const d of req.paths) {
    const pts = d.points.map(([x, y]) => at(x, y));
    g.strokeStyle = g.fillStyle = "#e08a00";
    g.lineWidth = 1.5;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    for (const i of d.keyed) { const q = pts[i]; if (q) { g.beginPath(); g.arc(q[0], q[1], 4, 0, Math.PI * 2); g.stroke(); } }
  }
  return { png: base64(out), width: size.width, height: size.height, scale: cam.zoom, origin: at(0, 0), bones };
}

/** The box around every drawn vertex and the bones within it, or null when nothing is drawn. */
function drawnBox(p: Posed): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of p.draw.slots) {
    const v = new Float64Array(d.vertexCount * 2);
    drawnVertices(p.rig, d, v);
    for (let i = 0; i < v.length; i += 2) { minX = Math.min(minX, v[i]!); maxX = Math.max(maxX, v[i]!); minY = Math.min(minY, v[i + 1]!); maxY = Math.max(maxY, v[i + 1]!); }
  }
  if (!(minX <= maxX)) return null;
  // Bones that start or end on the pictures (a short margin) are framed whole, so their names fit.
  const pad = Math.max(maxX - minX, maxY - minY) * 0.1, box = { minX, minY, maxX, maxY };
  const near = (x: number, y: number) => x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad;
  for (const b of p.rig.data.bones) {
    if (!p.rig.active[b.index]) continue;
    const m = boneMatrix(p, b.index), [tx, ty] = boneTip(p, b.index);
    if (!near(m[4], m[5]) && !near(tx, ty)) continue;
    for (const [x, y] of [[m[4], m[5]], [tx, ty]] as const) { box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x); box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y); }
  }
  return box;
}

/** A CSS colour (`#rrggbb`) as 0..1 channels; mid grey when unreadable. */
function rgb(css: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(css);
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
