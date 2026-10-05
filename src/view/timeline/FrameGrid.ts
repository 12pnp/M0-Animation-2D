import { h, on, raf } from "@/view/widgets/dom";
import { FRAME_WIDTH_MAX, FRAME_WIDTH_MIN, anchoredScroll, fitFrameWidth, playheadLabel, steppedFrameWidth } from "./zoom";
import type { Store } from "@/app/Store";
import type { Animation, DeformKey, DrawOrderKey, EventKey, IkKey, InheritKey, Layer, Node, SequenceKey, TcKey, Track } from "@/core/doc/types";
import { moveKeys } from "@/core/doc/sequence";
import { moveTcKeys } from "@/core/doc/transformKeys";
import { deformKeysOf, moveDeformKeys } from "@/core/mesh/deform";
import { deformRow } from "@/core/mesh/meshPlan";
import { ikDragAxis, ikPoseAt, moveIkKeys, withIkKey, withIkMixDragged } from "@/core/doc/ikKeys";
import { moveDrawOrderKeys } from "@/core/doc/drawOrder";
import { eventFrames, moveEventKeys } from "@/core/doc/events";
import type { CnId, IkId, NodeId, TcId } from "@/core/doc/ids";
import { describeFrame, ensureTrack } from "@/app/TimelineOps";
import { keyIndexAt, MAX_FRAMES, spanIndexAt } from "@/core/doc/timeline";
import { easeTag } from "@/core/math/easing";
import type { LayerRow } from "@/core/doc/layerTree";
import { timelineRows } from "./rows";
import { moveChannelKeys, propertyKeys, type TimelineProp } from "@/core/doc/propertyKeys";

/** The Draw order row's keys. */
const DRAW_ORDER_COLOR = "#7fa8ff";
/** Deform rows' keys. */
const DEFORM_COLOR = "#4fd1c5";
const SEQUENCE_COLOR = "#f6ad55";
/** Transform constraint rows' keys. */
const TC_COLOR = "#c792ea";
/** Inherit rows' keys. */
const INHERIT_COLOR = "#9ad0ff";
/** Physics, slider and path constraint rows' keys. */
const CONSTRAINT_KEY_COLOR = "#e0a0ff";

/** The rows of whole-frame keys that are not transforms. */
type KeyRowKind = "deform" | "sequence" | "inherit" | "constraint";
function keyRowKind(row: { deform?: true; sequence?: true; inherit?: true; cn?: CnId } | undefined): KeyRowKind | null {
  return row?.deform ? "deform" : row?.sequence ? "sequence" : row?.inherit ? "inherit" : row?.cn ? "constraint" : null;
}
type KeySel = { node: NodeId; frames: number[]; sequence?: true; inherit?: true; cn?: CnId };
function selKind(sel: KeySel): KeyRowKind {
  return sel.sequence ? "sequence" : sel.inherit ? "inherit" : sel.cn ? "constraint" : "deform";
}
function selFlag(kind: KeyRowKind, cn?: CnId): { sequence?: true; inherit?: true; cn?: CnId } {
  return kind === "sequence" ? { sequence: true } : kind === "inherit" ? { inherit: true } : kind === "constraint" ? { cn } : {};
}
/** The picked keys when they are on this row. */
function picked(sel: KeySel | null, node: NodeId, kind: KeyRowKind, cn?: CnId): number[] {
  return sel?.node === node && selKind(sel) === kind && sel.cn === cn ? sel.frames : [];
}
/** A constraint row's diamonds: a frame any channel keys, with that key's tween. */
function constraintRowKeys(anim: Animation | null | undefined, cn: CnId): Array<{ frame: number; tween?: { kind: string } }> {
  const channels = Object.values(anim?.constraintKeys?.[cn] ?? {});
  return constraintKeyFrames(anim, cn).map((frame) => ({ frame, tween: channels.flatMap((keys) => keys.filter((k) => k.frame === frame))[0]?.tween }));
}

/** The Events row's flags. */
const EVENT_COLOR = "#ffb35c";

/** The property rows' key colours: Spine's, green rotate, blue translate,
 *  red scale, yellow shear. */
const PROP_COLORS: Record<TimelineProp, string> = {
  rotate: "#5fd35f", x: "#4fb3ff", y: "#4fb3ff", scale: "#ff6b6b", shear: "#f0c94a",
};
import { withAlpha } from "@/view/viewport/overlayColors";
import { DEFAULT_PREFS, PLAYHEAD_DEFAULT } from "@/core/prefs/prefs";
import { uiFont, type UiFontSize, uiPx } from "@/core/prefs/fonts";
import { dragMarkers, type MarkerDrag, type OnionSpan, wrapSpan } from "@/core/doc/onion";
import { SEAM_TOLERANCE, type SeamGap, seamFrame, seamGap } from "@/core/doc/cycle";
import { posedSymbol } from "@/core/spine/spinePose";
import { eventSounds, peakBetween, type Waveform } from "@/core/doc/waveform";
import { constraintKeyFrames, moveConstraintKeys } from "@/core/doc/constraintKeys";

/** The unscaled row and ruler heights. The layer list is DOM and the grid is
 *  canvas, so the same two numbers have to reach both — see `TimelinePanel`. */
export const ROW_HEIGHT = 20;
export const HEADER_HEIGHT = 22;

export interface FrameGridCallbacks {
  onScrub(frame: number): void;
  onSelectCell(layerIndex: number, frame: number, additive: boolean): void;
  /**
   * A rectangle of cells, from a drag or a shift-click: rows `rowFrom..rowTo`
   * over frames `from..to`, both inclusive.
   */
  onSelectRange(rowFrom: number, rowTo: number, from: number, to: number): void;
  onMoveKeyframes(nodeId: NodeId, from: number, to: number, delta: number, base?: Track): void;
  /** A property row's edit: the bone's track as it is to be. `kind` merges
   *  the steps of one drag into one undo. */
  onEditTrack(nodeId: NodeId, track: Track, label: string, kind?: string): void;
  /** The Draw order row's edit: the animation's keys as they are to be. */
  onEditDrawOrder(keys: DrawOrderKey[], label: string, kind?: string): void;
  /** Right-click on the Draw order row. */
  onDrawOrderMenu(frame: number, x: number, y: number): void;
  /** The Events row's edit: the animation's event keys as they are to be. */
  onEditEvents(keys: EventKey[], label: string, kind?: string): void;
  /** Right-click on the Events row. */
  onEventsMenu(frame: number, x: number, y: number): void;
  /** An event sound's decoded waveform, or null while it is not ready. */
  waveform?(path: string): Waveform | null;
  /** A Deform row's edit: the mesh's deform keys as they are to be. */
  onEditDeform(nodeId: NodeId, keys: DeformKey[], label: string, kind?: string): void;
  /** A Sequence row's edit: the node's sequence keys as they are to be. */
  onEditSequence(nodeId: NodeId, keys: SequenceKey[], label: string, kind?: string): void;
  /** An Inherit row's edit: the bone's inherit keys as they are to be. */
  onEditInherit(nodeId: NodeId, keys: InheritKey[], label: string, kind?: string): void;
  /** A constraint row's edit: the animation's physics, slider and path keys as they are to be. */
  onEditConstraintKeys(keys: Animation["constraintKeys"], label: string, kind?: string): void;
  /** A transform constraint row's edit: its keys as they are to be. */
  onEditTc(tc: TcId, keys: TcKey[], label: string, kind?: string): void;
  /** An IK row's edit: the constraint's keys as they are to be. */
  onEditIk(ik: IkId, keys: IkKey[], label: string, kind?: string): void;
  /** A frame selection dragged somewhere else: its top-left cell lands on
   *  `row`/`frame`. `copy` is ⌥ held at the release. */
  onDragFrames(row: number, frame: number, copy: boolean): void;
  onDragSpanEnd(nodeId: NodeId, endFrame: number): void;
  onBeginInteraction(kind: string): void;
  onEndInteraction(): void;
  onContextMenu(layerIndex: number, frame: number, x: number, y: number): void;
  /** Right-click on the ruler: frame operations that span every layer. */
  onRulerContextMenu(frame: number, x: number, y: number): void;
  /** A vertical wheel over the grid. The layer list owns the only vertical
   *  scroll in the panel, so the grid forwards rather than scrolling itself. */
  onWheelY(delta: number): void;
  /** The drawn geometry changed — `contentWidth` or `scrollX`. The horizontal
   *  scrollbar is a sibling element, so it has to be told; it used to be
   *  refreshed only on store events, and the zoom slider emits none. */
  onGeometry(): void;
}

/** A rectangle of cells: visible rows `top..bottom` over frames `from..to`. */
interface FrameRect { top: number; bottom: number; from: number; to: number }

/** The frame grid's palette. A value rather than a constant so the
 *  Preferences dialog can recolour the playhead, tweens and the selection —
 *  the three things a user squints at on a long timeline. */
const DEFAULT_GRID_COLORS = {
  headerBg: "#3c3c3c",
  headerAlt: "#464646",
  headerLine: "#2a2a2a",
  tick: "#8a8a8a",
  text: "#a8a8a8",
  /** The empty cell, and every fifth one a shade darker. The grid of little
   *  rectangles IS the ruler down in the rows: it is what makes a frame
   *  countable without reading the header.
   *
   *  ONE pair, for every empty cell on every row. Lighting the cells inside
   *  the animation's length and dimming the rest made a row's empty frames
   *  change tone under a neighbouring layer that happened to reach further —
   *  the length is a property of the animation, not of the cell, and the end
   *  mark on each track already says where a layer stops. */
  cell: "#464646",
  cellAlt: "#414141",
  /** Behind the cells, and the whole area below the last layer. */
  bodyBg: "#383838",
  /** The line down the left of a keyframe, and the end of a span. */
  spanEdge: "rgba(0,0,0,0.55)",
  occupied: "#6e6e6e",
  blank: "#4a4a4a",
  tween: "#7a7fb0",
  tweenLine: "#c2c6ec",
  /** A key's outline (the Timeline preference) and its fill: a light diamond
   *  outlined dark reads on a tween, a static span and an empty cell alike. */
  keyDot: "#161616",
  keyRing: "#161616",
  keyFill: "#ececec",
  endMark: "#161616",
  playhead: PLAYHEAD_DEFAULT,
  /** A cycle's join, and the rows whose pose there is not frame 0's. */
  loop: "#5fb3d9",
  seamWarn: "#e8a33d",
  selected: DEFAULT_PREFS.timeline.selected,
  rowLine: "rgba(0,0,0,0.22)",
  currentRow: "rgba(255,255,255,0.045)",
  group: "#585858",
  emptyRow: "#565656",
  excluded: "rgba(0,0,0,0.30)",
};

/** Wheel pixels per zoom step: one notch of a mouse wheel. */
const WHEEL_STEP = 100;

/**
 * The frame grid, drawn on a canvas.
 *
 * DOM rows would be tens of thousands of elements for a long animation with
 * many layers; a canvas draws only what is on screen and keeps scrubbing
 * smooth. The layer list beside it stays DOM, because those rows are few and
 * need real inputs and drag targets.
 */
export class FrameGrid {
  /** The palette in force. Rebuilt when the preferences change, not per draw. */
  private C = { ...DEFAULT_GRID_COLORS };

  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  frameWidth = 12;
  /** Kept in step with the layer list beside it: both come from the UI text
   *  scale, and one row of names that does not line up with its strip of
   *  frames is the first thing that breaks. */
  rowHeight = 20;
  headerHeight = 22;
  private fontSize: UiFontSize = "small";
  /**
   * Reserved strip along the bottom. The horizontal scrollbar is an overlay
   * inside this element, so without it the last row is drawn underneath the
   * bar and its pointer events go to the bar instead of the grid.
   */
  bottomGutter = 14;
  scrollX = 0;
  scrollY = 0;
  /** Seam gaps by node, for the document revision they were measured at. */
  private seam: { key: string; gaps: Map<NodeId, SeamGap> } | null = null;
  /** Where a frame drag currently points; drawn, not applied, until release. */
  private drop: FrameRect | null = null;

  readonly invalidate: () => void;

  constructor(
    private readonly store: Store,
    private readonly cb: FrameGridCallbacks,
  ) {
    this.canvas = h("canvas");
    this.el = h("div", { class: "tl-frames" }, this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.invalidate = raf(() => this.draw());
    this.applyPrefs();
    store.prefs.subscribe(() => { this.applyPrefs(); this.invalidate(); });

    new ResizeObserver(() => this.resize()).observe(this.el);
    this.resize();
    this.wireInput();
  }

  private applyPrefs(): void {
    const t = this.store.prefs.value.timeline;
    this.frameWidth = t.frameWidth;
    this.fontSize = this.store.prefs.value.interface.fontSize;
    this.rowHeight = uiPx(ROW_HEIGHT, this.fontSize);
    this.headerHeight = uiPx(HEADER_HEIGHT, this.fontSize);
    this.C = {
      ...DEFAULT_GRID_COLORS,
      playhead: t.playhead,
      tween: t.tween,
      selected: t.selected,
      keyDot: t.keyframe,
      keyRing: t.keyframe,
      endMark: t.keyframe,
    };
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.invalidate();
  }

  get viewWidth(): number { return this.el.clientWidth; }
  get viewHeight(): number {
    return this.el.clientHeight - this.bodyTop - this.bottomGutter;
  }
  /** The Draw order row, under the ruler: one row tall while an animation is open. */
  /** The Draw order and Events rows under the ruler. */
  get stripHeight(): number { return this.store.currentAnimation ? this.rowHeight * 2 : 0; }
  /** The Events row's top: under the Draw order row. */
  private get eventsTop(): number { return this.headerHeight + this.rowHeight; }
  /** Where the layer rows start: below the ruler and the Draw order row. */
  get bodyTop(): number { return this.headerHeight + this.stripHeight; }
  /** Bottom of the drawable row area, above the scrollbar strip. */
  private get bodyBottom(): number {
    return Math.max(this.headerHeight, this.el.clientHeight - this.bottomGutter);
  }

  /** How far the grid can be scrolled, in pixels. */
  get contentWidth(): number {
    // The frames past the end of the animation are not padding: the ruler
    // numbers them, the playhead can be parked on one, and F5/F6 out there is
    // how a timeline is made longer. So there is always a full viewport of
    // them to scroll into, and the reach follows the playhead — parking it at
    // 400 leaves room to keep going rather than stopping dead at 401.
    const duration = this.store.currentAnimation?.duration ?? 1;
    const reach = Math.max(duration, this.store.ui.frame + 1);
    const slack = Math.max(this.viewWidth, this.frameWidth * 24);
    const frames = Math.min(MAX_FRAMES, reach + Math.ceil(slack / this.frameWidth));
    return frames * this.frameWidth;
  }

  /** The rows currently on screen, matching the layer column exactly. */
  visibleRows(): LayerRow[] {
    return timelineRows(this.store);
  }

  frameAtX(x: number): number {
    const f = Math.floor((x + this.scrollX) / this.frameWidth);
    return Math.max(0, Math.min(MAX_FRAMES - 1, f));
  }
  xOfFrame(frame: number): number {
    return frame * this.frameWidth - this.scrollX;
  }
  rowAtY(y: number): number {
    if (y >= this.bodyBottom) return -1;      // the scrollbar strip, not a row
    return Math.floor((y - this.bodyTop + this.scrollY) / this.rowHeight);
  }

  // ── Drawing ────────────────────────────────────────────────────────────

  private draw(): void {
    const ctx = this.ctx;
    const w = this.el.clientWidth;
    const h = this.bodyBottom;
    if (w <= 0 || this.el.clientHeight <= 0) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, this.el.clientHeight);

    const anim = this.store.currentAnimation;
    const duration = anim?.duration ?? 1;
    const fps = this.store.project.frameRate;
    // The grid must show exactly the rows the layer column shows, collapsed
    // groups included, or the two panes drift apart by a row.
    const rows = timelineRows(this.store);

    // The visible range, NOT the animation's: the ruler is numbered and the
    // cells are drawn all the way out to `MAX_FRAMES`, so the playhead can be
    // put on a frame past the end and given content there. Stopping at
    // `duration` left the grid finishing at frame 16 with nothing to click.
    const first = Math.max(0, Math.floor(this.scrollX / this.frameWidth));
    const last = Math.min(MAX_FRAMES - 1, first + Math.ceil(w / this.frameWidth) + 1);

    this.drawBody(ctx, rows, first, last, w, h, duration);
    this.drawOrderStrip(ctx, first, last, w);
    this.eventStrip(ctx, first, last, w);
    this.drawHeader(ctx, first, last, w, fps);
    this.drawSeam(ctx, rows, h);
    this.drawOnionMarkers(ctx);
    this.drawPlayhead(ctx, h);

    // Every route that changes the geometry ends here — the zoom slider, a
    // ctrl-wheel, `revealFrame`, a longer animation — so this is the one
    // place the scrollbar can be kept in step without each of them
    // remembering to.
    this.cb.onGeometry();
  }

  private drawHeader(
    ctx: CanvasRenderingContext2D, first: number, last: number,
    w: number, fps: number,
  ): void {
    const H = this.headerHeight;
    ctx.fillStyle = this.C.headerBg;
    ctx.fillRect(0, 0, w, H);

    // A lighter band each second, the way Animate marks time. Across the
    // whole visible strip, not just the animation, so the seconds keep
    // counting out into the empty frames.
    if (fps > 0) {
      ctx.fillStyle = this.C.headerAlt;
      const start = Math.floor(first / fps) * fps;
      for (let f = start; f <= last; f += fps) {
        if (Math.floor(f / fps) % 2 !== 0) continue;
        ctx.fillRect(this.xOfFrame(f), 0, fps * this.frameWidth, H);
      }
    }

    ctx.font = uiFont(9, this.fontSize);
    ctx.textBaseline = "middle";
    ctx.strokeStyle = this.C.tick;
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Two passes, because the two kinds of label are on different rhythms —
    // seconds every `fps` frames, numbers every `step` — and out at frame
    // 15900 a five-digit number is wide enough to land on top of the "662s"
    // one frame along. The seconds go down first and the numbers give way to
    // them: the second is the coarser mark and the one that orients you.
    // The playhead's number takes its place first: the ruler's own labels
    // give way to it, as in Spine.
    const mark = this.playheadMark(ctx);
    const taken: Array<[number, number]> = [[mark.left, mark.left + mark.width]];
    ctx.font = uiFont(9, this.fontSize);
    const label = (f: number, text: string, second: boolean): void => {
      const x = this.xOfFrame(f);
      const left = x + 3;
      const right = left + ctx.measureText(text).width;
      if (taken.some(([a, b]) => left < b + 3 && right + 3 > a)) return;
      taken.push([left, right]);
      ctx.moveTo(Math.round(x) + 0.5, H - 5);
      ctx.lineTo(Math.round(x) + 0.5, H - 1);
      ctx.fillStyle = second ? "#e0e0e0" : this.C.text;
      ctx.fillText(text, left, H / 2 - 1);
    };

    if (fps > 0) {
      const start = Math.max(fps, Math.ceil(first / fps) * fps);
      for (let f = start; f <= last; f += fps) label(f, `${f / fps}s`, true);
    }

    // Labels land on the DISPLAYED number, which is 1-based: 1, then 5, 10,
    // 15. Stepping over the internal index instead would print 1, 6, 11.
    const step = this.frameWidth >= 10 ? 5 : this.frameWidth >= 5 ? 10 : 20;
    for (let f = first; f <= last; f++) {
      const shown = f + 1;
      if (f !== 0 && shown % step !== 0) continue;
      label(f, String(shown), false);
    }
    ctx.stroke();

    ctx.strokeStyle = this.C.headerLine;
    ctx.beginPath();
    ctx.moveTo(0, H - 0.5);
    ctx.lineTo(w, H - 0.5);
    ctx.stroke();
  }

  /**
   * Rows whose pose at a cycle's join is not frame 0's (`seamGap`, each node
   * in its parent's frame, so the warning is on the row the gap starts at).
   * Posing two frames is cheap but not free, so it is measured once per
   * document revision, not on every playhead move.
   */
  seamGaps(): Map<NodeId, SeamGap> {
    const anim = this.store.currentAnimation;
    const join = anim ? seamFrame(anim) : null;
    if (!anim || join === null) return new Map();
    const key = `${this.store.history.revision}|${this.store.currentSymbolId}|${anim.id}`;
    if (this.seam?.key !== key) {
      const { project } = this.store;
      const sym = this.store.currentSymbol;
      const gaps = seamGap(
        posedSymbol(project, sym, anim, 0, "animate"), posedSymbol(project, sym, anim, join, "animate"),
        SEAM_TOLERANCE, true);
      this.seam = { key, gaps: new Map(gaps.map((g) => [g.nodeId, g])) };
    }
    return this.seam.gaps;
  }

  /** A cycle's join: a ↻ over its column in the ruler, a thin line down the
   *  rows, and a dot in the join cell of each row that does not close. */
  private drawSeam(ctx: CanvasRenderingContext2D, rows: LayerRow[], h: number): void {
    const anim = this.store.currentAnimation;
    const join = anim ? seamFrame(anim) : null;
    if (join === null) return;
    const fw = this.frameWidth;
    const x = Math.round(this.xOfFrame(join));
    if (x + fw < 0 || x > this.el.clientWidth) return;
    const H = this.headerHeight;

    ctx.fillStyle = withAlpha(this.C.loop, 0.25);
    ctx.fillRect(x, 0, fw - 1, H - 1);
    ctx.font = uiFont(10, this.fontSize);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.C.loop;
    ctx.fillText("↻", x + (fw - 1) / 2, H / 2);
    ctx.textAlign = "left";

    const top = this.bodyTop;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.el.clientWidth, h - top);
    ctx.clip();
    ctx.fillStyle = withAlpha(this.C.loop, 0.6);
    ctx.fillRect(x + fw - 2, top, 1, Math.min(h, top + rows.length * this.rowHeight - this.scrollY) - top);
    const gaps = this.seamGaps();
    ctx.fillStyle = this.C.seamWarn;
    for (let i = 0; i < rows.length; i++) {
      if (!gaps.has(rows[i]!.layer.nodeId)) continue;
      const y = top + i * this.rowHeight - this.scrollY;
      ctx.beginPath();
      ctx.arc(x + (fw - 1) / 2, y + 5, Math.min(3, fw / 3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** What the seam dot under the pointer means, or "". */
  private seamTitle(clientX: number, clientY: number): string {
    const anim = this.store.currentAnimation;
    const join = anim ? seamFrame(anim) : null;
    if (join === null) return "";
    const r = this.el.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    if (this.frameAtX(x) !== join) return "";
    if (y < this.headerHeight) return `Frame ${join + 1} is the loop's join: it shows frame 1 again.`;
    const row = timelineRows(this.store)[this.rowAtY(y)];
    const g = row && this.seamGaps().get(row.layer.nodeId);
    if (!g) return "";
    const parts: string[] = [];
    if (g.distance > SEAM_TOLERANCE.px) parts.push(`${g.distance.toFixed(1)} px`);
    if (Math.abs(g.rotation) > SEAM_TOLERANCE.deg) parts.push(`${g.rotation.toFixed(1)}°`);
    if (g.scale > SEAM_TOLERANCE.scale) parts.push(`scale ${g.scale.toFixed(3)}`);
    if (g.color) parts.push("colour");
    if (g.display) parts.push("image");
    return `Does not match frame 1 (${parts.join(", ")}). Close Loop keys frame 1's pose here.`;
  }

  /** The markers are shown whenever something reads them: the onion skin,
   *  or Edit Multiple Frames. */
  private get markersShown(): boolean {
    const ui = this.store.ui;
    return (ui.onionSkin || ui.editMultipleFrames) && ui.mode === "animate" && !!this.store.currentAnimation;
  }

  /**
   * Animate's onion markers: a band over the ruler from the start marker to
   * the end one, with a bracket at each end in the past and future colours.
   * An anchored range gets a solid knob on each bracket, a following one a
   * hollow knob — the one thing that says whether the range will move with
   * the playhead.
   */
  private drawOnionMarkers(ctx: CanvasRenderingContext2D): void {
    if (!this.markersShown) return;
    const o = this.store.prefs.value.timeline;
    const H = this.headerHeight;
    const top = 1.5, bottom = H - 2.5;
    const pieces = this.markerPieces();
    const xs = pieces.map((p) => [Math.round(this.xOfFrame(p.start)) + 0.5, Math.round(this.xOfFrame(p.end + 1)) - 0.5] as const);

    ctx.fillStyle = "rgba(255,255,255,0.13)";
    for (const [x0, x1] of xs) ctx.fillRect(x0, top, x1 - x0, bottom - top);

    const anchored = !!this.store.ui.onionAnchor;
    const bracket = (x: number, dir: 1 | -1, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + dir * 3, top);
      ctx.lineTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineTo(x + dir * 3, bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, H / 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = anchored ? color : this.C.headerBg;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    bracket(xs[0]![0], 1, o.onionPastColor);
    bracket(xs[xs.length - 1]![1], -1, o.onionFutureColor);
  }

  /** The markers' span as drawn: one band, or two when a cycle's onion skin
   *  runs across the join (`wrapSpan`). The start bracket is on the first,
   *  the end bracket on the last. */
  private markerPieces(): OnionSpan[] {
    const span = this.store.onionSpan;
    const period = this.store.onionPeriod;
    return period ? wrapSpan(span, period) : [span];
  }

  /** Which marker a press on the ruler at `x` grabs, if any. */
  private markerAt(x: number, e: PointerEvent): MarkerDrag | null {
    if (!this.markersShown) return null;
    const pieces = this.markerPieces();
    const x0 = this.xOfFrame(pieces[0]!.start);
    const x1 = this.xOfFrame(pieces[pieces.length - 1]!.end + 1);
    const near = (a: number) => Math.abs(x - a) <= 5;
    if (e.shiftKey && pieces.some((p) => x >= this.xOfFrame(p.start) - 5 && x <= this.xOfFrame(p.end + 1) + 5)) return "range";
    const which: MarkerDrag | null = near(x0) ? "start" : near(x1) ? "end" : null;
    if (!which) return null;
    return e.metaKey || e.ctrlKey ? "both" : which;
  }

  private beginMarkerDrag(e: PointerEvent, which: MarkerDrag): void {
    this.el.setPointerCapture(e.pointerId);
    const base = this.store.onionSpan;
    const startX = e.clientX;
    const maxFrame = this.store.maxFrame;
    // A following range must keep the playhead inside it: what it stores is
    // two distances from it.
    const playhead = this.store.ui.onionAnchor ? undefined : this.store.ui.frame;
    const period = this.store.onionPeriod;
    let last = 0;
    const move = (m: PointerEvent) => {
      const delta = Math.round((m.clientX - startX) / this.frameWidth);
      if (delta === last) return;
      last = delta;
      this.store.setOnionSpan(dragMarkers(base, which, delta, maxFrame, playhead, period));
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  private drawBody(
    ctx: CanvasRenderingContext2D, rows: LayerRow[],
    first: number, last: number, w: number, h: number, duration: number,
  ): void {
    const anim = this.store.currentAnimation;
    const H = this.bodyTop;
    const rowH = this.rowHeight;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, H, w, h - H);
    ctx.clip();

    // Below the last layer there are no frames: nothing to count, nothing to
    // click, so nothing is drawn there. The cell grid and the animation's
    // extent used to be painted across the FULL height of the panel, which is
    // why deleting a layer left a lit block of frames hanging in the empty
    // space underneath — the rows were gone and their background was not.
    ctx.fillStyle = this.C.bodyBg;
    ctx.fillRect(0, H, w, h - H);

    const selectedFrames = new Set(this.store.selection.frames);
    const selectedNodes = new Set(this.store.selection.nodes);

    for (let i = 0; i < rows.length; i++) {
      const { layer, node } = rows[i]!;
      const y = H + i * rowH - this.scrollY;
      if (y + rowH < H || y > h) continue;

      // The empty grid first: it is the ground every span is drawn on.
      this.drawCells(ctx, y, first, last);

      if (selectedNodes.has(layer.nodeId)) {
        ctx.fillStyle = this.C.currentRow;
        ctx.fillRect(0, y, w, rowH);
      }

      const track: Track | undefined = anim?.tracks[layer.nodeId];
      if (rows[i]!.prop) {
        this.drawPropRow(ctx, track, rows[i]!.prop!, y, layer.nodeId);
        continue;
      }
      if (rows[i]!.ik) {
        this.drawIkRow(ctx, rows[i]!.ik!, y);
        continue;
      }
      if (rows[i]!.tc) {
        this.drawTcRow(ctx, rows[i]!.tc!, y);
        continue;
      }
      const keyKind = keyRowKind(rows[i]!);
      if (keyKind) {
        const keys = this.keyRowKeys(keyKind, layer.nodeId, rows[i]!.cn);
        const sel = picked(this.deformSel, layer.nodeId, keyKind, rows[i]!.cn);
        // Inherit keys are stepped: nothing joins them.
        const drawn = keyKind === "inherit" ? keys.map((k) => ({ frame: k.frame, tween: { kind: "none" } })) : keys;
        this.drawKeyRow(ctx, drawn, sel, keyKind === "sequence" ? SEQUENCE_COLOR : keyKind === "inherit" ? INHERIT_COLOR : keyKind === "constraint" ? CONSTRAINT_KEY_COLOR : DEFORM_COLOR, y);
        continue;
      }
      // A group has no artwork of its own, so it gets a thinner band: it is
      // a container, and drawing it like content would suggest otherwise. An
      // empty layer gets an outlined band with a hollow keyframe — Flash's
      // "one empty frame", and visibly not something that will be exported.
      this.drawTrackRow(ctx, track, layer, y, first, last, duration,
                        node.kind === "group" ? "group"
                          : node.kind === "empty" ? "empty" : "node");

      // An excluded layer is darkened across its whole width: it still draws
      // on the stage, so the timeline is the only place that can say it will
      // not be in the file.
      if (layer.excludeFromExport) {
        ctx.fillStyle = this.C.excluded;
        ctx.fillRect(0, y, w, rowH - 1);
      }

      // The selection wash sits on top and is drawn per row rather than per
      // track, so a layer with no track of its own still shows what is
      // selected on it.
      for (let f = first; f <= last; f++) {
        if (!selectedFrames.has(`${layer.nodeId}:${f}`)) continue;
        ctx.fillStyle = this.C.selected;
        ctx.fillRect(this.xOfFrame(f), y + 1, this.frameWidth - 1, rowH - 3);
      }
    }

    if (this.drop) this.drawFrameDrop(ctx, this.drop, w);

    // Vertical separators are the cells' own gutters now, drawn per row —
    // full-height lines were the other half of the block left behind by a
    // deleted layer, and they were the thing that had to be clipped to the
    // animation's length and so kept disappearing halfway across the panel.
    ctx.strokeStyle = this.C.rowLine;
    ctx.beginPath();
    for (let i = 0; i <= rows.length; i++) {
      const y = Math.round(H + i * rowH - this.scrollY) + 0.5;
      if (y < H || y > h) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    ctx.restore();
  }

  /** Where a dragged frame selection would land: a wash and an outline, so
   *  the destination is readable over the cells it covers. */
  private drawFrameDrop(ctx: CanvasRenderingContext2D, d: FrameRect, w: number): void {
    const x = this.xOfFrame(d.from);
    const y = this.bodyTop + d.top * this.rowHeight - this.scrollY;
    const width = (d.to - d.from + 1) * this.frameWidth - 1;
    const height = (d.bottom - d.top + 1) * this.rowHeight - 1;
    if (x > w || x + width < 0) return;
    ctx.fillStyle = this.C.selected;
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = this.C.playhead;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, width - 1, height - 1);
  }

  /**
   * One row of empty cells: rectangles with a one-pixel gutter of background
   * between them, every fifth a shade darker. Two paths and two fills, not a
   * fill per cell — this runs for every visible row of every draw, and
   * playback draws every frame.
   */
  private drawCells(
    ctx: CanvasRenderingContext2D, y: number, first: number, last: number,
  ): void {
    const fw = this.frameWidth;
    const paths = [new Path2D(), new Path2D()];
    for (let f = first; f <= last; f++) {
      const p = paths[(f + 1) % 5 === 0 ? 1 : 0]!;
      p.rect(Math.round(this.xOfFrame(f)), y, Math.max(1, fw - 1), this.rowHeight - 1);
    }
    ctx.fillStyle = this.C.cell;
    ctx.fill(paths[0]!);
    ctx.fillStyle = this.C.cellAlt;
    ctx.fill(paths[1]!);
  }

  /** The line down the left of a keyframe, or the right end of a span. */
  /**
   * A keyframe as Spine draws it: a diamond in the middle of its cell, as
   * large as the cell allows, light with a dark outline. Hollow, for a blank
   * keyframe: a light ring over a dark one, so it still shows on the grid.
   */
  private drawKey(ctx: CanvasRenderingContext2D, cellX: number, rowY: number, hollow: boolean): void {
    const cx = Math.round(cellX + this.frameWidth / 2 - 0.5) + 0.5;
    const cy = Math.round(rowY + this.rowHeight / 2 - 0.5) + 0.5;
    const r = Math.max(3, Math.min(5, this.frameWidth / 2 - 0.5, this.rowHeight / 2 - 3));
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    if (hollow) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = this.C.keyRing;
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = this.C.keyFill;
      ctx.stroke();
    } else {
      ctx.fillStyle = this.C.keyFill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = this.C.keyDot;
      ctx.stroke();
    }
  }

  private drawSpanEdge(ctx: CanvasRenderingContext2D, x: number, y: number, pad: number): void {
    ctx.fillStyle = this.C.spanEdge;
    ctx.fillRect(Math.round(x), y + pad, 1, this.rowHeight - pad * 2 - 1);
  }

  /** The draw order keys picked on the Draw order row, by frame. */
  orderSel: number[] | null = null;

  /**
   * The Draw order row, under the ruler: a key where the order changes, the
   * picked ones ringed. Spine's dopesheet has it at the top.
   */
  private drawOrderStrip(ctx: CanvasRenderingContext2D, first: number, last: number, w: number): void {
    if (!this.stripHeight) return;
    const h = this.rowHeight;
    const y = this.headerHeight;
    ctx.fillStyle = this.C.headerBg;
    ctx.fillRect(0, y, w, h);
    this.drawCells(ctx, y, first, last);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, y, w, h);
    const keys = this.store.currentAnimation?.drawOrder ?? [];
    const half = this.frameWidth / 2;
    const mid = Math.round(y + h / 2 - 0.5) + 0.5;
    const r = Math.max(3, Math.min(5, half - 0.5, h / 2 - 3));
    for (const k of keys) {
      if (k.frame < first || k.frame > last) continue;
      const cx = Math.round(this.xOfFrame(k.frame) + half - 0.5) + 0.5;
      ctx.beginPath();
      ctx.rect(cx - r, mid - r, r * 2, r * 2);
      // A key back to the setup order is hollow.
      ctx.fillStyle = k.order ? DRAW_ORDER_COLOR : this.C.headerBg;
      ctx.fill();
      const picked = this.orderSel?.includes(k.frame);
      ctx.lineWidth = picked ? 2 : 1;
      ctx.strokeStyle = picked ? "#ffffff" : DRAW_ORDER_COLOR;
      ctx.stroke();
    }
    ctx.strokeStyle = this.C.rowLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + h - 0.5);
    ctx.lineTo(w, y + h - 0.5);
    ctx.stroke();
  }

  /**
   * The Events row: a flag on each frame that fires events, a count beside it
   * when several do, else the event's name while it fits before the next
   * flag; the picked frames ringed.
   */
  private eventStrip(ctx: CanvasRenderingContext2D, first: number, last: number, w: number): void {
    if (!this.stripHeight) return;
    const y = this.eventsTop, h = this.rowHeight;
    ctx.fillStyle = this.C.headerBg;
    ctx.fillRect(0, y, w, h);
    this.drawCells(ctx, y, first, last);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, y, w, h);
    const keys = this.store.currentAnimation?.events ?? [];
    this.waveStrip(ctx, keys, y, h, w);
    const frames = eventFrames(keys);
    const picked = new Set(this.store.ui.eventFrames);
    const half = this.frameWidth / 2;
    ctx.font = uiFont(9, this.fontSize);
    ctx.textBaseline = "middle";
    frames.forEach((f, i) => {
      if (f < first - 20 || f > last) return;
      const x = Math.round(this.xOfFrame(f) + half) + 0.5;
      const top = y + 3, bottom = y + h - 3;
      ctx.strokeStyle = EVENT_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x + 7, top + 3.5);
      ctx.lineTo(x, top + 7);
      ctx.closePath();
      ctx.fillStyle = EVENT_COLOR;
      ctx.fill();
      if (picked.has(f)) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - half + 1, y + 1.5, this.frameWidth - 2, h - 3);
      }
      const at = keys.filter((k) => k.frame === f);
      const label = at.length > 1 ? `${at.length}` : at[0]!.name;
      const room = (i + 1 < frames.length ? this.xOfFrame(frames[i + 1]!) : w) - (x + 9) - 4;
      if (room > 8) {
        ctx.fillStyle = this.C.text ?? "#ddd";
        let text = label;
        while (text.length > 1 && ctx.measureText(text).width > room) text = text.slice(0, -1);
        ctx.fillText(text === label ? text : `${text.slice(0, -1)}…`, x + 9, y + h / 2);
      }
    });
    ctx.strokeStyle = this.C.rowLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + h - 0.5);
    ctx.lineTo(w, y + h - 0.5);
    ctx.stroke();
  }

  /** Each keyed sound's waveform from where its event fires, scaled by its
   *  volume, under the flags. */
  private waveStrip(ctx: CanvasRenderingContext2D, keys: readonly EventKey[], y: number, h: number, w: number): void {
    if (!this.cb.waveform) return;
    const fps = this.store.project.frameRate;
    const pxPerSecond = fps * this.frameWidth;
    const mid = y + h / 2, room = (h - 4) / 2;
    ctx.fillStyle = withAlpha(EVENT_COLOR, 0.45);
    for (const sound of eventSounds(keys, this.store.currentSymbol.events)) {
      const wave = this.cb.waveform(sound.path);
      if (!wave) continue;
      const x0 = this.xOfFrame(sound.frame) + this.frameWidth / 2;
      const from = Math.max(0, Math.floor(x0)), to = Math.min(w, Math.ceil(x0 + wave.duration * pxPerSecond));
      for (let px = from; px < to; px++) {
        const t = (px - x0) / pxPerSecond;
        const a = Math.min(1, peakBetween(wave, t, t + 1 / pxPerSecond) * sound.volume) * room;
        if (a >= 0.25) ctx.fillRect(px, mid - a, 1, a * 2);
      }
    }
  }

  /** Pick the Events row's frames (the Events panel edits their keys). */
  private pickEventFrames(frames: number[]): void {
    const now = this.store.ui.eventFrames;
    if (now.length === frames.length && now.every((f, i) => f === frames[i])) return;
    this.store.ui.eventFrames = frames;
    this.store.emit("timeline");
  }

  /** Move the keys of the picked event frames by whole frames, from the keys
   *  as they were at pointerdown. */
  private beginEventDrag(e: PointerEvent, frames: number[], base: EventKey[]): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const first = Math.min(...frames);
    let lastDelta = 0;
    let started = false;
    const move = (m: PointerEvent) => {
      const delta = Math.max(-first, Math.round((m.clientX - startX) / this.frameWidth));
      if (delta === lastDelta) return;
      if (!started) { started = true; this.cb.onBeginInteraction("timeline.eventMove"); }
      this.cb.onEditEvents(moveEventKeys(base, frames, delta), "Move Event Keys", "timeline.eventMove");
      this.pickEventFrames(frames.map((f) => f + delta));
      lastDelta = delta;
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** Move the picked draw order keys by whole frames, from the keys as they
   *  were at pointerdown. */
  private beginOrderDrag(e: PointerEvent, frames: number[], base: DrawOrderKey[]): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const first = Math.min(...frames);
    let lastDelta = 0;
    let started = false;
    const move = (m: PointerEvent) => {
      const delta = Math.max(-first, Math.round((m.clientX - startX) / this.frameWidth));
      if (delta === lastDelta) return;
      if (!started) { started = true; this.cb.onBeginInteraction("timeline.drawOrderMove"); }
      this.cb.onEditDrawOrder(moveDrawOrderKeys(base, frames, delta), "Move Draw Order Keys", "timeline.drawOrderMove");
      this.orderSel = frames.map((f) => f + delta);
      lastDelta = delta;
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** The keys picked on a Deform row, a Sequence row (`sequence`) or an Inherit row (`inherit`). */
  deformSel: KeySel | null = null;

  private keyRowKeys(kind: KeyRowKind, node: NodeId, cn?: CnId): ReadonlyArray<{ frame: number; tween?: { kind: string } }> {
    const a = this.store.currentAnimation;
    if (kind === "constraint") return constraintRowKeys(a, cn!);
    if (kind === "deform") {
      const sym = this.store.currentSymbol, n = sym.nodes[node];
      const row = n ? deformRow(sym, n) : null;
      return (row && deformKeysOf(a, row.target)) ?? [];
    }
    return (kind === "sequence" ? a?.sequences : a?.inherits)?.[node] ?? [];
  }

  /** A row of keys: a diamond per key, joined where they tween (none after
   *  a stepped key), the picked ones ringed. */
  private drawKeyRow(ctx: CanvasRenderingContext2D, keys: ReadonlyArray<{ frame: number; tween?: { kind: string } }>, sel: readonly number[], color: string, y: number): void {
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(0, y, this.el.clientWidth, this.rowHeight);
    if (!keys.length) return;
    const mid = Math.round(y + this.rowHeight / 2 - 0.5) + 0.5;
    const half = this.frameWidth / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 1; i < keys.length; i++) {
      if (keys[i - 1]!.tween?.kind === "none") continue;
      ctx.moveTo(this.xOfFrame(keys[i - 1]!.frame) + half, mid);
      ctx.lineTo(this.xOfFrame(keys[i]!.frame) + half, mid);
    }
    ctx.stroke();
    const r = Math.max(3, Math.min(5.5, half, this.rowHeight / 2 - 2.5));
    for (const k of keys) {
      const cx = Math.round(this.xOfFrame(k.frame) + half - 0.5) + 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, mid - r); ctx.lineTo(cx + r, mid); ctx.lineTo(cx, mid + r); ctx.lineTo(cx - r, mid); ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      const picked = sel.includes(k.frame);
      ctx.lineWidth = picked ? 2 : 1;
      ctx.strokeStyle = picked ? "#ffffff" : this.C.keyDot;
      ctx.stroke();
    }
  }

  /** Move the picked deform or sequence keys by whole frames, from the keys at pointerdown. */
  private beginDeformDrag(e: PointerEvent, node: NodeId, frames: number[], base: ReadonlyArray<unknown>, kind: KeyRowKind, cn?: CnId): void {
    const baseAll = this.store.currentAnimation?.constraintKeys;
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const first = Math.min(...frames);
    let lastDelta = 0;
    let started = false;
    const move = (m: PointerEvent) => {
      const delta = Math.max(-first, Math.round((m.clientX - startX) / this.frameWidth));
      if (delta === lastDelta) return;
      if (!started) { started = true; this.cb.onBeginInteraction(`timeline.${kind}Move`); }
      if (kind === "sequence") this.cb.onEditSequence(node, moveKeys(base as SequenceKey[], frames, delta), "Move Sequence Keys", "timeline.sequenceMove");
      else if (kind === "inherit") this.cb.onEditInherit(node, moveKeys(base as InheritKey[], frames, delta), "Move Inherit Keys", "timeline.inheritMove");
      else if (kind === "constraint") this.cb.onEditConstraintKeys(moveConstraintKeys(baseAll, cn!, frames, delta), "Move Constraint Keys", "timeline.constraintMove");
      else this.cb.onEditDeform(node, moveDeformKeys(base as DeformKey[], frames, delta), "Move Deform Keys", "timeline.deformMove");
      this.deformSel = { node, frames: frames.map((f) => f + delta), ...selFlag(kind, cn) };
      lastDelta = delta;
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** The keys picked on a transform constraint row. */
  tcSel: { tc: TcId; frames: number[] } | null = null;

  /** A transform constraint row: a diamond per key, joined where the mixes
   *  tween (none after a stepped key), the picked ones ringed. */
  private drawTcRow(ctx: CanvasRenderingContext2D, tc: TcId, y: number): void {
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(0, y, this.el.clientWidth, this.rowHeight);
    const keys = this.store.currentAnimation?.transforms?.[tc] ?? [];
    if (!keys.length) return;
    const sel = this.tcSel?.tc === tc ? this.tcSel.frames : [];
    const color = TC_COLOR;
    const mid = Math.round(y + this.rowHeight / 2 - 0.5) + 0.5;
    const half = this.frameWidth / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 1; i < keys.length; i++) {
      if (keys[i - 1]!.tween?.kind === "none") continue;
      ctx.moveTo(this.xOfFrame(keys[i - 1]!.frame) + half, mid);
      ctx.lineTo(this.xOfFrame(keys[i]!.frame) + half, mid);
    }
    ctx.stroke();
    const r = Math.max(3, Math.min(5.5, half, this.rowHeight / 2 - 2.5));
    for (const k of keys) {
      const cx = Math.round(this.xOfFrame(k.frame) + half - 0.5) + 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, mid - r); ctx.lineTo(cx + r, mid); ctx.lineTo(cx, mid + r); ctx.lineTo(cx - r, mid); ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      const picked = sel.includes(k.frame);
      ctx.lineWidth = picked ? 2 : 1;
      ctx.strokeStyle = picked ? "#ffffff" : this.C.keyDot;
      ctx.stroke();
    }
  }

  /** Move the picked transform keys by whole frames, from the keys at pointerdown. */
  private beginTcDrag(e: PointerEvent, tc: TcId, frames: number[], base: TcKey[]): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const first = Math.min(...frames);
    let lastDelta = 0;
    let started = false;
    const move = (m: PointerEvent) => {
      const delta = Math.max(-first, Math.round((m.clientX - startX) / this.frameWidth));
      if (delta === lastDelta) return;
      if (!started) { started = true; this.cb.onBeginInteraction("timeline.tcMove"); }
      this.cb.onEditTc(tc, moveTcKeys(base, frames, delta), "Move Transform Keys", "timeline.tcMove");
      this.tcSel = { tc, frames: frames.map((f) => f + delta) };
      lastDelta = delta;
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** The keys picked on an IK row. */
  ikSel: { ik: IkId; frames: number[] } | null = null;

  /** The mix a drag on an IK row is setting, shown beside its key. */
  private ikMixLabel: { ik: IkId; frame: number; mix: number } | null = null;

  /**
   * An IK row: the mix in force at each frame as a filled band from the
   * row's bottom (full height = 1), a diamond per key in the IK colour,
   * joined where the mix tweens (none after a stepped key), the picked ones
   * ringed; a key whose bend differs from the one before is hollow.
   */
  private drawIkRow(ctx: CanvasRenderingContext2D, ik: IkId, y: number): void {
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(0, y, this.el.clientWidth, this.rowHeight);
    const anim = this.store.currentAnimation;
    const k = this.store.currentSymbol.ik.find((c) => c.id === ik);
    const keys = anim?.ik?.[ik] ?? [];
    if (!keys.length || !anim || !k) return;
    const sel = this.ikSel?.ik === ik ? this.ikSel.frames : [];
    const color = this.store.prefs.value.gizmos.ikTarget;
    const mid = Math.round(y + this.rowHeight / 2 - 0.5) + 0.5;
    const half = this.frameWidth / 2;
    const bottom = y + this.rowHeight - 1, span = this.rowHeight - 3;
    const first = Math.max(0, this.frameAtX(0)), last = Math.min(anim.duration - 1, this.frameAtX(this.el.clientWidth) + 1);
    ctx.beginPath();
    ctx.moveTo(this.xOfFrame(first) + half, bottom);
    for (let f = first; f <= last; f++) ctx.lineTo(this.xOfFrame(f) + half, bottom - ikPoseAt(k, anim, f).mix * span);
    ctx.lineTo(this.xOfFrame(last) + half, bottom);
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.16);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 1; i < keys.length; i++) {
      if (keys[i - 1]!.tween?.kind === "none") continue;
      ctx.moveTo(this.xOfFrame(keys[i - 1]!.frame) + half, mid);
      ctx.lineTo(this.xOfFrame(keys[i]!.frame) + half, mid);
    }
    ctx.stroke();
    const r = Math.max(3, Math.min(5.5, half, this.rowHeight / 2 - 2.5));
    keys.forEach((k, i) => {
      const cx = Math.round(this.xOfFrame(k.frame) + half - 0.5) + 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, mid - r); ctx.lineTo(cx + r, mid); ctx.lineTo(cx, mid + r); ctx.lineTo(cx - r, mid); ctx.closePath();
      const flips = i > 0 && keys[i - 1]!.bendPositive !== k.bendPositive;
      ctx.fillStyle = flips ? this.C.keyDot : color;
      ctx.fill();
      const picked = sel.includes(k.frame);
      ctx.lineWidth = picked ? 2 : 1;
      ctx.strokeStyle = picked ? "#ffffff" : flips ? color : this.C.keyDot;
      ctx.stroke();
    });
    const label = this.ikMixLabel?.ik === ik ? this.ikMixLabel : null;
    if (label) {
      ctx.font = uiFont(9, this.fontSize);
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label.mix.toFixed(2), this.xOfFrame(label.frame) + this.frameWidth + 3, mid);
    }
  }

  /**
   * Drag the picked IK keys, from the keys at pointerdown: sideways moves
   * them by whole frames, up and down sets their mix (`withIkMixDragged`, ⇧
   * finer), whichever way the pointer goes first.
   */
  private beginIkDrag(e: PointerEvent, ik: IkId, frames: number[], base: IkKey[]): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const first = Math.min(...frames);
    let lastDelta = 0;
    let started = false;
    let axis: "time" | "mix" | null = null;
    const move = (m: PointerEvent) => {
      axis ??= ikDragAxis(m.clientX - startX, m.clientY - startY);
      if (axis === "mix") {
        if (!started) { started = true; this.cb.onBeginInteraction("timeline.ikMix"); }
        const keys = withIkMixDragged(base, frames, m.clientY - startY, m.shiftKey);
        this.cb.onEditIk(ik, keys, "IK Mix", "timeline.ikMix");
        const shown = keys.find((k) => k.frame === frames[frames.length - 1]);
        this.ikMixLabel = shown ? { ik, frame: shown.frame, mix: shown.mix } : null;
        this.invalidate();
        return;
      }
      if (axis !== "time") return;
      const delta = Math.max(-first, Math.round((m.clientX - startX) / this.frameWidth));
      if (delta === lastDelta) return;
      if (!started) { started = true; this.cb.onBeginInteraction("timeline.ikMove"); }
      this.cb.onEditIk(ik, moveIkKeys(base, frames, delta), "Move IK Keys", "timeline.ikMove");
      this.ikSel = { ik, frames: frames.map((f) => f + delta) };
      lastDelta = delta;
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      this.ikMixLabel = null;
      this.invalidate();
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /**
   * A press on an IK row away from its keys: sideways scrubs, as anywhere on
   * the grid; up and down keys the mix in force at that frame and sets it,
   * one undo step with the key.
   */
  private beginIkEmptyDrag(e: PointerEvent, ik: IkId, frame: number): void {
    this.el.setPointerCapture(e.pointerId);
    this.cb.onScrub(frame);
    const r = this.el.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    let axis: "time" | "mix" | null = null;
    let base: IkKey[] | null = null;
    const move = (m: PointerEvent) => {
      axis ??= ikDragAxis(m.clientX - startX, m.clientY - startY);
      if (axis === "time") { this.cb.onScrub(this.frameAtX(m.clientX - r.left)); return; }
      if (axis !== "mix") return;
      const anim = this.store.currentAnimation;
      const k = this.store.currentSymbol.ik.find((c) => c.id === ik);
      if (!anim || !k) return;
      if (!base) {
        base = withIkKey(anim.ik?.[ik] ?? [], frame, ikPoseAt(k, anim, frame), k.softness);
        this.cb.onBeginInteraction("timeline.ikMix");
        this.ikSel = { ik, frames: [frame] };
      }
      const keys = withIkMixDragged(base, [frame], m.clientY - startY, m.shiftKey);
      this.cb.onEditIk(ik, keys, "IK Mix", "timeline.ikMix");
      this.ikMixLabel = { ik, frame, mix: keys.find((x) => x.frame === frame)!.mix };
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      this.ikMixLabel = null;
      this.invalidate();
      if (base) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** The property keys picked on a property row: one bone, one property. */
  propSel: { nodeId: NodeId; prop: TimelineProp; frames: number[] } | null = null;

  /**
   * A focused bone's property row: a square where that property is keyed
   * (`propertyKeys`), in the property's colour, joined by a line between two
   * of them, the picked ones ringed. Spine's dopesheet draws the same.
   */
  private drawPropRow(
    ctx: CanvasRenderingContext2D, track: Track | undefined, prop: TimelineProp, y: number, nodeId: NodeId,
  ): void {
    const sel = this.propSel?.nodeId === nodeId && this.propSel.prop === prop ? this.propSel.frames : [];
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(0, y, this.el.clientWidth, this.rowHeight);
    const frames = propertyKeys(track, prop);
    if (!frames.length) return;
    const color = PROP_COLORS[prop];
    const mid = Math.round(y + this.rowHeight / 2 - 0.5) + 0.5;
    const half = this.frameWidth / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 1; i < frames.length; i++) {
      ctx.moveTo(this.xOfFrame(frames[i - 1]!) + half, mid);
      ctx.lineTo(this.xOfFrame(frames[i]!) + half, mid);
    }
    ctx.stroke();
    const r = Math.max(3, Math.min(5, half - 0.5, this.rowHeight / 2 - 3));
    for (const f of frames) {
      const cx = Math.round(this.xOfFrame(f) + half - 0.5) + 0.5;
      ctx.beginPath();
      ctx.rect(cx - r, mid - r, r * 2, r * 2);
      ctx.fillStyle = color;
      ctx.fill();
      const picked = sel.includes(f);
      ctx.lineWidth = picked ? 2 : 1;
      ctx.strokeStyle = picked ? "#ffffff" : this.C.keyDot;
      ctx.stroke();
    }
  }

  private drawTrackRow(
    ctx: CanvasRenderingContext2D, track: Track | undefined, layer: Layer,
    y: number, first: number, last: number,
    duration = 1, band: "node" | "group" | "empty" = "node",
  ): void {
    const fw = this.frameWidth;
    const isGroup = band === "group";

    // A node with no track still shows its bind pose at every frame, so draw
    // the span it actually occupies. Leaving the row blank would suggest the
    // object is not on stage, and creating a real track just to say "static"
    // would put a useless timeline into the export.
    if (!track) {
      const x0 = this.xOfFrame(0);
      const x1 = this.xOfFrame(duration);

      if (band === "empty") {
        // Outline, not fill: the layer occupies the stack but holds nothing,
        // and the hollow dot at frame 0 is the empty keyframe.
        ctx.strokeStyle = this.C.emptyRow;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y + 1.5, x1 - x0 - 2, this.rowHeight - 4);
        this.drawKey(ctx, x0, y, true);
        return;
      }

      const inset = isGroup ? 6 : 1;
      ctx.fillStyle = isGroup ? this.C.group : this.C.occupied;
      ctx.fillRect(x0, y + inset, x1 - x0, this.rowHeight - inset * 2 - 1);
      if (isGroup) return;
      // The implicit keyframe at 0, and the end of the span: the only two
      // edges a static layer has.
      this.drawSpanEdge(ctx, x0, y, inset);
      this.drawSpanEdge(ctx, x1 - 1, y, inset);
      this.drawKey(ctx, x0, y, false);
      ctx.fillStyle = this.C.endMark;
      ctx.fillRect(this.xOfFrame(duration - 1) + fw - 4, y + 3, 2, this.rowHeight - 8);
      return;
    }

    const rowH = this.rowHeight;
    const pad = 1;

    // Span backgrounds first, so dots and arrows land on top.
    for (let i = 0; i < track.keys.length; i++) {
      const key = track.keys[i]!;
      const nextKey = track.keys[i + 1];
      const spanEnd = nextKey ? nextKey.frame : track.endFrame + 1;
      if (spanEnd < first || key.frame > last) continue;

      const x0 = this.xOfFrame(key.frame);
      const x1 = this.xOfFrame(spanEnd);
      const tweening = !!nextKey && key.tween.kind !== "none" && key.displayIndex >= 0;

      // Full width, no gutter: two spans of the same kind side by side are
      // ONE rectangle, the way Flash draws them. What separates them is the
      // edge line every keyframe carries, drawn once the fills are down.
      ctx.fillStyle = key.displayIndex < 0 ? this.C.blank : tweening ? this.C.tween : this.C.occupied;
      ctx.fillRect(x0, y + pad, x1 - x0, rowH - pad * 2 - 1);

      if (tweening && x1 - x0 > fw * 1.5) {
        // The tween arrow: a line from this keyframe to the next.
        const cy = y + rowH / 2;
        ctx.strokeStyle = this.C.tweenLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0 + fw * 0.7, cy);
        ctx.lineTo(x1 - fw * 0.5, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1 - fw * 0.5, cy);
        ctx.lineTo(x1 - fw * 0.5 - 4, cy - 3);
        ctx.lineTo(x1 - fw * 0.5 - 4, cy + 3);
        ctx.closePath();
        ctx.fillStyle = this.C.tweenLine;
        ctx.fill();

        // Which easing it is, so an ease in is distinguishable from an ease
        // out without opening a menu.
        const base = easeTag(key.tween);
        const tag = base !== null || key.eases ? `${base ?? ""}${key.eases ? "*" : ""}` : null;
        if (tag && x1 - x0 > fw * 3) {
          ctx.font = uiFont(8, this.fontSize);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillStyle = this.C.tweenLine;
          ctx.fillText(tag, x0 + fw * 0.9, cy - 5);
          ctx.textAlign = "start";
        }
      }
    }

    // Edges: one down the left of every keyframe, one closing the track.
    for (const key of track.keys) {
      if (key.frame < first - 1 || key.frame > last + 1) continue;
      this.drawSpanEdge(ctx, this.xOfFrame(key.frame), y, pad);
    }
    if (track.endFrame >= first - 1 && track.endFrame <= last + 1) {
      this.drawSpanEdge(ctx, this.xOfFrame(track.endFrame + 1) - 1, y, pad);
    }

    // Keyframe markers. A blank keyframe is hollow, as Flash's ring was.
    for (const key of track.keys) {
      if (key.frame < first - 1 || key.frame > last + 1) continue;
      this.drawKey(ctx, this.xOfFrame(key.frame), y, key.displayIndex < 0);
    }

    // End-of-span marker.
    if (track.endFrame >= first && track.endFrame <= last) {
      const x = this.xOfFrame(track.endFrame);
      ctx.fillStyle = this.C.endMark;
      ctx.fillRect(x + fw - 4, y + 3, 2, rowH - 8);
    }

    void layer;
  }

  /** Where the playhead line runs, and the frame number above it (1-based,
   *  as the ruler counts) with the room it takes in the ruler. */
  private playheadMark(ctx: CanvasRenderingContext2D) {
    // Centred on the CELL, which starts at a rounded x and is `frameWidth - 1`
    // wide — half of `frameWidth` from the unrounded left edge put the line a
    // pixel to the right of centre, and that is visible against a grid.
    const cellX = Math.round(this.xOfFrame(this.store.ui.frame));
    const cellW = Math.max(1, this.frameWidth - 1);
    const x = cellX + Math.floor((cellW - 1) / 2) + 0.5;
    const text = String(this.store.ui.frame + 1);
    ctx.font = uiFont(11, this.fontSize);
    const { left, width } = playheadLabel(x, ctx.measureText(text).width);
    return { x, cellW, text, left, width };
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, h: number): void {
    const H = this.headerHeight;
    const { x, cellW, text } = this.playheadMark(ctx);
    if (x < -this.frameWidth - 40 || x > this.el.clientWidth + this.frameWidth + 40) return;

    // Spine's marker: the frame number in the playhead's colour, a triangle
    // under it whose tip is on the line under the header, then the line.
    const tip = H - 1;                       // the `headerLine` pixel row
    const arrow = 0.85 * Math.max(4, Math.min(6, cellW / 2 + 2));
    const top = tip - arrow;

    ctx.fillStyle = this.C.playhead;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // Lifted clear of the triangle, as in Spine.
    ctx.fillText(text, x, top - 3);
    ctx.textAlign = "start";
    ctx.textBaseline = "middle";

    ctx.beginPath();
    ctx.moveTo(x - arrow, top);
    ctx.lineTo(x + arrow, top);
    ctx.lineTo(x, tip);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = this.C.playhead;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, tip);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // ── Input ──────────────────────────────────────────────────────────────

  private wireInput(): void {
    const el = this.el;

    on(el, "pointermove", (e: PointerEvent) => {
      const title = this.seamTitle(e.clientX, e.clientY);
      if (el.title !== title) el.title = title;
    });

    on(el, "wheel", (ev) => {
      const e = ev as unknown as WheelEvent;
      const r = el.getBoundingClientRect();
      // Over the ruler, or with ⌘/Ctrl anywhere: zoom about the frame under
      // the pointer. Below the ruler the plain wheel scrolls the rows.
      if (e.ctrlKey || e.metaKey || (e.clientY - r.top < this.headerHeight && e.deltaY !== 0)) {
        e.preventDefault();
        // By distance, not by event: a mouse sends one event a notch, a
        // trackpad dozens of small ones, and both should zoom alike.
        const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        this.zoomWheel += px;
        while (Math.abs(this.zoomWheel) >= WHEEL_STEP) {
          const zoomIn = this.zoomWheel < 0;
          this.zoomWheel += zoomIn ? WHEEL_STEP : -WHEEL_STEP;
          this.zoomAt(e.clientX - r.left, zoomIn);
        }
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        this.scrollX = Math.max(0, this.scrollX + e.deltaX);
        this.invalidate();
        return;
      }
      // Vertical: the rows the wheel is over live in the LAYER LIST, whose
      // native scroll drives `setScrollY`. Without this the grid swallowed
      // the wheel and a rig with thirty layers only scrolled while the
      // pointer sat on the names.
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.cb.onWheelY(e.deltaY);
      }
    }, { passive: false });

    on(el, "contextmenu", (ev) => {
      const e = ev as unknown as MouseEvent;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const localY = e.clientY - r.top;
      const frame = this.frameAtX(e.clientX - r.left);
      // The ruler belongs to no layer, so it gets the menu whose operations
      // are about the animation as a whole.
      if (localY < this.headerHeight) {
        this.cb.onRulerContextMenu(frame, e.clientX, e.clientY);
        return;
      }
      if (localY >= this.eventsTop && localY < this.bodyTop) {
        const keyed = this.store.currentAnimation?.events?.some((k) => k.frame === frame);
        if (keyed && !this.store.ui.eventFrames.includes(frame)) this.pickEventFrames([frame]);
        this.invalidate();
        this.cb.onEventsMenu(frame, e.clientX, e.clientY);
        return;
      }
      if (localY < this.bodyTop) {
        const keyed = this.store.currentAnimation?.drawOrder?.some((k) => k.frame === frame);
        if (keyed && !this.orderSel?.includes(frame)) this.orderSel = [frame];
        this.invalidate();
        this.cb.onDrawOrderMenu(frame, e.clientX, e.clientY);
        return;
      }
      this.cb.onContextMenu(this.rowAtY(localY), frame, e.clientX, e.clientY);
    });

    on(el, "pointerdown", (ev) => {
      const e = ev as unknown as PointerEvent;
      if (e.button !== 0) return;
      const r = el.getBoundingClientRect();
      const localX = e.clientX - r.left;
      const localY = e.clientY - r.top;
      const frame = this.frameAtX(localX);

      // The ruler scrubs, except on an onion marker: a marker is a few
      // pixels drawn over the ruler, and whatever is behind it is the ruler.
      if (localY < this.headerHeight) {
        const marker = this.markerAt(localX, e);
        if (marker) { this.beginMarkerDrag(e, marker); return; }
        this.beginScrub(e, frame);
        return;
      }

      // The Events row: a press on a frame with events picks it (shift adds
      // or drops one) and a drag moves the picked frames' keys; elsewhere it
      // moves the playhead.
      if (localY >= this.eventsTop && localY < this.bodyTop) {
        this.orderSel = null;
        this.propSel = null;
        this.ikSel = null;
        const keys = this.store.currentAnimation?.events ?? [];
        if (keys.some((k) => k.frame === frame)) {
          const mine = this.store.ui.eventFrames;
          const frames = e.shiftKey
            ? (mine.includes(frame) ? mine.filter((f) => f !== frame) : [...mine, frame].sort((a, b) => a - b))
            : (mine.includes(frame) ? mine : [frame]);
          this.pickEventFrames(frames);
          this.cb.onScrub(frame);
          this.invalidate();
          if (!e.shiftKey) this.beginEventDrag(e, frames, keys);
          return;
        }
        this.pickEventFrames([]);
        this.beginScrub(e, frame);
        return;
      }
      if (this.store.ui.eventFrames.length) this.pickEventFrames([]);
      // The Draw order row: a press on a key picks it (shift adds or drops
      // one) and a drag moves the picked keys; elsewhere it moves the playhead.
      if (localY < this.bodyTop) {
        const keys = this.store.currentAnimation?.drawOrder ?? [];
        if (keys.some((k) => k.frame === frame)) {
          const mine = this.orderSel ?? [];
          this.orderSel = e.shiftKey
            ? (mine.includes(frame) ? mine.filter((f) => f !== frame) : [...mine, frame])
            : (mine.includes(frame) ? mine : [frame]);
          this.propSel = null;
          this.ikSel = null;
          this.cb.onScrub(frame);
          this.invalidate();
          if (!e.shiftKey) this.beginOrderDrag(e, this.orderSel, keys);
          return;
        }
        this.orderSel = null;
        this.beginScrub(e, frame);
        return;
      }
      this.orderSel = null;

      const row = this.rowAtY(localY);
      const layer = this.visibleRows()[row]?.layer;
      // Below the last layer there are no frames: a press there deselects
      // them, as a press on the empty stage does.
      if (!layer) { this.store.clearFrameSelection(); return; }
      // A Deform row: a press on a key picks it (shift adds or drops one), a
      // drag moves the picked keys; elsewhere it scrubs.
      const keyKind = keyRowKind(this.visibleRows()[row]);
      if (keyKind) {
        this.propSel = null;
        this.ikSel = null;
        this.tcSel = null;
        const node = layer.nodeId;
        const cn = this.visibleRows()[row]?.cn;
        const keys = this.keyRowKeys(keyKind, node, cn);
        if (keys.some((k) => k.frame === frame)) {
          const mine = picked(this.deformSel, node, keyKind, cn);
          const frames = e.shiftKey
            ? (mine.includes(frame) ? mine.filter((f) => f !== frame) : [...mine, frame])
            : (mine.includes(frame) ? mine : [frame]);
          this.deformSel = { node, frames, ...selFlag(keyKind, cn) };
          this.cb.onScrub(frame);
          this.invalidate();
          if (!e.shiftKey) this.beginDeformDrag(e, node, frames, keys, keyKind, cn);
          return;
        }
        this.deformSel = null;
        this.beginScrub(e, frame);
        return;
      }
      this.deformSel = null;
      // A transform constraint row: a press on a key picks it (shift adds or
      // drops one), a drag moves the picked keys; elsewhere it scrubs.
      const tc = this.visibleRows()[row]?.tc;
      if (tc) {
        this.propSel = null;
        this.ikSel = null;
        const keys = this.store.currentAnimation?.transforms?.[tc] ?? [];
        if (keys.some((k) => k.frame === frame)) {
          const mine = this.tcSel?.tc === tc ? this.tcSel.frames : [];
          const frames = e.shiftKey
            ? (mine.includes(frame) ? mine.filter((f) => f !== frame) : [...mine, frame])
            : (mine.includes(frame) ? mine : [frame]);
          this.tcSel = { tc, frames };
          this.cb.onScrub(frame);
          this.invalidate();
          if (!e.shiftKey) this.beginTcDrag(e, tc, frames, keys);
          return;
        }
        this.tcSel = null;
        this.beginScrub(e, frame);
        return;
      }
      this.tcSel = null;
      // An IK row: a press on a key picks it (shift adds or drops one), a
      // drag moves the picked keys; elsewhere it moves the playhead.
      const ik = this.visibleRows()[row]?.ik;
      if (ik) {
        this.propSel = null;
        const keys = this.store.currentAnimation?.ik?.[ik] ?? [];
        if (keys.some((k) => k.frame === frame)) {
          const mine = this.ikSel?.ik === ik ? this.ikSel.frames : [];
          const frames = e.shiftKey
            ? (mine.includes(frame) ? mine.filter((f) => f !== frame) : [...mine, frame])
            : (mine.includes(frame) ? mine : [frame]);
          this.ikSel = { ik, frames };
          this.cb.onScrub(frame);
          this.invalidate();
          if (!e.shiftKey) this.beginIkDrag(e, ik, frames, keys);
          return;
        }
        this.ikSel = null;
        this.beginIkEmptyDrag(e, ik, frame);
        return;
      }
      this.ikSel = null;
      // A property row: a press on one of its keys picks it (shift adds or
      // drops one) and a drag moves the picked keys of that property alone.
      const prop = this.visibleRows()[row]?.prop;
      if (prop) {
        const track = this.store.currentAnimation?.tracks[layer.nodeId];
        const node = this.store.currentSymbol.nodes[layer.nodeId];
        if (track && node && propertyKeys(track, prop).includes(frame)) {
          const mine = this.propSel?.nodeId === layer.nodeId && this.propSel.prop === prop ? this.propSel.frames : [];
          const frames = e.shiftKey
            ? (mine.includes(frame) ? mine.filter((f) => f !== frame) : [...mine, frame])
            : (mine.includes(frame) ? mine : [frame]);
          this.propSel = { nodeId: layer.nodeId, prop, frames };
          this.cb.onScrub(frame);
          this.invalidate();
          if (!e.shiftKey) this.beginPropDrag(e, node, prop, frames, track);
          return;
        }
        this.propSel = null;
        this.anchor = { row, frame };
        this.cb.onSelectCell(row, frame, false);
        return;
      }
      this.propSel = null;

      const track = this.store.currentAnimation?.tracks[layer.nodeId];
      // A layer with no track still shows a full-length span, so its end is
      // draggable too — the drag is what materialises the track.
      const endFrame = track?.endFrame
        ?? Math.max(0, (this.store.currentAnimation?.duration ?? 1) - 1);

      // Shift extends the existing selection rather than starting a new one.
      if (e.shiftKey && this.anchor) {
        const a = this.anchor;
        this.cb.onSelectRange(
          Math.min(a.row, row), Math.max(a.row, row),
          Math.min(a.frame, frame), Math.max(a.frame, frame),
        );
        this.beginRangeSelect(e, a.row, a.frame);
        return;
      }

      // The very end of a span is the stretch handle, and it wins even inside
      // a selection — that is the gesture the right edge is there for.
      const onSpanEnd = frame === endFrame
        && localX > this.xOfFrame(frame) + this.frameWidth * 0.55;

      // Flash's frame drag: a press INSIDE the current selection picks the
      // whole rectangle up and drops it on another frame or another layer,
      // rather than starting a new selection. The selection is left standing
      // until the pointer is released without having moved, which is then an
      // ordinary click.
      const rect = onSpanEnd ? null : this.frameSelectionRect();
      if (rect && row >= rect.top && row <= rect.bottom
          && frame >= rect.from && frame <= rect.to) {
        this.anchor = { row, frame };
        this.beginFrameDrag(e, row, frame, rect);
        return;
      }

      this.anchor = { row, frame };
      this.cb.onSelectCell(row, frame, false);

      // Dragging the very end of a span extends or trims it.
      if (onSpanEnd) {
        this.beginSpanDrag(e, layer.nodeId, endFrame);
        return;
      }
      if (track && keyIndexAt(track, frame) >= 0) {
        this.beginKeyDrag(e, layer.nodeId, frame);
        return;
      }
      // A layer with no track shows an implicit keyframe at 0 (a group shows
      // none), and dragging it is how an instance just dropped on the stage
      // starts later: the drag materialises the track, as the end drag does.
      const node = this.store.currentSymbol.nodes[layer.nodeId];
      if (!track && frame === 0 && node && node.kind !== "group") {
        this.beginKeyDrag(e, layer.nodeId, frame, ensureTrack(this.store, node));
        return;
      }
      // Dragging across the body selects a run of frames, the way it does in
      // Flash. Scrubbing lives on the ruler.
      this.beginRangeSelect(e, row, frame);
    });
  }

  private anchor: { row: number; frame: number } | null = null;

  /**
   * The frame selection as a rectangle of VISIBLE rows, or null when there is
   * nothing to pick up: a single cell is a click, not a span, and its keyframe
   * drag is the gesture that already covers it.
   */
  private frameSelectionRect(): FrameRect | null {
    const frames = this.store.selection.frames;
    if (frames.length < 2) return null;
    const rows = this.visibleRows();
    const index = new Map(rows.map((r, i) => [r.layer.nodeId, i] as const));
    let top = Infinity, bottom = -Infinity, from = Infinity, to = -Infinity;
    for (const cell of frames) {
      const cut = cell.lastIndexOf(":");
      const row = index.get(cell.slice(0, cut) as NodeId);
      const frame = Number(cell.slice(cut + 1));
      if (row === undefined || !Number.isFinite(frame)) continue;
      top = Math.min(top, row); bottom = Math.max(bottom, row);
      from = Math.min(from, frame); to = Math.max(to, frame);
    }
    if (!Number.isFinite(top)) return null;
    return { top, bottom, from, to };
  }

  /**
   * Dragging the selection. The document is edited once, on release: the drop
   * is a cut and an overwrite over as many rows as the rectangle is tall, and
   * showing it a frame at a time would be a hundred of those. What moves under
   * the pointer is the outline `drawFrameDrop` paints.
   */
  private beginFrameDrag(e: PointerEvent, row: number, frame: number, rect: FrameRect): void {
    this.el.setPointerCapture(e.pointerId);
    const r = this.el.getBoundingClientRect();
    const height = rect.bottom - rect.top + 1;
    const rowCount = this.visibleRows().length;
    let drop: { row: number; frame: number } | null = null;
    // ⌥ anywhere during the drag copies, as it does in Flash — not only ⌥ still
    // down at the release, which is a hair's timing to ask of anyone.
    let copy = false;

    const move = (m: PointerEvent) => {
      copy = copy || m.altKey;
      const f = Math.max(0, rect.from + this.frameAtX(m.clientX - r.left) - frame);
      const y = Math.min(this.bodyBottom - 1, Math.max(this.bodyTop, m.clientY - r.top));
      // Clamped so the whole rectangle stays on existing rows: dragging frames
      // off the bottom of the stack would otherwise create layers, which no
      // frame drag in Flash does.
      const top = Math.max(0, Math.min(rowCount - height, rect.top + this.rowAtY(y) - row));
      if (drop && drop.row === top && drop.frame === f) return;
      drop = { row: top, frame: f };
      this.drop = top === rect.top && f === rect.from
        ? null
        : { top, bottom: top + height - 1, from: f, to: f + (rect.to - rect.from) };
      this.invalidate();
    };
    const up = (ev: Event) => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      const moved = !!this.drop;
      this.drop = null;
      this.invalidate();
      if (moved && drop) this.cb.onDragFrames(drop.row, drop.frame, copy || (ev as PointerEvent).altKey);
      // A press that went nowhere is a plain click: it collapses the selection
      // onto the cell, which is what the press itself would have done.
      else if (!moved) this.cb.onSelectCell(row, frame, false);
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  private beginRangeSelect(e: PointerEvent, fromRow: number, fromFrame: number): void {
    this.el.setPointerCapture(e.pointerId);
    const r = this.el.getBoundingClientRect();
    let lastFrame = fromFrame;
    let lastRow = fromRow;
    const move = (m: PointerEvent) => {
      const frame = this.frameAtX(m.clientX - r.left);
      // Clamped, so dragging into the header or the scrollbar strip keeps the
      // rectangle on the rows rather than collapsing it.
      const rowCount = this.visibleRows().length;
      const rawRow = Math.floor(
        (Math.min(this.bodyBottom - 1, Math.max(this.bodyTop, m.clientY - r.top))
          - this.bodyTop + this.scrollY) / this.rowHeight,
      );
      const row = Math.max(0, Math.min(rowCount - 1, rawRow));
      if (frame === lastFrame && row === lastRow) return;
      lastFrame = frame;
      lastRow = row;
      this.cb.onSelectRange(
        Math.min(fromRow, row), Math.max(fromRow, row),
        Math.min(fromFrame, frame), Math.max(fromFrame, frame),
      );
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    // A pointer the browser cancels sends no pointerup; left alone, the drag's
    // interaction stayed open and swallowed the next timeline edit.
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** Wheel distance not yet turned into a zoom step. */
  private zoomWheel = 0;

  /** One wheel step in or out, keeping the frame under `x` where it is. */
  zoomAt(x: number, zoomIn: boolean): void {
    const from = this.frameWidth;
    const to = steppedFrameWidth(from, zoomIn);
    if (to === from) return;
    const scroll = anchoredScroll(this.scrollX, x, from, to);
    this.setFrameWidth(to);
    this.scrollX = scroll;
    this.invalidate();
  }

  /** Zoom so `frames` frames fill the visible width, from frame 1. */
  fitToView(frames: number): void {
    this.setFrameWidth(fitFrameWidth(frames, this.viewWidth));
    this.scrollX = 0;
    this.invalidate();
  }

  setFrameWidth(px: number): void {
    const w = Math.max(FRAME_WIDTH_MIN, Math.min(FRAME_WIDTH_MAX, px));
    this.frameWidth = w;
    // Through the preferences, so the zoom the user settles on survives a
    // reload and the Preferences dialog shows the value they are looking at.
    this.store.prefs.set("timeline", { frameWidth: Math.round(w) });
    this.invalidate();
  }

  private beginScrub(e: PointerEvent, frame: number): void {
    this.el.setPointerCapture(e.pointerId);
    this.cb.onScrub(frame);
    const r = this.el.getBoundingClientRect();
    const move = (m: PointerEvent) => this.cb.onScrub(this.frameAtX(m.clientX - r.left));
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  private beginKeyDrag(e: PointerEvent, nodeId: NodeId, frame: number, virtual?: Track): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    let lastDelta = 0;
    let started = false;
    // Every step is computed from the track as it was at pointerdown, so a
    // key the drag merely passes over is still there when it moves on.
    const base = this.store.currentAnimation?.tracks[nodeId] ?? virtual;

    const move = (m: PointerEvent) => {
      const delta = Math.round((m.clientX - startX) / this.frameWidth);
      if (delta === lastDelta) return;
      if (!started && delta !== 0) {
        started = true;
        this.cb.onBeginInteraction("timeline.move");
      }
      if (started) {
        this.cb.onMoveKeyframes(nodeId, frame, frame, delta, base);
        lastDelta = delta;
      }
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** Move the picked keys of one property by whole frames; every step is
   *  computed from the track as it was at pointerdown. */
  private beginPropDrag(e: PointerEvent, node: Node, prop: TimelineProp, frames: number[], base: Track): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const first = Math.min(...frames);
    let lastDelta = 0;
    let started = false;
    const move = (m: PointerEvent) => {
      const delta = Math.max(-first, Math.round((m.clientX - startX) / this.frameWidth));
      if (delta === lastDelta) return;
      if (!started) { started = true; this.cb.onBeginInteraction("timeline.propMove"); }
      this.cb.onEditTrack(node.id, moveChannelKeys(base, node, prop, frames, delta), "Move Keys", "timeline.propMove");
      this.propSel = { nodeId: node.id, prop, frames: frames.map((f) => f + delta) };
      lastDelta = delta;
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  private beginSpanDrag(e: PointerEvent, nodeId: NodeId, endFrame: number): void {
    this.el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    let started = false;
    const move = (m: PointerEvent) => {
      const delta = Math.round((m.clientX - startX) / this.frameWidth);
      if (!started && delta === 0) return;
      if (!started) { started = true; this.cb.onBeginInteraction("timeline.span"); }
      this.cb.onDragSpanEnd(nodeId, Math.max(0, endFrame + delta));
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.el.releasePointerCapture?.(e.pointerId);
      if (started) this.cb.onEndInteraction();
    };
    const offMove = on(this.el, "pointermove", move as (x: Event) => void);
    const offUp = on(this.el, "pointerup", up);
    const offCancel = on(this.el, "pointercancel", up);
  }

  /** Keep the playhead in view while scrubbing or playing. */
  revealFrame(frame: number): void {
    const x = this.xOfFrame(frame);
    const margin = this.frameWidth * 2;
    if (x < margin) {
      this.scrollX = Math.max(0, frame * this.frameWidth - margin);
      this.invalidate();
    } else if (x > this.viewWidth - margin) {
      this.scrollX = frame * this.frameWidth - this.viewWidth + margin;
      this.invalidate();
    }
  }

  setScrollY(y: number): void {
    if (this.scrollY === y) return;
    this.scrollY = y;
    this.invalidate();
  }
}


export { spanIndexAt, describeFrame };
