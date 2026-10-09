import { addAnimation, deleteAnimation, renameAnimation } from "@/edit/animations";
import type { TimelineMemory } from "../viewMemory";
import { BONE_PROPERTIES, keyBone } from "@/edit/boneKeys";
import { PRESETS, type Shape } from "@/edit/curves";
import { isSeamless, trimClosingKeys } from "@/edit/loop";
import { type Edit, EditRefused } from "@/edit/history";
import { keyEvent } from "@/edit/events";
import { deleteKeys, type KeyRef, moveKeys, sameTime, setChannelCurve, setCurve, setKey } from "@/edit/keys";
import { copyKeys, pasteKeys } from "@/edit/paste";
import type { Skeleton } from "@/model/skeleton";
import { animationDuration, channelValues, frameTime, keyLists, keyTime, pathId, timeFrame } from "@/model/timelines";
import { type Channel, channelField, channelId, channelsOf, fitValues, intervals, valueY, yValue } from "./graph";
import { iconButton, type IconName, setIcon } from "../icons";
import { clipboard } from "../clipboard";
import type { Session } from "../session";
import { animatedLocal } from "../stage/posed";
import {
  secondsSinceLastKey, frameX, labelStep, refId, RULER, type View, xFrame,
} from "./layout";
import { keysOf } from "../shortcuts";
import { localPoint, pageScale } from "../pageScale";
import { graphColours } from "../graphLook";

const CURVES: ReadonlyArray<{ label: string; title: string; icon: IconName; curve: "linear" | "stepped" | Shape }> = [
  { label: "Linear", icon: "curveLinear", title: "Straight from each selected key to the next", curve: "linear" },
  { label: "Stepped", icon: "curveStepped", title: "Hold each selected key until the next", curve: "stepped" },
  { label: "Ease in", icon: "curveEaseIn", title: "Start slow", curve: PRESETS.easeIn },
  { label: "Ease out", icon: "curveEaseOut", title: "End slow", curve: PRESETS.easeOut },
  { label: "Ease in-out", icon: "curveEaseInOut", title: "Start and end slow", curve: PRESETS.easeInOut },
];

type Drag =
  | { kind: "scrub" }
  /** A press on empty graph: a click (playhead, selection cleared) until it moves; then a box (E6 step 4c). */
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; moved: boolean; add: boolean; base: Map<string, KeyRef> };

/**
 * The track's zoom limits, in CSS pixels per frame. The least is a key's width (a diamond is 10 px
 * across), so keys on neighbouring frames never overlap; the most is double what it was (60).
 */
const MIN_FRAME_WIDTH = 10;
/** The playhead: a green tag with the frame number on the ruler, and a line of the same green under it. */
const PLAYHEAD = "#30a46c";
const BADGE_H = 15;
const BADGE_BOTTOM = 9 + BADGE_H / 2;
const MAX_FRAME_WIDTH = 120;

/** The height of the strip of time-difference tabs under the ruler. */
const TABS = 22;

/** How far a press on empty track moves before it is a box rather than a click. */
const BOX_SLOP = 4;

/**
 * The timeline (SPEC §7, docs/TIMELINE-GRAPH-PLAN.md): the animation list and transport, a ruler in
 * frames at the skeleton's fps, and the curve graph of the selected bone's (or constraint's) channels.
 * Click the ruler or an empty place on the graph to move the playhead; click a key to select it (Shift
 * adds), drag a box to select the keys in it; drag a key or a curve's handle to edit it (one undo
 * step); Delete removes the selected keys; the curve buttons set the interpolation to the next key.
 */
export class Timeline {
  readonly element: HTMLElement;
  onStatus: (message: string) => void = () => {};
  private readonly select: HTMLSelectElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly loopBtn: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly frameOut: HTMLOutputElement;
  private readonly animButtons: HTMLButtonElement[];
  private readonly curveButtons: HTMLButtonElement[];
  private readonly keyBtn: HTMLButtonElement;
  private readonly fitBtn: HTMLButtonElement;
  private readonly closedBox: HTMLInputElement;
  private readonly trimBtn: HTMLButtonElement;
  private readonly labels: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly body: HTMLDivElement;
  private view: View = { frameWidth: 12, first: -0.5 };
  private readonly selected = new Map<string, KeyRef>();
  private drag: Drag | null = null;
  /** The frame tag on the ruler as last drawn, for the cursor. */
  private tag: { x0: number; x1: number; y0: number; y1: number } | null = null;
  /** A middle-button drag that pans the track: where it began, the view then, and the rows' scroll then. */
  private pan: { x: number; y: number; first: number; scroll: number } | null = null;
  /** The curve graph (E6 step 4g): on, the track draws the chosen channels' curves. */
  /** The value range, held still while a curve is dragged. */
  private graphFit: { min: number; max: number } | null = null;
  private graphDrag:
    | { kind: "handle"; id: string; at: number; which: 0 | 1 }
    | { kind: "key"; id: string; time: number; from: number; applied: number }
    | null = null;
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
    const deleteBtn = iconButton(button("Delete", "Delete this animation", () => this.deleteAnimation()), "delete");
    this.animButtons = [renameBtn, deleteBtn];
    const startBtn = iconButton(button("⏮", `To the first frame (${keysOf("firstFrame")})`, () => session.seek(0)), "start", false);
    this.playBtn = iconButton(button("▶", `Play (${keysOf("play")})`, () => this.togglePlay()), "play", false);
    this.loopBtn = iconButton(button("Loop", "Loop playback", () => { session.loop = !session.loop; session.changed(); }), "loop");
    this.frameOut = document.createElement("output");
    this.frameOut.className = "frame";
    this.keyBtn = iconButton(button("Key", `Key the selected bone's rotate, translate and scale here, or fire the selected event here (${keysOf("key")})`, () => this.keySelected()), "key");
    // Icons only, so the bar stays one line; the name leads the tooltip and is the accessible name.
    this.curveButtons = CURVES.map((c) => {
      const b = button(c.label, `${c.label}: ${c.title.toLowerCase()}`, () => this.applyCurve(c.curve));
      b.setAttribute("aria-label", c.label);
      return iconButton(b, c.icon, false);
    });
    this.bar = bar;
    // The animation is a loop: it ends on its first pose, and the closing frame is supplied (docs/LOOP-PLAN.md).
    const closedLabel = document.createElement("label");
    closedLabel.className = "closed-loop";
    closedLabel.title = "A closed loop: the animation ends on its first pose, so key it up to the last frame before the end and the closing frame (a copy of frame 0) is added when it is played or exported. Untick for an animation that does not loop.";
    this.closedBox = document.createElement("input");
    this.closedBox.type = "checkbox";
    this.closedBox.addEventListener("change", () => { const an = session.animation; if (an) session.setLoop(an.name, this.closedBox.checked); });
    closedLabel.append(this.closedBox, " Closed loop");
    this.trimBtn = button("Trim end", "This animation already ends on a copy of its first pose (frame 0 = the last frame): delete the copy, and let Closed loop supply it", () => this.trimEnd());
    this.trimBtn.hidden = true;
    bar.append(this.select, newBtn, ...this.animButtons, closedLabel, this.trimBtn, sep(), startBtn, this.playBtn, this.loopBtn, this.frameOut, sep(), this.keyBtn, sep(), ...this.curveButtons);

    this.body = document.createElement("div");
    this.body.className = "timeline-body";
    this.labels = document.createElement("div");
    this.labels.className = "timeline-labels";
    const track = document.createElement("div");
    track.className = "timeline-track";
    this.canvas = document.createElement("canvas");
    this.fitBtn = iconButton(button("Fit", "Fit the whole animation in the track", () => this.fit()), "fit", false);
    this.fitBtn.className = "tl-fit";
    track.append(this.fitBtn, this.canvas);
    const split = document.createElement("div");
    split.className = "timeline-split";
    split.title = "Drag to resize the names column";
    this.attachSplit(split);
    this.body.append(this.labels, track, split);
    this.body.addEventListener("scroll", () => this.redraw());
    // The track is as wide as the panel leaves it (and the names column): repaint when that changes.
    new ResizeObserver(() => this.redraw()).observe(track);
    this.element.append(bar, this.body);

    // The middle button drags the track; the browser's own middle-click autoscroll is off.
    this.canvas.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", (e) => this.up(e));
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    session.onChange(() => this.update());
    this.update();
  }

  /** Buttons the app puts at the bar's end (Auto Key, Onion): they act on what the timeline shows. */
  addTools(...buttons: HTMLElement[]): void {
    this.bar.append(sep(), ...buttons);
  }

  /** The panel's own layout back: the names column at its default width, the whole animation in the track. */
  resetLayout(): void {
    try { localStorage.removeItem("bb.timelineLabels"); } catch { /* storage blocked: nothing kept to remove */ }
    this.element.style.removeProperty("--tl-labels");
    this.body.scrollTop = 0;
    this.fit();
    this.redraw();
  }

  /** The names column's width: dragged at the splitter, kept in this browser. */
  private attachSplit(split: HTMLElement): void {
    const KEY = "bb.timelineLabels";
    const set = (px: number): void => {
      const max = Math.max(80, this.element.clientWidth - 160);
      this.element.style.setProperty("--tl-labels", `${Math.round(Math.min(max, Math.max(80, px)))}px`);
    };
    try {
      const saved = Number(localStorage.getItem(KEY));
      if (Number.isFinite(saved) && saved > 0) set(saved);
    } catch { /* storage blocked: the default width */ }
    let from: { x: number; width: number } | null = null;
    split.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      from = { x: e.clientX, width: this.labels.getBoundingClientRect().width };
      split.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    split.addEventListener("pointermove", (e) => {
      if (!from) return;
      set(from.width + (e.clientX - from.x));
      this.redraw();
    });
    const end = (): void => {
      if (!from) return;
      from = null;
      try { localStorage.setItem(KEY, String(parseInt(this.element.style.getPropertyValue("--tl-labels"), 10))); } catch { /* storage blocked: kept for this visit only */ }
    };
    split.addEventListener("pointerup", end);
    split.addEventListener("pointercancel", end);
  }

  /** Keys are selected, so Delete is the timeline's. */
  get hasSelection(): boolean { return this.selected.size > 0; }

  /** Select every key of the shown animation (⌘A). */
  selectAll(): void {
    const fps = this.session.fps;
    this.selected.clear();
    for (const ch of this.graphChannels()) for (const k of ch.keys) { const ref: KeyRef = { path: ch.path, time: keyTime(k) }; this.selected.set(refId(ref, fps), ref); }
    this.session.changed();
  }

  /** Copy the selected keys (⌘C); what it says. */
  copySelected(): string {
    const a = this.session.animation;
    if (!a || !this.selected.size) return `Select keys to copy (click, Shift-click, drag a box, or ${keysOf("selectAll")}).`;
    clipboard.keys = copyKeys(a, [...this.selected.values()], this.session.fps);
    return `Copied ${clipboard.keys.keys.length} key${clipboard.keys.keys.length === 1 ? "" : "s"}.`;
  }

  /** Paste the copied keys with the first at the playhead (⌘V), the pasted keys selected; what it says. */
  paste(): string {
    const a = this.session.animation, clip = clipboard.keys, doc = this.session.doc, fps = this.session.fps;
    if (!clip) return `Copy keys first (${keysOf("copyKeys")}).`;
    if (!a || !doc) return "Choose an animation to paste the keys into.";
    this.session.pause();
    const frame = this.session.frame, p = pasteKeys(a.name, clip, frame, fps), skipped = p.skipped(doc);
    if (!this.apply(`Paste ${clip.keys.length} key${clip.keys.length === 1 ? "" : "s"} at frame ${frame}`, p.edit)) return "";
    this.selected.clear();
    for (const k of clip.keys) {
      const ref: KeyRef = { path: k.path, time: frameTime(frame + k.offset, fps), ...(k.path.section === "events" ? { name: String(k.fields.name) } : {}) };
      this.selected.set(refId(ref, fps), ref);
    }
    this.session.changed();
    return `Pasted at frame ${frame}${skipped.length ? `; skipped (not in this rig): ${skipped.join(", ")}` : ""}.`;
  }

  /** Delete the closing keys of an animation that already ends on its first pose. */
  private trimEnd(): void {
    const s = this.session, a = s.animation, h = s.history;
    if (!a || !h) return;
    try {
      h.apply(`Trim the closing frame of ${a.name}`, trimClosingKeys(a.name));
      s.changed();
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
  }

  /** What the track's view is (zoom, first frame shown, rows' scroll), for the project's remembered view (ui/viewMemory.ts). */
  get memory(): TimelineMemory {
    return { frameWidth: this.view.frameWidth, first: this.view.first, scroll: this.body.scrollTop };
  }

  restoreMemory(m: TimelineMemory): void {
    if (!Number.isFinite(m.frameWidth) || !Number.isFinite(m.first)) return;
    this.view = { frameWidth: Math.min(MAX_FRAME_WIDTH, Math.max(MIN_FRAME_WIDTH, m.frameWidth)), first: Math.max(-0.5, m.first) };
    this.body.scrollTop = Number.isFinite(m.scroll) ? m.scroll : 0;
    this.redraw();
  }

  /** Zoom and scroll the track so the whole animation, from frame 0 to its end, fits the width. */
  fit(): void {
    const a = this.session.animation;
    if (!a) return;
    const width = Math.max(1, this.canvas.parentElement!.clientWidth), left = 12, right = 34;
    const end = Math.max(1, timeFrame(this.session.length(a), this.session.fps));
    const frameWidth = Math.min(MAX_FRAME_WIDTH, Math.max(MIN_FRAME_WIDTH, (width - left - right) / end));
    this.view = { frameWidth, first: -left / frameWidth };
    this.redraw();
  }

  togglePlay(): void {
    if (this.session.playing) { this.session.pause(); return; }
    if (!this.session.animation && !this.session.doc?.animations?.length) { this.onStatus("No animations yet: New… adds one."); return; }
    this.session.play();
  }

  deleteSelected(): void {
    const a = this.session.animation;
    if (!a || !this.selected.size) return;
    if (this.apply(`Delete ${this.selected.size} key${this.selected.size === 1 ? "" : "s"}`, deleteKeys(a.name, [...this.selected.values()]))) this.selected.clear();
  }

  /** Key what is selected at the playhead: an event fires there (E6 step 4b), a bone is keyed. */
  keySelected(): void {
    const a = this.session.animation, sel = this.session.selected;
    if (sel?.kind !== "event") { this.keySelectedBone(); return; }
    if (!a) { this.onStatus("Choose an animation to key the event in."); return; }
    this.session.pause();
    const time = this.session.keyTime;
    if ((a.events ?? []).some((k) => k.name === sel.name && Math.abs((k.time ?? 0) - time) <= 1e-5)) { this.onStatus(`${sel.name} already fires at frame ${this.session.frame}.`); return; }
    this.apply(`Key event ${sel.name} at frame ${this.session.frame}`, keyEvent(a.name, time, sel.name));
  }

  /** Key the selected bone's rotate, translate and scale at the playhead. */
  keySelectedBone(): void {
    const a = this.session.animation, bone = this.session.selectedBone, p = this.session.pose();
    if (!a || bone === null || !p) { this.onStatus("Choose an animation and select a bone to key it."); return; }
    const i = p.bones.get(bone);
    if (i === undefined) return;
    this.session.pause();
    this.apply(`Key ${bone} at frame ${this.session.frame}`, keyBone(a.name, bone, this.session.hasUnkeyed ? BONE_PROPERTIES : BONE_PROPERTIES.filter((x) => x !== "shear"), animatedLocal(p, i), this.session.keyTime));
    this.session.clearUnkeyed(bone);
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
    this.fitBtn.disabled = !a;
    this.closedBox.disabled = !a;
    this.closedBox.checked = a ? s.loopOf(a.name) : true;
    this.trimBtn.hidden = !(a && isSeamless(a, s.fps));
    for (const b of this.curveButtons) b.disabled = !a || !this.selected.size;
    this.keyBtn.disabled = !a || (s.selectedBone === null && s.selected?.kind !== "event");
    // Play is there in Pose mode too: it switches to Animate (the last animation, or the first) and plays.
    this.playBtn.disabled = !a && !doc?.animations?.length;
    setIcon(this.playBtn, s.playing ? "pause" : "play");
    this.playBtn.title = `${s.playing ? "Pause" : "Play"} (${keysOf("play")})`;
    this.playBtn.setAttribute("aria-label", this.playBtn.title);
    this.loopBtn.setAttribute("aria-pressed", String(s.loop));
    const end = a ? timeFrame(s.length(a), s.fps) : 0;
    this.frameOut.textContent = a ? `frame ${s.frame} / ${end} · ${s.fps} fps` : "";

    // Keys an undo or another edit took away leave the selection.
    const live = new Set(a ? keyLists(a).flatMap((l) => l.keys.map((k) => refId({ path: l.path, time: keyTime(k) }, s.fps))) : []);
    for (const id of [...this.selected.keys()]) if (!live.has(id)) this.selected.delete(id);
    // The labels are DOM: rebuilt only when the channels shown change, not every frame.
    const sig = `${this.graphChannels().map((c) => channelId(c)).join(",")}|${a?.name}|${s.selectedBone}|${!!doc}`;
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
    const chs = this.graphChannels();
    const head = document.createElement("div");
    head.className = "ruler-gap";
    const rows = chs.map((ch, i) => {
      const el = document.createElement("div");
      el.className = "row depth0 channel";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      // Inline: a swatch the size of the text's x-height, beside the label.
      Object.assign(swatch.style, { display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", marginRight: "6px", flex: "none", background: CHANNEL_COLOURS[i % CHANNEL_COLOURS.length]! });
      const name = document.createElement("span");
      name.textContent = ch.label;
      el.append(swatch, name);
      return el;
    });
    if (!rows.length) rows.push(Object.assign(document.createElement("p"), { className: "empty", textContent: "Select a bone (or a constraint) with keys to see its curves." }));
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
    const dpr = (view.devicePixelRatio || 1) * pageScale(this.canvas.ownerDocument);
    // The graph fills what is in view.
    const width = Math.max(1, parent.clientWidth), height = this.graphHeight();
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      c.style.height = `${height}px`;
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = view.getComputedStyle(this.element);
    const col = (n: string) => css.getPropertyValue(n).trim();
    // The graph's body in the graph colours (a theme like Hybrid gives it its own); the ruler and the playhead tag keep the theme's.
    const gc = graphColours(css);
    g.fillStyle = gc("--panel");
    g.fillRect(0, 0, width, height);
    const s = this.session, a = s.animation;
    if (!a) return;
    const v = this.view, fps = s.fps, end = timeFrame(s.length(a), fps);
    // Past the end, dimmed.
    const ex = frameX(v, end);
    if (ex < width) { g.fillStyle = gc("--bg"); g.globalAlpha = 0.5; g.fillRect(Math.max(0, ex), RULER, width, height); g.globalAlpha = 1; }
    // A closed loop's closing frame is not a key you edit: a dashed line where it falls, "= 0" under the ruler.
    if (s.loopOf(a.name) && end > timeFrame(animationDuration(a), fps)) {
      const sx = Math.round(ex) + 0.5;
      g.save();
      g.strokeStyle = gc("--muted");
      g.fillStyle = gc("--muted");
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(sx, RULER); g.lineTo(sx, height); g.stroke();
      g.setLineDash([]);
      g.font = `10px ${col("--font-mono")}`;
      g.textBaseline = "top";
      g.fillText("= 0", sx + 4, RULER + 3);
      g.restore();
    }
    // The ruler's frame lines run down through the graph.
    const step = labelStep(v.frameWidth);
    const firstFrame = Math.max(0, Math.floor(v.first)), lastFrame = Math.ceil(xFrame(v, width));
    g.strokeStyle = gc("--line");
    g.globalAlpha = 0.35;
    g.beginPath();
    for (let f = firstFrame; f <= lastFrame; f++) {
      if (f % step) continue;
      const x = Math.round(frameX(v, f)) + 0.5;
      g.moveTo(x, RULER); g.lineTo(x, height);
    }
    g.stroke();
    g.globalAlpha = 1;
    this.paintRuler(g, width, 0, col, step, firstFrame, lastFrame);
    this.paintGraph(g, width, height, gc);
    this.paintPlayheadBadge(g, width, 0, col);
  }

  /** Where the ruler is drawn: the top of what is in view (the rows scroll under it). */
  private rulerTop(): number { return 0; }

  /** Whether a y in the canvas is on the ruler as it is now drawn. */
  private inRuler(y: number): boolean {
    const t = this.rulerTop();
    return y >= t && y < t + RULER;
  }

  private paintRuler(g: CanvasRenderingContext2D, width: number, top: number, col: (n: string) => string, step: number, firstFrame: number, lastFrame: number): void {
    const v = this.view;
    g.save();
    g.translate(0, top);
    g.fillStyle = col("--bg");
    g.fillRect(0, 0, width, RULER);
    g.font = `11px ${col("--font-mono")}`;
    g.textBaseline = "middle";
    for (let f = firstFrame; f <= lastFrame; f++) {
      const x = Math.round(frameX(v, f)) + 0.5;
      const major = f % step === 0;
      if (!major && v.frameWidth < 5) continue;
      g.strokeStyle = col("--line");
      // A labelled tick runs the ruler's whole height; its number sits centred on it, in the upper part, with the tick cut behind it.
      g.beginPath(); g.moveTo(x, major ? 0 : 17); g.lineTo(x, RULER); g.stroke();
      if (major) {
        const label = String(f), w = Math.ceil(g.measureText(label).width) + 6;
        g.fillStyle = col("--bg");
        g.fillRect(Math.round(x - w / 2), 2, w, 14);
        g.fillStyle = col("--muted");
        g.textAlign = "center";
        g.fillText(label, x, 9.5);
        g.textAlign = "start";
      }
    }
    g.restore();
  }

  /** The playhead's frame number, in a green tag on the ruler. */
  private paintPlayheadBadge(g: CanvasRenderingContext2D, width: number, top: number, col: (n: string) => string): void {
    const s = this.session, label = String(Math.round(s.time * s.fps));
    g.save();
    g.font = `600 11px ${col("--font-mono")}`;
    g.textBaseline = "middle";
    g.textAlign = "center";
    const w = Math.ceil(g.measureText(label).width) + 10, h = BADGE_H;
    // On the same line as the ruler's own numbers (their middle is 9 px down).
    const x = Math.min(Math.max(Math.round(frameX(this.view, s.time * s.fps)) + 0.5, w / 2), width - w / 2), y = top + 9 - h / 2;
    g.fillStyle = PLAYHEAD;
    g.beginPath();
    g.roundRect(x - w / 2, y, w, h, 4);
    g.fill();
    g.fillStyle = "#ffffff";
    g.fillText(label, x, y + h / 2 + 0.5);
    this.tag = { x0: x - w / 2, x1: x + w / 2, y0: y, y1: y + h };
    // The time since the last key before it, beside the tag (docs: the owner's note); on the other side when it would run off the track.
    const since = s.animation ? secondsSinceLastKey(s.animation, s.frame, s.fps) : null;
    if (since !== null) {
      const text = `+${since.toFixed(2)}s`;
      g.font = `10px ${col("--font-mono")}`;
      g.fillStyle = col("--muted");
      const tw = g.measureText(text).width;
      if (x + w / 2 + 6 + tw <= width) { g.textAlign = "left"; g.fillText(text, x + w / 2 + 6, y + h / 2 + 0.5); }
      else { g.textAlign = "right"; g.fillText(text, x - w / 2 - 6, y + h / 2 + 0.5); }
    }
    g.restore();
  }

  /** The cursor over the track: a hand on the frame tag, a sideways arrow on the ruler (a press there scrubs). */
  private cursorAt(x: number, y: number): string {
    const t = this.tag;
    if (t && x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) return "grab";
    return this.inRuler(y) ? "ew-resize" : "";
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    return localPoint(this.canvas, e);
  }

  private down(e: PointerEvent): void {
    if (e.button === 1) {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.pan = { x: e.clientX, y: e.clientY, first: this.view.first, scroll: this.body.scrollTop };
      return;
    }
    const s = this.session, a = s.animation;
    if (!a || e.button !== 0) return;
    const [x, y] = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (!this.inRuler(y) && this.graphDown(x, y, e.shiftKey)) return;
    if (!this.inRuler(y)) { this.drag = { kind: "box", x0: x, y0: y, x1: x, y1: y, moved: false, add: e.shiftKey, base: new Map(this.selected) }; return; }
    this.drag = { kind: "scrub" };
    s.seek(xFrame(this.view, x));
  }

  private move(e: PointerEvent): void {
    if (this.pan) {
      const p = this.pan, scale = this.canvas.getBoundingClientRect().width / Math.max(1, this.canvas.clientWidth);
      this.view = { ...this.view, first: Math.max(-0.5, p.first - (e.clientX - p.x) / scale / this.view.frameWidth) };
      this.body.scrollTop = p.scroll - (e.clientY - p.y) / scale;
      this.redraw();
      return;
    }
    const d = this.drag, s = this.session, a = s.animation;
    if (this.graphDrag && a) { const [gx, gy] = this.local(e); this.graphMove(gx, gy); return; }
    if (!d || !a) {
      const [cx, cy] = this.local(e);
      this.canvas.style.cursor = this.cursorAt(cx, cy);
      return;
    }
    const [x, y] = this.local(e);
    if (d.kind === "scrub") { this.canvas.style.cursor = "grabbing"; s.seek(xFrame(this.view, x)); return; }
    if (d.kind === "box") {
      d.x1 = x; d.y1 = y;
      if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < BOX_SLOP) return;
      d.moved = true;
      this.boxSelect(d);
      return;
    }
  }

  private up(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.canvas.style.cursor = "";
    if (this.pan) { this.pan = null; return; }
    if (this.graphDrag) { this.graphDrag = null; this.graphFit = null; this.session.history?.end(); this.session.changed(); return; }
    const d = this.drag;
    // A click on empty track: the playhead goes there; without Shift the selection is cleared.
    if (d?.kind === "box" && !d.moved) {
      if (!d.add) this.selected.clear();
      this.session.seek(xFrame(this.view, d.x0));
    }
    this.drag = null;
    if (d?.kind === "box") this.redraw();
  }

  /** The keys of the shown channels inside the box, added to what was selected with Shift. */
  private boxSelect(d: Extract<Drag, { kind: "box" }>): void {
    const fps = this.session.fps, chs = this.graphChannels(), [top, bottom] = this.graphBand(this.graphHeight()), fit = this.graphFit ?? fitValues(chs);
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    this.selected.clear();
    if (d.add) for (const [k, v] of d.base) this.selected.set(k, v);
    for (const ch of chs) {
      for (const k of ch.keys) {
        const kx = frameX(this.view, keyTime(k) * fps), ky = valueY(fit, top, bottom, channelValues(ch.path, k, "start")[ch.c]!);
        if (kx < x0 || kx > x1 || ky < y0 || ky > y1) continue;
        const ref: KeyRef = { path: ch.path, time: keyTime(k) };
        this.selected.set(refId(ref, fps), ref);
      }
    }
    this.session.changed();
  }

  /** The channels the graph shows: the selected bone's or constraint's, else the selected keys' timelines. */
  private graphChannels(): Channel[] {
    const s = this.session, a = s.animation;
    if (!a) return [];
    const lists = keyLists(a), sel = s.selected;
    // The selected bone's or constraint's channels, whatever keys are picked; the picked keys' timelines when neither is selected.
    const picked = new Set([...this.selected.values()].map((r) => pathId(r.path)));
    const chosen = sel?.kind === "bone" ? lists.filter((l) => l.path.section === "bones" && l.path.owner === sel.name)
      : sel?.kind === "constraint" ? lists.filter((l) => l.path.section === sel.type && "owner" in l.path && l.path.owner === sel.name)
        : lists.filter((l) => picked.has(pathId(l.path)));
    // A bone's combined translate is FramePath's (docs/FRAMEPATH-SPEED-PLAN.md, step 7): edited in Motion Path, not on this graph.
    return channelsOf(chosen.filter((l) => !(l.path.section === "bones" && l.path.timeline === "translate")));
  }

  /** The selected bone's name when it has combined translate keys, which this graph leaves to Motion Path. */
  private translateLeftOut(): string | null {
    const s = this.session, a = s.animation, sel = s.selected;
    if (!a || sel?.kind !== "bone") return null;
    return keyLists(a).some((l) => l.path.section === "bones" && l.path.owner === sel.name && l.path.timeline === "translate" && l.keys.length) ? sel.name : null;
  }

  /** The graph's height: the timeline body as seen (it does not scroll in graph mode). */
  private graphHeight(): number {
    if (this.body.scrollTop) this.body.scrollTop = 0;
    return Math.max(RULER + TABS + 60, this.body.clientHeight);
  }

  /** The band the curves are drawn in. */
  private graphBand(height: number): [number, number] { return [RULER + TABS + 14, Math.max(RULER + TABS + 44, height - 10)]; }

  private paintGraph(g: CanvasRenderingContext2D, width: number, height: number, col: (n: string) => string): void {
    const fps = this.session.fps, v = this.view, chs = this.graphChannels(), [top, bottom] = this.graphBand(height);
    const fit = this.graphFit ?? fitValues(chs), y = (val: number) => valueY(fit, top, bottom, val), x = (t: number) => frameX(v, t * fps);
    this.paintTabs(g, chs, col);
    const away = this.translateLeftOut();
    if (away) {
      g.save();
      g.font = `11px ${col("--font-mono")}`;
      g.fillStyle = col("--muted");
      g.textBaseline = "top";
      g.fillText(`${away} · translate: edit it in FramePath`, 8, top - 10);
      g.restore();
    }
    // Zero, when it is in view.
    if (fit.min < 0 && fit.max > 0) { g.strokeStyle = col("--line"); g.beginPath(); g.moveTo(0, Math.round(y(0)) + 0.5); g.lineTo(width, Math.round(y(0)) + 0.5); g.stroke(); }
    chs.forEach((ch, n) => {
      const colour = CHANNEL_COLOURS[n % CHANNEL_COLOURS.length]!;
      const ivs = intervals(ch);
      g.globalAlpha = 1;
      g.strokeStyle = colour;
      g.lineWidth = 1.5;
      g.beginPath();
      if (!ivs.length && ch.keys.length) { const k = ch.keys[0]!, kv = channelValues(ch.path, k, "start")[ch.c]!; g.moveTo(x(keyTime(k)), y(kv)); g.lineTo(width, y(kv)); }
      for (const iv of ivs) {
        g.moveTo(x(iv.t0), y(iv.v0));
        if (iv.kind === "stepped") { g.lineTo(x(iv.t1), y(iv.v0)); g.lineTo(x(iv.t1), y(iv.v1)); }
        else if (iv.kind === "bezier") g.bezierCurveTo(x(iv.h[0]), y(iv.h[1]), x(iv.h[2]), y(iv.h[3]), x(iv.t1), y(iv.v1));
        else g.lineTo(x(iv.t1), y(iv.v1));
      }
      g.stroke();
      // Handles: thin lines from the keys, small rings; a straight interval's faint, at its thirds.
      g.lineWidth = 1;
      for (const iv of ivs) {
        if (iv.kind === "stepped") continue;
        g.globalAlpha = iv.kind === "bezier" ? 0.9 : 0.4;
        g.beginPath(); g.moveTo(x(iv.t0), y(iv.v0)); g.lineTo(x(iv.h[0]), y(iv.h[1])); g.moveTo(x(iv.t1), y(iv.v1)); g.lineTo(x(iv.h[2]), y(iv.h[3])); g.stroke();
        for (const [ht, hv] of [[iv.h[0], iv.h[1]], [iv.h[2], iv.h[3]]] as const) { g.beginPath(); g.arc(x(ht), y(hv), 3, 0, Math.PI * 2); g.stroke(); }
        g.globalAlpha = 1;
      }
      for (const k of ch.keys) {
        const kx = x(keyTime(k)), ky = y(channelValues(ch.path, k, "start")[ch.c]!), on = this.selected.has(refId({ path: ch.path, time: keyTime(k) }, this.session.fps));
        g.fillStyle = on ? "#ffffff" : colour;
        g.strokeStyle = colour;
        g.lineWidth = 2;
        g.beginPath(); g.rect(kx - (on ? 4.5 : 3.5), ky - (on ? 4.5 : 3.5), on ? 9 : 7, on ? 9 : 7); g.fill();
        if (on) g.stroke();
        g.lineWidth = 1;
      }
      g.globalAlpha = 1;
    });
    // The selection box.
    const d = this.drag, accent = col("--accent");
    if (d?.kind === "box" && d.moved) {
      g.strokeStyle = accent;
      g.fillStyle = accent;
      g.globalAlpha = 0.12;
      g.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.globalAlpha = 1;
      g.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    // Playhead.
    const px = Math.round(frameX(v, this.session.time * fps)) + 0.5;
    g.strokeStyle = PLAYHEAD;
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(px, BADGE_BOTTOM); g.lineTo(px, height); g.stroke();
    g.lineWidth = 1;
  }

  /**
   * The strip of tabs under the ruler: one between each two neighbouring key frames of the channels
   * shown, labelled with the time between them (frames, and seconds when there is room). A closed
   * loop's closing frame ends the last tab; the tab the playhead is in is lit.
   */
  private paintTabs(g: CanvasRenderingContext2D, chs: readonly Channel[], col: (n: string) => string): void {
    const s = this.session, a = s.animation, fps = s.fps, v = this.view;
    if (!a) return;
    const set = new Set<number>();
    for (const ch of chs) for (const k of ch.keys) set.add(timeFrame(keyTime(k), fps));
    const end = timeFrame(s.length(a), fps);
    if (set.size && end > Math.max(...set)) set.add(end);
    const frames = [...set].sort((p, q) => p - q);
    if (frames.length < 2) return;
    const y0 = RULER + 4, h = TABS - 8;
    g.save();
    g.font = `10px ${col("--font-mono")}`;
    g.textBaseline = "middle";
    g.textAlign = "center";
    for (let i = 0; i + 1 < frames.length; i++) {
      const f0 = frames[i]!, f1 = frames[i + 1]!, x0 = frameX(v, f0) + 1.5, x1 = frameX(v, f1) - 1.5;
      if (x1 < 0 || x0 > this.canvas.clientWidth || x1 - x0 < 3) continue;
      const here = s.frame >= f0 && s.frame < f1;
      g.fillStyle = here ? col("--accent") : col("--hover");
      g.globalAlpha = here ? 0.35 : 1;
      g.beginPath(); g.roundRect(x0, y0, x1 - x0, h, 3); g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = here ? col("--accent") : col("--line");
      g.lineWidth = 1;
      g.beginPath(); g.roundRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, h - 1, 3); g.stroke();
      const d = f1 - f0, long = `${d}f · ${(d / fps).toFixed(2)}s`, short = `${d}f`, num = String(d);
      const room = x1 - x0 - 6;
      const text = g.measureText(long).width <= room ? long : g.measureText(short).width <= room ? short : g.measureText(num).width <= room ? num : "";
      if (text) { g.fillStyle = col("--text"); g.fillText(text, (x0 + x1) / 2, y0 + h / 2 + 0.5); }
      g.lineWidth = 1;
    }
    g.restore();
  }

  /** A press on the graph: on a handle or a key, a drag begins (one undo step); false when on neither. */
  private graphDown(px: number, py: number, shift: boolean): boolean {
    const s = this.session, fps = s.fps, chs = this.graphChannels(), height = this.graphHeight();
    const [top, bottom] = this.graphBand(height), fit = fitValues(chs);
    const x = (t: number) => frameX(this.view, t * fps), y = (v: number) => valueY(fit, top, bottom, v), near = (a: number, b: number) => Math.hypot(a - px, b - py) <= 6;
    for (const ch of chs) {
      for (const iv of intervals(ch)) {
        if (iv.kind === "stepped") continue;
        for (const which of [0, 1] as const) {
          if (!near(x(iv.h[which * 2]!), y(iv.h[which * 2 + 1]!))) continue;
          this.graphFit = fit;
          this.graphDrag = { kind: "handle", id: channelId(ch), at: iv.t0, which };
          s.pause();
          s.history?.begin(`Shape ${ch.label} after frame ${timeFrame(iv.t0, fps)}`);
          return true;
        }
      }
    }
    for (const ch of chs) {
      for (const k of ch.keys) {
        if (!near(x(keyTime(k)), y(channelValues(ch.path, k, "start")[ch.c]!))) continue;
        // The key is selected (Shift adds it to the others, or takes it out), so the curve buttons, Delete and Copy have it.
        const ref: KeyRef = { path: ch.path, time: keyTime(k) }, id = refId(ref, fps);
        if (shift) { if (this.selected.has(id)) this.selected.delete(id); else this.selected.set(id, ref); }
        else if (!this.selected.has(id)) { this.selected.clear(); this.selected.set(id, ref); }
        this.graphFit = fit;
        this.graphDrag = { kind: "key", id: channelId(ch), time: keyTime(k), from: timeFrame(keyTime(k), fps), applied: 0 };
        s.pause();
        s.history?.begin(`Move ${ch.label} key at frame ${timeFrame(keyTime(k), fps)}`);
        return true;
      }
    }
    return false;
  }

  /** One step of a graph drag: a handle reshapes its interval; a key takes the value under the pointer and moves by whole frames. */
  private graphMove(px: number, py: number): void {
    const d = this.graphDrag!, s = this.session, a = s.animation!, fps = s.fps, h = s.history!;
    const ch = this.graphChannels().find((c) => channelId(c) === d.id);
    if (!ch || !this.graphFit) return;
    const [top, bottom] = this.graphBand(this.graphHeight());
    const value = yValue(this.graphFit, top, bottom, py), time = xFrame(this.view, px) / fps;
    try {
      if (d.kind === "handle") {
        const iv = intervals(ch).find((i) => sameTime(i.t0, d.at));
        if (!iv) return;
        const hs: [number, number, number, number] = d.which === 0 ? [time, value, iv.h[2], iv.h[3]] : [iv.h[0], iv.h[1], time, value];
        h.apply("step", setChannelCurve(a.name, { path: ch.path, time: d.at }, ch.c, hs));
      } else {
        const field = channelField(ch.path, ch.c);
        if (field) h.apply("step", setKey(a.name, ch.path, d.time, { [field]: Math.round(value * 1000) / 1000 }));
        const by = Math.round(xFrame(this.view, px)) - d.from;
        if (by !== d.applied) {
          h.apply("step", moveKeys(a.name, [{ path: ch.path, time: d.time }], by - d.applied, fps));
          d.applied = by;
          d.time = frameTime(d.from + by, fps);
        }
      }
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
    s.changed();
  }

  private wheel(e: WheelEvent): void {
    const [x, y] = this.local(e);
    // Over the ruler a plain scroll zooms with the left edge pinned (gently: a mouse notch is ~100); Ctrl or Cmd zooms anywhere, around the pointer.
    const onRuler = this.inRuler(y) && Math.abs(e.deltaY) >= Math.abs(e.deltaX) && !e.shiftKey;
    const pinned = onRuler && !e.ctrlKey && !e.metaKey;
    if (e.ctrlKey || e.metaKey || onRuler) {
      e.preventDefault();
      const at = xFrame(this.view, x), frameWidth = Math.min(MAX_FRAME_WIDTH, Math.max(MIN_FRAME_WIDTH, this.view.frameWidth * Math.exp(-e.deltaY * (pinned ? 0.003 : 0.01))));
      this.view = { frameWidth, first: pinned ? this.view.first : at - x / frameWidth };
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      this.view = { ...this.view, first: Math.max(-0.5, this.view.first + dx / this.view.frameWidth) };
    } else return;
    this.redraw();
  }
}

/** The graph's channel colours, in order. */
const CHANNEL_COLOURS = ["#e5484d", "#30a46c", "#3e63dd", "#f76b15", "#8e4ec6", "#12a594", "#d6409f"];

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
