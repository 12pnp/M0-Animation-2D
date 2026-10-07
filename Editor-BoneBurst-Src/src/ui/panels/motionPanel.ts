import { type BoneProperty, keyBone, type LocalPose } from "@/edit/boneKeys";
import { EditRefused } from "@/edit/history";
import { addNodeTime, blocksOf, curveOf, endFrame, FLAT_SPEED, handleOffsets, moveNodeTime, nodeTimeFrames, placeAtFrame, progressAtFrame, nodeLabels, removeNodeTime, type SpeedPoint, moveNode, withNode, withOrigin, withBlockGraph, withFrames, withSpeed } from "@/edit/motionPath";
import { drawnVertices } from "@/engine/draw";
import { boneInherit } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import type { MotionPath } from "@/model/sidecar";
import { frameTime, keyLists, keyTime, timeFrame } from "@/model/timelines";
import { iconButton } from "../icons";
import { showContextMenu } from "../contextMenu";
import { bakeMotion, currentNode, dropMotion, keepMotion, motionChanged, motionFor, motionStale, nodeAfter, poseAtNode, startMotion } from "../motion";
import { keysAt } from "@/model/timelines";
import { localPoint, pageScale } from "../pageScale";
import type { Session } from "../session";
import { type Matrix, type Point, localRotation, spaceAxes, tidy, turn, turnSign } from "../stage/gizmo";
import { animatedLocal, boneMatrix, boneTip, parentMatrix, type Posed, Poser } from "../stage/posed";
import { axisLocked, constraintDriving, shiftedLocal } from "../stage/trailEdit";
import { drawBackdrop } from "../stage/canvasBackdrop";
import { NO_LOOK, type StageLook } from "../stage/look";
import { type OnionOptions, onionFrames } from "../stage/onion";
import { type BoneTrail, boneTrail, fromParent, type TrailSpace } from "../stage/trail";

/** The layers the panel can show: the bone's image, the bone itself, its path, and onion skin (the bone at frames either side of the playhead). */
export type Layer = "image" | "bone" | "path" | "length" | "onion" | "children";
const LAYERS: readonly Layer[] = ["image", "bone", "path", "length", "onion", "children"];
/** The path's dots and the lengths between them. */
const DOT = "#ff2bd6";
/** The top of the block speed graph (its canvas shows speeds 0 to this). */
const GRAPH_TOP = 3;
const PAST = "rgb(230, 64, 51)", FUTURE = "rgb(51, 179, 77)";
const LAYERS_KEY = "boneburst.motionPath.layers";
const AXES_KEY = "boneburst.motionPath.axes";
const AXIS_COLOURS = ["#e5484d", "#30a46c"] as const;

interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** A drag of a mark (move) or of the rotation handle, from what the bone was at that frame. */
interface BoneEdit {
  readonly bone: string;
  readonly kind: "move" | "rotate";
  readonly frame: number;
  readonly from: LocalPose;
  readonly parent: Matrix;
  /** Move only: the axis (0: x, 1: y) of `axes` the drag is held to, or null for a free drag; the axes as world unit vectors. */
  readonly axis: 0 | 1 | null;
  readonly axes: readonly [Point, Point];
  /** Where the drag began, on the canvas. */
  readonly start: [number, number];
  /** The animation and time to key, or null to pose without keying (Auto Key off). */
  readonly key: { animation: string; time: number } | null;
  // Rotate only: the joint and the pointer in the panel's space, the bone's matrix, and the turn so far.
  readonly joint: [number, number];
  readonly matrix: Matrix;
  readonly sign: number;
  readonly inherit: string;
  last: [number, number];
  turned: number;
}

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
 * The Motion Path panel (docs/MOTION-PREVIEW-PLAN.md): only the selected bone, over every frame of the
 * animation shown. Three layers, each a button in the header: its image (the slots on the bone, at
 * the playhead), the bone itself, and its path (the joint's trail with a mark for each frame, larger
 * where the animation keys the bone, lit at the playhead; the tip's trail fainter). Local measures
 * it all from the bone's parent's joint with the world's orientation, so a bone looks turned as it
 * does on the Stage but the parent's own movement is not in it; World is the Stage's own place. A click on a mark puts the playhead there. Empty, and saying
 * why, with no bone selected. In Pose mode (no animation) it shows the bone and its image on the setup
 * pose, with the same buttons and no path; it only shows: nothing in it is dragged.
 */
export class MotionPathPanel {
  readonly element: HTMLElement;
  private readonly canvas = document.createElement("canvas");
  private readonly head = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly title = document.createElement("span");
  private readonly note = document.createElement("p");
  private readonly spaceBtns: Record<TrailSpace, HTMLButtonElement>;
  private readonly layerBtns: Record<Layer, HTMLButtonElement>;
  private space: TrailSpace = "local";
  private show: Record<Layer, boolean> = { image: true, bone: true, path: true, length: true, onion: false, children: false };
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
  /** Said in the status line; set by the app. */
  onStatus: (message: string) => void = () => {};
  /** Whether a drag keys the animation (the Stage's Auto Key); set by the app. Off, a drag poses the bone without keying. */
  autoKey: () => boolean = () => true;
  /** How the panel maps a point of the bone's space onto the canvas, as last drawn: the inverse of `at`. */
  private mapping: { width: number; height: number; k: number; cx: number; cy: number } | null = null;
  /** The rotation handle beyond the bone's tip at the playhead, on the canvas, when the bone can be turned. */
  private handle: { x: number; y: number } | null = null;
  /** The drag in progress that edits the animation (docs/LOCALPATH-EDIT-PLAN.md). */
  private edit: BoneEdit | null = null;
  /** The frame tag at the playhead's dot, on the canvas as last drawn; a press on it scrubs along the path. */
  private tag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private scrubbing = false;
  /** The motion path's own row of buttons (docs/PATH-SPEED-PLAN.md), and the node picked on the canvas (-1: none). */
  private readonly motionBar = document.createElement("div");
  private readonly motionInfo = document.createElement("span");
  private readonly motionBtns: Record<"draw" | "time" | "add" | "del" | "addTime" | "delTime" | "bakeTl" | "drop", HTMLButtonElement>;
  /** Total frames (14 + 0), the picked node time's frame, the picked block's time multiplier, and whether the spline is a ring. */
  private readonly framesField = document.createElement("input");
  private readonly frameField = document.createElement("input");
  private readonly speedField = document.createElement("input");
  private readonly closedBox = document.createElement("input");
  private readonly closedLabel = document.createElement("label");
  private readonly framesBox = document.createElement("label");
  private readonly frameBox = document.createElement("label");
  private readonly speedBox = document.createElement("label");
  private readonly framesHint = document.createElement("span");
  /** The capture bar (docs/PATH-CAPTURE-PLAN.md): a numbered button for each node (press: put the bone there), a green + to add a slot. */
  private readonly slotBar = document.createElement("div");
  private slotSig = "";
  /** The path as a held number would leave it (and the two nodes), drawn dashed on the canvas while it is dragged. */
  private nodePreview: { motion: MotionPath; from: number } | null = null;
  /** The click that ends a drag of a number is ignored. */
  private suppressClick = false;
  /** The picked block's speed graph (Adjust time): presets above a small canvas of draggable points; a straight line at 1 by default. */
  private readonly graphBar = document.createElement("div");
  private readonly graphCanvas = document.createElement("canvas");
  private graphDrag = -1;
  /** The graph's points on its canvas as last drawn (a test hook). */
  private graphDots: { x: number; y: number }[] = [];
  /** What the panel does with a path: Edit Path shapes the spline; Adjust time sets the node times and their multipliers (docs/PATH-FRAMES-PLAN.md). */
  private mode: "draw" | "time" = "draw";
  private selNode = -1;
  /** The path's nodes on the canvas as last drawn (Local space only). */
  private nodePts: { x: number; y: number }[] = [];
  /** The curve's handles at the nodes on the canvas (Edit Path, Local), and the one being dragged. */
  private handlePts: { slot: number; side: "out" | "in"; x: number; y: number }[] = [];
  private handleDrag: { slot: number; side: "out" | "in" } | null = null;
  /** A node being dragged, or a dot being slid along the path (the speed). */
  private nodeDrag: number | null = null;
  /** The node time picked (-1: none); where the node times are on the canvas; how far the last bake to the timeline strays. */
  /** The picked node time / block: kept on the session, where the Timeline's block tabs read it too. */
  private get selTime(): number { return this.session.pickedBlock; }
  private set selTime(i: number) { this.session.pickedBlock = i; }
  private syncRev = -1;
  private timePts: { i: number; x: number; y: number }[] = [];
  private stray: number | null = null;
  /** The box the view was fitted to, as last drawn. */
  private box: Box | null = null;
  /** Hold that box after an edit too, until Fit or another bone, animation or space: the picture does not jump when a drag lets go. */
  private hold = false;
  /** What the move arrows follow: the parent's axes (as the Stage's default) or the world's. */
  private axes: "parent" | "world" = "parent";
  private readonly axesBtn = document.createElement("button");
  /** The move arrows at the playhead's joint, on the canvas as last drawn. */
  private arrows: { axis: 0 | 1; x0: number; y0: number; x1: number; y1: number }[] = [];

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel motion-path";
    try {
      const saved = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "{}") as Partial<Record<Layer, unknown>>;
      for (const l of LAYERS) if (typeof saved[l] === "boolean") this.show[l] = saved[l] as boolean;
    } catch { /* storage blocked: all shown */ }
    this.head.className = "lp-head";
    this.spaceBtns = { local: this.button("Local", "The world's orientation, from the parent's joint: the parent's own movement is not in it"), world: this.button("World", "In the skeleton's space, as the Stage shows it") };
    this.layerBtns = { image: this.button("Image", "Show the bone's image"), bone: this.button("Bone", "Show the bone"), path: this.button("Path", "Show the bone's path over the animation"), length: this.button("Length", "Show the distance between each pair of dots along the path (in the panel's space)"), onion: this.button("Onion", "Show the bone at the frames before (red) and after (green) the playhead; the count is set in Preferences ▸ Behavior"), children: this.button("Children", "Show every bone under the selected one, with their images") };
    try { if (localStorage.getItem(AXES_KEY) === "world") this.axes = "world"; } catch { /* storage blocked: the default */ }
    this.axesBtn.type = "button";
    this.axesBtn.addEventListener("click", () => {
      this.axes = this.axes === "parent" ? "world" : "parent";
      try { localStorage.setItem(AXES_KEY, this.axes); } catch { /* not kept */ }
      this.schedule();
    });
    this.head.append(this.title, this.layerBtns.image, this.layerBtns.bone, this.layerBtns.path, this.layerBtns.length, this.layerBtns.onion, this.layerBtns.children, this.spaceBtns.local, this.spaceBtns.world, this.axesBtn);
    this.body.className = "lp-body";
    this.note.className = "empty lp-note";
    const fit = iconButton(this.button("Fit", "Fit the whole path in the panel (double-click does the same)"), "fit", false);
    fit.className = "lp-fit";
    fit.addEventListener("click", () => this.fitView());
    this.body.append(this.canvas, this.note, fit);
    this.motionBar.className = "lp-motion";
    this.motionInfo.className = "lp-motion-info";
    this.motionBtns = {
      draw: this.button("Edit Path", "Edit the bone's path, a spline: two nodes to start (where it is, and an offset). A number puts the bone on that node, moving the bone moves the node, + adds a node"),
      time: this.button("Adjust time", "Set the node times (where the ring is cut into blocks) and each block's time multiplier, then Bake to timeline"),
      add: this.button("+", "Add a spline node"),
      del: this.button("− Node", "Remove the picked spline node (a path keeps two)"),
      addTime: this.button("+ Time", "Add a node time at the playhead's frame (a path keeps at least two)"),
      delTime: this.button("− Time", "Remove the picked node time (the first, on frame 0, stays; a path keeps two)"),
      bakeTl: this.button("Bake to timeline", "Write the bone's translate keys from the path: a key at each node time and one at the end (replaces its translate keys; Undo brings them back)"),
      drop: this.button("Remove path", "Forget this bone's path; its keys stay as they are"),
    };
    this.slotBar.className = "lp-slots";
    this.graphBar.className = "lp-graph";
    this.graphBar.hidden = true;
    const presets: [string, string, readonly SpeedPoint[]][] = [
      ["Even", "A straight line: even speed through the block", FLAT_SPEED],
      ["Slow in", "Start slow, end fast", [{ u: 0, v: 0.2 }, { u: 1, v: 1.8 }]],
      ["Slow out", "Start fast, end slow", [{ u: 0, v: 1.8 }, { u: 1, v: 0.2 }]],
      ["Slow in & out", "Slow at both ends, fast in the middle", [{ u: 0, v: 0.2 }, { u: 0.5, v: 1.8 }, { u: 1, v: 0.2 }]],
    ];
    const label = document.createElement("span");
    label.textContent = "Speed";
    label.title = "How fast the bone goes through the picked block (not how many frames it has). Drag a point; double-click to add or remove one.";
    this.graphBar.append(label);
    for (const [text, tip, points] of presets) {
      const b = this.button(text, tip);
      b.addEventListener("click", () => this.setGraph(points === FLAT_SPEED ? null : points));
      this.graphBar.append(b);
    }
    this.graphCanvas.className = "lp-graph-canvas";
    this.graphCanvas.setAttribute("aria-label", "Block speed graph");
    this.graphCanvas.addEventListener("pointerdown", (e) => this.graphDown(e));
    this.graphCanvas.addEventListener("pointermove", (e) => this.graphMove(e));
    this.graphCanvas.addEventListener("pointerup", () => { this.graphDrag = -1; });
    this.graphCanvas.addEventListener("dblclick", (e) => this.graphDouble(e));
    const field = (input: HTMLInputElement, label: HTMLLabelElement, text: string, tip: string, aria: string, step: string, min: string, run: () => void, extra?: HTMLElement): void => {
      input.type = "number";
      input.step = step;
      input.min = min;
      input.className = "time-field";
      input.title = tip;
      input.setAttribute("aria-label", aria);
      input.addEventListener("change", run);
      label.className = "lp-field";
      label.append(`${text} `, input);
      if (extra) label.append(extra);
    };
    field(this.framesField, this.framesBox, "Total frames", "How many frames the path takes, counting frame 0: 15 is 14 + 0 (the loop goes 0 to 14, then to 0 again)", "Total frames", "1", "4", () => this.setFrames(), this.framesHint);
    field(this.frameField, this.frameBox, "Node time frame", "The picked node time's frame", "Node time frame", "1", "1", () => this.setPickedFrame());
    field(this.speedField, this.speedBox, "Time ×", "The picked block's time multiplier: 1 is even; 2 covers twice as much of the path in it", "Block time multiplier", "0.1", "0.1", () => this.setPickedSpeed());
    this.closedBox.type = "checkbox";
    this.closedBox.addEventListener("change", () => this.setClosed(this.closedBox.checked));
    this.closedLabel.className = "lp-field";
    this.closedLabel.title = "A ring: the last spline node joins the first, so the path comes back to where it began (on by default)";
    this.closedLabel.append(this.closedBox, " Closed");
    this.motionBar.append(this.motionBtns.draw, this.motionBtns.time, this.motionBtns.add, this.motionBtns.del, this.motionBtns.addTime, this.motionBtns.delTime, this.framesBox, this.closedLabel, this.frameBox, this.speedBox, this.motionBtns.bakeTl, this.motionBtns.drop, this.motionInfo);
    this.motionBtns.addTime.addEventListener("click", () => this.addTimeHere());
    this.motionBtns.delTime.addEventListener("click", () => this.removePickedTime());
    this.motionBtns.draw.addEventListener("click", () => this.enterDraw());
    this.motionBtns.time.addEventListener("click", () => this.enterTime());
    this.motionBtns.bakeTl.addEventListener("click", () => this.bakeToTimeline());
    this.motionBtns.add.className = "add";
    this.motionBtns.add.addEventListener("click", () => { if (motionFor(this.session)) this.addNode(); else this.enterDraw(); });
    this.motionBtns.del.addEventListener("click", () => this.removeNode());
    this.motionBtns.drop.addEventListener("click", () => { const m = motionFor(this.session); if (m) { dropMotion(this.session, m.animation, m.bone); this.selNode = -1; this.selTime = -1; } });
    this.element.append(this.head, this.motionBar, this.slotBar, this.graphBar, this.body);
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
    this.canvas.addEventListener("dblclick", (e) => { const [x, y] = localPoint(this.canvas, e); if (!this.resetHandleAt(x, y) && !this.insertNodeAt(x, y) && !this.addTimeAt(x, y)) this.fitView(); });
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("keydown", (e) => {
      if ((e.key !== "Delete" && e.key !== "Backspace") || !motionFor(this.session)) return;
      if (this.mode === "draw" && this.selNode >= 0) { e.preventDefault(); e.stopPropagation(); this.removeNode(); }
      else if (this.mode === "time" && this.selTime > 0) { e.preventDefault(); e.stopPropagation(); this.removePickedTime(); }
    });
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    session.onChange(() => { this.syncFromBone(); this.schedule(); });
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
    const s = this.session, doc = s.closedDoc()!;
    if (this.poser?.doc !== doc || this.poser.images !== s.images) this.poser = { doc, images: s.images, value: new Poser(doc, s.images) };
    return this.poser.value;
  }

  /** The trail of the selected bone in the animation shown, worked out again only when the document, skin, animation, bone or space changed. */
  private trail(): { trail: BoneTrail | null; bone: string; extent: Box | null } | string {
    const s = this.session, doc = s.closedDoc(), anim = s.animation, bone = s.selectedBone;
    if (!doc) return "Nothing open.";
    if (bone === null) return anim ? "Select a bone to see its path." : "Select a bone to see it on the setup pose.";
    const name = anim?.name ?? null, c = this.cached;
    if (!c || c.doc !== doc || c.images !== s.images || c.skin !== s.skin || c.animation !== name || c.bone !== bone || c.space !== this.space || c.children !== this.show.children) {
      const poser = this.posers();
      const trail = anim ? boneTrail(poser, s.skin, anim.name, bone, s.fps, s.length(anim), this.space) : null;
      const extent = extentOf(poser, s.skin, name, bone, this.space, s.fps, trail?.frames ?? 0, this.show.children);
      this.cached = { doc, images: s.images, skin: s.skin, animation: name, bone, space: this.space, trail, extent, children: this.show.children };
      // New content: shown whole.
      if (!c || c.bone !== bone || c.animation !== name || c.space !== this.space) { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.hold = false; }
    }
    const c2 = this.cached!;
    return c2.trail || (!anim && c2.extent) ? { trail: c2.trail, bone, extent: c2.extent } : `${bone} has no pose in this skin.`;
  }

  private draw(): void {
    const s = this.session, r = this.trail();
    for (const k of ["local", "world"] as const) this.spaceBtns[k].setAttribute("aria-pressed", String(this.space === k));
    for (const l of LAYERS) this.layerBtns[l].setAttribute("aria-pressed", String(this.show[l]));
    this.updateMotionBar();
    this.axesBtn.textContent = this.axes === "parent" ? "Axes: Parent" : "Axes: World";
    this.axesBtn.title = this.axes === "parent" ? "The move arrows follow the parent's axes; press for the world's" : "The move arrows follow the world's axes; press for the parent's";
    const width = Math.max(1, Math.floor(this.body.clientWidth)), height = Math.max(1, Math.floor(this.body.clientHeight)), dpr = (window.devicePixelRatio || 1) * pageScale();
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
      this.title.textContent = "Motion Path";
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
    // The stored poses are in view too, so a node can always be reached.
    const path = motionFor(s);
    if (path && this.space === "local") for (const n of path.nodes) grow(n.x, n.y);
    if (!Number.isFinite(minX)) { this.note.textContent = `${bone} has no pose in this animation.`; this.note.hidden = false; return; }
    if (this.hold && this.box) ({ minX, maxX, minY, maxY } = this.box);
    else this.box = { minX, maxX, minY, maxY };
    const pad = 28, w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
    // The fit, then the zoom and pan on top of it.
    const k = Math.max(Math.min((width - 2 * pad) / w, (height - 2 * pad) / h), 1e-6) * this.zoom;
    const at = (x: number, y: number): [number, number] => [width / 2 + this.pan.x + (x - (minX + maxX) / 2) * k, height / 2 + this.pan.y - (y - (minY + maxY) / 2) * k];
    // The Stage's own backdrop under it all: background, checkerboard, grid and centre axes, in the same world units.
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    this.mapping = { width, height, k, cx, cy };
    this.handle = null;
    this.arrows = [];
    this.tag = null;
    this.nodePts = [];
    this.handlePts = [];
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
    if (trail && index !== undefined && p.rig.active[index] && !constraintDriving(s.doc!, bone)) { if (!motionFor(s)) this.drawArrows(g, p, index, to, at); this.drawHandle(g, p, index, to, at, accent); }
    g.fillStyle = text;
    g.font = `11px "JetBrains Mono", monospace`;
    g.textBaseline = "top";
    g.fillText(trail ? `frame ${here} of ${trail.frames} · ${trail.fps} fps · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}` : `setup pose · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}`, 8, 6);
  }

  /** Onion skin: the bone (its image, and the bone) at the frames either side of the playhead, farthest first, past red and future green when colour-coded. */
  private drawOnion(g: CanvasRenderingContext2D, poser: Poser, bone: string, trail: BoneTrail, here: number, at: (x: number, y: number) => [number, number], dpr: number, boneColour: string): void {
    const s = this.session, a = s.animation!, o = this.onion(), end = timeFrame(s.length(a), trail.fps);
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
      if (f === here) { g.fillStyle = "#ffffff"; g.strokeStyle = DOT; g.lineWidth = 3; g.arc(px, py, 6, 0, Math.PI * 2); g.fill(); g.stroke(); continue; }
      g.fillStyle = DOT;
      g.globalAlpha = keyed.has(f) ? 1 : 0.65;
      g.arc(px, py, keyed.has(f) ? 4 : 2, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
    this.marks = Float64Array.from(marks);
    if (this.show.length) this.drawLengths(g, trail, at);
    this.drawMotion(g, at, c.accent);
    this.drawTag(g, trail, bone, here);
  }

  /** The two move arrows at the bone's joint (x red, y green), along the parent's or the world's axes; a press on one drags the bone along it only. */
  private drawArrows(g: CanvasRenderingContext2D, p: Posed, index: number, to: (x: number, y: number) => [number, number], at: (x: number, y: number) => [number, number]): void {
    const m = boneMatrix(p, index), [jx, jy] = at(...to(m[4], m[5]));
    if (![jx, jy].every(Number.isFinite)) return;
    const axes = spaceAxes(this.axes, m, parentMatrix(p, index)), len = 46;
    g.save();
    g.lineWidth = 2;
    g.lineCap = "round";
    ([0, 1] as const).forEach((axis) => {
      const [ax, ay] = axes[axis], ex = jx + ax * len, ey = jy - ay * len, angle = Math.atan2(ey - jy, ex - jx);
      g.strokeStyle = g.fillStyle = AXIS_COLOURS[axis];
      g.globalAlpha = this.edit?.axis === axis ? 1 : 0.9;
      g.beginPath(); g.moveTo(jx, jy); g.lineTo(ex, ey); g.stroke();
      g.beginPath();
      g.moveTo(ex + Math.cos(angle) * 6, ey + Math.sin(angle) * 6);
      g.lineTo(ex + Math.cos(angle + 2.5) * 7, ey + Math.sin(angle + 2.5) * 7);
      g.lineTo(ex + Math.cos(angle - 2.5) * 7, ey + Math.sin(angle - 2.5) * 7);
      g.closePath();
      g.fill();
      this.arrows.push({ axis, x0: jx, y0: jy, x1: ex, y1: ey });
    });
    g.restore();
  }

  /** The axis of the arrow a canvas point is on (not within the joint's own grab), or null. */
  private arrowAt(x: number, y: number): 0 | 1 | null {
    for (const a of this.arrows) {
      if (Math.hypot(x - a.x0, y - a.y0) <= 12) continue;
      const dx = a.x1 - a.x0, dy = a.y1 - a.y0, t = Math.max(0, Math.min(1, ((x - a.x0) * dx + (y - a.y0) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(x - (a.x0 + dx * t), y - (a.y0 + dy * t)) <= 7) return a.axis;
    }
    return null;
  }

  /** The rotation handle: a ring a little beyond the bone's tip, on the line from its joint; drag it to turn the bone at the playhead. */
  private drawHandle(g: CanvasRenderingContext2D, p: Posed, index: number, to: (x: number, y: number) => [number, number], at: (x: number, y: number) => [number, number], accent: string): void {
    const m = boneMatrix(p, index), [jx, jy] = at(...to(m[4], m[5])), [tx, ty] = at(...to(...boneTip(p, index)));
    if (![jx, jy, tx, ty].every(Number.isFinite)) return;
    const len = Math.hypot(tx - jx, ty - jy), ux = len > 1e-6 ? (tx - jx) / len : 1, uy = len > 1e-6 ? (ty - jy) / len : 0;
    const hx = tx + ux * 16, hy = ty + uy * 16, on = this.edit?.kind === "rotate";
    this.handle = { x: hx, y: hy };
    g.save();
    g.strokeStyle = accent;
    g.globalAlpha = 0.7;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.stroke();
    g.globalAlpha = 1;
    g.lineWidth = 2;
    g.fillStyle = on ? accent : "#ffffff";
    g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill(); g.stroke();
    // A short arc round it says "turns".
    g.beginPath(); g.arc(hx, hy, 10, Math.atan2(uy, ux) - 1, Math.atan2(uy, ux) + 1); g.stroke();
    g.restore();
  }

  /** What can be grabbed, on the canvas as last drawn: each frame's mark (x, y pairs) and the rotation handle; for tests. */
  get grabPoints(): { marks: readonly number[]; handle: { x: number; y: number } | null; tag: { x0: number; y0: number; x1: number; y1: number } | null; nodes: readonly { x: number; y: number }[]; handles: readonly { slot: number; side: "out" | "in"; x: number; y: number }[]; times: readonly { i: number; x: number; y: number }[]; arrows: readonly { axis: 0 | 1; x0: number; y0: number; x1: number; y1: number }[] } {
    return { marks: [...this.marks], handle: this.handle, tag: this.tag, nodes: this.nodePts, handles: this.handlePts, times: this.timePts, arrows: this.arrows };
  }

  /** The bone's space (what the panel shows) at a canvas point: the inverse of the mapping `draw` made. */
  private spaceAt(x: number, y: number): [number, number] | null {
    const m = this.mapping;
    if (!m) return null;
    return [(x - m.width / 2 - this.pan.x) / m.k + m.cx, m.cy - (y - m.height / 2 - this.pan.y) / m.k];
  }

  /** The frame of the mark nearest a canvas point within the grab radius, or -1. */
  private markAt(x: number, y: number): number {
    let best = -1, bestD = 12;
    for (let f = 0; f * 2 < this.marks.length; f++) {
      const d = Math.hypot(this.marks[f * 2]! - x, this.marks[f * 2 + 1]! - y);
      if (d <= bestD) { best = f; bestD = d; }
    }
    return best;
  }

  /**
   * Begin editing the selected bone from a press: on the rotation handle, turn the bone at the
   * playhead; on a mark, go to that frame and move the joint. True when the press was an edit's.
   */
  private beginEdit(x: number, y: number, kind: "move" | "rotate", frame: number, axis: 0 | 1 | null = null): boolean {
    const s = this.session, bone = s.selectedBone, doc = s.doc, anim = s.animation;
    if (!doc || bone === null || !anim) return false;
    const driver = constraintDriving(doc, bone);
    if (driver) {
      s.seek(frame);
      this.onStatus(`${bone} is placed by the ${driver.type} constraint ${driver.name}: its keys do not move it.${driver.target ? ` Drag ${driver.target} instead.` : ""}`);
      return true;
    }
    s.pause();
    this.hold = true;
    if (kind === "move") s.seek(frame);
    const p = s.pose(), index = p?.bones.get(bone), b = doc.bones?.find((o) => o.name === bone);
    if (!p || index === undefined || !b) return false;
    const parent = parentMatrix(p, index), matrix = boneMatrix(p, index), unkeyed = !this.autoKey() || this.drawing;
    const to = (px: number, py: number): [number, number] => (this.space === "local" ? fromParent(p, index, px, py) : [px, py]);
    const joint = to(matrix[4], matrix[5]), at = this.spaceAt(x, y) ?? joint;
    this.edit = {
      bone, kind, frame: s.frame, from: animatedLocal(p, index), parent, axis, axes: spaceAxes(this.axes, matrix, parent), start: [x, y],
      key: unkeyed ? null : { animation: anim.name, time: s.keyTime },
      joint, matrix, sign: turnSign(parent, boneInherit(b), p.rig.scaleX * p.rig.scaleY < 0), inherit: boneInherit(b), last: at, turned: 0,
    };
    if (unkeyed) this.onStatus(`Unkeyed pose of ${bone}: press Key to key it; moving the playhead drops it.`);
    else s.history!.begin(kind === "move" ? `Move ${bone} at frame ${s.frame}` : `Rotate ${bone} at frame ${s.frame}`);
    return true;
  }

  /** One step of the edit drag: the bone's new local pose from where the pointer is. */
  private editTo(x: number, y: number, shift: boolean): void {
    const e = this.edit, m = this.mapping, s = this.session;
    if (!e || !m) return;
    let local: LocalPose, property: BoneProperty, said: string;
    if (e.kind === "move") {
      // With the parent held, a shift is the same in Local and in World: the pointer's, in the bone's space.
      let dx = (x - e.start[0]) / m.k, dy = -(y - e.start[1]) / m.k;
      if (e.axis !== null) {
        // Held to the arrow's axis: only the pointer's part along it.
        const a = e.axes[e.axis], along = dx * a[0] + dy * a[1];
        [dx, dy] = [a[0] * along, a[1] * along];
      } else if (shift) [dx, dy] = axisLocked(dx, dy);
      const moved = shiftedLocal(e.parent, e.from, dx, dy);
      local = { ...e.from, ...moved };
      property = "translate";
      said = `${e.bone} · frame ${e.frame} · x ${moved.x}, y ${moved.y}${e.axis !== null ? ` · along the ${this.axes} ${e.axis === 0 ? "x" : "y"}` : ""}`;
    } else {
      const at = this.spaceAt(x, y);
      if (!at) return;
      // Summed step by step, so a drag round the bone more than half a turn keeps going (as on the Stage).
      e.turned += turn(e.joint, e.last, at);
      e.last = at;
      const rough = e.from.rotation + e.turned * e.sign;
      let r = e.inherit === "normal" ? localRotation(e.parent, (Math.atan2(e.matrix[2], e.matrix[0]) * 180) / Math.PI + e.turned, e.from.shearX, e.from.scaleX, rough) : rough;
      if (shift) r = Math.round(r / 15) * 15;
      r = tidy(r, 2);
      local = { ...e.from, rotation: r };
      property = "rotate";
      said = `${e.bone} · frame ${e.frame} · rotation ${r}°`;
    }
    try {
      if (e.key === null) s.setUnkeyed(e.bone, local);
      else s.history!.apply("step", keyBone(e.key.animation, e.bone, [property], local, e.key.time));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return;
    }
    this.onStatus(said);
    s.changed();
  }

  /** The distance between each pair of neighbouring dots, at the middle of the segment between them, as a number in the panel's space; left out where the segment is too short on the canvas to hold it. */
  private drawLengths(g: CanvasRenderingContext2D, trail: BoneTrail, at: (x: number, y: number) => [number, number]): void {
    g.save();
    g.font = `10px "JetBrains Mono", monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = DOT;
    let lastRight = -Infinity;
    for (let f = 0; f < trail.frames; f++) {
      const x0 = trail.joint[f * 2]!, y0 = trail.joint[f * 2 + 1]!, x1 = trail.joint[f * 2 + 2]!, y1 = trail.joint[f * 2 + 3]!;
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      const [ax, ay] = at(x0, y0), [bx, by] = at(x1, y1), px = Math.hypot(bx - ax, by - ay);
      const text = String(Math.round(Math.hypot(x1 - x0, y1 - y0) * 10) / 10), w = g.measureText(text).width;
      // Only where the number fits on its segment, and not on the one before it.
      if (px < w + 10) continue;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (mx - w / 2 < lastRight + 4) continue;
      // To the side of the line, so the number does not sit on it.
      const nx = -(by - ay) / px, ny = (bx - ax) / px, side = ny > 0 ? -1 : 1;
      g.fillText(text, mx + nx * side * 9, my + ny * side * 9);
      lastRight = mx + w / 2;
    }
    g.restore();
  }

  /**
   * The frame tag by the playhead's dot: its frame number in green, and beside it the time since
   * the bone's last key before it ("+0.17s"). Drag it along the path and the playhead follows,
   * frame by frame, to the dot nearest the pointer.
   */
  private drawTag(g: CanvasRenderingContext2D, trail: BoneTrail, bone: string, here: number): void {
    const px = this.marks[here * 2], py = this.marks[here * 2 + 1];
    if (px === undefined || py === undefined || !Number.isFinite(px) || !Number.isFinite(py)) return;
    let last = -1;
    for (const group of this.session.animation?.bones ?? []) if (group.name === bone) for (const t of group.timelines) for (const key of t.keys) {
      const f = Math.round((key.time ?? 0) * trail.fps);
      if (f < here && f > last) last = f;
    }
    const label = String(here), since = last >= 0 ? `+${((here - last) / trail.fps).toFixed(2)}s` : null;
    g.save();
    g.font = `600 11px "JetBrains Mono", monospace`;
    g.textBaseline = "middle";
    g.textAlign = "center";
    const w = Math.ceil(g.measureText(label).width) + 10, h = 15, x0 = px + 10, y0 = py + 12;
    g.fillStyle = "#30a46c";
    g.beginPath(); g.roundRect(x0, y0, w, h, 4); g.fill();
    g.fillStyle = "#ffffff";
    g.fillText(label, x0 + w / 2, y0 + h / 2 + 0.5);
    this.tag = { x0, y0, x1: x0 + w, y1: y0 + h };
    if (since) {
      g.font = `10px "JetBrains Mono", monospace`;
      g.textAlign = "left";
      g.fillStyle = "#30a46c";
      g.fillText(since, x0 + w + 5, y0 + h / 2 + 0.5);
    }
    g.restore();
  }

  /** Whether a canvas point is on the frame tag. */
  private onTag(x: number, y: number): boolean {
    const t = this.tag;
    return !!t && x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1;
  }

  /** Put the playhead on the dot nearest a canvas point. */
  private scrubTo(x: number, y: number): void {
    let best = -1, bestD = Infinity;
    for (let f = 0; f * 2 < this.marks.length; f++) {
      const d = Math.hypot(this.marks[f * 2]! - x, this.marks[f * 2 + 1]! - y);
      if (d < bestD) { best = f; bestD = d; }
    }
    if (best >= 0 && best !== this.session.frame) this.session.seek(best);
  }

  /** The row of path buttons: what can be done for the selected bone in the animation shown, and what the path is. */
  private updateMotionBar(): void {
    const s = this.session, m = motionFor(s), bone = s.selectedBone, anim = s.animation;
    const can = !!anim && bone !== null && !(s.doc && constraintDriving(s.doc, bone));
    this.motionBar.hidden = !can;
    const draw = !!m && this.mode === "draw", time = !!m && this.mode === "time";
    // Without a path the one button is Edit Path (it starts one); with a path the two modes.
    this.motionBtns.draw.hidden = !can;
    this.motionBtns.time.hidden = !m;
    this.motionBtns.drop.hidden = !m;
    // The green +: no path yet, it makes one (node 1 is where the bone is, node 2 that plus an offset); in Edit Path it adds a node.
    this.motionBtns.add.hidden = !can || (!!m && !draw);
    this.motionBtns.add.setAttribute("aria-label", m ? "Add a spline node" : "Create a path");
    this.motionBtns.add.title = m ? "Add another spline node (the last plus the offset): then move the bone or drag the node to place it" : "Make a path for this bone: node 1 is where it is, node 2 that plus an offset";
    this.motionBtns.del.hidden = !draw;
    for (const k of ["addTime", "delTime", "bakeTl"] as const) this.motionBtns[k].hidden = !time;
    this.motionBtns.draw.setAttribute("aria-pressed", String(draw));
    this.motionBtns.time.setAttribute("aria-pressed", String(time));
    this.motionBtns.del.disabled = !m || m.nodes.length <= 2 || this.selNode < 0;
    // Edit Path shapes the spline (a ring or not); Adjust time sets the timing (total frames, node times, blocks).
    this.framesBox.hidden = !time;
    this.closedLabel.hidden = !draw;
    const times = m ? nodeTimeFrames(m) : [], blocks = m ? blocksOf(m) : [];
    if (this.selTime >= times.length) this.selTime = -1;
    this.motionBtns.delTime.disabled = this.selTime <= 0 || times.length <= 2;
    this.frameBox.hidden = !time || this.selTime < 1;
    this.speedBox.hidden = !time || this.selTime < 0;
    const idle = (el: HTMLInputElement) => el.ownerDocument.activeElement !== el;
    if (m) {
      if (idle(this.framesField)) this.framesField.value = String(m.frames);
      this.framesHint.textContent = m.closed ? `(${m.frames - 1} + 0)` : "";
      this.closedBox.checked = m.closed;
      if (this.selTime >= 1 && idle(this.frameField)) this.frameField.value = String(times[this.selTime]!);
      if (this.selTime >= 0 && idle(this.speedField)) this.speedField.value = String(blocks[this.selTime]!.speed);
    }
    this.renderStrip(m);
    this.drawGraph(m && time ? m : undefined);
    if (!m) { this.motionInfo.textContent = ""; return; }
    const stale = motionStale(s, m), unbaked = m.baked === undefined, changed = motionChanged(m);
    this.motionInfo.textContent = `${m.nodes.length} spline nodes · ${times.length} node times${unbaked ? " · not baked to the timeline" : stale ? " · timeline keys changed since the last bake" : changed ? " · changed since the last bake to the timeline" : ""}${this.stray !== null && !unbaked && !stale && !changed ? ` · strays ${Math.round(this.stray * 10) / 10}` : ""}`;
    this.motionBtns.bakeTl.classList.toggle("attention", unbaked || stale || changed);
    if (this.space !== "local") this.motionInfo.textContent += " · nodes edit in Local";
  }

  /**
   * The strip under the path row: in Edit Path a green numbered button for each spline node and the green + (the capture bar,
   * docs/PATH-CAPTURE-PLAN.md); in Adjust time a tab for each block (its frames and its multiplier).
   */
  private renderStrip(m: MotionPath | undefined): void {
    this.slotBar.hidden = !m;
    const sig = !m ? "" : (this.mode === "draw" ? `d|${JSON.stringify(m.nodes)}|${this.selNode}` : `t|${JSON.stringify([m.starts, m.speeds, m.frames, m.closed, m.curves ?? []])}|${this.selTime}`);
    if (sig === this.slotSig) return;
    this.slotSig = sig;
    const make = (cls: string, text: string, title: string, run: (e: MouseEvent) => void): HTMLButtonElement => {
      const b = this.button(text, title);
      b.className = cls;
      b.addEventListener("click", run);
      return b;
    };
    if (!m) { this.slotBar.replaceChildren(); return; }
    if (this.mode === "draw") {
      const items = m.nodes.map((n, i) => {
        const label = nodeLabels(m)[i]!;
        const b = make(`slot node${i === this.selNode ? " picked" : ""}`, `${label}`,
          `Spline node ${label}: x ${n.x}, y ${n.y}. Press to put the bone there; then moving the bone moves the node. Drag it along the numbers to move it in the order.`,
          () => { if (this.suppressClick) { this.suppressClick = false; return; } this.pickSlot(i); });
        b.setAttribute("aria-label", `Spline node ${label}`);
        this.nodeDragStart(b, i);
        // Right-click: make this node the origin (the path starts there and goes round in the same order).
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const ring = motionFor(this.session)?.closed ?? false;
          showContextMenu(e.clientX, e.clientY, [{
            label: `Set ${label} to Origin`,
            disabled: i === 0 || !ring,
            run: () => this.setOrigin(i),
          }]);
        });
        return b;
      });
      this.slotBar.replaceChildren(...items);
      return;
    }
    const tabs = blocksOf(m).map((b, i) => {
      const t = make(`slot block${i === this.selTime ? " picked" : ""}`, `${b.start}→${b.end}${b.speed !== 1 ? ` ×${b.speed}` : ""}${b.graph.some((q) => q.v !== 1) ? " ∿" : ""}`,
        `Block ${i + 1}: frames ${b.start} to ${b.end}, time multiplier ${b.speed}. Press to pick it (its node time and its multiplier).`, () => this.pickTime(i));
      t.setAttribute("aria-label", `Block ${i + 1}`);
      return t;
    });
    this.slotBar.replaceChildren(...tabs);
  }

  /** The graph's drawing box inside its canvas, and the speeds it shows (0 to GRAPH_TOP). */
  private graphPoint(p: SpeedPoint, w: number, h: number): { x: number; y: number } {
    return { x: 8 + p.u * (w - 16), y: h - 8 - (p.v / GRAPH_TOP) * (h - 16) };
  }

  private drawGraph(m: MotionPath | undefined): void {
    const block = m && this.selTime >= 0 ? blocksOf(m)[this.selTime] : undefined;
    this.graphBar.hidden = !block;
    // The canvas is in the page only while a block is picked (the panel's own canvas stays the only one otherwise).
    if (!block || !m) { this.graphDots = []; this.graphCanvas.remove(); return; }
    if (!this.graphCanvas.isConnected) this.graphBar.append(this.graphCanvas);
    const c = this.graphCanvas, dpr = window.devicePixelRatio || 1, w = 240, h = 72;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; }
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(this.element), line = css.getPropertyValue("--line").trim() || "#555", accent = css.getPropertyValue("--accent").trim() || "#4a90e2", muted = css.getPropertyValue("--muted").trim() || "#999";
    g.strokeStyle = line;
    g.strokeRect(0.5, 0.5, w - 1, h - 1);
    const one = this.graphPoint({ u: 0, v: 1 }, w, h).y;
    g.setLineDash([3, 3]);
    g.strokeStyle = muted;
    g.beginPath(); g.moveTo(8, one); g.lineTo(w - 8, one); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = accent;
    g.lineWidth = 2;
    g.beginPath();
    block.graph.forEach((p, i) => { const q = this.graphPoint(p, w, h); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); });
    g.stroke();
    g.lineWidth = 1;
    this.graphDots = block.graph.map((p) => this.graphPoint(p, w, h));
    g.fillStyle = accent;
    for (const q of this.graphDots) { g.beginPath(); g.arc(q.x, q.y, 4, 0, Math.PI * 2); g.fill(); }
  }

  /** The speed graph's points on its canvas (test hook). */
  get speedGraph(): readonly { x: number; y: number }[] {
    return this.graphDots;
  }

  private graphAt(e: MouseEvent): { u: number; v: number; x: number; y: number } {
    const r = this.graphCanvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, w = 240, h = 72;
    return { x, y, u: Math.min(1, Math.max(0, (x - 8) / (w - 16))), v: Math.min(GRAPH_TOP, Math.max(0.05, ((h - 8 - y) / (h - 16)) * GRAPH_TOP)) };
  }

  private graphHit(x: number, y: number): number {
    return this.graphDots.findIndex((q) => Math.hypot(q.x - x, q.y - y) <= 8);
  }

  private graphDown(e: PointerEvent): void {
    const a = this.graphAt(e);
    this.graphDrag = this.graphHit(a.x, a.y);
    if (this.graphDrag >= 0) this.graphCanvas.setPointerCapture?.(e.pointerId);
  }

  private graphMove(e: PointerEvent): void {
    const m = motionFor(this.session);
    if (!m || this.selTime < 0 || this.graphDrag < 0 || !(e.buttons & 1)) return;
    const graph = [...blocksOf(m)[this.selTime]!.graph], i = this.graphDrag, a = this.graphAt(e), last = graph.length - 1;
    const u = i === 0 ? 0 : i === last ? 1 : Math.min(graph[i + 1]!.u - 0.02, Math.max(graph[i - 1]!.u + 0.02, a.u));
    graph[i] = { u, v: a.v };
    this.setGraph(graph);
  }

  /** A double click on a point removes it (not the two ends); on empty graph it adds one there. */
  private graphDouble(e: MouseEvent): void {
    const m = motionFor(this.session);
    if (!m || this.selTime < 0) return;
    const graph = [...blocksOf(m)[this.selTime]!.graph], a = this.graphAt(e), hit = this.graphHit(a.x, a.y);
    if (hit >= 0) {
      if (hit === 0 || hit === graph.length - 1) return;
      graph.splice(hit, 1);
    } else {
      const at = graph.findIndex((p) => p.u > a.u);
      if (at <= 0 || graph[at]!.u - a.u < 0.02 || a.u - graph[at - 1]!.u < 0.02) return;
      graph.splice(at, 0, { u: a.u, v: a.v });
    }
    this.setGraph(graph);
  }

  /** The picked block's speed graph set (null: the straight line). */
  private setGraph(graph: readonly SpeedPoint[] | null): void {
    const m = motionFor(this.session);
    if (!m || this.selTime < 0) return;
    try { this.timeEdit(withBlockGraph(m, this.selTime, graph)); }
    catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  /** Pick a node time (and the block it starts): its frame and its multiplier show in the path row. */
  private pickTime(i: number): void {
    this.selTime = i;
    this.slotSig = "";
    this.schedule();
    // The Timeline's block tabs show the pick too.
    this.session.changed();
  }

  /**
   * An arrow key while the pointer is over this panel: in Edit Path the picked node moves by one step (Shift: the big step) and the bone
   * goes with it; in Adjust time nothing moves. False when the bone has no path, so the key goes on to the bone as anywhere else.
   */
  nudge(dir: "left" | "right" | "up" | "down", big: boolean, step: number, bigFactor: number): boolean {
    const s = this.session, m = motionFor(s);
    if (!m) return false;
    if (this.mode !== "draw") return true;
    const n = m.nodes[this.selNode];
    if (!n) { this.onStatus("Pick a node first (press its number, or Q and W)."); return true; }
    const d = step * (big ? bigFactor : 1), dx = dir === "left" ? -d : dir === "right" ? d : 0, dy = dir === "up" ? d : dir === "down" ? -d : 0;
    const x = Math.round((n.x + dx) * 1e4) / 1e4, y = Math.round((n.y + dy) * 1e4) / 1e4;
    keepMotion(s, { ...m, nodes: m.nodes.map((q, i) => (i === this.selNode ? { ...q, x, y } : q)) });
    poseAtNode(s, x, y);
    return true;
  }

  /**
   * Q and W while this panel has the keys: the previous or next node (Edit Path: the bone goes to it) or node time (Adjust
   * time). A ring goes round; an open path stops at its ends. False when there is nothing to step through here.
   */
  stepNode(dir: -1 | 1): boolean {
    const m = motionFor(this.session);
    if (!m) return false;
    const count = this.mode === "draw" ? m.nodes.length : nodeTimeFrames(m).length, at = this.mode === "draw" ? this.selNode : this.selTime;
    if (count < 1) return false;
    const wrap = this.mode === "time" || m.closed;
    let next = at < 0 ? (dir > 0 ? 0 : count - 1) : at + dir;
    if (next < 0 || next >= count) next = wrap ? (next + count) % count : Math.min(count - 1, Math.max(0, next));
    if (this.mode === "draw") this.pickSlot(next); else this.pickTime(next);
    return true;
  }

  /**
   * Pick a spline node (the one the bone and the node now follow each other for) and pose the bone at it, at
   * the playhead's frame: then dragging the bone moves the node and dragging the node moves the bone.
   */
  private pickSlot(i: number): void {
    const s = this.session, n = motionFor(s)?.nodes[i];
    this.selNode = i;
    if (!n) return;
    s.pause();
    poseAtNode(s, n.x, n.y);
  }

  /** The bone was dragged (unkeyed) on the Stage while a node is picked: the node follows it. */
  private syncFromBone(): void {
    const s = this.session;
    if (!this.drawing || this.selNode < 0 || !s.hasUnkeyed || this.nodeDrag !== null) return;
    // Only when the bone was posed since last time: another session change (a node picked, a handle dragged) must not copy its pose into a node.
    if (s.unkeyedRevision === this.syncRev) return;
    this.syncRev = s.unkeyedRevision;
    const m = motionFor(s), n = m?.nodes[this.selNode];
    if (!m || !n) return;
    const cur = currentNode(s);
    if (!cur || Math.hypot(cur.x - n.x, cur.y - n.y) < 1e-3) return;
    keepMotion(s, { ...m, nodes: m.nodes.map((x, i) => (i === this.selNode ? { ...n, x: cur.x, y: cur.y } : x)) });
  }

  /** Edit Path: start a path for the bone (two spline nodes: where it is, and that plus an offset), or go back to drawing the one it has. */
  private enterDraw(): void {
    const s = this.session, m = motionFor(s);
    if (!m) {
      const started = startMotion(s);
      if (!started) { this.onStatus("Select a bone in Animate mode, then Edit Path."); return; }
      keepMotion(s, started);
      // Node 2 is picked and the bone goes to it; node 1 is one press away.
      this.pickSlot(1);
      this.onStatus(`${started.bone}: two spline nodes (where it is, and an offset). Press a number to put the bone on that node, then move the bone or drag the node; + adds a node; then Bake.`);
    }
    this.mode = "draw";
    this.slotSig = "";
    this.schedule();
  }

  /**
   * Adjust time (the mode button): the spline is done, so the path is baked as it stands (its nodes and handles are kept and
   * the bone goes back to the animation's pose) and only the timing can be edited: node times, blocks, total frames. Nothing
   * is written to the timeline until Bake to timeline.
   */
  private enterTime(): void {
    const m = motionFor(this.session);
    if (!m) return;
    if (this.mode !== "time") this.selTime = -1;
    this.mode = "time";
    this.nodeDrag = null;
    this.handleDrag = null;
    this.session.clearUnkeyed();
    this.slotSig = "";
    this.onStatus(`${m.bone}: the spline is set. Adjust time: add or remove node times and set each block's multiplier, then Bake to timeline.`);
    this.schedule();
  }

  /**
   * Drag a numbered button along the strip to move that node to another place in the path's order. While it is held a red
   * arrow carrying its number shows the gap it would go into; the status line says the order the path would run in
   * and the canvas draws that path. Let go outside the strip, or press Escape, to leave it as it was.
   */
  private nodeDragStart(b: HTMLButtonElement, from: number): void {
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const m0 = motionFor(this.session);
      if (!m0) return;
      const x0 = e.clientX, y0 = e.clientY, bar = this.slotBar, cells = [...bar.querySelectorAll<HTMLButtonElement>("button.node")];
      let arrow: HTMLElement | null = null, to = -1, moved = false;
      // The place the node would take: the gap the pointer is over (before the cell whose middle is past it), as an index; -1 outside the strip or where it already is.
      const place = (cx: number, cy: number): number => {
        const r = bar.getBoundingClientRect();
        if (cy < r.top - 24 || cy > r.bottom + 24 || cx < r.left - 24 || cx > r.right + 24) return -1;
        const gap = cells.filter((q) => { const c = q.getBoundingClientRect(); return (c.left + c.right) / 2 < cx; }).length, at = gap > from ? gap - 1 : gap;
        return at === from ? -1 : at;
      };
      const gapX = (at: number): number => {
        // The gap's x: before the cell now at `at` when moving left, after it when moving right.
        const q = cells[at]!.getBoundingClientRect(), r = bar.getBoundingClientRect();
        return (at > from ? q.right : q.left) - r.left;
      };
      const show = (): void => {
        const preview = to >= 0 ? moveNode(m0, from, to) : null;
        cells.forEach((q, k) => q.classList.toggle("dragging", k === from && moved));
        if (arrow) {
          arrow.hidden = to < 0;
          if (to >= 0) arrow.style.left = `${gapX(to)}px`;
        }
        this.nodePreview = preview ? { motion: preview, from } : null;
        if (moved) this.onStatus(preview ? `Drop here: the path will run ${nodeLabels(preview).join(", ")}.` : "Drag along the numbers to a gap; let go here to leave the order as it is.");
        this.schedule();
      };
      const finish = (apply: boolean): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", key, true);
        arrow?.remove();
        cells.forEach((q) => q.classList.remove("dragging"));
        this.nodePreview = null;
        if (moved && apply && to >= 0) this.moveNodeTo(from, to);
        else this.schedule();
        // A drag is not a press: the click that follows it must not put the bone on a node.
        if (moved) { this.suppressClick = true; setTimeout(() => { this.suppressClick = false; }, 0); }
      };
      const move = (ev: PointerEvent): void => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        if (!moved) {
          moved = true;
          // The marker: a line on the gap, an arrow under it, the dragged number in the arrow.
          arrow = document.createElement("div");
          arrow.className = "lp-drop-arrow";
          arrow.hidden = true;
          const tag = document.createElement("span");
          tag.textContent = b.textContent;
          arrow.append(tag);
          bar.append(arrow);
          show();
        }
        const next = place(ev.clientX, ev.clientY);
        if (next !== to) { to = next; show(); }
      };
      const up = (): void => finish(true);
      const key = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.stopPropagation(); finish(false); } };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", key, true);
    });
  }

  /** The ring started at the node at place `i`; the picked node stays the one picked. */
  private setOrigin(i: number): void {
    const s = this.session, m = motionFor(s);
    if (!m) return;
    try {
      const next = withOrigin(m, i);
      keepMotion(s, next);
      if (this.selNode >= 0) this.selNode = nodeLabels(next).indexOf(nodeLabels(m)[this.selNode]!);
      this.slotSig = "";
      this.onStatus(`The path now starts at ${nodeLabels(next)[0]} and runs ${nodeLabels(next).join(", ")}.`);
      this.schedule();
    } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  /** The node at place `from` moved to place `to` in the path's order (a number dragged to a gap); it stays the picked one if it was. */
  private moveNodeTo(from: number, to: number): void {
    const s = this.session, m = motionFor(s);
    if (!m || from === to || from < 0 || to < 0 || from >= m.nodes.length || to >= m.nodes.length) return;
    const next = moveNode(m, from, to);
    keepMotion(s, next);
    // The picked node keeps its place in the order as the others shift.
    if (this.selNode === from) this.selNode = to;
    else if (this.selNode >= 0) this.selNode = nodeLabels(next).indexOf(nodeLabels(m)[this.selNode]!);
    this.slotSig = "";
    this.onStatus(`The path now runs ${nodeLabels(next).join(", ")}.`);
    this.schedule();
  }

  /** The green +: another spline node, after the last by the same offset. */
  private addNode(): void {
    const s = this.session, m = motionFor(s);
    if (!m) return;
    keepMotion(s, withNode(m, nodeAfter(s, m.nodes.at(-1)!)));
    this.selNode = m.nodes.length;
    this.slotSig = "";
    this.onStatus("Added a spline node: move the bone (or drag the node) to place it.");
    this.schedule();
  }

  /** Whether the path's time is being adjusted: the bone is not dragged, on the Stage or here, and its spline stays as it is. */
  get timing(): boolean {
    return this.mode === "time" && !!motionFor(this.session);
  }

  /** Whether a path is being drawn for the selected bone: its nodes are stored by posing it, so dragging it writes no keys. */
  get drawing(): boolean {
    return this.mode === "draw" && !!motionFor(this.session);
  }

  /** The ring (dashed); in Edit Path the spline nodes and their handles; in Adjust time the frames' dots and the node times, in Local space. */
  private drawMotion(g: CanvasRenderingContext2D, at: (x: number, y: number) => [number, number], accent: string): void {
    const m = motionFor(this.session);
    if (!m || this.space !== "local" || !this.show.path) return;
    const curve = curveOf(m), draw = this.mode === "draw";
    g.save();
    g.strokeStyle = "#ffffff";
    g.globalAlpha = draw ? 0.55 : 0.35;
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    g.beginPath();
    const steps = Math.max(48, m.nodes.length * 48);
    for (let i = 0; i <= steps; i++) {
      const p = curve.at((curve.length * i) / steps), [x, y] = at(p.x, p.y);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
    const pre = this.nodePreview;
    if (pre && draw) {
      // The path a held number would make: solid in the accent colour, the node being moved ringed.
      const pc = curveOf(pre.motion);
      g.strokeStyle = accent;
      g.lineWidth = 2.5;
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const p = pc.at((pc.length * i) / steps), [x, y] = at(p.x, p.y);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      const held = m.nodes[pre.from];
      if (held) {
        const [x, y] = at(held.x, held.y);
        g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke();
      }
    }
    this.timePts = [];
    if (!draw) {
      // Where the bone will be on each frame (even speed inside a block), and the node times: where a block begins.
      g.fillStyle = DOT;
      g.globalAlpha = 0.45;
      for (let f = 0; f < endFrame(m); f++) {
        const p = placeAtFrame(m, f), [x, y] = at(p.x, p.y);
        g.beginPath(); g.arc(x, y, 2, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      nodeTimeFrames(m).forEach((f, i) => {
        const p = placeAtFrame(m, f), [x, y] = at(p.x, p.y), picked = i === this.selTime;
        this.timePts.push({ i, x, y });
        g.fillStyle = picked ? "#ffffff" : DOT;
        g.strokeStyle = DOT;
        g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, picked ? 7 : 6, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = DOT;
        g.font = `10px "JetBrains Mono", monospace`;
        g.textAlign = "left";
        g.textBaseline = "top";
        g.fillText(`${f}`, x + 9, y + 5);
      });
    }
    m.nodes.forEach((n, i) => {
      const [x, y] = at(n.x, n.y);
      this.nodePts.push({ x, y });
      g.strokeStyle = accent;
      g.lineWidth = 2;
      if (draw) {
        g.fillStyle = i === this.selNode ? accent : "#ffffff";
        g.beginPath(); g.rect(x - 5, y - 5, 10, 10); g.fill(); g.stroke();
        g.fillStyle = "#ffffff";
        g.font = `10px "JetBrains Mono", monospace`;
        g.textAlign = "left";
        g.textBaseline = "bottom";
        g.fillText(String(nodeLabels(m)[i]), x + 7, y - 4);
      } else {
        // Locked while only the time is adjusted: small, hollow, not grabbed.
        g.globalAlpha = 0.6;
        g.lineWidth = 1.5;
        g.beginPath(); g.rect(x - 3, y - 3, 6, 6); g.stroke();
        g.globalAlpha = 1;
      }
    });
    // The curve's hand tools: a handle each side of a node (Edit Path), joined to it by a line; drag one to bend the curve there.
    if (draw) {
      const offs = handleOffsets(m.nodes, m.closed);
      g.lineWidth = 1;
      m.nodes.forEach((n, slot) => {
        const [nx, ny] = at(n.x, n.y);
        for (const side of ["out", "in"] as const) {
          const o = offs[slot]![side];
          if (!o.x && !o.y) continue;
          const [hx, hy] = at(n.x + o.x, n.y + o.y);
          g.strokeStyle = accent;
          g.globalAlpha = slot === this.selNode ? 0.9 : 0.45;
          g.beginPath(); g.moveTo(nx, ny); g.lineTo(hx, hy); g.stroke();
          g.fillStyle = "#ffffff";
          g.beginPath(); g.arc(hx, hy, 4, 0, Math.PI * 2); g.fill(); g.stroke();
          this.handlePts.push({ slot, side, x: hx, y: hy });
        }
      });
      g.globalAlpha = 1;
    }
    g.restore();
  }

  /** The handle under a canvas point, or null. */
  private handleAt(x: number, y: number): { slot: number; side: "out" | "in" } | null {
    let best: { slot: number; side: "out" | "in" } | null = null, bestD = 8;
    for (const h of this.handlePts) { const d = Math.hypot(h.x - x, h.y - y); if (d <= bestD) { best = { slot: h.slot, side: h.side }; bestD = d; } }
    return best;
  }

  /** The handle follows the pointer: the node's tangent is the pointer's offset from it (mirrored for the way in). */
  private dragHandle(x: number, y: number): void {
    const hd = this.handleDrag, m = motionFor(this.session), at = this.spaceAt(x, y);
    if (!hd || !m || !at) return;
    const n = m.nodes[hd.slot];
    if (!n) return;
    const dx = at[0] - n.x, dy = at[1] - n.y, sign = hd.side === "out" ? 1 : -1;
    keepMotion(this.session, { ...m, nodes: m.nodes.map((o, i) => (i === hd.slot ? { ...o, tx: sign * dx, ty: sign * dy } : o)) });
  }

  /** Back to the automatic handle at the one under the point (a double click on it). */
  private resetHandleAt(x: number, y: number): boolean {
    const h = this.handleAt(x, y), m = motionFor(this.session);
    if (!h || !m || this.mode !== "draw") return false;
    keepMotion(this.session, { ...m, nodes: m.nodes.map((o, i) => { if (i !== h.slot) return o; const { tx: _a, ty: _b, ...rest } = o; return rest; }) });
    return true;
  }

  /** The spline node under a canvas point, or -1. */
  private nodeAt(x: number, y: number): number {
    let best = -1, bestD = 9;
    this.nodePts.forEach((n, i) => { const d = Math.hypot(n.x - x, n.y - y); if (d <= bestD) { best = i; bestD = d; } });
    return best;
  }

  /** The node time under a canvas point, or -1. */
  private timeAt(x: number, y: number): number {
    let best = -1, bestD = 9;
    for (const q of this.timePts) { const d = Math.hypot(q.x - x, q.y - y); if (d <= bestD) { best = q.i; bestD = d; } }
    return best;
  }

  /** Bake to timeline: write the keys (a key at each node time and at the end of the run) into the bone's translate timeline, one undo step. */
  private bakeToTimeline(): void {
    const s = this.session, m = motionFor(s);
    if (!m) return;
    const a = s.animation, had = a ? (keysAt(a, { section: "bones", owner: m.bone, timeline: "translate" })?.length ?? 0) : 0, first = m.baked === undefined;
    try {
      const { path, stray } = bakeMotion(s, m);
      this.stray = stray;
      this.onStatus(`${m.bone}: baked ${nodeTimeFrames(path).length + 1} keys to the timeline${first && had ? `; its ${had} translate key${had === 1 ? "" : "s"} were replaced (Undo brings them back)` : ""}.`);
    } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  /** Keep a changed path; the keys are only written by Bake to timeline. */
  private timeEdit(next: MotionPath, say?: string): void {
    keepMotion(this.session, next);
    if (say) this.onStatus(say);
  }

  /** + Time: a node time at the playhead's frame (or, if that is not free, in the middle of the longest block). */
  private addTimeHere(): void {
    const s = this.session, m = motionFor(s);
    if (!m) return;
    try {
      const times = nodeTimeFrames(m), end = endFrame(m);
      let frame = s.frame;
      if (frame <= 0 || frame >= end || times.includes(frame)) {
        const longest = blocksOf(m).reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
        frame = Math.round((longest.start + longest.end) / 2);
      }
      const next = addNodeTime(m, frame);
      this.timeEdit(next, `Added a node time on frame ${frame}.`);
      this.selTime = nodeTimeFrames(next).indexOf(frame);
    } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  private removePickedTime(): void {
    const m = motionFor(this.session);
    if (!m || this.selTime < 0) return;
    try { this.timeEdit(removeNodeTime(m, this.selTime), "Removed the node time."); this.selTime = -1; }
    catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  /** The picked node time's frame was typed. */
  private setPickedFrame(): void {
    const m = motionFor(this.session);
    if (!m || this.selTime < 1) return;
    try {
      const next = moveNodeTime(m, this.selTime, Number(this.frameField.value));
      this.timeEdit(next);
      this.frameField.value = String(nodeTimeFrames(next)[this.selTime]);
    } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); this.frameField.value = String(nodeTimeFrames(m)[this.selTime]); }
  }

  /** The picked block's time multiplier was typed. */
  private setPickedSpeed(): void {
    const m = motionFor(this.session);
    if (!m || this.selTime < 0) return;
    try { this.timeEdit(withSpeed(m, this.selTime, Number(this.speedField.value))); }
    catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); this.speedField.value = String(blocksOf(m)[this.selTime]!.speed); }
  }

  /** Total frames was typed (a loop of 15 is 14 + 0): the node times keep their share of it. */
  private setFrames(): void {
    const m = motionFor(this.session);
    if (!m) return;
    try { this.timeEdit(withFrames(m, Math.round(Number(this.framesField.value))), `${Math.round(Number(this.framesField.value))} frames.`); }
    catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); this.framesField.value = String(m.frames); }
  }

  /** Closed: the spline is a ring (the last node joins the first); off, it is a path with two ends. */
  private setClosed(on: boolean): void {
    const m = motionFor(this.session);
    if (!m) return;
    this.timeEdit({ ...m, closed: on }, on ? "The spline is a ring." : "The spline is open: it ends on its last node.");
  }

  private removeNode(): void {
    const m = motionFor(this.session);
    if (!m || this.selNode < 0 || this.selNode >= m.nodes.length) return;
    if (m.nodes.length <= 2) { this.onStatus("A path keeps two spline nodes."); return; }
    keepMotion(this.session, { ...m, nodes: m.nodes.filter((_, i) => i !== this.selNode) });
    this.selNode = -1;
  }

  /** Put a spline node where a double click on the curve is (Edit Path). */
  private insertNodeAt(x: number, y: number): boolean {
    const m = motionFor(this.session), at = this.spaceAt(x, y);
    if (!m || !at || this.space !== "local" || this.mode !== "draw") return false;
    const curve = curveOf(m), hit = curve.project({ x: at[0], y: at[1] }), k = this.mapping?.k ?? 1;
    if (hit.distance * k > 10) return false;
    const i = curve.nodeAt.slice(0, m.nodes.length).filter((v) => v <= hit.s).length, p = curve.at(hit.s);
    keepMotion(this.session, withNode(m, { x: p.x, y: p.y }, i));
    this.selNode = i;
    return true;
  }

  /** A node time added where a double click on the ring is (Adjust time): on the frame the bone is nearest there. */
  private addTimeAt(x: number, y: number): boolean {
    const m = motionFor(this.session), at = this.spaceAt(x, y);
    if (!m || !at || this.space !== "local" || this.mode !== "time") return false;
    const curve = curveOf(m), hit = curve.project({ x: at[0], y: at[1] }), k = this.mapping?.k ?? 1;
    if (hit.distance * k > 10) return false;
    const want = hit.s / Math.max(curve.length, 1e-9), times = nodeTimeFrames(m);
    let best = -1, bestD = Infinity;
    for (let f = 1; f < endFrame(m); f++) {
      if (times.includes(f)) continue;
      const d = Math.abs(progressAtFrame(m, f) - want);
      if (d < bestD) { best = f; bestD = d; }
    }
    if (best < 0) return true;
    try { const next = addNodeTime(m, best); this.timeEdit(next, `Added a node time on frame ${best}.`); this.selTime = nodeTimeFrames(next).indexOf(best); }
    catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
    return true;
  }

  /** Shown whole again (F while the pointer is over this panel). */
  fitView(): void {
    this.hold = false;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.schedule();
  }

  /** A press: on a mark, the playhead goes to its frame; anywhere else it starts a pan (the middle and right buttons pan from a mark too). */
  private down(e: PointerEvent): void {
    const [x, y] = localPoint(this.canvas, e);
    if (e.button === 0) {
      if (this.onTag(x, y)) {
        this.session.pause();
        this.scrubbing = true;
        this.grab(e);
        return;
      }
      const hnd = this.mode === "draw" ? this.handleAt(x, y) : null;
      if (hnd) { this.selNode = hnd.slot; this.handleDrag = hnd; this.grab(e); return; }
      const tm = this.mode === "time" ? this.timeAt(x, y) : -1;
      if (tm >= 0) { this.pickTime(tm); return; }
      const node = this.mode === "draw" ? this.nodeAt(x, y) : -1;
      if (node >= 0) { this.pickSlot(node); this.nodeDrag = node; this.grab(e); return; }
      const h = this.handle;
      if (h && !this.timing && Math.hypot(h.x - x, h.y - y) <= 11 && this.beginEdit(x, y, "rotate", this.session.frame)) { this.grab(e); return; }
      const arrow = this.arrowAt(x, y);
      if (arrow !== null && !this.timing && this.beginEdit(x, y, "move", this.session.frame, arrow)) { this.grab(e); return; }
      const best = this.markAt(x, y);
      if (best >= 0) {
        // With a path a dot only puts the playhead there (its node times are what is dragged, in Adjust time); with none, drag it to move the bone at that frame.
        if (motionFor(this.session)) { this.session.seek(best); return; }
        if (this.beginEdit(x, y, "move", best)) { this.grab(e); return; }
        this.session.seek(best);
        return;
      }
    }
    this.dragging = { x: e.clientX, y: e.clientY };
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* no such pointer: the pan still follows moves over the canvas */ }
    this.canvas.style.cursor = "grabbing";
  }

  /** Keep the pointer for an edit drag. */
  private grab(e: PointerEvent): void {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* no such pointer: the drag follows moves over the canvas */ }
    this.canvas.style.cursor = "grabbing";
    this.schedule();
  }

  private move(e: PointerEvent): void {
    if (this.scrubbing) {
      const [x, y] = localPoint(this.canvas, e);
      this.scrubTo(x, y);
      return;
    }
    if (this.handleDrag) {
      const [x, y] = localPoint(this.canvas, e);
      this.dragHandle(x, y);
      return;
    }
    if (this.nodeDrag !== null) {
      const [x, y] = localPoint(this.canvas, e), at = this.spaceAt(x, y), m = motionFor(this.session);
      if (at && m) {
        keepMotion(this.session, { ...m, nodes: m.nodes.map((n, i) => (i === this.nodeDrag && n ? { ...n, x: at[0], y: at[1] } : n)) });
        // The bone goes with the node (at the playhead's frame).
        poseAtNode(this.session, at[0], at[1]);
      }
      return;
    }
    if (this.edit) {
      const [x, y] = localPoint(this.canvas, e);
      this.editTo(x, y, e.shiftKey);
      return;
    }
    if (!this.dragging) {
      const [x, y] = localPoint(this.canvas, e), h = this.handle;
      this.canvas.style.cursor = this.onTag(x, y) ? "grab" : (h && Math.hypot(h.x - x, h.y - y) <= 11) || this.arrowAt(x, y) !== null || this.markAt(x, y) >= 0 ? "grab" : "";
      return;
    }
    this.pan = { x: this.pan.x + e.clientX - this.dragging.x, y: this.pan.y + e.clientY - this.dragging.y };
    this.dragging = { x: e.clientX, y: e.clientY };
    this.schedule();
  }

  private up(e: PointerEvent): void {
    this.scrubbing = false;
    this.nodeDrag = null;
    this.handleDrag = null;
    const edit = this.edit;
    if (edit) {
      this.edit = null;
      if (edit.key !== null) this.session.history?.end();
      this.session.changed();
    }
    this.dragging = null;
    this.canvas.style.cursor = "";
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  }

  /** The wheel zooms about the pointer: the point under it stays put. A trackpad's pinch comes as ctrl + wheel with small steps. */
  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const [lx, ly] = localPoint(this.canvas, e), px = lx - this.canvas.offsetWidth / 2, py = ly - this.canvas.offsetHeight / 2;
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
