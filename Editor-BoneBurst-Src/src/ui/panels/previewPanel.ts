import { type Camera, fit, pan, zoomAt } from "../stage/camera";
import { iconButton } from "../icons";
import { pageScale } from "../pageScale";
import { bounds } from "../stage/posed";
import { Renderer } from "../stage/renderer";
import type { Session } from "../session";

const BG_KEY = "boneburst.preview.colour";
const MINE_KEY = "boneburst.preview.mine";
const WHITE = "#ffffff";
const GREY = "#808080";

/**
 * The Preview panel: the animation playing on its own, only the picture (no bones, handles or paths).
 * It has a clock of its own and a rig of its own (`Session.previewPose`), so the Timeline's playhead and
 * the Stage stay where they are. The animation follows the one shown until one is picked here.
 */
export class PreviewPanel {
  readonly element = document.createElement("div");
  private readonly bar = document.createElement("div");
  private readonly pick = document.createElement("select");
  private readonly playBtn = document.createElement("button");
  private readonly loopBox = document.createElement("input");
  private readonly clock = document.createElement("span");
  private readonly fitBtn = document.createElement("button");
  private readonly colourA = document.createElement("input");
  private readonly whiteBtn = document.createElement("button");
  private readonly greyBtn = document.createElement("button");
  private readonly view = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private renderer: Renderer | null = null;
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private size = { width: 1, height: 1 };
  private fitted = false;
  /** Zoomed or panned by hand: a new size or document no longer refits. */
  private touched = false;
  private chosen: string | null | undefined;
  private time = 0;
  private playing = true;
  private loop = true;
  private last = 0;
  private lastDoc: unknown = null;
  private optionsKey = "";
  private colour = WHITE;
  /** The adjustable slot's colour. */
  private mine = "#4f8cff";

  constructor(private readonly session: Session) {
    const e = this.element;
    e.className = "panel preview";
    this.bar.className = "pv-bar";
    this.pick.setAttribute("aria-label", "Preview animation");
    this.pick.addEventListener("change", () => { this.chosen = this.pick.value === "" ? null : this.pick.value; this.time = 0; });
    this.playBtn.type = "button";
    this.playBtn.addEventListener("click", () => { this.playing = !this.playing; this.update(); });
    const label = document.createElement("label");
    this.loopBox.type = "checkbox";
    this.loopBox.checked = true;
    this.loopBox.addEventListener("change", () => { this.loop = this.loopBox.checked; });
    label.append(this.loopBox, " Loop");
    this.clock.className = "pv-clock";
    this.fitBtn.type = "button";
    this.fitBtn.title = "Fit the whole rig in the panel (double-click the picture does the same)";
    this.fitBtn.setAttribute("aria-label", "Fit");
    iconButton(this.fitBtn, "fit", false);
    this.fitBtn.addEventListener("click", () => this.fitView());
    // The background is one solid colour, three slots for a quick test: white and grey (fixed), and one to adjust.
    const slot = (b: HTMLButtonElement, colour: string, name: string): void => {
      b.type = "button";
      b.className = "pv-slot";
      b.style.background = colour;
      b.title = `${name} background`;
      b.setAttribute("aria-label", `${name} background`);
      b.addEventListener("click", () => { this.colour = colour; this.applyBg(); });
    };
    slot(this.whiteBtn, WHITE, "White");
    slot(this.greyBtn, GREY, "Grey");
    this.colourA.type = "color";
    this.colourA.className = "pv-colour";
    this.colourA.title = "Your own background colour";
    this.colourA.setAttribute("aria-label", "Background colour");
    this.colourA.addEventListener("input", () => { this.mine = this.colour = this.colourA.value; this.applyBg(); });
    try {
      const k = localStorage.getItem(BG_KEY);
      if (k && /^#[0-9a-f]{6}$/i.test(k)) this.colour = k;
      const m = localStorage.getItem(MINE_KEY);
      if (m && /^#[0-9a-f]{6}$/i.test(m)) this.mine = m;
    } catch { /* the default */ }
    this.bar.append(this.pick, this.playBtn, label, this.whiteBtn, this.greyBtn, this.colourA, this.clock, this.fitBtn);
    this.view.className = "pv-view";
    this.canvas.className = "pv-canvas";
    this.view.append(this.canvas);
    e.append(this.bar, this.view);
    this.applyBg();
    new ResizeObserver(() => this.measure()).observe(this.view);
    this.wheel();
    requestAnimationFrame((now) => this.tick(now));
    this.update();
  }

  /** Dockview's size for the whole panel: the picture takes what the bar leaves, which the observer reports. */
  layout(_w: number, _h: number): void { this.measure(); }

  fitView(): void { this.fitted = false; this.touched = false; }

  /** The picture's back: one solid colour under the clear canvas; the slot it came from is marked. */
  private applyBg(): void {
    this.colourA.value = this.mine;
    this.view.style.background = this.colour;
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
    this.whiteBtn.setAttribute("aria-pressed", String(same(this.colour, WHITE)));
    this.greyBtn.setAttribute("aria-pressed", String(same(this.colour, GREY)));
    this.colourA.setAttribute("aria-pressed", String(!same(this.colour, WHITE) && !same(this.colour, GREY)));
    try { localStorage.setItem(BG_KEY, this.colour); localStorage.setItem(MINE_KEY, this.mine); } catch { /* not kept */ }
  }

  private get animationName(): string | null {
    const names = (this.session.doc?.animations ?? []).map((a) => a.name);
    const want = this.chosen === undefined ? this.session.animation?.name ?? null : this.chosen;
    return want !== null && names.includes(want) ? want : null;
  }

  private measure(): void {
    const r = this.view.getBoundingClientRect(), s = pageScale(this.element.ownerDocument) || 1;
    this.size = { width: Math.max(1, r.width / s), height: Math.max(1, r.height / s) };
    const dpr = (this.element.ownerDocument.defaultView?.devicePixelRatio ?? 1) * s;
    this.canvas.width = Math.round(this.size.width * dpr);
    this.canvas.height = Math.round(this.size.height * dpr);
    if (!this.touched) this.fitted = false;
  }

  private update(): void {
    this.playBtn.textContent = this.playing ? "❚❚ Pause" : "▶ Play";
    const names = (this.session.doc?.animations ?? []).map((a) => a.name), key = names.join("\u0000");
    if (key !== this.optionsKey) {
      this.optionsKey = key;
      this.pick.replaceChildren(new Option("Setup pose", ""), ...names.map((n) => new Option(n, n)));
    }
    this.pick.value = this.animationName ?? "";
  }

  private wheel(): void {
    this.view.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.view.getBoundingClientRect();
      this.camera = zoomAt(this.camera, this.size, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.002));
      this.fitted = this.touched = true;
    }, { passive: false });
    let drag: { x: number; y: number } | null = null;
    this.view.addEventListener("pointerdown", (e) => { if (e.button === 1) { drag = { x: e.clientX, y: e.clientY }; this.view.setPointerCapture(e.pointerId); e.preventDefault(); } });
    this.view.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.camera = pan(this.camera, e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
      this.fitted = this.touched = true;
    });
    this.view.addEventListener("pointerup", () => { drag = null; });
    this.view.addEventListener("dblclick", () => this.fitView());
  }

  private tick(now: number): void {
    const win = this.element.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame((t) => this.tick(t));
    const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 0);
    this.last = now;
    // Nothing to draw while the panel is hidden or has no room.
    if (!this.element.isConnected || this.element.offsetParent === null) return;
    const doc = this.session.doc;
    if (doc !== this.lastDoc) { this.lastDoc = doc; this.touched = false; this.fitted = false; this.update(); }
    else if (this.pick.value !== (this.animationName ?? "")) this.update();
    const name = this.animationName, anim = name !== null ? this.session.doc?.animations?.find((a) => a.name === name) : undefined;
    const end = anim ? this.session.length(anim) : 0;
    if (this.playing && anim && end > 0) {
      this.time += dt;
      if (this.time >= end) { if (this.loop) this.time %= end; else { this.time = end; this.playing = false; this.update(); } }
    }
    this.clock.textContent = anim ? `${this.time.toFixed(2)} / ${end.toFixed(2)} s` : "setup pose";
    this.paint(name, this.time);
  }

  /** The box the whole run fits in, so the picture does not jump as the rig moves: twelve samples along the animation, or the setup pose. */
  private whole(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const name = this.animationName, anim = name !== null ? this.session.doc?.animations?.find((a) => a.name === name) : undefined, end = anim ? this.session.length(anim) : 0;
    let box = null as { minX: number; minY: number; maxX: number; maxY: number } | null;
    for (let k = 0; k <= (end > 0 ? 12 : 0); k++) {
      const pose = this.session.previewPose(name, end > 0 ? (end * k) / 12 : 0), b = pose ? bounds(pose, false) ?? bounds(pose) : null;
      if (b) box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
    }
    return box;
  }

  private paint(name: string | null, time: number): void {
    if (this.canvas.width < 2) this.measure();
    try { this.renderer ??= new Renderer(this.canvas, true); } catch { return; }
    // The fit poses along the run on the same rig, so the pose drawn is made after it.
    if (!this.fitted && this.session.doc) { this.fitted = true; this.camera = fit(this.size, this.whole()); }
    const p = this.session.previewPose(name, time);
    const css = (this.element.ownerDocument.defaultView ?? window).getComputedStyle(this.element), m = /^#([0-9a-f]{6})$/i.exec(css.getPropertyValue("--stage-bg").trim());
    const n = m ? parseInt(m[1]!, 16) : 0x808080, bg: [number, number, number] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    this.renderer.keepOnly(this.session.pages);
    this.renderer.draw(p, this.session.pages, this.camera, this.size, this.canvas.width / this.size.width, bg);
  }
}
