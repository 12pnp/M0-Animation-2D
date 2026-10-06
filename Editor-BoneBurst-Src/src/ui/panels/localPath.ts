import type { Skeleton } from "@/model/skeleton";
import { animationDuration } from "@/model/timelines";
import type { Session } from "../session";
import { Poser } from "../stage/posed";
import { type BoneTrail, boneTrail, type TrailSpace } from "../stage/trail";

/**
 * The Local Path panel (docs/MOTION-PREVIEW-PLAN.md): only the selected bone, over every frame of the
 * animation shown. Its joint is drawn as a trail with a mark for each frame (larger where the
 * animation keys the bone, lit at the playhead), its tip as a fainter trail; Local measures it in
 * the bone's parent's space, World in the skeleton's. A click on a mark puts the playhead there.
 * Empty, and saying why, in Pose mode or with no bone selected.
 */
export class LocalPathPanel {
  readonly element: HTMLElement;
  private readonly canvas = document.createElement("canvas");
  private readonly title = document.createElement("span");
  private readonly note = document.createElement("p");
  private readonly spaceBtns: Record<TrailSpace, HTMLButtonElement>;
  private space: TrailSpace = "local";
  private cached: { doc: Skeleton; images: unknown; skin: string | null; animation: string; bone: string; space: TrailSpace; trail: BoneTrail | null } | null = null;
  private poser: { doc: Skeleton; images: unknown; value: Poser } | null = null;
  private size = { width: 0, height: 0 };
  private queued = false;
  /** Each frame's mark on the canvas as last drawn, for a click. */
  private marks: Float64Array = new Float64Array(0);

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel local-path";
    const head = document.createElement("div");
    head.className = "lp-head";
    this.spaceBtns = { local: this.button("Local", "The path in the bone's parent's space"), world: this.button("World", "The path in the skeleton's space") };
    head.append(this.title, this.spaceBtns.local, this.spaceBtns.world);
    const body = document.createElement("div");
    body.className = "lp-body";
    this.note.className = "empty lp-note";
    body.append(this.canvas, this.note);
    this.element.append(head, body);
    for (const s of ["local", "world"] as const) this.spaceBtns[s].addEventListener("click", () => { this.space = s; this.schedule(); });
    this.canvas.addEventListener("pointerdown", (e) => this.click(e));
    session.onChange(() => this.schedule());
    this.schedule();
  }

  /** The panel's size, from the dock. */
  layout(width: number, height: number): void {
    this.size = { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height - 30)) };
    this.schedule();
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

  /** The trail of the selected bone in the animation shown, worked out again only when the document, skin, animation, bone or space changed. */
  private trail(): { trail: BoneTrail; bone: string } | string {
    const s = this.session, doc = s.doc, anim = s.animation, bone = s.selectedBone;
    if (!doc) return "Nothing open.";
    if (!anim) return "Choose an animation (Animate) to see a bone's path through it.";
    if (bone === null) return "Select a bone to see its path.";
    const c = this.cached;
    if (!c || c.doc !== doc || c.images !== s.images || c.skin !== s.skin || c.animation !== anim.name || c.bone !== bone || c.space !== this.space) {
      if (this.poser?.doc !== doc || this.poser.images !== s.images) this.poser = { doc, images: s.images, value: new Poser(doc, s.images) };
      const trail = boneTrail(this.poser.value, s.skin, anim.name, bone, s.fps, animationDuration(anim), this.space);
      this.cached = { doc, images: s.images, skin: s.skin, animation: anim.name, bone, space: this.space, trail };
    }
    return this.cached!.trail ? { trail: this.cached!.trail, bone } : `${bone} has no pose in this skin.`;
  }

  private draw(): void {
    const s = this.session, r = this.trail();
    for (const k of ["local", "world"] as const) this.spaceBtns[k].setAttribute("aria-pressed", String(this.space === k));
    const { width, height } = this.size, dpr = window.devicePixelRatio || 1;
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
    if (typeof r === "string") {
      this.title.textContent = "Local Path";
      this.note.textContent = r;
      this.note.hidden = false;
      return;
    }
    this.note.hidden = true;
    const { trail, bone } = r, css = getComputedStyle(this.element);
    const accent = css.getPropertyValue("--accent").trim() || "#4c9bff", muted = css.getPropertyValue("--muted").trim() || "#999", line = css.getPropertyValue("--line").trim() || "#444", text = css.getPropertyValue("--text").trim() || "#ddd";
    this.title.textContent = `${bone} · ${this.space === "local" ? "Local" : "World"}`;
    // The box around both trails, drawn at one scale (y up) with room round it.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const a of [trail.joint, trail.tip]) for (let i = 0; i < a.length; i += 2) {
      const x = a[i]!, y = a[i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX)) { this.note.textContent = `${bone} has no pose in this animation.`; this.note.hidden = false; return; }
    const pad = 28, w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
    const k = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
    const at = (x: number, y: number): [number, number] => [width / 2 + (x - (minX + maxX) / 2) * k, height / 2 - (y - (minY + maxY) / 2) * k];
    // The origin's axes, when they fall in view.
    g.strokeStyle = line;
    g.lineWidth = 1;
    const [ox, oy] = at(0, 0);
    g.beginPath();
    if (ox >= 0 && ox <= width) { g.moveTo(Math.round(ox) + 0.5, 0); g.lineTo(Math.round(ox) + 0.5, height); }
    if (oy >= 0 && oy <= height) { g.moveTo(0, Math.round(oy) + 0.5); g.lineTo(width, Math.round(oy) + 0.5); }
    g.stroke();
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
    g.strokeStyle = muted;
    g.globalAlpha = 0.55;
    g.lineWidth = 1;
    trace(trail.tip);
    g.globalAlpha = 1;
    g.strokeStyle = accent;
    g.lineWidth = 2;
    trace(trail.joint);
    // A mark per frame: larger where the animation keys the bone, lit at the playhead.
    const anim = s.animation!, keyed = new Set<number>();
    for (const group of anim.bones ?? []) if (group.name === bone) for (const t of group.timelines) for (const key of t.keys) keyed.add(Math.round((key.time ?? 0) * trail.fps));
    const here = s.frame, marks: number[] = [];
    for (let f = 0; f <= trail.frames; f++) {
      const x = trail.joint[f * 2]!, y = trail.joint[f * 2 + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) { marks.push(Number.NaN, Number.NaN); continue; }
      const [px, py] = at(x, y);
      marks.push(px, py);
      g.beginPath();
      if (f === here) { g.fillStyle = "#ffffff"; g.strokeStyle = accent; g.lineWidth = 3; g.arc(px, py, 6, 0, Math.PI * 2); g.fill(); g.stroke(); continue; }
      g.fillStyle = keyed.has(f) ? accent : muted;
      g.arc(px, py, keyed.has(f) ? 4 : 2, 0, Math.PI * 2);
      g.fill();
    }
    this.marks = Float64Array.from(marks);
    g.fillStyle = text;
    g.font = `11px "JetBrains Mono", monospace`;
    g.textBaseline = "top";
    g.fillText(`frame ${Math.min(here, trail.frames)} of ${trail.frames} · ${trail.fps} fps · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}`, 8, 6);
  }

  /** A click on a mark: the playhead goes to its frame. */
  private click(e: PointerEvent): void {
    const box = this.canvas.getBoundingClientRect(), x = e.clientX - box.left, y = e.clientY - box.top;
    let best = -1, bestD = 12;
    for (let f = 0; f * 2 < this.marks.length; f++) {
      const d = Math.hypot(this.marks[f * 2]! - x, this.marks[f * 2 + 1]! - y);
      if (d <= bestD) { best = f; bestD = d; }
    }
    if (best >= 0) this.session.seek(best);
  }
}
