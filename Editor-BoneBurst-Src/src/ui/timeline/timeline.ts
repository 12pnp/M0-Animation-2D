import { addAnimation, deleteAnimation, renameAnimation } from "@/edit/animations";
import { BONE_PROPERTIES, keyBone } from "@/edit/boneKeys";
import { PRESETS, type Shape } from "@/edit/curves";
import { type Edit, EditRefused } from "@/edit/history";
import { deleteKeys, type KeyRef, moveKeys, setCurve } from "@/edit/keys";
import type { Skeleton } from "@/model/skeleton";
import { animationDuration, timeFrame } from "@/model/timelines";
import type { Session } from "../session";
import { animatedLocal } from "../stage/posed";
import {
  buildRows, shiftedRefs, frameX, labelStep, type Mark, markAt, marks, refId, ROW, type Row, rowAt, RULER, type View, xFrame,
} from "./layout";

const CURVES: ReadonlyArray<{ label: string; title: string; curve: "linear" | "stepped" | Shape }> = [
  { label: "Linear", title: "Straight from each selected key to the next", curve: "linear" },
  { label: "Stepped", title: "Hold each selected key until the next", curve: "stepped" },
  { label: "Ease in", title: "Start slow", curve: PRESETS.easeIn },
  { label: "Ease out", title: "End slow", curve: PRESETS.easeOut },
  { label: "Ease in-out", title: "Start and end slow", curve: PRESETS.easeInOut },
];

type Drag =
  | { kind: "scrub" }
  | { kind: "keys"; from: number; applied: number; refs: KeyRef[] };

/**
 * The timeline (SPEC §7): the animation list and transport, a ruler in frames at the skeleton's
 * fps, and a row per bone, slot and constraint with its keys. Click the ruler or an empty track to
 * move the playhead; click a key to select it (Shift adds), drag to move the selection by whole
 * frames (one undo step); Delete removes it; the curve buttons set the interpolation to the next key.
 */
export class Timeline {
  readonly element: HTMLElement;
  onStatus: (message: string) => void = () => {};
  private readonly select: HTMLSelectElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly loopBtn: HTMLButtonElement;
  private readonly frameOut: HTMLOutputElement;
  private readonly animButtons: HTMLButtonElement[];
  private readonly curveButtons: HTMLButtonElement[];
  private readonly keyBtn: HTMLButtonElement;
  private readonly labels: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly body: HTMLDivElement;
  private view: View = { frameWidth: 12, first: -0.5 };
  private rows: Row[] = [];
  private readonly expanded = new Set<string>();
  private readonly selected = new Map<string, KeyRef>();
  private drag: Drag | null = null;
  private queued = false;
  private labelSig = "";

  constructor(private readonly session: Session) {
    this.element = document.createElement("section");
    this.element.className = "timeline";
    const bar = document.createElement("div");
    bar.className = "timeline-bar";
    this.select = document.createElement("select");
    this.select.title = "The animation shown and keyed";
    this.select.addEventListener("change", () => session.showAnimation(this.select.value || null));
    const newBtn = button("New…", "Add an animation", () => this.newAnimation());
    const renameBtn = button("Rename…", "Rename this animation", () => this.renameAnimation());
    const deleteBtn = button("Delete", "Delete this animation", () => this.deleteAnimation());
    this.animButtons = [renameBtn, deleteBtn];
    const startBtn = button("⏮", "To the first frame (Home)", () => session.seek(0));
    this.playBtn = button("▶", "Play (Space)", () => this.togglePlay());
    this.loopBtn = button("Loop", "Loop playback", () => { session.loop = !session.loop; session.changed(); });
    this.frameOut = document.createElement("output");
    this.frameOut.className = "frame";
    this.keyBtn = button("Key", "Key the selected bone's rotate, translate and scale here (K)", () => this.keySelectedBone());
    this.curveButtons = CURVES.map((c) => button(c.label, c.title, () => this.applyCurve(c.curve)));
    bar.append(this.select, newBtn, ...this.animButtons, sep(), startBtn, this.playBtn, this.loopBtn, this.frameOut, sep(), this.keyBtn, sep(), ...this.curveButtons);

    this.body = document.createElement("div");
    this.body.className = "timeline-body";
    this.labels = document.createElement("div");
    this.labels.className = "timeline-labels";
    const track = document.createElement("div");
    track.className = "timeline-track";
    this.canvas = document.createElement("canvas");
    track.append(this.canvas);
    this.body.append(this.labels, track);
    this.element.append(bar, this.body);

    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", (e) => this.up(e));
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    session.onChange(() => this.update());
    this.update();
  }

  /** Keys are selected, so Delete is the timeline's. */
  get hasSelection(): boolean { return this.selected.size > 0; }

  togglePlay(): void {
    if (this.session.playing) this.session.pause(); else this.session.play();
  }

  deleteSelected(): void {
    const a = this.session.animation;
    if (!a || !this.selected.size) return;
    if (this.apply(`Delete ${this.selected.size} key${this.selected.size === 1 ? "" : "s"}`, deleteKeys(a.name, [...this.selected.values()]))) this.selected.clear();
  }

  /** Key the selected bone's rotate, translate and scale at the playhead. */
  keySelectedBone(): void {
    const a = this.session.animation, bone = this.session.selectedBone, p = this.session.pose();
    if (!a || bone === null || !p) { this.onStatus("Choose an animation and select a bone to key it."); return; }
    const i = p.bones.get(bone);
    if (i === undefined) return;
    this.session.pause();
    this.apply(`Key ${bone} at frame ${this.session.frame}`, keyBone(a.name, bone, BONE_PROPERTIES.filter((x) => x !== "shear"), animatedLocal(p, i), this.session.keyTime));
  }

  private apply(label: string, edit: Edit<Skeleton>): boolean {
    const h = this.session.history;
    if (!h) return false;
    try {
      const changed = h.apply(label, edit);
      this.session.changed();
      return changed;
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return false;
    }
  }

  private applyCurve(curve: "linear" | "stepped" | Shape): void {
    const a = this.session.animation;
    if (!a || !this.selected.size) { this.onStatus("Select keys first; a curve runs from each to the next."); return; }
    this.apply("Set curve", setCurve(a.name, [...this.selected.values()], curve));
  }

  private newAnimation(): void {
    const name = prompt("Name of the new animation:", "animation")?.trim();
    if (!name) return;
    if (this.apply(`Add animation ${name}`, addAnimation(name))) this.session.showAnimation(name);
  }

  private renameAnimation(): void {
    const a = this.session.animation;
    if (!a) return;
    const name = prompt(`Rename "${a.name}" to:`, a.name)?.trim();
    if (!name || name === a.name) return;
    if (this.apply(`Rename animation ${a.name} to ${name}`, renameAnimation(a.name, name))) this.session.showAnimation(name);
  }

  private deleteAnimation(): void {
    const a = this.session.animation;
    if (!a || !confirm(`Delete the animation "${a.name}"? Undo brings it back.`)) return;
    if (this.apply(`Delete animation ${a.name}`, deleteAnimation(a.name))) this.session.showAnimation(null);
  }

  private update(): void {
    const s = this.session, doc = s.doc, a = s.animation;
    const names = (doc?.animations ?? []).map((x) => x.name);
    if (this.select.options.length !== names.length + 1 || names.some((n, i) => this.select.options[i + 1]!.value !== n)) {
      this.select.replaceChildren(new Option("Setup pose", ""), ...names.map((n) => new Option(n, n)));
    }
    this.select.value = a?.name ?? "";
    this.select.disabled = !doc;
    for (const b of this.animButtons) b.disabled = !a;
    for (const b of this.curveButtons) b.disabled = !a || !this.selected.size;
    this.keyBtn.disabled = !a || s.selectedBone === null;
    this.playBtn.disabled = !a;
    this.playBtn.textContent = s.playing ? "⏸" : "▶";
    this.playBtn.title = s.playing ? "Pause (Space)" : "Play (Space)";
    this.loopBtn.setAttribute("aria-pressed", String(s.loop));
    const end = a ? timeFrame(animationDuration(a), s.fps) : 0;
    this.frameOut.textContent = a ? `frame ${s.frame} / ${end} · ${s.fps} fps` : "";

    this.rows = doc && a ? buildRows(doc, a, s.selectedBone, this.expanded) : [];
    // Keys an undo or another edit took away leave the selection.
    const live = new Set(this.rows.flatMap((r) => marks(r, s.fps).flatMap((m) => m.refs.map((x) => refId(x, s.fps)))));
    for (const id of [...this.selected.keys()]) if (!live.has(id)) this.selected.delete(id);
    // The labels are DOM: rebuilt only when the rows or the selected bone change, not every frame.
    const sig = `${a?.name}|${s.selectedBone}|${!!doc}|${this.rows.map((r) => `${r.id}:${r.expandable}:${r.expanded}`).join(",")}`;
    if (sig !== this.labelSig) { this.labelSig = sig; this.renderLabels(); }
    this.redraw();
  }

  private renderLabels(): void {
    const s = this.session;
    if (!s.animation) {
      this.labels.replaceChildren(Object.assign(document.createElement("p"), {
        className: "empty",
        textContent: s.doc ? "Choose an animation, or New… to start one." : "",
      }));
      return;
    }
    const head = document.createElement("div");
    head.className = "ruler-gap";
    const rows = this.rows.map((r) => {
      const el = document.createElement("div");
      el.className = `row depth${r.depth}`;
      if (r.bone !== undefined && r.bone === s.selectedBone && r.depth === 0) el.classList.add("selected");
      if (r.expandable) {
        const t = button(r.expanded ? "▾" : "▸", r.expanded ? "Collapse" : "Show each timeline", () => {
          if (this.expanded.has(r.id)) this.expanded.delete(r.id); else this.expanded.add(r.id);
          this.update();
        });
        t.className = "twisty";
        el.append(t);
      }
      const name = document.createElement("span");
      name.textContent = r.label;
      el.append(name);
      if (r.bone !== undefined) el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("twisty")) return;
        s.selectBone(r.bone!);
      });
      return el;
    });
    if (!rows.length) rows.push(Object.assign(document.createElement("p"), { className: "empty", textContent: "No keys yet: select a bone and press Key, or drag it on the stage." }));
    this.labels.replaceChildren(head, ...rows);
  }

  redraw(): void {
    if (this.queued) return;
    this.queued = true;
    (this.element.ownerDocument.defaultView ?? window).requestAnimationFrame(() => { this.queued = false; this.paint(); });
  }

  private paint(): void {
    const c = this.canvas, parent = c.parentElement!;
    const view = this.element.ownerDocument.defaultView ?? window;
    const dpr = view.devicePixelRatio || 1;
    const width = Math.max(1, parent.clientWidth), height = Math.max(parent.clientHeight, RULER + this.rows.length * ROW);
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      c.style.height = `${height}px`;
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = view.getComputedStyle(this.element);
    const col = (n: string) => css.getPropertyValue(n).trim();
    g.fillStyle = col("--panel");
    g.fillRect(0, 0, width, height);
    const s = this.session, a = s.animation;
    if (!a) return;
    const v = this.view, fps = s.fps, end = timeFrame(animationDuration(a), fps);
    // Rows, alternating.
    this.rows.forEach((_, i) => {
      if (i % 2) { g.fillStyle = col("--hover"); g.fillRect(0, RULER + i * ROW, width, ROW); }
    });
    // Past the end, dimmed.
    const ex = frameX(v, end);
    if (ex < width) { g.fillStyle = col("--bg"); g.globalAlpha = 0.5; g.fillRect(Math.max(0, ex), RULER, width, height); g.globalAlpha = 1; }
    // Ruler.
    g.fillStyle = col("--bg");
    g.fillRect(0, 0, width, RULER);
    const step = labelStep(v.frameWidth);
    g.font = `11px ${col("--font-mono")}`;
    g.textBaseline = "middle";
    const firstFrame = Math.max(0, Math.floor(v.first)), lastFrame = Math.ceil(xFrame(v, width));
    for (let f = firstFrame; f <= lastFrame; f++) {
      const x = Math.round(frameX(v, f)) + 0.5;
      const major = f % step === 0;
      if (!major && v.frameWidth < 5) continue;
      g.strokeStyle = col("--line");
      g.beginPath(); g.moveTo(x, major ? 10 : 17); g.lineTo(x, RULER); g.stroke();
      if (major) {
        g.fillStyle = col("--muted");
        g.fillText(String(f), x + 3, 9);
        g.globalAlpha = 0.35;
        g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, height); g.stroke();
        g.globalAlpha = 1;
      }
    }
    // Keys.
    const accent = col("--accent"), text = col("--text");
    this.rows.forEach((r, i) => {
      const y = RULER + i * ROW + ROW / 2;
      for (const m of marks(r, fps)) {
        const x = frameX(v, m.frame);
        if (x < -8 || x > width + 8) continue;
        const on = m.refs.every((ref) => this.selected.has(refId(ref, fps)));
        g.fillStyle = on ? accent : r.depth ? col("--muted") : text;
        g.beginPath();
        const k = r.depth ? 4 : 5;
        if (m.stepped) g.rect(x - k + 1, y - k + 1, 2 * k - 2, 2 * k - 2);
        else { g.moveTo(x, y - k); g.lineTo(x + k, y); g.lineTo(x, y + k); g.lineTo(x - k, y); g.closePath(); }
        g.fill();
        if (m.eased) { g.strokeStyle = on ? accent : text; g.beginPath(); g.arc(x, y, k + 2.5, 0, Math.PI * 2); g.stroke(); }
      }
    });
    // Playhead.
    const px = Math.round(frameX(v, s.time * fps)) + 0.5;
    g.strokeStyle = col("--playhead");
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, height); g.stroke();
    g.lineWidth = 1;
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private down(e: PointerEvent): void {
    const s = this.session, a = s.animation;
    if (!a || e.button !== 0) return;
    const [x, y] = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    const i = rowAt(y, this.rows.length);
    const mark: Mark | null = i >= 0 ? markAt(this.view, marks(this.rows[i]!, s.fps), x) : null;
    if (!mark) {
      if (!e.shiftKey && y >= RULER) this.selected.clear();
      this.drag = { kind: "scrub" };
      s.seek(xFrame(this.view, x));
      return;
    }
    const ids = mark.refs.map((r) => refId(r, s.fps));
    const all = ids.every((id) => this.selected.has(id));
    if (e.shiftKey) {
      for (const [k, r] of ids.map((id, j) => [id, mark.refs[j]!] as const)) { if (all) this.selected.delete(k); else this.selected.set(k, r); }
    } else if (!all) {
      this.selected.clear();
      mark.refs.forEach((r, j) => this.selected.set(ids[j]!, r));
    }
    const row = this.rows[i]!;
    if (row.bone !== undefined && s.selectedBone !== row.bone) s.selected = { kind: "bone", name: row.bone };
    s.pause();
    this.drag = { kind: "keys", from: Math.round(xFrame(this.view, x)), applied: 0, refs: [...this.selected.values()] };
    s.history?.begin(`Move ${this.selected.size} key${this.selected.size === 1 ? "" : "s"}`);
    s.changed();
  }

  private move(e: PointerEvent): void {
    const d = this.drag, s = this.session, a = s.animation;
    if (!d || !a) return;
    const [x] = this.local(e);
    if (d.kind === "scrub") { s.seek(xFrame(this.view, x)); return; }
    const by = Math.round(xFrame(this.view, x)) - d.from;
    if (by === d.applied) return;
    const fps = s.fps;
    try {
      s.history!.apply("step", moveKeys(a.name, shiftedRefs(d.refs, d.applied, fps), by - d.applied, fps));
      d.applied = by;
      this.selected.clear();
      for (const r of shiftedRefs(d.refs, by, fps)) this.selected.set(refId(r, fps), r);
      s.changed();
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
  }

  private up(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.drag?.kind === "keys") { this.session.history?.end(); this.session.changed(); }
    this.drag = null;
  }

  private wheel(e: WheelEvent): void {
    const [x] = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const at = xFrame(this.view, x), frameWidth = Math.min(60, Math.max(1, this.view.frameWidth * Math.exp(-e.deltaY * 0.01)));
      this.view = { frameWidth, first: at - x / frameWidth };
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      this.view = { ...this.view, first: Math.max(-0.5, this.view.first + dx / this.view.frameWidth) };
    } else return;
    this.redraw();
  }
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function sep(): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "sep";
  s.setAttribute("aria-hidden", "true");
  return s;
}
