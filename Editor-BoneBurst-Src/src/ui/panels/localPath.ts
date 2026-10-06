import { drawnVertices } from "@/engine/draw";
import type { Skeleton } from "@/model/skeleton";
import { animationDuration, frameTime, keyLists, keyTime, timeFrame } from "@/model/timelines";
import { iconButton } from "../icons";
import type { Session } from "../session";
import { boneMatrix, boneTip, type Posed, Poser } from "../stage/posed";
import { drawBackdrop } from "../stage/canvasBackdrop";
import { NO_LOOK, type StageLook } from "../stage/look";
import { type OnionOptions, onionFrames } from "../stage/onion";
import { type BoneTrail, boneTrail, fromParent, type TrailSpace } from "../stage/trail";

/** The layers the panel can show: the bone's image, the bone itself, its path, and onion skin (the bone at frames either side of the playhead). */
export type Layer = "image" | "bone" | "path" | "onion" | "children";
const LAYERS: readonly Layer[] = ["image", "bone", "path", "onion", "children"];
const PAST = "rgb(230, 64, 51)", FUTURE = "rgb(51, 179, 77)";
const LAYERS_KEY = "boneburst.localPath.layers";

interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** The slots of `bones` that draw an image in `p`. */
const slotsOf = (p: Posed, bones: readonly number[]) => p.draw.slots.filter((d) => bones.includes(p.rig.data.slots[d.slot]!.bone));

/** `bone`, and with `children` every bone under it. */
function withChildren(p: Posed, bone: number, children: boolean): number[] {
  if (!children) return [bone];
  const parents = p.rig.data.bones.map((b) => b.parent), out = [bone];
  for (let i = 0; i < parents.length; i++) {
    for (let b = parents[i]!; b >= 0; b = parents[b]!) if (b === bone) { out.push(i); break; }
  }
  return out;
}

/**
 * The box round the bone's images and the bone itself at some frames of the trail, in `space`: the
 * panel is scaled to hold them all, so what is drawn does not change size from frame to frame.
 */
function extentOf(poser: Poser, skin: string | null, animation: string | null, bone: string, space: TrailSpace, fps: number, frames: number, children: boolean): Box | null {
  let box: Box | null = null;
  const grow = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    box = box ? { minX: Math.min(box.minX, x), minY: Math.min(box.minY, y), maxX: Math.max(box.maxX, x), maxY: Math.max(box.maxY, y) } : { minX: x, minY: y, maxX: x, maxY: y };
  };
  // The setup pose (no animation) is one frame.
  const stride = Math.max(1, Math.ceil(frames / 8)), last = animation === null ? 0 : frames;
  for (let f = 0; f <= last; f += stride) {
    const p = poser.pose(skin, animation, animation === null ? 0 : Math.fround(frameTime(f, fps)), "none"), i = p.bones.get(bone);
    if (i === undefined) return null;
    const to = (x: number, y: number): [number, number] => (space === "local" ? fromParent(p, i, x, y) : [x, y]);
    const set = withChildren(p, i, children);
    for (const d of slotsOf(p, set)) {
      const v = new Float64Array(d.vertexCount * 2);
      drawnVertices(p.rig, d, v);
      for (let k = 0; k < d.vertexCount; k++) grow(...to(v[k * 2]!, v[k * 2 + 1]!));
    }
    for (const b of set) {
      if (!p.rig.active[b]) continue;
      const m = boneMatrix(p, b);
      grow(...to(m[4], m[5]));
      grow(...to(...boneTip(p, b)));
    }
  }
  return box;
}

/**
 * The Local Path panel (docs/MOTION-PREVIEW-PLAN.md): only the selected bone, over every frame of the
 * animation shown. Three layers, each a button in the header: its image (the slots on the bone, at
 * the playhead), the bone itself, and its path (the joint's trail with a mark for each frame, larger
 * where the animation keys the bone, lit at the playhead; the tip's trail fainter). Local measures
 * it all from the bone's parent's joint with the world's orientation, so a bone looks turned as it
 * does on the Stage but the parent's own movement is not in it; World is the Stage's own place. A click on a mark puts the playhead there. Empty, and saying
 * why, with no bone selected. In Pose mode (no animation) it shows the bone and its image on the setup
 * pose, with the same buttons and no path; it only shows: nothing in it is dragged.
 */
export class LocalPathPanel {
  readonly element: HTMLElement;
  private readonly canvas = document.createElement("canvas");
  private readonly head = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly title = document.createElement("span");
  private readonly note = document.createElement("p");
  private readonly spaceBtns: Record<TrailSpace, HTMLButtonElement>;
  private readonly layerBtns: Record<Layer, HTMLButtonElement>;
  private space: TrailSpace = "local";
  private show: Record<Layer, boolean> = { image: true, bone: true, path: true, onion: false, children: false };
  /** What onion skin shows (frames before and after, keyed only, colour-coded); set by the app from the preferences. */
  onion: () => OnionOptions = () => ({ before: 2, after: 2, keyedOnly: false, colour: true });
  /** What the Stage draws behind the skeleton (checkerboard, grid, centre axes), from the preferences; set by the app. */
  background: () => { look: StageLook; grid: number | null } = () => ({ look: NO_LOOK, grid: null });
  private scratch: HTMLCanvasElement | null = null;
  /** The view on top of the fit: a zoom (1 = fitted) and a pan in pixels; wheel, drag and Fit change them. */
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private dragging: { x: number; y: number } | null = null;
  private cached: { doc: Skeleton; images: unknown; skin: string | null; animation: string | null; bone: string; space: TrailSpace; trail: BoneTrail | null; extent: Box | null; children: boolean } | null = null;
  private poser: { doc: Skeleton; images: unknown; value: Poser } | null = null;
  private queued = false;
  /** Each frame's mark on the canvas as last drawn, for a click. */
  private marks: Float64Array = new Float64Array(0);

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel local-path";
    try {
      const saved = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "{}") as Partial<Record<Layer, unknown>>;
      for (const l of LAYERS) if (typeof saved[l] === "boolean") this.show[l] = saved[l] as boolean;
    } catch { /* storage blocked: all shown */ }
    this.head.className = "lp-head";
    this.spaceBtns = { local: this.button("Local", "The world's orientation, from the parent's joint: the parent's own movement is not in it"), world: this.button("World", "In the skeleton's space, as the Stage shows it") };
    this.layerBtns = { image: this.button("Image", "Show the bone's image"), bone: this.button("Bone", "Show the bone"), path: this.button("Path", "Show the bone's path over the animation"), onion: this.button("Onion", "Show the bone at the frames before (red) and after (green) the playhead; the count is set in Preferences ▸ Behavior"), children: this.button("Children", "Show every bone under the selected one, with their images") };
    this.head.append(this.title, this.layerBtns.image, this.layerBtns.bone, this.layerBtns.path, this.layerBtns.onion, this.layerBtns.children, this.spaceBtns.local, this.spaceBtns.world);
    this.body.className = "lp-body";
    this.note.className = "empty lp-note";
    const fit = iconButton(this.button("Fit", "Fit the whole path in the panel (double-click does the same)"), "fit", false);
    fit.className = "lp-fit";
    fit.addEventListener("click", () => this.fit());
    this.body.append(this.canvas, this.note, fit);
    this.element.append(this.head, this.body);
    // The canvas is as big as its box, whatever else the panel holds (the path window under it).
    new ResizeObserver(() => this.schedule()).observe(this.body);
    for (const l of LAYERS) {
      this.layerBtns[l].addEventListener("click", () => {
        this.show[l] = !this.show[l];
        try { localStorage.setItem(LAYERS_KEY, JSON.stringify(this.show)); } catch { /* not kept */ }
        this.schedule();
      });
    }
    for (const s of ["local", "world"] as const) this.spaceBtns[s].addEventListener("click", () => { this.space = s; this.schedule(); });
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", (e) => this.up(e));
    this.canvas.addEventListener("dblclick", () => this.fit());
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    session.onChange(() => this.schedule());
    this.schedule();
  }

  /** The preferences changed: draw again. */
  refresh(): void {
    this.schedule();
  }

  /** The dock laid the panel out: draw again at the new size. */
  layout(_width: number, _height: number): void {
    this.schedule();
  }

  /** Put `el` (the path window) under the canvas. */
  addTools(el: HTMLElement): void {
    this.element.append(el);
  }

  private button(text: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    return b;
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }

  private posers(): Poser {
    const s = this.session, doc = s.doc!;
    if (this.poser?.doc !== doc || this.poser.images !== s.images) this.poser = { doc, images: s.images, value: new Poser(doc, s.images) };
    return this.poser.value;
  }

  /** The trail of the selected bone in the animation shown, worked out again only when the document, skin, animation, bone or space changed. */
  private trail(): { trail: BoneTrail | null; bone: string; extent: Box | null } | string {
    const s = this.session, doc = s.doc, anim = s.animation, bone = s.selectedBone;
    if (!doc) return "Nothing open.";
    if (bone === null) return anim ? "Select a bone to see its path." : "Select a bone to see it on the setup pose.";
    const name = anim?.name ?? null, c = this.cached;
    if (!c || c.doc !== doc || c.images !== s.images || c.skin !== s.skin || c.animation !== name || c.bone !== bone || c.space !== this.space || c.children !== this.show.children) {
      const poser = this.posers();
      const trail = anim ? boneTrail(poser, s.skin, anim.name, bone, s.fps, animationDuration(anim), this.space) : null;
      const extent = extentOf(poser, s.skin, name, bone, this.space, s.fps, trail?.frames ?? 0, this.show.children);
      this.cached = { doc, images: s.images, skin: s.skin, animation: name, bone, space: this.space, trail, extent, children: this.show.children };
      // New content: shown whole.
      if (!c || c.bone !== bone || c.animation !== name || c.space !== this.space) { this.zoom = 1; this.pan = { x: 0, y: 0 }; }
    }
    const c2 = this.cached!;
    return c2.trail || (!anim && c2.extent) ? { trail: c2.trail, bone, extent: c2.extent } : `${bone} has no pose in this skin.`;
  }

  private draw(): void {
    const s = this.session, r = this.trail();
    for (const k of ["local", "world"] as const) this.spaceBtns[k].setAttribute("aria-pressed", String(this.space === k));
    for (const l of LAYERS) this.layerBtns[l].setAttribute("aria-pressed", String(this.show[l]));
    const width = Math.max(1, Math.floor(this.body.clientWidth)), height = Math.max(1, Math.floor(this.body.clientHeight)), dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
    const g = this.canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    this.marks = new Float64Array(0);
    const style = getComputedStyle(this.element), stageBg = style.getPropertyValue("--stage-bg").trim() || "#4f4f4f";
    if (typeof r === "string") {
      drawBackdrop(g, { width, height, left: -width / 2, right: width / 2, top: height / 2, bottom: -height / 2, scale: 1, ...this.background(), background: stageBg, light: lightColour(stageBg) });
      this.title.textContent = "Local Path";
      this.note.textContent = r;
      this.note.hidden = false;
      return;
    }
    this.note.hidden = true;
    const { trail, bone, extent } = r, css = style;
    const accent = css.getPropertyValue("--accent").trim() || "#4c9bff", muted = css.getPropertyValue("--muted").trim() || "#999", text = css.getPropertyValue("--text").trim() || "#ddd", boneColour = css.getPropertyValue("--bone").trim() || "#ccc";
    this.title.textContent = `${bone} · ${this.space === "local" ? "Local" : "World"}${trail ? "" : " · Pose"}`;
    // The box round the trails and the bone's image, drawn at one scale (y up) with room round it.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const grow = (x: number, y: number) => { if (Number.isFinite(x) && Number.isFinite(y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } };
    for (const a of trail ? [trail.joint, trail.tip] : []) for (let i = 0; i < a.length; i += 2) grow(a[i]!, a[i + 1]!);
    if (extent) { grow(extent.minX, extent.minY); grow(extent.maxX, extent.maxY); }
    if (!Number.isFinite(minX)) { this.note.textContent = `${bone} has no pose in this animation.`; this.note.hidden = false; return; }
    const pad = 28, w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
    // The fit, then the zoom and pan on top of it.
    const k = Math.max(Math.min((width - 2 * pad) / w, (height - 2 * pad) / h), 1e-6) * this.zoom;
    const at = (x: number, y: number): [number, number] => [width / 2 + this.pan.x + (x - (minX + maxX) / 2) * k, height / 2 + this.pan.y - (y - (minY + maxY) / 2) * k];
    // The Stage's own backdrop under it all: background, checkerboard, grid and centre axes, in the same world units.
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    drawBackdrop(g, { width, height, left: cx + (-width / 2 - this.pan.x) / k, right: cx + (width / 2 - this.pan.x) / k, top: cy + (height / 2 + this.pan.y) / k, bottom: cy + (-height / 2 + this.pan.y) / k, scale: k, ...this.background(), background: stageBg, light: lightColour(stageBg) });
    const here = trail ? Math.min(s.frame, trail.frames) : 0;
    // At the playhead: the pose the image and the bone are drawn from (the setup pose in Pose mode).
    const poser = this.posers(), p = trail ? poser.pose(s.skin, s.animation!.name, Math.fround(frameTime(here, trail.fps)), "none") : poser.pose(s.skin, null, 0, "none"), index = p.bones.get(bone);
    const to = (x: number, y: number): [number, number] => (this.space === "local" && index !== undefined ? fromParent(p, index, x, y) : [x, y]);
    if (this.show.onion && trail && index !== undefined) this.drawOnion(g, poser, bone, trail, here, at, dpr, boneColour);
    const set = index === undefined ? [] : withChildren(p, index, this.show.children);
    if (this.show.image && index !== undefined) this.drawImage(g, p, set, to, at, dpr);
    if (this.show.bone && index !== undefined) {
      // The children first and lighter, the selected bone over them.
      for (const b of [...set.slice(1), set[0]!]) {
        if (!p.rig.active[b]) continue;
        const m = boneMatrix(p, b), [jx, jy] = at(...to(m[4], m[5])), [tx, ty] = at(...to(...boneTip(p, b)));
        if ([jx, jy, tx, ty].every(Number.isFinite)) { g.save(); g.globalAlpha = b === index ? 1 : 0.65; this.drawBone(g, jx, jy, tx, ty, boneColour); g.restore(); }
      }
    }
    if (this.show.path && trail) this.drawPath(g, trail, bone, at, here, { accent, muted });
    g.fillStyle = text;
    g.font = `11px "JetBrains Mono", monospace`;
    g.textBaseline = "top";
    g.fillText(trail ? `frame ${here} of ${trail.frames} · ${trail.fps} fps · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}` : `setup pose · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}`, 8, 6);
  }

  /** Onion skin: the bone (its image, and the bone) at the frames either side of the playhead, farthest first, past red and future green when colour-coded. */
  private drawOnion(g: CanvasRenderingContext2D, poser: Poser, bone: string, trail: BoneTrail, here: number, at: (x: number, y: number) => [number, number], dpr: number, boneColour: string): void {
    const s = this.session, a = s.animation!, o = this.onion(), end = timeFrame(animationDuration(a), trail.fps);
    const keyed = o.keyedOnly ? keyLists(a).flatMap((l) => l.keys.map((k) => timeFrame(keyTime(k), trail.fps))) : [];
    const frames = onionFrames(here, end, o, keyed, s.loop).sort((x, y) => x.opacity - y.opacity);
    for (const f of frames) {
      const p = poser.pose(s.skin, a.name, Math.fround(frameTime(f.frame, trail.fps)), "none"), i = p.bones.get(bone);
      if (i === undefined) continue;
      const to = (x: number, y: number): [number, number] => (this.space === "local" ? fromParent(p, i, x, y) : [x, y]);
      const colour = o.colour ? (f.side === "before" ? PAST : FUTURE) : null;
      if (this.show.image) {
        // The image into a scratch canvas, then a silhouette in the ghost's colour when colour-coded, then onto the panel faint.
        const sc = this.scratch ?? (this.scratch = document.createElement("canvas"));
        if (sc.width !== this.canvas.width || sc.height !== this.canvas.height) { sc.width = this.canvas.width; sc.height = this.canvas.height; }
        const c2 = sc.getContext("2d")!;
        c2.setTransform(1, 0, 0, 1, 0, 0);
        c2.globalCompositeOperation = "source-over";
        c2.clearRect(0, 0, sc.width, sc.height);
        this.drawImage(c2, p, withChildren(p, i, this.show.children), to, at, dpr);
        if (colour) { c2.setTransform(1, 0, 0, 1, 0, 0); c2.globalCompositeOperation = "source-in"; c2.fillStyle = colour; c2.fillRect(0, 0, sc.width, sc.height); c2.globalCompositeOperation = "source-over"; }
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = f.opacity;
        g.drawImage(sc, 0, 0);
        g.restore();
      }
      if (this.show.bone) {
        for (const b of withChildren(p, i, this.show.children)) {
          if (!p.rig.active[b]) continue;
          const m = boneMatrix(p, b), [jx, jy] = at(...to(m[4], m[5])), [tx, ty] = at(...to(...boneTip(p, b)));
          if ([jx, jy, tx, ty].every(Number.isFinite)) { g.save(); g.globalAlpha = Math.min(1, f.opacity * 1.6); this.drawBone(g, jx, jy, tx, ty, colour ?? boneColour); g.restore(); }
        }
      }
    }
  }

  /** The bone's slots' images at the playhead: each triangle of the drawn mesh, textured from its page by the map from texture to panel. */
  private drawImage(g: CanvasRenderingContext2D, p: Posed, bones: readonly number[], to: (x: number, y: number) => [number, number], at: (x: number, y: number) => [number, number], dpr: number): void {
    for (const d of slotsOf(p, bones)) {
      const page = this.session.pages.get(d.frame.region.page.name);
      if (!page) continue;
      const v = new Float64Array(d.vertexCount * 2), uvs = d.frame.uvs;
      drawnVertices(p.rig, d, v);
      const s: [number, number][] = [], t: [number, number][] = [];
      for (let i = 0; i < d.vertexCount; i++) { s.push(at(...to(v[i * 2]!, v[i * 2 + 1]!))); t.push([uvs[i * 2]! * page.width, uvs[i * 2 + 1]! * page.height]); }
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, d.color[3]));
      for (let n = 0; n + 2 < d.triangles.length; n += 3) {
        const [i0, i1, i2] = [d.triangles[n]!, d.triangles[n + 1]!, d.triangles[n + 2]!], s0 = s[i0]!, s1 = s[i1]!, s2 = s[i2]!, t0 = t[i0]!, t1 = t[i1]!, t2 = t[i2]!;
        const den = (t1[0] - t0[0]) * (t2[1] - t0[1]) - (t2[0] - t0[0]) * (t1[1] - t0[1]);
        if (Math.abs(den) < 1e-9 || ![...s0, ...s1, ...s2].every(Number.isFinite)) continue;
        const a = ((s1[0] - s0[0]) * (t2[1] - t0[1]) - (s2[0] - s0[0]) * (t1[1] - t0[1])) / den;
        const c = ((s2[0] - s0[0]) * (t1[0] - t0[0]) - (s1[0] - s0[0]) * (t2[0] - t0[0])) / den;
        const b = ((s1[1] - s0[1]) * (t2[1] - t0[1]) - (s2[1] - s0[1]) * (t1[1] - t0[1])) / den;
        const dd = ((s2[1] - s0[1]) * (t1[0] - t0[0]) - (s1[1] - s0[1]) * (t2[0] - t0[0])) / den;
        g.save();
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.beginPath();
        g.moveTo(s0[0], s0[1]); g.lineTo(s1[0], s1[1]); g.lineTo(s2[0], s2[1]);
        g.closePath();
        g.clip();
        g.setTransform(dpr * a, dpr * b, dpr * c, dpr * dd, dpr * (s0[0] - a * t0[0] - c * t0[1]), dpr * (s0[1] - b * t0[0] - dd * t0[1]));
        g.drawImage(page, 0, 0);
        g.restore();
      }
      g.restore();
    }
  }

  /** The bone as the Stage draws it: a thin kite from its joint to its tip, a dot at the joint. */
  private drawBone(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, colour: string): void {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    g.save();
    g.fillStyle = g.strokeStyle = colour;
    if (len >= 4) {
      const w = Math.min(7, len * 0.14), ux = dx / len, uy = dy / len, mx = x0 + dx * 0.2, my = y0 + dy * 0.2;
      g.globalAlpha = 0.8;
      g.beginPath();
      g.moveTo(x0, y0); g.lineTo(mx - uy * w, my + ux * w); g.lineTo(x1, y1); g.lineTo(mx + uy * w, my - ux * w);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(x0, y0, 3, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  /** The path: the tip's trail fainter, the joint's trail with a mark per frame (larger where the bone is keyed, lit at the playhead). */
  private drawPath(g: CanvasRenderingContext2D, trail: BoneTrail, bone: string, at: (x: number, y: number) => [number, number], here: number, c: { accent: string; muted: string }): void {
    const trace = (a: Float64Array) => {
      g.beginPath();
      let pen = false;
      for (let f = 0; f <= trail.frames; f++) {
        const x = a[f * 2]!, y = a[f * 2 + 1]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) { pen = false; continue; }
        const [px, py] = at(x, y);
        if (pen) g.lineTo(px, py); else g.moveTo(px, py);
        pen = true;
      }
      g.stroke();
    };
    g.strokeStyle = c.muted;
    g.globalAlpha = 0.55;
    g.lineWidth = 1;
    trace(trail.tip);
    g.globalAlpha = 1;
    g.strokeStyle = c.accent;
    g.lineWidth = 2;
    trace(trail.joint);
    const keyed = new Set<number>(), marks: number[] = [];
    for (const group of this.session.animation?.bones ?? []) if (group.name === bone) for (const t of group.timelines) for (const key of t.keys) keyed.add(Math.round((key.time ?? 0) * trail.fps));
    for (let f = 0; f <= trail.frames; f++) {
      const x = trail.joint[f * 2]!, y = trail.joint[f * 2 + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) { marks.push(Number.NaN, Number.NaN); continue; }
      const [px, py] = at(x, y);
      marks.push(px, py);
      g.beginPath();
      if (f === here) { g.fillStyle = "#ffffff"; g.strokeStyle = c.accent; g.lineWidth = 3; g.arc(px, py, 6, 0, Math.PI * 2); g.fill(); g.stroke(); continue; }
      g.fillStyle = keyed.has(f) ? c.accent : c.muted;
      g.arc(px, py, keyed.has(f) ? 4 : 2, 0, Math.PI * 2);
      g.fill();
    }
    this.marks = Float64Array.from(marks);
  }

  /** Shown whole again. */
  private fit(): void {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.schedule();
  }

  /** A press: on a mark, the playhead goes to its frame; anywhere else it starts a pan (the middle and right buttons pan from a mark too). */
  private down(e: PointerEvent): void {
    const box = this.canvas.getBoundingClientRect(), x = e.clientX - box.left, y = e.clientY - box.top;
    if (e.button === 0) {
      let best = -1, bestD = 12;
      for (let f = 0; f * 2 < this.marks.length; f++) {
        const d = Math.hypot(this.marks[f * 2]! - x, this.marks[f * 2 + 1]! - y);
        if (d <= bestD) { best = f; bestD = d; }
      }
      if (best >= 0) { this.session.seek(best); return; }
    }
    this.dragging = { x: e.clientX, y: e.clientY };
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* no such pointer: the pan still follows moves over the canvas */ }
    this.canvas.style.cursor = "grabbing";
  }

  private move(e: PointerEvent): void {
    if (!this.dragging) return;
    this.pan = { x: this.pan.x + e.clientX - this.dragging.x, y: this.pan.y + e.clientY - this.dragging.y };
    this.dragging = { x: e.clientX, y: e.clientY };
    this.schedule();
  }

  private up(e: PointerEvent): void {
    this.dragging = null;
    this.canvas.style.cursor = "";
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  }

  /** The wheel zooms about the pointer: the point under it stays put. A trackpad's pinch comes as ctrl + wheel with small steps. */
  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const box = this.canvas.getBoundingClientRect(), px = e.clientX - box.left - box.width / 2, py = e.clientY - box.top - box.height / 2;
    const next = Math.min(200, Math.max(0.05, this.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)))), ratio = next / this.zoom;
    this.pan = { x: px - (px - this.pan.x) * ratio, y: py - (py - this.pan.y) * ratio };
    this.zoom = next;
    this.schedule();
  }
}

/** Whether a CSS colour (#rrggbb, as the theme writes the stage's) is light. */
function lightColour(c: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  return ((n >> 16) & 255) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11 > 127;
}
