import { cls, h, on } from "@/view/widgets/dom";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import { doSetIkKeys, doSetTrack, ensureTrack } from "@/app/TimelineOps";
import { uiFont } from "@/core/prefs/fonts";
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

const PAD = { left: 44, right: 10, top: 10, bottom: 18 };
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
  readonly footer: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private chips: HTMLElement;
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

  constructor(private readonly store: Store) {
    this.canvas = h("canvas", { class: "graph-canvas" }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.chips = h("div", { class: "graph-chips" });
    const fit = h("button", { class: "btn", title: "Fit the curves to the view (F)" }, "Fit");
    on(fit, "click", () => { this.fit(); this.draw(); });
    this.footer = h("div", { class: "pfooter graph-footer" }, this.chips, h("div", { class: "spacer" }), fit);
    this.el = h("div", { class: "graph-panel", tabindex: "0" }, this.canvas);
    new ResizeObserver(() => this.resize()).observe(this.el);
    store.subscribe((t) => {
      if (t === "doc" || t === "timeline" || t === "selection" || t === "stage" || t === "frame" || t === "ui") this.schedule();
    });
    this.wire();
  }

  onShow(): void {
    this.resize();
    requestAnimationFrame(() => this.resize());
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.rebuild(); this.draw(); });
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
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
    this.draw();
  }

  /* ── what is shown ── */

  /** The node the graph follows: the first selected one with a transform. */
  private subject(): Node | null {
    const sel = this.store.selectedNodes.filter((n) => n.kind !== "group");
    return sel[0] ?? null;
  }

  private rebuild(): void {
    const anim = this.store.currentAnimation;
    const node = this.subject();
    if (node?.id !== this.node?.id) this.picks.clear();
    this.node = node;
    // While dragging, each curve keeps the range it had at the press: the
    // normalized view would otherwise rescale under the pointer.
    const kept = this.drag ? new Map(this.curves.map((c) => [c.id, [c.lo, c.hi]] as const)) : null;
    this.curves = [];
    if (!anim || !node) { this.renderChips(); return; }
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
    this.renderChips();
  }

  /** The curves drawn: switched on, and with keys (or picked on by hand). */
  private visible(): Curve[] {
    return this.curves.filter((c) => !this.hidden.has(c.id) && (c.keys.length > 0 || this.forced.has(c.id)));
  }
  /** Curves without keys the user switched on. */
  private forced = new Set<string>();

  private renderChips(): void {
    this.chips.replaceChildren();
    if (!this.node) {
      this.chips.appendChild(h("span", { class: "hint" }, "Select a bone to see its curves."));
      return;
    }
    for (const c of this.curves) {
      const on_ = !this.hidden.has(c.id) && (c.keys.length > 0 || this.forced.has(c.id));
      const chip = h("button", { class: "graph-chip", title: c.keys.length ? `${c.label}: show or hide its curve` : `${c.label} has no keys` },
        h("span", { class: "graph-swatch", style: { background: c.color } }), c.label);
      cls(chip, "on", on_);
      cls(chip, "empty", !c.keys.length);
      on(chip, "click", () => {
        if (on_) { this.hidden.add(c.id); this.forced.delete(c.id); } else { this.hidden.delete(c.id); this.forced.add(c.id); }
        this.rebuild();
        this.draw();
      });
      this.chips.appendChild(chip);
    }
  }

  /* ── mapping ── */

  private get normalized(): boolean { return this.visible().length > 1; }
  private n(c: Curve, v: number): number { return this.normalized ? (v - c.lo) / (c.hi - c.lo) : v; }
  private v(c: Curve, n: number): number { return this.normalized ? c.lo + n * (c.hi - c.lo) : n; }
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
      ctx.fillText(anim ? "Select a bone to see its curves." : "No animation.", PAD.left, 24);
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
    // The playhead.
    const px = Math.round(this.xOf(this.store.ui.frame)) + 0.5;
    ctx.strokeStyle = this.store.prefs.value.timeline.playhead;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
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
      ctx.fillStyle = "#8a8a8a";
      ctx.fillText(String(f + 1), x + 2, this.h - PAD.bottom / 2);
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
      this.el.focus();
      const { x, y } = local(e);
      el.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2) {
        this.drag = { kind: "pan", x, y, from: this.from, yMin: this.yMin, yMax: this.yMax };
        return;
      }
      if (e.button !== 0) return;
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
        this.store.setFrame(pt.key.frame);
        const base = new Map(this.curves.map((c) => [c.id, c.keys] as const));
        this.drag = { kind: "keys", x, y, base, baseTrack, started: false };
        this.draw();
        return;
      }
      if (!e.shiftKey) this.picks.clear();
      this.drag = { kind: "scrub" };
      this.store.setFrame(Math.max(0, Math.round(this.frameAt(x))));
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
        this.store.setFrame(Math.max(0, Math.round(this.frameAt(x))));
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

    on(this.el, "keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "f" || e.key === "F") { this.fit(); this.draw(); e.preventDefault(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && this.deletePicked()) { e.preventDefault(); e.stopPropagation(); }
    });
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
        const dv = this.normalized ? dn * (p.curve.hi - p.curve.lo) : dn;
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

