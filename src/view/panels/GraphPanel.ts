import { clear, drag as dragEl, h, on } from "@/view/widgets/dom";
import { icon, type IconName } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import { doSetIkKeys, doSetTrack, ensureTrack } from "@/app/TimelineOps";
import { uiFont, uiPx } from "@/core/prefs/fonts";
import { layerRows } from "@/core/doc/layerTree";
import { isCycle } from "@/core/doc/cycle";
import { DEFAULT_GRID_COLORS, HEADER_HEIGHT, ROW_HEIGHT } from "@/view/timeline/FrameGrid";
import { playheadLabel } from "@/view/timeline/zoom";
import type { Playback } from "@/view/timeline/Playback";
import { transportButtons } from "@/view/timeline/transport";
import {
  type ChannelKey, channelKeys, deleteChannelKeys, keyChannelAt, setChannel, type TimelineProp,
} from "@/core/doc/propertyKeys";
import { valuesOf } from "@/core/doc/keyed";
import {
  GRAPH_CHANNELS, type GraphPick, graphSamples, handlesOf, moveGraphKeys, valueRange, withHandle,
} from "@/core/doc/graphEdit";
import { deleteIkKeys, ikPoseAt, withIkKey } from "@/core/doc/ikKeys";
import { ikRelations } from "@/core/doc/ikGraph";
import type { IkKey, Node, Track } from "@/core/doc/types";
import type { IkId } from "@/core/doc/ids";

/** What a curve writes back to: a bone property's channel, or an IK mix. */
type Target = { kind: "prop"; prop: TimelineProp } | { kind: "ik"; ik: IkId };

/** A key of an IK mix curve carries the IK key it came from. */
type Key = ChannelKey & { ik?: IkKey };

interface Curve {
  id: string;
  label: string;
  color: string;
  target: Target;
  /** Which of the target's values this curve draws. */
  leaf: number;
  keys: Key[];
  rest: number[];
  /** Its values' span, for the normalized view. */
  lo: number;
  hi: number;
}

type Drag =
  | { kind: "pan"; x: number; y: number; from: number; yMin: number; yMax: number }
  | { kind: "scrub" }
  | { kind: "keys"; x: number; y: number; base: Map<string, Key[]>; baseTrack: Track | undefined; started: boolean }
  | { kind: "handle"; curve: Curve; index: number; end: "out" | "in"; base: Key[]; baseTrack: Track | undefined; started: boolean };

/** Room for the value labels on the left; `top` is set below the ruler. */
/** A layer row's icon in the Graph's layer column. */
function kindIcon(n: Node): IconName {
  return n.kind === "group" ? "folderItem" : n.kind === "bone" ? "bone" : n.kind === "empty" ? "emptyItem"
    : n.kind === "box" ? "boxItem" : n.kind === "point" ? "pointItem" : n.kind === "path" ? "pathItem" : "imageItem";
}

const PAD = { left: 44, right: 10, top: 30, bottom: 10 };
const HIT = 6;

/**
 * The graph editor (ARCHITECTURE ▸ Graph editor, docs/GRAPH-PLAN.md): the
 * selected node's property values over time, and its IK constraint's mix, as
 * the curves the runtime plays. A point is a key: drag it in time and value;
 * a picked key shows the handles of the intervals beside it, which bend
 * them. One curve shows its own values on the axis; several are each scaled
 * to their own range. The rules are `core/doc/graphEdit.ts`.
 */
export class GraphPanel implements Panel {
  readonly id = "graph";
  readonly title = "Graph";
  readonly icon = "axes" as const;
  readonly el: HTMLElement;

  /** The plot: the canvas and what takes the keyboard. */
  private view: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** The layer column, as the timeline's: the subject's curves under its row. */
  private list: HTMLElement;
  private animSelect: HTMLSelectElement;
  private frameLabel: HTMLElement;
  private fpsLabel: HTMLElement;
  private elapsedLabel: HTMLElement;
  private dpr = 1;
  private w = 1;
  private h = 1;
  /** The view: frames across, normalized (or real) values up. */
  private from = 0;
  private perFrame = 12;
  private yMin = -0.1;
  private yMax = 1.1;
  private fitted = "";
  private hidden = new Set<string>();
  private picks = new Set<string>();
  private curves: Curve[] = [];
  private node: Node | null = null;
  private drag: Drag | null = null;
  private queued = false;

  constructor(private readonly store: Store, private readonly playback: Playback) {
    this.canvas = h("canvas", { class: "graph-canvas" }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.view = h("div", { class: "graph-panel", tabindex: "0" }, this.canvas);
    this.list = h("div", { class: "tl-llist" });
    const layers = h("div", { class: "tl-layers" },
      h("div", { class: "tl-lhead graph-lhead" }, h("span", { class: "hint" }, "Curves")),
      this.list);

    const splitter = h("div", { class: "splitter v" });
    let startW = 186;
    dragEl(splitter, {
      cursor: "ew-resize",
      onStart: () => { startW = layers.offsetWidth; splitter.classList.add("dragging"); },
      onMove: (dx) => main.style.setProperty("--tl-layers", `${Math.max(110, Math.min(400, startW + dx))}px`),
      onEnd: () => splitter.classList.remove("dragging"),
    });
    const main = h("div", { class: "tl-main" }, layers, splitter, this.view);

    this.animSelect = h("select", { class: "tl-anim", title: "Animation" }) as HTMLSelectElement;
    on(this.animSelect, "change", () => {
      const anim = this.store.currentSymbol.animations.find((a) => a.id === this.animSelect.value);
      if (!anim) return;
      this.store.setUi({ animId: anim.id, frame: 0 }, "doc");
      this.store.emit("timeline");
    });
    this.frameLabel = h("span", { class: "cur" }, "1");
    this.fpsLabel = h("span", { class: "fps" });
    this.elapsedLabel = h("span", { class: "elapsed" });
    const fit = h("button", { class: "iconbtn", title: "Fit the curves to the view (F)" }, icon("fit", 13));
    on(fit, "click", () => { this.fit(); this.draw(); });
    const bar = h("div", { class: "tl-foot" },
      ...transportButtons(store, playback).buttons,
      h("div", { class: "sep-v" }),
      this.animSelect,
      h("div", { class: "readout" }, this.frameLabel, this.fpsLabel, this.elapsedLabel),
      h("div", { class: "spacer" }),
      fit);

    this.el = h("div", { class: "tl graph-tl" }, bar, main);
    new ResizeObserver(() => this.resize()).observe(this.view);
    store.subscribe((t) => {
      if (t === "doc" || t === "timeline" || t === "selection" || t === "stage" || t === "frame" || t === "ui" || t === "playback") this.schedule();
    });
    store.prefs.subscribe(() => this.schedule());
    this.wire();
  }

  onShow(): void {
    this.resize();
    requestAnimationFrame(() => this.resize());
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.rebuild(); this.syncBar(); this.draw(); });
  }

  private syncBar(): void {
    const sym = this.store.currentSymbol;
    const current = this.store.currentAnimation;
    const ids = sym.animations.map((a) => `${a.id}:${a.name}:${isCycle(a)}`).join("|");
    if (this.animSelect.dataset.ids !== ids) {
      this.animSelect.dataset.ids = ids;
      clear(this.animSelect);
      for (const a of sym.animations) this.animSelect.appendChild(h("option", { value: a.id }, isCycle(a) ? `${a.name} ↻` : a.name));
    }
    if (current) this.animSelect.value = current.id;
    const frame = this.store.ui.frame;
    const fps = this.store.project.frameRate;
    this.frameLabel.textContent = String(frame + 1);
    this.fpsLabel.textContent = `${fps} fps`;
    this.elapsedLabel.textContent = `${(frame / fps).toFixed(1)} s`;
  }

  private resize(): void {
    const r = this.view.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    // A view fitted while the panel had no size fits again once it has one.
    if (this.w <= 1 || this.h <= 1) this.fitted = "";
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.rebuild();
    this.syncBar();
    this.draw();
  }

  private get fontSize() { return this.store.prefs.value.interface.fontSize; }
  /** The ruler's height: the timeline's. */
  private get rulerH(): number { return uiPx(HEADER_HEIGHT, this.fontSize); }

  /* ── what is shown ── */

  /** The node the graph follows: the first selected one with a transform. */
  private subject(): Node | null {
    const sel = this.store.selectedNodes.filter((n) => n.kind !== "group");
    return sel[0] ?? null;
  }

  private rebuild(): void {
    PAD.top = this.rulerH + 8;
    const anim = this.store.currentAnimation;
    const node = this.subject();
    if (node?.id !== this.node?.id) this.picks.clear();
    this.node = node;
    // While dragging, each curve keeps the range it had at the press: the
    // normalized view would otherwise rescale under the pointer.
    const kept = this.drag ? new Map(this.curves.map((c) => [c.id, [c.lo, c.hi]] as const)) : null;
    this.curves = [];
    if (!anim || !node) { this.renderList(); return; }
    const track = anim.tracks[node.id];
    for (const c of GRAPH_CHANNELS) {
      const keys = channelKeys(track, c.prop);
      const rest = valuesOf(c.prop, track?.keys[0]?.transform ?? node.bind);
      this.curves.push({ id: c.id, label: c.label, color: c.color, target: { kind: "prop", prop: c.prop }, leaf: c.leaf, keys, rest, lo: 0, hi: 1 });
    }
    const sym = this.store.currentSymbol;
    for (const rel of ikRelations(sym, node.id)) {
      const k = rel.constraint;
      const keys: Key[] = (anim.ik?.[k.id] ?? []).map((ik) => ({ frame: ik.frame, values: [ik.mix], eases: [ik.tween ?? { kind: "linear" }], ik }));
      this.curves.push({
        id: `ik:${k.id}`, label: `IK ${k.name}`, color: this.store.prefs.value.gizmos.ikTarget,
        target: { kind: "ik", ik: k.id }, leaf: 0, keys, rest: [ikPoseAt(k, anim, 0).mix], lo: 0, hi: 1,
      });
    }
    const end = Math.max(1, anim.duration - 1);
    for (const c of this.curves) {
      const r = c.target.kind === "ik" ? { min: 0, max: 1 } : valueRange(graphSamples(c.keys, c.leaf, 0, end, 1, c.rest));
      const k = kept?.get(c.id);
      c.lo = k ? k[0] : r.min;
      c.hi = k ? k[1] : r.max;
    }
    // Fit when what is shown changes: another node, animation or set of curves.
    const sig = `${node.id}|${anim.id}|${this.visible().map((c) => c.id).join(",")}`;
    if (sig !== this.fitted) { this.fitted = sig; this.fit(); }
    this.renderList();
  }

  /** The curves drawn: switched on, and with keys (or picked on by hand). */
  private visible(): Curve[] {
    return this.curves.filter((c) => this.shown(c));
  }
  private shown(c: Curve): boolean {
    return !this.hidden.has(c.id) && (c.keys.length > 0 || this.forced.has(c.id));
  }
  /** Curves without keys the user switched on. */
  private forced = new Set<string>();

  /**
   * The layer column: every layer, as the timeline lists them; a press
   * selects one. The subject's curves are rows under it, each a switch.
   */
  private renderList(): void {
    const sym = this.store.currentSymbol;
    const rowH = `${uiPx(ROW_HEIGHT, this.fontSize)}px`;
    const rows = layerRows(sym);
    const sig = JSON.stringify([rowH, this.node?.id, rows.map((r) => [r.node.id, r.layer.name, r.depth]),
      this.curves.map((c) => [c.id, c.keys.length > 0, this.shown(c)])]);
    if (this.list.dataset.sig === sig) return;
    this.list.dataset.sig = sig;
    this.list.replaceChildren();
    if (!rows.length) {
      this.list.appendChild(h("div", { class: "empty" }, "No layers."));
      return;
    }
    for (const r of rows) {
      const row = h("div", {
        class: `tl-layer${r.node.id === this.node?.id ? " selected" : ""}`,
        style: { height: rowH, paddingLeft: `${5 + r.depth * 12}px` },
        title: r.node.kind === "group" ? r.layer.name : `${r.layer.name}: select to show its curves`,
      }, h("span", { class: "kind" }, icon(kindIcon(r.node), 12)), h("div", { class: "name" }, r.layer.name));
      on(row, "pointerdown", (ev) => {
        const e = ev as PointerEvent;
        if (e.button !== 0) return;
        this.store.clearFrameSelection();
        if (e.shiftKey) this.store.toggleNode(r.node.id);
        else this.store.selectNodes([r.node.id]);
      });
      this.list.appendChild(row);
      if (r.node.id !== this.node?.id) continue;
      for (const c of this.curves) {
        const on_ = this.shown(c);
        const eye = h("div", { class: `dot${on_ ? " on" : ""}` });
        eye.appendChild(icon(on_ ? "eye" : "eyeOff", 11));
        const prop = h("div", {
          class: `tl-layer tl-prop graph-curve${c.keys.length ? "" : " nokeys"}${on_ ? "" : " off"}`,
          style: { height: rowH, paddingLeft: `${22 + r.depth * 12}px` },
          title: c.keys.length ? `${c.label}: show or hide its curve` : `${c.label} has no keys: show its value anyway`,
        }, h("span", { class: "graph-swatch", style: { background: c.color } }), h("div", { class: "name" }, c.label), eye);
        on(prop, "pointerdown", (ev) => {
          if ((ev as PointerEvent).button !== 0) return;
          if (on_) { this.hidden.add(c.id); this.forced.delete(c.id); } else { this.hidden.delete(c.id); this.forced.add(c.id); }
          this.rebuild();
          this.draw();
        });
        this.list.appendChild(prop);
      }
    }
    this.list.querySelector(".tl-layer.selected")?.scrollIntoView({ block: "nearest" });
  }

  /* ── mapping ── */

  private get normalized(): boolean { return this.visible().length > 1; }
  /** The span a curve is scaled over: a flat one gets a unit span centred on
   *  its value, so it runs through the middle and its keys still drag. */
  private span(c: Curve): { lo: number; size: number } {
    return c.hi - c.lo < 1e-9 ? { lo: c.lo - 0.5, size: 1 } : { lo: c.lo, size: c.hi - c.lo };
  }
  private n(c: Curve, v: number): number {
    if (!this.normalized) return v;
    const { lo, size } = this.span(c);
    return (v - lo) / size;
  }
  private v(c: Curve, n: number): number {
    if (!this.normalized) return n;
    const { lo, size } = this.span(c);
    return lo + n * size;
  }
  private xOf(frame: number): number { return PAD.left + (frame - this.from) * this.perFrame; }
  private frameAt(x: number): number { return this.from + (x - PAD.left) / this.perFrame; }
  private yOfN(n: number): number { return PAD.top + ((this.yMax - n) / (this.yMax - this.yMin)) * (this.h - PAD.top - PAD.bottom); }
  private nAt(y: number): number { return this.yMax - ((y - PAD.top) / (this.h - PAD.top - PAD.bottom)) * (this.yMax - this.yMin); }
  private yOf(c: Curve, v: number): number { return this.yOfN(this.n(c, v)); }

  private fit(): void {
    const anim = this.store.currentAnimation;
    const end = Math.max(1, (anim?.duration ?? 2) - 1);
    this.from = -0.5;
    this.perFrame = Math.max(2, (this.w - PAD.left - PAD.right) / (end + 1));
    const shown = this.visible();
    if (!shown.length) { this.yMin = -0.1; this.yMax = 1.1; return; }
    let lo = Infinity, hi = -Infinity;
    for (const c of shown) {
      for (const p of graphSamples(c.keys, c.leaf, 0, end, 1, c.rest)) {
        const n = this.n(c, p.value);
        lo = Math.min(lo, n);
        hi = Math.max(hi, n);
      }
      for (let i = 0; i < c.keys.length; i++) {
        const hd = handlesOf(c.keys, i, c.leaf);
        if (hd) for (const p of [hd.out, hd.in]) { const n = this.n(c, p.value); lo = Math.min(lo, n); hi = Math.max(hi, n); }
      }
    }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08;
    this.yMin = lo - pad;
    this.yMax = hi + pad;
  }

  /* ── drawing ── */

  private draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#2e2e2e";
    ctx.fillRect(0, 0, this.w, this.h);
    const anim = this.store.currentAnimation;
    if (!anim || !this.node) {
      ctx.fillStyle = "#888";
      ctx.font = uiFont(11, this.store.prefs.value.interface.fontSize);
      ctx.textBaseline = "middle";
      ctx.fillText(anim ? "Select a bone to see its curves." : "No animation.", PAD.left, PAD.top + 14);
      if (anim) this.drawRuler(anim.duration);
      return;
    }
    this.drawGrid(anim.duration);
    const shown = this.visible();
    const first = Math.max(0, Math.floor(this.frameAt(PAD.left))), last = Math.ceil(this.frameAt(this.w));
    for (const c of shown) {
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      graphSamples(c.keys, c.leaf, first, Math.max(first, last), 0.25, c.rest).forEach((p, i) => {
        const x = this.xOf(p.frame), y = this.yOf(c, p.value);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    // Handles of the intervals beside each picked key.
    for (const c of shown) {
      c.keys.forEach((k, i) => {
        const pickedHere = this.picks.has(this.pickId(c, k.frame));
        const pickedNext = !!c.keys[i + 1] && this.picks.has(this.pickId(c, c.keys[i + 1]!.frame));
        if (!pickedHere && !pickedNext) return;
        const hd = handlesOf(c.keys, i, c.leaf);
        if (!hd) return;
        const b = c.keys[i + 1]!;
        this.drawHandle(this.xOf(k.frame), this.yOf(c, k.values[c.leaf]!), this.xOf(hd.out.frame), this.yOf(c, hd.out.value), c.color);
        this.drawHandle(this.xOf(b.frame), this.yOf(c, b.values[c.leaf]!), this.xOf(hd.in.frame), this.yOf(c, hd.in.value), c.color);
      });
    }
    for (const c of shown) {
      for (const k of c.keys) {
        const x = this.xOf(k.frame), y = this.yOf(c, k.values[c.leaf]!);
        const picked = this.picks.has(this.pickId(c, k.frame));
        ctx.beginPath();
        ctx.rect(x - 3.5, y - 3.5, 7, 7);
        ctx.fillStyle = picked ? "#ffffff" : c.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    this.drawRuler(anim.duration);
  }

  /** The timeline's ruler over the plot: its numbers, seconds and playhead marker. */
  private drawRuler(duration: number): void {
    const ctx = this.ctx;
    const C = DEFAULT_GRID_COLORS;
    const H = this.rulerH;
    const fps = this.store.project.frameRate;
    ctx.fillStyle = C.headerBg;
    ctx.fillRect(0, 0, this.w, H);
    const first = Math.max(0, Math.floor(this.frameAt(PAD.left)));
    const last = Math.ceil(this.frameAt(this.w));
    if (fps > 0) {
      // A lighter band every other second, as the timeline marks time.
      ctx.fillStyle = C.headerAlt;
      for (let f = Math.floor(first / fps) * fps; f <= last; f += fps) {
        if (Math.floor(f / fps) % 2 !== 0) continue;
        const a = Math.max(PAD.left, this.xOf(f - 0.5));
        ctx.fillRect(a, 0, Math.max(0, this.xOf(f - 0.5 + fps) - a), H);
      }
    }
    const frame = this.store.ui.frame;
    const px = Math.round(this.xOf(frame)) + 0.5;
    const markText = String(frame + 1);
    ctx.font = uiFont(11, this.fontSize);
    const mark = playheadLabel(px, ctx.measureText(markText).width);
    const taken: Array<[number, number]> = [[mark.left, mark.left + mark.width]];
    ctx.font = uiFont(9, this.fontSize);
    ctx.textBaseline = "middle";
    ctx.strokeStyle = C.tick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const label = (f: number, text: string, second: boolean) => {
      const x = Math.round(this.xOf(f)) + 0.5;
      if (x < PAD.left) return;
      const left = x - ctx.measureText(text).width / 2;
      const right = left + ctx.measureText(text).width;
      if (taken.some(([a, b]) => left < b + 3 && right + 3 > a)) return;
      taken.push([left, right]);
      ctx.moveTo(x, H - 4);
      ctx.lineTo(x, H - 1);
      ctx.fillStyle = second ? "#e0e0e0" : C.text;
      ctx.fillText(text, left, H / 2 - 2);
    };
    if (fps > 0) for (let f = Math.max(fps, Math.ceil(first / fps) * fps); f <= last; f += fps) label(f, `${f / fps}s`, true);
    const step = [1, 2, 5, 10, 20, 50, 100].find((s) => s * this.perFrame >= 28) ?? 200;
    for (let f = first; f <= last; f++) if (f === 0 || (f + 1) % step === 0) label(f, String(f + 1), false);
    ctx.stroke();
    // Past the animation's end, as the plot dims it.
    const endX = this.xOf(duration - 0.5);
    if (endX < this.w) { ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(Math.max(0, endX), 0, this.w - endX, H); }
    ctx.strokeStyle = C.headerLine;
    ctx.beginPath();
    ctx.moveTo(0, H - 0.5);
    ctx.lineTo(this.w, H - 0.5);
    ctx.stroke();

    // Spine's marker, as the timeline draws it: the number, a triangle whose
    // tip is on the ruler's lower edge, then the line down the plot.
    if (px < PAD.left - 1) return;
    const playhead = this.store.prefs.value.timeline.playhead;
    const tip = H - 1, arrow = 5, top = tip - arrow;
    ctx.fillStyle = playhead;
    ctx.font = uiFont(11, this.fontSize);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(markText, px, top - 3);
    ctx.textAlign = "start";
    ctx.beginPath();
    ctx.moveTo(px - arrow, top);
    ctx.lineTo(px + arrow, top);
    ctx.lineTo(px, tip);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = playhead;
    ctx.beginPath();
    ctx.moveTo(px, tip);
    ctx.lineTo(px, this.h);
    ctx.stroke();
  }

  private drawHandle(ax: number, ay: number, x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#2e2e2e";
    ctx.fill();
    ctx.stroke();
  }

  private drawGrid(duration: number): void {
    const ctx = this.ctx;
    const font = this.store.prefs.value.interface.fontSize;
    ctx.font = uiFont(9, font);
    ctx.textBaseline = "middle";
    // Frames: a line every n frames, n chosen so they are 40 px apart or more.
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    const every = steps.find((s) => s * this.perFrame >= 40) ?? 1000;
    const first = Math.max(0, Math.floor(this.frameAt(PAD.left) / every) * every);
    for (let f = first; this.xOf(f) < this.w; f += every) {
      const x = Math.round(this.xOf(f)) + 0.5;
      ctx.strokeStyle = f > duration - 1 ? "#333" : "#3d3d3d";
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, this.h - PAD.bottom); ctx.stroke();
    }
    // Values: real ones for one curve, 0..1 of each curve's range for several.
    const span = this.yMax - this.yMin;
    const raw = span / Math.max(1, (this.h - PAD.top - PAD.bottom) / 30);
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
    for (let n = Math.ceil(this.yMin / step) * step; n <= this.yMax; n += step) {
      const y = Math.round(this.yOfN(n)) + 0.5;
      ctx.strokeStyle = Math.abs(n) < step / 2 ? "#4a4a4a" : "#383838";
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(this.w, y); ctx.stroke();
      ctx.fillStyle = "#8a8a8a";
      const label = this.normalized ? `${Math.round(n * 100)}%` : String(+n.toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
      ctx.fillText(label, 4, y);
    }
    // Past the animation's end, dimmed.
    const endX = this.xOf(duration - 0.5);
    if (endX < this.w) { ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(endX, 0, this.w - endX, this.h); }
  }

  /* ── picking ── */

  private pickId(c: Curve, frame: number): string { return `${c.id}@${frame}`; }

  private pointAt(x: number, y: number): { curve: Curve; key: Key } | null {
    let best: { curve: Curve; key: Key; d: number } | null = null;
    for (const c of this.visible()) {
      for (const k of c.keys) {
        const d = Math.hypot(this.xOf(k.frame) - x, this.yOf(c, k.values[c.leaf]!) - y);
        if (d <= HIT && (!best || d < best.d)) best = { curve: c, key: k, d };
      }
    }
    return best;
  }

  private handleAt(x: number, y: number): { curve: Curve; index: number; end: "out" | "in" } | null {
    for (const c of this.visible()) {
      for (let i = 0; i < c.keys.length; i++) {
        const near = this.picks.has(this.pickId(c, c.keys[i]!.frame)) || (!!c.keys[i + 1] && this.picks.has(this.pickId(c, c.keys[i + 1]!.frame)));
        if (!near) continue;
        const hd = handlesOf(c.keys, i, c.leaf);
        if (!hd) continue;
        for (const end of ["out", "in"] as const) {
          const p = hd[end];
          if (Math.hypot(this.xOf(p.frame) - x, this.yOf(c, p.value) - y) <= HIT) return { curve: c, index: i, end };
        }
      }
    }
    return null;
  }

  private curveNear(x: number, y: number): Curve | null {
    const frame = this.frameAt(x);
    for (const c of this.visible()) {
      const v = graphSamples(c.keys, c.leaf, frame, frame, 1, c.rest)[0]!.value;
      if (Math.abs(this.yOf(c, v) - y) <= HIT) return c;
    }
    return null;
  }

  /* ── writing ── */

  private write(target: Target, keys: Key[], baseTrack: Track | undefined, cleanup: number[], label: string, kind?: string): void {
    const node = this.node;
    if (!node) return;
    if (target.kind === "prop") {
      const track = baseTrack ?? ensureTrack(this.store, node);
      doSetTrack(this.store, node.id, setChannel(track, node, target.prop, keys, cleanup), label, kind);
    } else {
      doSetIkKeys(this.store, target.ik, keys.map((k) => {
        const out: IkKey = { ...(k.ik ?? { bendPositive: false }), frame: k.frame, mix: Math.min(1, Math.max(0, k.values[0]!)) };
        const e = k.eases[0]!;
        if (e.kind === "linear") delete out.tween; else out.tween = e;
        return out;
      }), label, kind);
    }
  }

  private targetId(t: Target): string { return t.kind === "prop" ? `prop:${t.prop}` : `ik:${t.ik}`; }

  /** The picked keys, by what they write to. */
  private picksByTarget(): Map<string, { target: Target; picks: Array<GraphPick & { curve: Curve }> }> {
    const out = new Map<string, { target: Target; picks: Array<GraphPick & { curve: Curve }> }>();
    for (const c of this.visible()) {
      for (const k of c.keys) {
        if (!this.picks.has(this.pickId(c, k.frame))) continue;
        const id = this.targetId(c.target);
        const entry = out.get(id) ?? out.set(id, { target: c.target, picks: [] }).get(id)!;
        entry.picks.push({ frame: k.frame, leaf: c.leaf, curve: c });
      }
    }
    return out;
  }

  /** Delete the picked keys; false with none picked. */
  deletePicked(): boolean {
    const node = this.node;
    const anim = this.store.currentAnimation;
    const groups = this.picksByTarget();
    if (!node || !anim || !groups.size) return false;
    for (const { target, picks } of groups.values()) {
      const frames = [...new Set(picks.map((p) => p.frame))];
      if (target.kind === "prop") {
        const track = anim.tracks[node.id];
        if (track) doSetTrack(this.store, node.id, deleteChannelKeys(track, node, target.prop, frames), "Delete Keys");
      } else {
        doSetIkKeys(this.store, target.ik, deleteIkKeys(anim.ik?.[target.ik] ?? [], frames), "Delete IK Keys");
      }
    }
    this.picks.clear();
    return true;
  }

  /* ── input ── */

  private wire(): void {
    const el = this.canvas;
    const local = (e: MouseEvent) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    on(el, "wheel", (ev) => {
      const e = ev as WheelEvent;
      e.preventDefault();
      const { x, y } = local(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      if (e.altKey) {
        const n = this.nAt(y);
        this.yMin = n + (this.yMin - n) / f;
        this.yMax = n + (this.yMax - n) / f;
      } else {
        const frame = this.frameAt(x);
        this.perFrame = Math.min(200, Math.max(1, this.perFrame * f));
        this.from = frame - (x - PAD.left) / this.perFrame;
      }
      this.draw();
    });

    on(el, "contextmenu", (e) => e.preventDefault());

    on(el, "dblclick", (ev) => {
      const e = ev as MouseEvent;
      const { x, y } = local(e);
      const c = this.curveNear(x, y);
      const node = this.node, anim = this.store.currentAnimation;
      if (!c || !node || !anim) return;
      const frame = Math.max(0, Math.round(this.frameAt(x)));
      if (c.target.kind === "prop") {
        const track = anim.tracks[node.id] ?? ensureTrack(this.store, node);
        doSetTrack(this.store, node.id, keyChannelAt(track, node, c.target.prop, frame), "Key");
      } else {
        const k = this.store.currentSymbol.ik.find((i) => i.id === (c.target as { ik: IkId }).ik)!;
        doSetIkKeys(this.store, k.id, withIkKey(anim.ik?.[k.id] ?? [], frame, ikPoseAt(k, anim, frame), k.softness), "Key IK");
      }
      this.picks = new Set([this.pickId(c, frame)]);
    });

    on(el, "pointerdown", (ev) => {
      const e = ev as PointerEvent;
      this.view.focus();
      const { x, y } = local(e);
      el.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2) {
        this.drag = { kind: "pan", x, y, from: this.from, yMin: this.yMin, yMax: this.yMax };
        return;
      }
      if (e.button !== 0) return;
      if (y < this.rulerH) {
        this.drag = { kind: "scrub" };
        this.scrubTo(x);
        return;
      }
      const anim = this.store.currentAnimation;
      const baseTrack = this.node && anim ? anim.tracks[this.node.id] : undefined;
      const hd = this.handleAt(x, y);
      if (hd) {
        this.drag = { kind: "handle", curve: hd.curve, index: hd.index, end: hd.end, base: hd.curve.keys, baseTrack, started: false };
        return;
      }
      const pt = this.pointAt(x, y);
      if (pt) {
        const id = this.pickId(pt.curve, pt.key.frame);
        if (e.shiftKey) { if (this.picks.has(id)) this.picks.delete(id); else this.picks.add(id); }
        else if (!this.picks.has(id)) this.picks = new Set([id]);
        this.playback.pause();
        this.store.setFrame(pt.key.frame);
        const base = new Map(this.curves.map((c) => [c.id, c.keys] as const));
        this.drag = { kind: "keys", x, y, base, baseTrack, started: false };
        this.draw();
        return;
      }
      if (!e.shiftKey) this.picks.clear();
      this.drag = { kind: "scrub" };
      this.scrubTo(x);
      this.draw();
    });

    on(el, "pointermove", (ev) => {
      const e = ev as PointerEvent;
      const d = this.drag;
      if (!d) return;
      const { x, y } = local(e);
      if (d.kind === "pan") {
        this.from = d.from - (x - d.x) / this.perFrame;
        const dn = ((y - d.y) / (this.h - PAD.top - PAD.bottom)) * (d.yMax - d.yMin);
        this.yMin = d.yMin + dn;
        this.yMax = d.yMax + dn;
        this.draw();
      } else if (d.kind === "scrub") {
        this.scrubTo(x);
      } else if (d.kind === "keys") {
        this.dragKeys(d, x, y, e.shiftKey);
      } else {
        this.dragHandle(d, x, y);
      }
    });

    const up = (ev: Event) => {
      const d = this.drag;
      this.drag = null;
      this.dragPicks = null;
      el.releasePointerCapture?.((ev as PointerEvent).pointerId);
      if (d && (d.kind === "keys" || d.kind === "handle") && d.started) this.store.history.endInteraction();
    };
    on(el, "pointerup", up);
    on(el, "pointercancel", up);

    on(this.view, "keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "f" || e.key === "F") { this.fit(); this.draw(); e.preventDefault(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && this.deletePicked()) { e.preventDefault(); e.stopPropagation(); }
    });
  }

  private scrubTo(x: number): void {
    this.playback.pause();
    this.store.setFrame(Math.max(0, Math.round(this.frameAt(x))));
  }

  /** Move the picked keys from where they were at the press: whole frames
   *  across, each curve's own units up (⇧: one axis, the larger). */
  private dragKeys(d: Extract<Drag, { kind: "keys" }>, x: number, y: number, oneAxis: boolean): void {
    let dx = x - d.x, dy = y - d.y;
    if (!d.started && Math.hypot(dx, dy) < 3) return;
    if (oneAxis) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (!d.started) { d.started = true; this.store.history.beginInteraction("graph.keys"); }
    const frames = Math.round(dx / this.perFrame);
    const dn = -(dy / (this.h - PAD.top - PAD.bottom)) * (this.yMax - this.yMin);
    const groups = new Map<string, { target: Target; picks: Array<GraphPick & { curve: Curve }> }>();
    for (const c of this.curves) {
      for (const k of d.base.get(c.id) ?? []) {
        if (!this.picksAtPress(d, c, k.frame)) continue;
        const id = this.targetId(c.target);
        const entry = groups.get(id) ?? groups.set(id, { target: c.target, picks: [] }).get(id)!;
        entry.picks.push({ frame: k.frame, leaf: c.leaf, curve: c });
      }
    }
    const next = new Set<string>();
    for (const { target, picks } of groups.values()) {
      const base = d.base.get(picks[0]!.curve.id)!;
      let keys: Key[] = moveGraphKeys(base, picks, frames, 0);
      for (const p of picks) {
        const dv = this.normalized ? dn * this.span(p.curve).size : dn;
        keys = moveGraphKeys(keys, [{ frame: Math.max(0, p.frame + frames), leaf: p.leaf }], 0, dv);
        next.add(this.pickId(p.curve, Math.max(0, p.frame + frames)));
      }
      this.write(target, keys, d.baseTrack, picks.map((p) => p.frame), "Move Keys", "graph.keys");
    }
    this.dragPicks ??= new Set(this.picks);
    this.picks = next;
  }

  /** The picks as they were when this drag began. */
  private dragPicks: Set<string> | null = null;
  private picksAtPress(_d: unknown, c: Curve, frame: number): boolean {
    return (this.dragPicks ?? this.picks).has(this.pickId(c, frame));
  }

  private dragHandle(d: Extract<Drag, { kind: "handle" }>, x: number, y: number): void {
    if (!d.started) { d.started = true; this.store.history.beginInteraction("graph.handle"); }
    const c = d.curve;
    const keys = withHandle(d.base, d.index, c.leaf, d.end, this.frameAt(x), this.v(c, this.nAt(y)));
    this.write(c.target, keys, d.baseTrack, [], "Bend Curve", "graph.handle");
  }
}

