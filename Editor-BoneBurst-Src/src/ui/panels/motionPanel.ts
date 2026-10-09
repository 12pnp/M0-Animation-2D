import { type BoneProperty, keyBone, type LocalPose } from "@/edit/boneKeys";
import { EditRefused } from "@/edit/history";
import { drawnVertices } from "@/engine/draw";
import { boneInherit } from "@/model/defaults";
import type { Key, Skeleton } from "@/model/skeleton";
import { animationDuration, DEFAULT_FPS, frameTime, keyLists, keyTime, timeFrame } from "@/model/timelines";
import { iconButton } from "../icons";
import { graphColours, speedColour } from "../graphLook";
import { CurvesView } from "./curvesView";
import { pickColour } from "../colourPopup";
import { showContextMenu } from "../contextMenu";
import type { MenuItem } from "../menubar";
import type { MotionMemory } from "../viewMemory";
import { deleteTranslateKeys, translateKeyCount } from "@/edit/pathKeys";
import { alongChord, clampSpeed, keyChords, keyHandles, keyReaches, keySpeedPairs, multiplierOf, retimeTranslateKey, setKeyHandles, setSpanEase, setTranslateKeyReaches, spanEase, type SpanEase, setTranslateKeySpeeds, spanSpeedSamples, SPEED_MAX, SPEED_MIN, translateNodes, type Vec } from "@/edit/keySpeed";
import { deleteKeys, setKey } from "@/edit/keys";
import { FPS_RANGE, keysOffFrame, setFps } from "@/edit/header";
import { packAnimation, trimAnimation } from "@/edit/fitLength";
import { convertToFramePath, framePathReport } from "@/edit/toFramePath";
import { analyseOpen } from "../importAnalysis";
import { localPoint, pageScale } from "../pageScale";
import { labelStep, RULER, secondsSinceLastKey } from "../timeline/layout";
import type { Session } from "../session";
import { type Matrix, moveDelta, type Point, localRotation, scaleAlong, scaleFactors, shearAlong, shearDelta, spaceAxes, tidy, turn, turnSign } from "../stage/gizmo";
import { animatedLocal, boneMatrix, boneTip, parentMatrix, type Posed, Poser } from "../stage/posed";
import { axisLocked, constraintDriving, shiftedLocal } from "../stage/trailEdit";
import { drawBackdrop } from "../stage/canvasBackdrop";
import { NO_LOOK, type StageLook } from "../stage/look";
import { type OnionOptions, onionFrames } from "../stage/onion";
import { setOf, tiersAround } from "../stage/tiers";
import { type BoneTrail, boneTrail, fromParent, type TrailSpace } from "../stage/trail";

/** The layers the panel can show: the bone's image, the bone itself, its path, and onion skin (the bone at frames either side of the playhead). */
export type Layer = "image" | "bone" | "path" | "length" | "onion" | "rotate" | "move" | "scale" | "shear";
const LAYERS: readonly Layer[] = ["image", "bone", "path", "length", "onion", "rotate", "move", "scale", "shear"];
/** The four handles the panel can show on the bone (each a toggle in the header, the Stage's tool icons): rotate ring, move arrows, scale square, shear diamond. */
const GIZMOS = ["rotate", "move", "scale", "shear"] as const;
/** The Timeline's playhead green, for FramePath's frame strip. */
const PLAYHEAD_GREEN = "#30a46c";
/** A FramePath key with Shift held over it: a click deletes it. */
const DELETE_RED = "#e5484d";
/** FramePath's strip: the row of span tabs under the ruler (the Timeline's height), and the middle of its key diamonds. */
const KEY_TABS = 22;
const KEY_Y = RULER + KEY_TABS / 2;
/** The height of what is under the picture at first, and the least of it and of the picture. */
const DEFAULT_LOWER = 270, MIN_LOWER = 150, MIN_PICTURE = 120, MIN_GRAPH = 60;
const LOWER_KEY = "boneburst.motionPath.lower";
const GRAPH_KEY = "boneburst.motionPath.graphHeight";
/** FramePath's handles on the picture and its speed curve, and the path on the Stage, until a colour is picked (docs/STAGE-PATH-PLAN.md). */
const PATH_COLOUR = "#ff9f1c";
const STAGE_PATH_KEY = "boneburst.motionPath.stagePath";
/** The Curves sub-panel's width at first, and the least it and the speed graph keep (docs/CURVES-PANEL-PLAN.md). */
const DEFAULT_CURVES = 170, MIN_CURVES = 90, MIN_GRAPH_WIDTH = 160;
const CURVES_KEY = "boneburst.motionPath.curvesWidth";
const PAST = "rgb(230, 64, 51)", FUTURE = "rgb(51, 179, 77)";
const LAYERS_KEY = "boneburst.motionPath.layers";
const TIERS_KEY = "boneburst.motionPath.tiers";
/** The layers with a count on each side: tiers above and below the bone (Bone, Image), frames before and after (Onion). docs/SHOW-STEPPERS-PLAN.md. */
type StepKey = "image" | "bone" | "onion";
interface Counts { a: number; b: number }
const ONION_MAX = 10;
/** A count that means "all of them": what a saved Parent or Children toggle becomes. */
const ALL = 99;
const AXES_KEY = "boneburst.motionPath.axes";
const AXIS_COLOURS = ["#e5484d", "#30a46c"] as const;

interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** A drag of a mark (move) or of the rotation handle, from what the bone was at that frame. */
interface BoneEdit {
  readonly bone: string;
  readonly kind: "move" | "rotate" | "scale" | "shear";
  readonly frame: number;
  readonly from: LocalPose;
  readonly parent: Matrix;
  /** The panel's origin in the world: the parent bone's joint (Parent space). */
  readonly origin: Point;
  /** Move only: the axis (0: x, 1: y) of `axes` the drag is held to, or null for a free drag; the axes as world unit vectors. */
  readonly axis: 0 | 1 | null;
  readonly axes: readonly [Point, Point];
  /** Where the drag began, on the canvas. */
  readonly start: [number, number];
  /** The animation and time to key: a FramePath drag always keys, whatever the Stage's Auto Key (docs/FRAMEPATH-SPEED-PLAN.md, step 14). */
  readonly key: { animation: string; time: number };
  /** Closed FramePath: the time of the frame at the other end, keyed with the same pose as the drag moves this one; null otherwise. */
  readonly otherEnd: number | null;
  // Rotate only: the joint and the pointer in the panel's space, the bone's matrix, and the turn so far.
  readonly joint: [number, number];
  readonly matrix: Matrix;
  readonly sign: number;
  readonly inherit: string;
  last: [number, number];
  turned: number;
  /** Scale and Shear in the Local or World axes: the axis the drag is held to once it has gone far enough (0: x, 1: y), or null. */
  lock: 0 | 1 | null;
}

/** The slots of `bones` that draw an image in `p`. */
const slotsOf = (p: Posed, bones: readonly number[]) => p.draw.slots.filter((d) => bones.includes(p.rig.data.slots[d.slot]!.bone));

/**
 * The box round the bone's images and the bone itself at some frames of the trail, in `space`: the
 * panel is scaled to hold them all, so what is drawn does not change size from frame to frame.
 */
function extentOf(poser: Poser, skin: string | null, animation: string | null, bone: string, space: TrailSpace, origin: string | null, fps: number, frames: number, up: number, down: number): Box | null {
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
    const to = (x: number, y: number): [number, number] => (space === "parent" ? fromParent(p, i, x, y, origin) : [x, y]);
    const set = setOf(p.rig.data.bones.map((b) => b.parent), i, up, down);
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
  private readonly layerBtns: Record<Layer, HTMLButtonElement>;
  /** Everything is in the parent bone's space (the World view was removed: the path follows its parent). */
  private readonly space: TrailSpace = "parent";
  private show: Record<Layer, boolean> = { image: true, bone: true, path: true, length: true, onion: false, rotate: true, move: true, scale: true, shear: true };
  /** What onion skin shows (frames before and after, keyed only, colour-coded); set by the app from the preferences. */
  onion: () => OnionOptions = () => ({ before: 2, after: 2, keyedOnly: false, colour: true });
  /** What the Stage draws behind the skeleton (checkerboard, grid, centre axes), from the preferences; set by the app. */
  background: () => { look: StageLook; grid: number | null } = () => ({ look: NO_LOOK, grid: null });
  private scratch: HTMLCanvasElement | null = null;
  /** The view on top of the fit: a zoom (1 = fitted) and a pan in pixels; wheel, drag and Fit change them. */
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private dragging: { x: number; y: number } | null = null;
  /** FramePath's ⋮ menu button, after its name in the header. */
  private readonly menuBtn: HTMLButtonElement;
  /** The count on each side of Bone, Image and Onion: a is the tiers above (frames before), b the tiers below (frames after). */
  private counts: Record<StepKey, Counts> = { image: { a: 0, b: 0 }, bone: { a: 0, b: 0 }, onion: { a: 2, b: 2 } };
  private readonly stepBtns = {} as Record<StepKey, { c1: HTMLElement; c2: HTMLElement; plus1: HTMLButtonElement; minus1: HTMLButtonElement; plus2: HTMLButtonElement; minus2: HTMLButtonElement }>;
  private cached: { doc: Skeleton; images: unknown; skin: string | null; animation: string | null; bone: string; space: TrailSpace; origin: string | null; trail: BoneTrail | null; extent: Box | null; tiers: string } | null = null;
  private poser: { doc: Skeleton; images: unknown; value: Poser } | null = null;
  private queued = false;
  /** Each frame's mark on the canvas as last drawn, for a click. */
  private marks: Float64Array = new Float64Array(0);
  /** Said in the status line; set by the app. */
  onStatus: (message: string) => void = () => {};
  /** How the panel maps a point of the bone's space onto the canvas, as last drawn: the inverse of `at`. */
  private mapping: { width: number; height: number; k: number; cx: number; cy: number } | null = null;
  /** The rotation handle beyond the bone's tip at the playhead, on the canvas, when the bone can be turned. */
  private handle: { x: number; y: number } | null = null;
  /** The scale square and the shear diamond on the canvas as last drawn (null when hidden). */
  private scaleHandle: { x: number; y: number } | null = null;
  private shearHandle: { x: number; y: number } | null = null;
  /** The drag in progress that edits the animation (docs/LOCALPATH-EDIT-PLAN.md). */
  private edit: BoneEdit | null = null;
  /** The frame tag at the playhead's dot, on the canvas as last drawn; a press on it scrubs along the path. */
  private tag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private scrubbing = false;
  /** The line under the header: what FramePath shows for the bone, or why there is nothing. */
  private readonly motionBar = document.createElement("div");
  private readonly hint = document.createElement("span");
  /** Convert… beside the hint of a bone keyed as separate x and y. */
  private readonly convertBtn = document.createElement("button");
  /** Under the picture: the ◆ toggle and the frame strip, then the key's data beside the speed graph (docs/FRAMEPATH-SPEED-PLAN.md). */
  private readonly slotBar = document.createElement("div");
  private readonly dataBox = document.createElement("div");
  /** Everything under the picture (the strip and the data), and the line above it that is dragged to give it more or less room. */
  private readonly lower = document.createElement("div");
  private readonly split = document.createElement("div");
  private lowerHeight = DEFAULT_LOWER;
  /** The height was set by a drag (or kept from before); until then the area is the usual height, or less in a small panel. */
  private lowerSet = false;
  /** The Curves sub-panel left of the speed graph (docs/CURVES-PANEL-PLAN.md), the row holding both, the line between them and its width. */
  private readonly curves: CurvesView;
  private readonly graphRow = document.createElement("div");
  private readonly curvesSplit = document.createElement("div");
  private curvesWidth = DEFAULT_CURVES;
  /** The speed graph, and its points on the canvas as last drawn; the point being dragged. */
  private readonly speedCanvas = document.createElement("canvas");
  /** The green line under the speed graph: drag it to make the graph taller or shorter (double-click: it fills the room again). */
  private readonly speedGrip = document.createElement("div");
  /** The graph's own height in pixels, or null to fill what the area gives it. */
  private graphHeight: number | null = null;
  private readonly viewBar = document.createElement("div");
  private readonly zoomLabel = document.createElement("span");
  private speedDots: { i: number; x: number; y: number }[] = [];
  /** The speed graph's legs as last drawn, the one being dragged, the visible window over the animation (0..1), a pan in progress and the cap being dragged. */
  /** The leg being dragged and where the drag began across the graph: sideways past a few pixels it sets the leg's reach (step 10). */
  private gView = { x0: 0, x1: 1 };
  private graphPan: { x: number; x0: number; x1: number } | null = null;
  private gViewFor = "";
  private slotSig = "";
  /** FramePath: the translate key picked (-1: none), and the animation and bone it was picked in (docs/FRAMEPATH-SPEED-PLAN.md). */
  private selKey = -1;
  /** FramePath's frame strip (drawn like the Timeline's ruler) and its ◆ toggle. */
  private readonly keyStrip = document.createElement("canvas");
  private readonly keyToggle = document.createElement("button");
  /** At the strip's right end (step 15): Fit for the speed graph and the strip, and the frame lock under it. */
  private readonly stripFit = document.createElement("button");
  /** The document's frame rate, at the ruler row's left end (step 22). */
  private readonly fpsBox = document.createElement("label");
  private readonly fpsInput = document.createElement("input");
  /** The last frame the playhead goes to (step 24), at the ruler row's right end by Fit. */
  private readonly limitBtn = document.createElement("button");
  /** FramePath keys whose mode was chosen where the file cannot show it (Mirror or Break at 0 and 0, Break on equal speeds), and for which bone. */
  private keyModes = new Map<string, "mirror" | "break">();
  /** The speed graph's own leg mode per key, where the data cannot show it: Broken on equal speeds and reaches (step 11). */
  private speedModes = new Map<string, "broken">();
  private keyBrokenFor = "";
  /** FramePath's handles on the picture as last drawn (with the key's joint in the panel's space and its parent matrix), the one dragged, and the parent matrices at the keys. */
  private keyHandlePts: { i: number; side: "in" | "out"; x: number; y: number; jx: number; jy: number; m: Matrix }[] = [];
  private keyHandleDrag: { i: number; side: "in" | "out"; jx: number; jy: number; m: Matrix } | null = null;
  private keyMats: { doc: unknown; sig: string; mats: (Matrix | null)[] } | null = null;
  /** FramePath's frame strip: each key's diamond as last drawn. */
  private stripDots: { i: number; x: number }[] = [];
  /** What a click on the picture would do with ⌘ or Shift held, previewed (step 21); and where the pointer last was over the picture. */
  private pathHover: { kind: "add" | "menu" | "delete"; frame: number } | null = null;
  private picPointer: { x: number; y: number } | null = null;
  /** The key being slid in time with ⌘ + drag on its diamond (step 16), or null. */
  private retimeDrag: number | null = null;
  /** A key under the pointer with Shift held: drawn red, and a click deletes it (docs/FRAMEPATH-SPEED-PLAN.md, step 3). */
  private delHover: { where: "graph" | "strip"; i: number } | null = null;
  /** Where the pointer last was over the graph or the strip, so pressing or letting go of Shift lights or clears the red key. */
  private lastOver: { where: "graph" | "strip"; x: number; y: number } | null = null;
  /** The box the view was fitted to, as last drawn. */
  private box: Box | null = null;
  /** Hold that box after an edit too, until Fit or another bone, animation or space: the picture does not jump when a drag lets go. */
  private hold = false;
  /** FramePath's Closed: the first and the last frame are one place, so a drag of either moves both. */
  private framesClosed = false;
  /** What the move arrows follow: the parent's axes (as the Stage's default) or the world's. */
  private axes: "parent" | "world" = "parent";
  private readonly axesBtn = document.createElement("button");
  /** The selected bone's path on the Stage, and the colour it, FramePath's handles and the speed curve are drawn in (docs/STAGE-PATH-PLAN.md). */
  private stagePath = { on: false, colour: PATH_COLOUR };
  private stageCache: { doc: Skeleton; images: unknown; skin: string | null; animation: string; bone: string; fps: number; trail: BoneTrail | null } | null = null;
  /** The Stage toggle or the colour changed; set by the app (the Stage draws again). */
  onStagePath: () => void = () => {};
  /** The move arrows at the playhead's joint, on the canvas as last drawn. */
  private arrows: { axis: 0 | 1; x0: number; y0: number; x1: number; y1: number }[] = [];

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel motion-path";
    try {
      const saved = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "{}") as Partial<Record<Layer, unknown>>;
      for (const l of LAYERS) if (typeof saved[l] === "boolean") this.show[l] = saved[l] as boolean;
      const n = (v: unknown, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(hi, Math.round(v))) : null);
      const kept = localStorage.getItem(TIERS_KEY);
      if (kept) {
        const t = JSON.parse(kept) as Partial<Record<StepKey, { a?: unknown; b?: unknown }>>;
        for (const k of ["image", "bone", "onion"] as const) {
          const a = n(t[k]?.a, ALL), b = n(t[k]?.b, ALL);
          if (a !== null) this.counts[k].a = a;
          if (b !== null) this.counts[k].b = b;
        }
      } else {
        // A panel saved before the counts: Parent bone and Parent image become all the tiers above, Children all below.
        const old = saved as Record<string, unknown>;
        if (old.parentBone === true) this.counts.bone.a = ALL;
        if (old.parentImage === true) this.counts.image.a = ALL;
        if (old.children === true) this.counts.bone.b = this.counts.image.b = ALL;
      }
    } catch { /* storage blocked: all shown */ }
    this.head.className = "lp-head";
    this.layerBtns = { image: this.button("Image", "Show the bone's image; the counts either side are how many tiers of bones above (parents) and below (children) are drawn too"), bone: this.button("Bone", "Show the bone; the counts either side are how many tiers of bones above (parents) and below (children) are drawn too"), path: this.button("Path", "Show the bone's path over the animation (where it goes, frame by frame)"), length: this.button("Length", "Show the distance between each pair of dots along the path (in the panel's space)"), onion: this.button("Onion", "Show the bone at the frames before (red) and after (green) the playhead; the counts either side are how many frames before and after"), rotate: this.button("Rotate", "Show the rotation handle (the ring beyond the bone's tip)"), move: this.button("Move", "Show the move arrows"), scale: this.button("Scale", "Show the scale handle (the square beside the bone's tip)"), shear: this.button("Shear", "Show the shear handle (the diamond on the other side of the tip)") };
    for (const g of GIZMOS) {
      this.layerBtns[g].setAttribute("aria-label", `Show ${g} handle`);
      iconButton(this.layerBtns[g], g, false);
    }
    try { if (localStorage.getItem(AXES_KEY) === "world") this.axes = "world"; } catch { /* storage blocked: the default */ }
    try {
      const kept = JSON.parse(localStorage.getItem(STAGE_PATH_KEY) ?? "{}") as { on?: unknown; colour?: unknown };
      if (typeof kept.on === "boolean") this.stagePath.on = kept.on;
      if (typeof kept.colour === "string" && /^#[0-9a-f]{6}$/i.test(kept.colour)) this.stagePath.colour = kept.colour;
    } catch { /* storage blocked: off, the usual colour */ }
    this.axesBtn.type = "button";
    this.axesBtn.addEventListener("click", () => {
      this.axes = this.axes === "parent" ? "world" : "parent";
      try { localStorage.setItem(AXES_KEY, this.axes); } catch { /* not kept */ }
      this.schedule();
    });
    // The parent's two buttons share their names with the bone's: the groups tell them apart, and so do their accessible names.
    // Title and FramePath on top; under them the toggles in groups: what is shown, the handles.
    const tools = document.createElement("div");
    tools.className = "lp-tools";
    tools.append(
      this.rowGroup("Show", [this.stepper("image", "Image", "above", "below"), this.stepper("bone", "Bone", "above", "below"), this.segOf("Length", [this.layerBtns.length]), this.stepper("onion", "Onion", "before", "after")]),
      this.group("Handles", [this.layerBtns.rotate, this.layerBtns.move, this.layerBtns.scale, this.layerBtns.shear], this.axesBtn),
    );
    // Path is an icon before FramePath's name: the bone's keyed trail.
    this.layerBtns.path.setAttribute("aria-label", "Path");
    iconButton(this.layerBtns.path, "keyTranslate", false);
    this.layerBtns.path.classList.add("lp-layer");
    // FramePath's ⋮ menu by its name (docs/FRAMEPATH-SPEED-PLAN.md): Closed, and Delete FramePath data.
    const mode = document.createElement("div"), box = document.createElement("div"), name = document.createElement("span");
    mode.className = "lp-tabs";
    box.className = "lp-tab";
    name.className = "main on";
    name.textContent = "FramePath";
    name.title = "The bone's motion as keyed in the animation (a Spine file's keys included)";
    this.menuBtn = this.button("⋮", "FramePath: more");
    this.menuBtn.className = "more";
    this.menuBtn.setAttribute("aria-label", "FramePath menu");
    this.menuBtn.setAttribute("aria-haspopup", "menu");
    this.menuBtn.addEventListener("click", () => { const r = this.menuBtn.getBoundingClientRect(); showContextMenu(r.left, r.bottom, this.keysMenu()); });
    box.append(name, this.menuBtn);
    mode.append(this.layerBtns.path, box);
    this.head.append(this.title, mode, tools);
    this.body.className = "lp-body";
    this.note.className = "empty lp-note";
    const fit = iconButton(this.button("Fit", "Fit the whole path in the panel (double-click does the same)"), "fit", false);
    fit.className = "lp-fit";
    fit.addEventListener("click", () => this.fitView());
    // The view bar over the picture: zoom out, the zoom, zoom in, Fit.
    this.viewBar.className = "lp-viewbar";
    const zoomBtn = (text: string, tip: string, factor: number): HTMLButtonElement => {
      const b = this.button(text, tip);
      b.className = "lp-zoom";
      b.addEventListener("click", () => this.zoomBy(factor));
      return b;
    };
    this.zoomLabel.className = "lp-zoom-label";
    this.zoomLabel.title = "The picture's zoom (1 = the whole path fitted)";
    const gap = document.createElement("span");
    gap.className = "lp-gap";
    this.viewBar.append(zoomBtn("−", "Zoom out", 1 / 1.25), this.zoomLabel, zoomBtn("+", "Zoom in", 1.25), gap, fit);
    this.body.append(this.canvas, this.note);
    this.motionBar.className = "lp-motion";
    this.slotBar.className = "lp-slots";
    this.dataBox.className = "lp-data";
    this.hint.className = "lp-hint";
    this.motionBar.append(this.hint);
    this.convertBtn.type = "button";
    this.convertBtn.className = "lp-convert";
    this.convertBtn.textContent = "Convert…";
    this.convertBtn.title = "Make this file's translate keys what FramePath edits: one list per bone, x and y timed together (one undo step)";
    this.convertBtn.addEventListener("click", () => void this.convertDoc());
    // The picture on top; under it the frame strip, and under that the key's data and the speed graph.
    this.split.className = "lp-split";
    this.split.title = "Drag to give the frame strip and the speed graph more or less room (double-click: back to the usual)";
    this.split.setAttribute("role", "separator");
    this.split.setAttribute("aria-orientation", "horizontal");
    this.lower.className = "lp-lower";
    this.lower.append(this.slotBar, this.dataBox);
    this.speedCanvas.className = "lp-speed-canvas";
    this.curves = new CurvesView({
      span: () => this.curveSpan(),
      colours: () => ({ path: this.stagePath.colour, ...this.legColours(this.stagePath.colour) }),
      begin: (label) => { this.session.pause(); this.session.history?.begin(label); },
      end: () => { this.session.history?.end(); this.slotSig = ""; this.schedule(); },
      apply: (index, ease, side) => this.applySpanEase(index, ease, side),
    });
    this.graphRow.className = "lp-speed-row";
    this.curvesSplit.className = "lp-curves-split";
    this.curvesSplit.title = "Drag to give the Curves view or the speed graph more room (double-click: back to the usual)";
    this.curvesSplit.setAttribute("role", "separator");
    this.curvesSplit.setAttribute("aria-orientation", "vertical");
    this.graphRow.append(this.curves.element, this.curvesSplit, this.speedCanvas);
    try { const w = Number(localStorage.getItem(CURVES_KEY)); if (Number.isFinite(w) && w >= MIN_CURVES) this.curvesWidth = w; } catch { /* the usual */ }
    this.applyCurvesWidth();
    this.curvesSplitDrag();
    try { const h = Number(localStorage.getItem(LOWER_KEY)); if (Number.isFinite(h) && h >= MIN_LOWER) { this.lowerHeight = h; this.lowerSet = true; } } catch { /* the usual */ }
    try { const h = Number(localStorage.getItem(GRAPH_KEY)); if (Number.isFinite(h) && h >= MIN_GRAPH) this.graphHeight = h; } catch { /* the usual */ }
    this.speedGrip.className = "lp-grip";
    this.speedGrip.title = "Drag to make the speed graph taller or shorter (double-click: it fills the room again)";
    this.speedGrip.setAttribute("role", "separator");
    this.applyGraph();
    this.gripDrag();
    this.applyLower();
    this.splitDrag();
    this.speedEvents();
    this.keyStrip.className = "lp-keystrip";
    this.keyStripEvents();
    this.keyToggle.type = "button";
    this.keyToggle.className = "lp-keytoggle";
    this.keyToggle.textContent = "◆";
    this.keyToggle.setAttribute("aria-label", "Toggle key");
    this.keyToggle.addEventListener("click", () => this.toggleKey());
    this.stripFit.type = "button";
    this.stripFit.className = "lp-stripfit";
    this.stripFit.title = "Fit: the whole animation across the strip and the speed graph (double-click on the graph does the same)";
    iconButton(this.stripFit, "fit", false);
    this.stripFit.addEventListener("click", () => this.fitGraph(false));
    this.fpsBox.className = "lp-stripfps";
    this.fpsBox.title = "The animation's frame rate (the document's): keys keep their times";
    this.fpsInput.type = "number";
    this.fpsInput.min = String(FPS_RANGE[0]);
    this.fpsInput.max = String(FPS_RANGE[1]);
    this.fpsInput.step = "1";
    this.fpsInput.setAttribute("aria-label", "Frame rate");
    this.fpsInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.fpsInput.blur(); } if (e.key === "Escape") { this.fpsInput.value = String(this.session.fps); this.fpsInput.blur(); } });
    this.fpsInput.addEventListener("change", () => this.setFrameRate(this.fpsInput.value));
    this.fpsBox.append(this.fpsInput, Object.assign(document.createElement("span"), { textContent: "fps" }));
    this.limitBtn.type = "button";
    this.limitBtn.className = "lp-striplimit";
    this.limitBtn.setAttribute("aria-label", "Last frame");
    this.limitBtn.setAttribute("aria-haspopup", "dialog");
    this.limitBtn.addEventListener("click", () => this.openLimitPopup());
    // Shift pressed or let go with the pointer still over a key: it turns red or back.
    for (const type of ["keydown", "keyup"] as const) window.addEventListener(type, (e) => { if (e.key === "Shift") this.updateDelHover(e.shiftKey); if (e.key === "Meta" || e.key === "Control") this.updateRetimeHover(e.metaKey || e.ctrlKey); if (["Shift", "Meta", "Control"].includes(e.key)) this.updatePathHover(e.metaKey || e.ctrlKey, e.shiftKey); });
    // The line that gives the picture or the strip and graph more room sits right under the picture, above the zoom bar (the owner, 2026-10-09).
    this.element.append(this.head, this.motionBar, this.body, this.split, this.viewBar, this.lower);
    new ResizeObserver(() => this.schedule()).observe(this.lower);
    // The canvas is as big as its box, whatever else the panel holds (the path window under it).
    new ResizeObserver(() => this.schedule()).observe(this.body);
    for (const l of LAYERS) {
      this.layerBtns[l].addEventListener("click", () => {
        this.show[l] = !this.show[l];
        try { localStorage.setItem(LAYERS_KEY, JSON.stringify(this.show)); } catch { /* not kept */ }
        this.schedule();
      });
    }
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", (e) => this.up(e));
    this.canvas.addEventListener("pointerleave", () => { this.picPointer = null; this.updatePathHover(false, false); });
    this.canvas.addEventListener("dblclick", () => this.fitView());
    this.canvas.tabIndex = 0;
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
    this.applyLower();
    this.schedule();
  }

  /** A header group: a small label, its toggles joined as one segmented control, and anything extra beside them. */
  private group(label: string, buttons: readonly HTMLElement[], extra?: HTMLElement): HTMLElement {
    const g = document.createElement("div"), l = document.createElement("span"), seg = document.createElement("div");
    g.className = "lp-group";
    l.className = "lp-glabel";
    l.textContent = label;
    seg.className = "lp-seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", label);
    seg.append(...buttons);
    const row = document.createElement("div");
    row.className = "lp-row";
    row.append(seg);
    if (extra) row.append(extra);
    g.append(l, row);
    return g;
  }

  /** A labelled group of several segmented controls side by side. */
  private rowGroup(label: string, segs: readonly HTMLElement[]): HTMLElement {
    const g = document.createElement("div"), l = document.createElement("span"), row = document.createElement("div");
    g.className = "lp-group";
    l.className = "lp-glabel";
    l.textContent = label;
    row.className = "lp-row";
    row.append(...segs);
    g.append(l, row);
    return g;
  }

  private segOf(label: string, buttons: readonly HTMLElement[]): HTMLElement {
    const seg = document.createElement("div");
    seg.className = "lp-seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", label);
    seg.append(...buttons);
    return seg;
  }

  /**
   * A layer with a count each side: [n] [+ over −] [Layer] [+ over −] [n]. + shows one more tier (or frame) on that side, − takes one away;
   * the two are half a button high each, one over the other. `before` and `after` name the sides in the tips ("above" and "below" for tiers
   * of bones, "before" and "after" for frames).
   */
  private stepper(key: StepKey, label: string, before: string, after: string): HTMLElement {
    const mk = (text: string, tip: string, side: "a" | "b", by: 1 | -1): HTMLButtonElement => {
      const b = this.button(text, tip);
      b.setAttribute("aria-label", `${label}: ${tip}`);
      b.classList.add("lp-half");
      b.addEventListener("click", () => this.bump(key, side, by));
      return b;
    };
    const unit = key === "onion" ? "frame" : "tier", count = (): HTMLElement => { const c = document.createElement("span"); c.className = "lp-count"; c.setAttribute("role", "status"); return c; };
    const stack = (up: HTMLButtonElement, down: HTMLButtonElement): HTMLElement => { const d = document.createElement("div"); d.className = "lp-stack"; d.append(up, down); return d; };
    const c1 = count(), c2 = count(), plus1 = mk("+", `one more ${unit} ${before}`, "a", 1), minus1 = mk("−", `one fewer ${unit} ${before}`, "a", -1), plus2 = mk("+", `one more ${unit} ${after}`, "b", 1), minus2 = mk("−", `one fewer ${unit} ${after}`, "b", -1);
    this.stepBtns[key] = { c1, c2, plus1, minus1, plus2, minus2 };
    const seg = this.segOf(label, [c1, stack(plus1, minus1), this.layerBtns[key], stack(plus2, minus2), c2]);
    seg.classList.add("lp-step");
    return seg;
  }

  /** The most tiers there are above and below the selected bone, or frames either side for Onion. */
  private maxOf(key: StepKey): Counts {
    if (key === "onion") return { a: ONION_MAX, b: ONION_MAX };
    const p = this.session.pose(), bone = this.session.selectedBone, i = bone === null ? undefined : p?.bones.get(bone);
    if (!p || i === undefined) return { a: 0, b: 0 };
    const t = tiersAround(p.rig.data.bones.map((b) => b.parent), i, 0, 0);
    return { a: t.maxUp, b: t.maxDown };
  }

  /** One more (or fewer) tier or frame on a side, held between none and what there is. */
  private bump(key: StepKey, side: "a" | "b", by: 1 | -1): void {
    const max = this.maxOf(key)[side], now = Math.min(this.counts[key][side], max);
    this.counts[key][side] = Math.max(0, Math.min(max, now + by));
    try { localStorage.setItem(TIERS_KEY, JSON.stringify(this.counts)); } catch { /* not kept */ }
    this.schedule();
  }

  /** The counts as shown, never past what exists for the selected bone. */
  private shownCounts(key: StepKey): Counts {
    const max = this.maxOf(key);
    return { a: Math.min(this.counts[key].a, max.a), b: Math.min(this.counts[key].b, max.b) };
  }

  private syncSteps(): void {
    for (const key of ["image", "bone", "onion"] as const) {
      const c = this.shownCounts(key), max = this.maxOf(key), t = this.stepBtns[key];
      t.c1.textContent = String(c.a);
      t.c2.textContent = String(c.b);
      t.c1.dataset.count = `${key}-a`;
      t.c2.dataset.count = `${key}-b`;
      t.minus1.disabled = c.a <= 0;
      t.minus2.disabled = c.b <= 0;
      t.plus1.disabled = c.a >= max.a;
      t.plus2.disabled = c.b >= max.b;
    }
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
    // The window the panel is in: a popout's own frames, so it repaints there while the main window is in the background.
    (this.element.ownerDocument.defaultView ?? window).requestAnimationFrame(() => { this.queued = false; this.draw(); this.drawSpeed(); });
  }

  /** The bone the panel measures from: the selected bone's parent (null: the skeleton's origin). */
  private originName(): string | null {
    const s = this.session, bone = s.selectedBone;
    return bone ? s.doc?.bones?.find((b) => b.name === bone)?.parent ?? null : null;
  }

  private posers(): Poser {
    const s = this.session, doc = s.closedDoc()!;
    if (this.poser?.doc !== doc || this.poser.images !== s.images) this.poser = { doc, images: s.images, value: new Poser(doc, s.images) };
    return this.poser.value;
  }

  /** FramePath's ⋮ menu: Closed, or delete the keys. */
  private keysMenu(): MenuItem[] {
    const s = this.session, a = s.animation, bone = s.selectedBone, keys = a && bone ? translateKeyCount(a, bone) : 0;
    return [
      { label: "Closed", checked: this.framesClosed, disabled: keys === 0, run: () => this.setFramesClosed(!this.framesClosed) },
      {},
      { label: "Delete FramePath data", disabled: keys === 0, run: () => this.deleteKeyData() },
      {},
      { label: "Convert to FramePath…", disabled: !s.doc || framePathReport(s.doc).length === 0, run: () => void this.convertDoc() },
    ];
  }

  /**
   * The document's translate keys made into what FramePath edits (docs/SPINE-IMPORT-FRAMEPATH-PLAN.md, step 3): the analysis window's
   * options, then one undo step. For a file opened as it is.
   */
  private async convertDoc(): Promise<void> {
    const s = this.session, doc = s.doc, h = s.history;
    if (!doc || !h) return;
    const choice = await analyseOpen({ kind: "json", name: `${s.name}.json`, skeleton: doc, issues: 0 }, true);
    if (choice.action !== "open" || !choice.convert) return;
    const r = convertToFramePath(doc, choice.convert);
    h.apply("Convert to FramePath", () => r.doc);
    s.changed();
    this.onStatus(`Converted to FramePath: ${r.added} key${r.added === 1 ? "" : "s"} added; the bones move at most ${Math.round(r.worst * 100) / 100} units.`);
  }

  /** The trail of the selected bone in the animation shown, worked out again only when the document, skin, animation, bone or space changed. */
  private trail(): { trail: BoneTrail | null; bone: string; extent: Box | null } | string {
    const s = this.session, doc = s.closedDoc(), anim = s.animation, bone = s.selectedBone;
    if (!doc) return "Nothing open.";
    if (bone === null) return anim ? "Select a bone to see its path." : "Select a bone to see it on the setup pose.";
    const name = anim?.name ?? null, c = this.cached;
    if (!c || c.doc !== doc || c.images !== s.images || c.skin !== s.skin || c.animation !== name || c.bone !== bone || c.space !== this.space || c.origin !== this.originName() || c.tiers !== this.tiersKey()) {
      const poser = this.posers();
      const origin = this.originName(), trail = anim ? boneTrail(poser, s.skin, anim.name, bone, s.fps, s.length(anim), this.space, origin) : null;
      const extent = extentOf(poser, s.skin, name, bone, this.space, origin, s.fps, trail?.frames ?? 0, ...this.tiersFor());
      this.cached = { doc, images: s.images, skin: s.skin, animation: name, bone, space: this.space, origin, trail, extent, tiers: this.tiersKey() };
      // New content: shown whole.
      if (!c || c.bone !== bone || c.animation !== name || c.space !== this.space || c.origin !== origin) { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.hold = false; }
    }
    const c2 = this.cached!;
    return c2.trail || (!anim && c2.extent) ? { trail: c2.trail, bone, extent: c2.extent } : `${bone} has no pose in this skin.`;
  }

  /**
   * What the Stage draws of the selected bone when Stage is on: its joint's path in world space over
   * the animation shown, and the colour. Null when off, in Pose mode, or with no bone.
   */
  stageTrail(): { trail: BoneTrail; colour: string } | null {
    const s = this.session, doc = s.closedDoc(), anim = s.animation, bone = s.selectedBone;
    if (!this.stagePath.on || !doc || !anim || bone === null) return null;
    const c = this.stageCache;
    if (!c || c.doc !== doc || c.images !== s.images || c.skin !== s.skin || c.animation !== anim.name || c.bone !== bone || c.fps !== s.fps) {
      this.stageCache = { doc, images: s.images, skin: s.skin, animation: anim.name, bone, fps: s.fps, trail: boneTrail(this.posers(), s.skin, anim.name, bone, s.fps, s.length(anim), "world") };
    }
    const trail = this.stageCache!.trail;
    return trail ? { trail, colour: this.stagePath.colour } : null;
  }

  /** Stage on or off, or a new colour: kept, the panel and the Stage drawn again. */
  private setStagePath(next: Partial<{ on: boolean; colour: string }>): void {
    this.stagePath = { ...this.stagePath, ...next };
    try { localStorage.setItem(STAGE_PATH_KEY, JSON.stringify(this.stagePath)); } catch { /* not kept */ }
    this.slotSig = "";
    this.schedule();
    this.onStagePath();
  }

  /** The tiers the picture must have room for: the most asked for by Bone or Image, above and below. */
  private tiersFor(): [number, number] {
    return [Math.min(ALL, Math.max(this.counts.bone.a, this.counts.image.a)), Math.min(ALL, Math.max(this.counts.bone.b, this.counts.image.b))];
  }

  private tiersKey(): string { return this.tiersFor().join("|"); }

  private draw(): void {
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    const s = this.session, r = this.trail();
    for (const l of LAYERS) this.layerBtns[l].setAttribute("aria-pressed", String(this.show[l]));
    this.syncSteps();
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
      this.title.textContent = "FramePath";
      this.note.textContent = r;
      this.note.hidden = false;
      return;
    }
    this.note.hidden = true;
    const { trail, bone, extent } = r, css = style;
    const accent = css.getPropertyValue("--accent").trim() || "#4c9bff", muted = css.getPropertyValue("--muted").trim() || "#999", text = css.getPropertyValue("--text").trim() || "#ddd", boneColour = css.getPropertyValue("--bone").trim() || "#ccc";
    this.title.textContent = `${bone}${this.originName() ? ` · Parent ${this.originName()}` : " · Parent"}${trail ? "" : " · Pose"}`;
    // The box round the trails and the bone's image, drawn at one scale (y up) with room round it.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const grow = (x: number, y: number) => { if (Number.isFinite(x) && Number.isFinite(y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } };
    for (const a of trail ? [trail.joint, trail.tip] : []) for (let i = 0; i < a.length; i += 2) grow(a[i]!, a[i + 1]!);
    if (extent) { grow(extent.minX, extent.minY); grow(extent.maxX, extent.maxY); }
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
    this.scaleHandle = null;
    this.shearHandle = null;
    this.arrows = [];
    this.tag = null;
    drawBackdrop(g, { width, height, left: cx + (-width / 2 - this.pan.x) / k, right: cx + (width / 2 - this.pan.x) / k, top: cy + (height / 2 + this.pan.y) / k, bottom: cy + (-height / 2 + this.pan.y) / k, scale: k, ...this.background(), background: stageBg, light: lightColour(stageBg) });
    const here = trail ? Math.min(s.frame, trail.frames) : 0;
    // At the playhead: the pose the image and the bone are drawn from (the setup pose in Pose mode).
    const poser = this.posers(), p = trail ? poser.pose(s.skin, s.animation!.name, Math.fround(frameTime(here, trail.fps)), "none") : poser.pose(s.skin, null, 0, "none"), index = p.bones.get(bone);
    const to = (x: number, y: number): [number, number] => (this.space === "parent" && index !== undefined ? fromParent(p, index, x, y, this.originName()) : [x, y]);
    if (this.show.onion && trail && index !== undefined) this.drawOnion(g, poser, bone, trail, here, at, dpr, boneColour);
    // The tiers of bones round the bone, as many as Bone and Image each ask for (docs/SHOW-STEPPERS-PLAN.md): above (the parent first) behind it, fainter; below (the children) over it.
    const parents = p.rig.data.bones.map((b) => b.parent), live = (list: readonly number[]) => list.filter((b) => p.rig.active[b]);
    const imageT = index === undefined ? null : tiersAround(parents, index, this.counts.image.a, this.counts.image.b), boneT = index === undefined ? null : tiersAround(parents, index, this.counts.bone.a, this.counts.bone.b);
    const faint = (b: number, i: number): number => (parents[i] === b ? 0.6 : 0.4);
    if (this.show.bone && index !== undefined && boneT) {
      for (const b of live(boneT.above)) {
        const m = boneMatrix(p, b), [jx, jy] = at(...to(m[4], m[5])), [tx, ty] = at(...to(...boneTip(p, b)));
        if ([jx, jy, tx, ty].every(Number.isFinite)) { g.save(); g.globalAlpha = faint(b, index); this.drawBone(g, jx, jy, tx, ty, boneColour); g.restore(); }
      }
    }
    if (this.show.image && index !== undefined && imageT) {
      g.save();
      g.globalAlpha = 0.6;
      this.drawImage(g, p, live(imageT.above), to, at, dpr);
      g.restore();
      this.drawImage(g, p, [index, ...imageT.below], to, at, dpr);
    }
    if (this.show.bone && index !== undefined && boneT) {
      // The bones below first and lighter, the selected bone over them.
      for (const b of [...live(boneT.below), index]) {
        if (!p.rig.active[b]) continue;
        const m = boneMatrix(p, b), [jx, jy] = at(...to(m[4], m[5])), [tx, ty] = at(...to(...boneTip(p, b)));
        if ([jx, jy, tx, ty].every(Number.isFinite)) { g.save(); g.globalAlpha = b === index ? 1 : 0.65; this.drawBone(g, jx, jy, tx, ty, boneColour); g.restore(); }
      }
    }
    if (this.show.path && trail) this.drawPath(g, trail, bone, at, here, { accent, muted });
    if (trail) this.drawKeyHandles(g, trail, at, this.stagePath.colour);
    if (trail && index !== undefined && p.rig.active[index] && !constraintDriving(s.doc!, bone)) {
      if (this.show.move) this.drawArrows(g, p, index, to, at);
      if (this.show.rotate) this.drawHandle(g, p, index, to, at, accent);
      if (this.show.scale || this.show.shear) this.drawScaleShear(g, p, index, to, at, accent);
    }
    g.fillStyle = text;
    g.font = `11px "JetBrains Mono", monospace`;
    g.textBaseline = "top";
    g.fillText(trail ? `frame ${here} of ${trail.frames} · ${trail.fps} fps · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}` : `setup pose · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}`, 8, 6);
  }

  /** Onion skin: the bone (its image, and the bone) at the frames either side of the playhead, farthest first, past red and future green when colour-coded. */
  private drawOnion(g: CanvasRenderingContext2D, poser: Poser, bone: string, trail: BoneTrail, here: number, at: (x: number, y: number) => [number, number], dpr: number, boneColour: string): void {
    const s = this.session, a = s.animation!, o = { ...this.onion(), before: this.shownCounts("onion").a, after: this.shownCounts("onion").b }, end = timeFrame(s.length(a), trail.fps);
    const keyed = o.keyedOnly ? keyLists(a).flatMap((l) => l.keys.map((k) => timeFrame(keyTime(k), trail.fps))) : [];
    const frames = onionFrames(here, end, o, keyed, s.loop).sort((x, y) => x.opacity - y.opacity);
    for (const f of frames) {
      const p = poser.pose(s.skin, a.name, Math.fround(frameTime(f.frame, trail.fps)), "none"), i = p.bones.get(bone);
      if (i === undefined) continue;
      const to = (x: number, y: number): [number, number] => (this.space === "parent" ? fromParent(p, i, x, y, this.originName()) : [x, y]);
      const colour = o.colour ? (f.side === "before" ? PAST : FUTURE) : null;
      if (this.show.image) {
        // The image into a scratch canvas, then a silhouette in the ghost's colour when colour-coded, then onto the panel faint.
        const sc = this.scratch ?? (this.scratch = document.createElement("canvas"));
        if (sc.width !== this.canvas.width || sc.height !== this.canvas.height) { sc.width = this.canvas.width; sc.height = this.canvas.height; }
        const c2 = sc.getContext("2d")!;
        c2.setTransform(1, 0, 0, 1, 0, 0);
        c2.globalCompositeOperation = "source-over";
        c2.clearRect(0, 0, sc.width, sc.height);
        this.drawImage(c2, p, setOf(p.rig.data.bones.map((b) => b.parent), i, this.counts.image.a, this.counts.image.b), to, at, dpr);
        if (colour) { c2.setTransform(1, 0, 0, 1, 0, 0); c2.globalCompositeOperation = "source-in"; c2.fillStyle = colour; c2.fillRect(0, 0, sc.width, sc.height); c2.globalCompositeOperation = "source-over"; }
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = f.opacity;
        g.drawImage(sc, 0, 0);
        g.restore();
      }
      if (this.show.bone) {
        for (const b of setOf(p.rig.data.bones.map((q) => q.parent), i, this.counts.bone.a, this.counts.bone.b)) {
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
    // The path in the speed graph's colour (the swatch by Stage), so the line, its dots and the graph read as one (FRAMEPATH-SPEED-PLAN step 17).
    const pathColour = this.stagePath.colour;
    g.strokeStyle = pathColour;
    g.lineWidth = 2;
    trace(trail.joint);
    // The span at the playhead (its tab lit on the strip) in the same accent, a little wider, so both are seen as one (step 18).
    const span = this.litSpan();
    if (span) {
      g.save();
      g.strokeStyle = c.accent;
      g.lineWidth = 3;
      g.lineJoin = "round";
      g.beginPath();
      let pen = false;
      for (let f = span[0]; f <= Math.min(span[1], trail.frames); f++) {
        const x = trail.joint[f * 2]!, y = trail.joint[f * 2 + 1]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) { pen = false; continue; }
        const [px, py] = at(x, y);
        if (pen) g.lineTo(px, py); else g.moveTo(px, py);
        pen = true;
      }
      g.stroke();
      g.restore();
    }
    const keyed = new Set<number>(), marks: number[] = [];
    for (const group of this.session.animation?.bones ?? []) if (group.name === bone) for (const t of group.timelines) for (const key of t.keys) keyed.add(Math.round((key.time ?? 0) * trail.fps));
    for (let f = 0; f <= trail.frames; f++) {
      const x = trail.joint[f * 2]!, y = trail.joint[f * 2 + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) { marks.push(Number.NaN, Number.NaN); continue; }
      const [px, py] = at(x, y);
      marks.push(px, py);
      g.beginPath();
      if (f === here) { g.fillStyle = "#ffffff"; g.strokeStyle = pathColour; g.lineWidth = 3; g.arc(px, py, 6, 0, Math.PI * 2); g.fill(); g.stroke(); continue; }
      // Only keyed frames get a dot (step 12); an unkeyed frame is still on the line, and a click there still goes to it.
      if (!keyed.has(f)) continue;
      g.fillStyle = pathColour;
      g.arc(px, py, 4, 0, Math.PI * 2);
      g.fill();
    }
    this.marks = Float64Array.from(marks);
    // The ⌘ / Shift preview (step 21): where a click adds a key, the key whose menu opens, or the key a click deletes.
    const hv = this.pathHover, hx = hv ? marks[hv.frame * 2] : undefined, hy = hv ? marks[hv.frame * 2 + 1] : undefined;
    if (hv && hx !== undefined && hy !== undefined && Number.isFinite(hx) && Number.isFinite(hy)) {
      g.save();
      g.lineWidth = 2;
      if (hv.kind === "add") {
        g.fillStyle = "#ffffff"; g.strokeStyle = pathColour;
        g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(hx - 3, hy); g.lineTo(hx + 3, hy); g.moveTo(hx, hy - 3); g.lineTo(hx, hy + 3); g.stroke();
      } else if (hv.kind === "menu") {
        g.strokeStyle = c.accent;
        g.beginPath(); g.arc(hx, hy, 8, 0, Math.PI * 2); g.stroke();
      } else {
        g.fillStyle = DELETE_RED; g.strokeStyle = "#ffffff";
        g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      g.restore();
    }
    if (this.show.length) this.drawLengths(g, trail, at, pathColour);
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

  /**
   * The scale handle (a square) and the shear handle (a diamond), either side of the bone's tip: drag one to scale or shear the bone at the
   * playhead, as on the Stage (the same maths, in this panel's axes).
   */
  private drawScaleShear(g: CanvasRenderingContext2D, p: Posed, index: number, to: (x: number, y: number) => [number, number], at: (x: number, y: number) => [number, number], accent: string): void {
    const m = boneMatrix(p, index), [jx, jy] = at(...to(m[4], m[5])), [tx, ty] = at(...to(...boneTip(p, index)));
    if (![jx, jy, tx, ty].every(Number.isFinite)) return;
    const len = Math.hypot(tx - jx, ty - jy), ux = len > 1e-6 ? (tx - jx) / len : 1, uy = len > 1e-6 ? (ty - jy) / len : 0, nx = -uy, ny = ux;
    g.save();
    g.lineWidth = 2;
    g.strokeStyle = accent;
    if (this.show.scale) {
      const x = tx + nx * 22, y = ty + ny * 22, on = this.edit?.kind === "scale";
      this.scaleHandle = { x, y };
      g.globalAlpha = 0.7; g.lineWidth = 1; g.beginPath(); g.moveTo(tx, ty); g.lineTo(x, y); g.stroke(); g.globalAlpha = 1; g.lineWidth = 2;
      g.fillStyle = on ? accent : "#ffffff";
      g.beginPath(); g.rect(x - 5, y - 5, 10, 10); g.fill(); g.stroke();
    }
    if (this.show.shear) {
      const x = tx - nx * 22, y = ty - ny * 22, on = this.edit?.kind === "shear";
      this.shearHandle = { x, y };
      g.globalAlpha = 0.7; g.lineWidth = 1; g.beginPath(); g.moveTo(tx, ty); g.lineTo(x, y); g.stroke(); g.globalAlpha = 1; g.lineWidth = 2;
      g.fillStyle = on ? accent : "#ffffff";
      g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x, y + 7); g.lineTo(x - 7, y); g.closePath(); g.fill(); g.stroke();
    }
    g.restore();
  }

  /** What can be grabbed, on the canvas as last drawn: each frame's mark (x, y pairs) and the rotation handle; for tests. */
  get grabPoints(): { marks: readonly number[]; handle: { x: number; y: number } | null; scaleHandle: { x: number; y: number } | null; shearHandle: { x: number; y: number } | null; tag: { x0: number; y0: number; x1: number; y1: number } | null; arrows: readonly { axis: 0 | 1; x0: number; y0: number; x1: number; y1: number }[] } {
    return { marks: [...this.marks], handle: this.handle, scaleHandle: this.scaleHandle, shearHandle: this.shearHandle, tag: this.tag, arrows: this.arrows };
  }

  /** The bone's space (what the panel shows) at a canvas point: the inverse of the mapping `draw` made. */
  private spaceAt(x: number, y: number): [number, number] | null {
    const m = this.mapping;
    if (!m) return null;
    return [(x - m.width / 2 - this.pan.x) / m.k + m.cx, m.cy - (y - m.height / 2 - this.pan.y) / m.k];
  }

  /** The frame of the mark nearest a canvas point within the grab radius, or -1. */
  private markAt(x: number, y: number): number {
    // Where the path passes a spot more than once (or stands still), the frame nearest the playhead wins (step 20).
    const here = this.session.frame;
    let best = -1, bestD = 12;
    for (let f = 0; f * 2 < this.marks.length; f++) {
      const d = Math.hypot(this.marks[f * 2]! - x, this.marks[f * 2 + 1]! - y);
      if (d < bestD - 0.5 || (d <= bestD + 0.5 && best >= 0 && Math.abs(f - here) < Math.abs(best - here)) || (best < 0 && d <= bestD)) { best = f; bestD = Math.min(bestD, d); }
    }
    return best;
  }

  /**
   * Begin editing the selected bone from a press: on the rotation handle, turn the bone at the
   * playhead; on a mark, go to that frame and move the joint. True when the press was an edit's.
   */
  private beginEdit(x: number, y: number, kind: "move" | "rotate" | "scale" | "shear", frame: number, axis: 0 | 1 | null = null): boolean {
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
    const parent = parentMatrix(p, index), matrix = boneMatrix(p, index), [ox, oy] = fromParent(p, index, 0, 0, this.originName());
    const to = (px: number, py: number): [number, number] => (this.space === "parent" ? fromParent(p, index, px, py, this.originName()) : [px, py]);
    const joint = to(matrix[4], matrix[5]), at = this.spaceAt(x, y) ?? joint;
    this.edit = {
      bone, kind, frame: s.frame, from: animatedLocal(p, index), parent, origin: [-ox, -oy], axis, axes: spaceAxes(this.axes, matrix, parent), start: [x, y],
      key: { animation: anim.name, time: s.keyTime },
      otherEnd: kind !== "move" ? null : this.otherEndTime(frame),
      joint, matrix, sign: turnSign(parent, boneInherit(b), p.rig.scaleX * p.rig.scaleY < 0), inherit: boneInherit(b), last: at, turned: 0, lock: null,
    };
    s.history!.begin(`${{ move: "Move", rotate: "Rotate", scale: "Scale", shear: "Shear" }[kind]} ${bone} at frame ${s.frame}`);
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
    } else if (e.kind === "scale" || e.kind === "shear") {
      // As on the Stage: the drag's world points about the bone's joint (the panel's Local space is the world's, moved to the parent's joint).
      const here = this.spaceAt(x, y), began = this.spaceAt(e.start[0], e.start[1]);
      if (!here || !began) return;
      const world = (q: Point): Point => (this.space === "parent" ? [q[0] + e.origin[0], q[1] + e.origin[1]] : q), p0 = world(began), p1 = world(here);
      if (e.kind === "scale") {
        let fx: number, fy: number;
        if (this.axes === "parent" || shift) [fx, fy] = scaleFactors(e.matrix, p0, p1, shift, 12 / m.k);
        else { const held = scaleAlong(this.axes, e.matrix, e.parent, p0, p1, e.lock, 4 / m.k, 12 / m.k); [fx, fy] = held.factors; e.lock = held.lock; }
        local = { ...e.from, scaleX: tidy(e.from.scaleX * fx, 3), scaleY: tidy(e.from.scaleY * fy, 3) };
        property = "scale";
        said = `${e.bone} · frame ${e.frame} · scale ${local.scaleX}, ${local.scaleY}`;
      } else {
        let lx: number, ly: number;
        if (this.axes === "parent") [lx, ly] = shearDelta((Math.atan2(e.matrix[2], e.matrix[0]) * 180) / Math.PI, p1[0] - p0[0], p1[1] - p0[1], shift);
        else { const held = shearAlong(this.axes, e.matrix, e.parent, p0, p1, e.lock, 4 / m.k); [lx, ly] = held.delta; e.lock = held.lock; }
        local = { ...e.from, shearX: tidy(e.from.shearX + lx, 2), shearY: tidy(e.from.shearY + ly, 2) };
        property = "shear";
        said = `${e.bone} · frame ${e.frame} · shear ${local.shearX}, ${local.shearY}`;
      }
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
      s.history!.apply("step", keyBone(e.key.animation, e.bone, [property], local, e.key.time));
      if (e.otherEnd !== null) s.history!.apply("step", keyBone(e.key.animation, e.bone, [property], local, e.otherEnd));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return;
    }
    this.onStatus(said);
    s.changed();
  }

  /** The distance between each pair of neighbouring dots, at the middle of the segment between them, as a number in the panel's space; left out where the segment is too short on the canvas to hold it. */
  private drawLengths(g: CanvasRenderingContext2D, trail: BoneTrail, at: (x: number, y: number) => [number, number], colour: string): void {
    g.save();
    g.font = `10px "JetBrains Mono", monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = colour;
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
    const s = this.session, bone = s.selectedBone, anim = s.animation;
    const can = !!anim && bone !== null && !(s.doc && constraintDriving(s.doc, bone));
    // Nothing here comes and goes (the header and the bar keep their size): what does not apply is dimmed, and the bar says why.
    this.menuBtn.disabled = !can;
    this.layerBtns.path.disabled = !can;
    this.hint.textContent = !can ? (anim ? "Select a bone to see its motion." : "Select a bone in Animate mode to see its motion.") : this.keyHint();
    // A bone keyed as separate x and y: Convert… beside the hint (step 3 of docs/SPINE-IMPORT-FRAMEPATH-PLAN.md).
    if (can && anim && bone !== null && translateNodes(anim, bone) === null) this.hint.append(" ", this.convertBtn);
    this.renderKeyStrip();
  }

  /** The line under the header: what FramePath shows, or why there are no numbered keys to pick. */
  private keyHint(): string {
    const s = this.session, a = s.animation, bone = s.selectedBone;
    if (!a) return "FramePath: open an animation (Animate mode) to see a bone's keys here.";
    if (bone === null) return "FramePath: select a bone to see its keys here.";
    const driver = s.doc ? constraintDriving(s.doc, bone) : null;
    if (driver) return `FramePath: ${bone} is placed by the ${driver.type} constraint ${driver.name}, so its translate keys do not move it.`;
    const keys = translateNodes(a, bone);
    if (keys === null) return `FramePath: ${bone} keys translate as separate x and y, so it has no frame strip or speed graph yet.`;
    if (keys.length < 2) return `FramePath: ${bone} has ${keys.length === 0 ? "no translate keys" : "one translate key"} in ${a?.name ?? "this animation"}; ◆ keys its place on the playhead's frame.`;
    return "FramePath: the bone's keyed motion.";
  }

  /** FramePath's nodes: the bone's combined translate keys in the animation shown; null when there is nothing to show or the keys are split x and y. */
  private keyNodes(): readonly Key[] | null {
    const s = this.session, a = s.animation, bone = s.selectedBone;
    if (!a || bone === null || (s.doc && constraintDriving(s.doc, bone))) return null;
    return translateNodes(a, bone);
  }

  /** The FramePath node keyed on `frame`, or -1. */
  private keyAtFrame(frame: number): number {
    return this.keyNodes()?.findIndex((k) => timeFrame(keyTime(k), this.session.fps) === frame) ?? -1;
  }

  /** Pick FramePath node `i`: the playhead goes to its frame. */
  private pickKey(i: number): void {
    const s = this.session, k = this.keyNodes()?.[i];
    this.slotSig = "";
    if (k) { s.pause(); s.seek(timeFrame(keyTime(k), s.fps)); }
    this.schedule();
  }

  /** The edits at FramePath node `i`, and in a closed FramePath at the node at the other end too, as one undo step. */
  private applyAtKey(i: number, label: string, edit: (index: number, k: Key) => (d: Skeleton) => Skeleton): void {
    const s = this.session, keys = this.keyNodes(), k = keys?.[i];
    if (!keys || !k || !s.history) return;
    const last = keys.length - 1, other = this.framesClosed && last > 0 && (i === 0 || i === last) ? (i === 0 ? last : 0) : -1;
    try {
      s.history.apply(label, (d) => { const one = edit(i, k)(d); return other >= 0 ? edit(other, keys[other]!)(one) : one; });
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return;
    }
    s.changed();
  }

  /** FramePath node `i`'s speed set (docs/FRAMEPATH-SPEED-PLAN.md): written into the curves of the spans either side of its key. */
  private setKeySpeed(i: number, v: number): void {
    const keys = this.keyNodes(), bone = this.session.selectedBone, pr = keys && bone !== null ? keySpeedPairs(bone, keys)[i] : undefined;
    if (!pr) return;
    // The point moves both legs by the same amount (in Mirror they are one value).
    const d = v - (this.keyPoint(pr) ?? 0);
    this.setKeySpeeds(i, { in: pr.in === null ? undefined : pr.in + d, out: pr.out === null ? undefined : pr.out + d });
  }

  /** FramePath key `i`'s in and out speeds (a side left out stays), held to the range; a closed FramePath's other end too. */
  private setKeySpeeds(i: number, sp: { in?: number | undefined; out?: number | undefined }, label = `Set the speed of key ${i + 1}`): void {
    const a = this.session.animation, bone = this.session.selectedBone;
    if (!a || bone === null) return;
    const held = { in: sp.in === undefined ? undefined : clampSpeed(sp.in), out: sp.out === undefined ? undefined : clampSpeed(sp.out) };
    this.applyAtKey(i, label, (index) => setTranslateKeySpeeds(a.name, bone, index, held));
  }

  /** FramePath key `i`'s reach in and out, a share of each straight span (docs/FRAMEPATH-SPEED-PLAN.md, step 10); a side left out stays. */
  private setKeyReaches(i: number, r: { in?: number | undefined; out?: number | undefined }, label = `Set the reach of key ${i + 1}`): void {
    const a = this.session.animation, bone = this.session.selectedBone;
    if (!a || bone === null) return;
    this.applyAtKey(i, label, (index) => setTranslateKeyReaches(a.name, bone, index, r));
  }



  /** A key's point on the graph: its speed, the middle of in and out when they differ; null when both sides are stepped. */
  private keyPoint(pr: { in: number | null; out: number | null }): number | null {
    if (pr.in === null) return pr.out;
    if (pr.out === null) return pr.in;
    return (pr.in + pr.out) / 2;
  }

  /** The id a broken key is remembered by. */
  private keyId(k: Key): string {
    const s = this.session;
    return `${s.animation?.name}/${s.selectedBone}/${keyTime(k)}`;
  }

  /**
   * Key `i`'s mode (docs/FRAMEPATH-SPEED-PLAN.md, step 5), read from its handles: both on their chords at a third is Plain; in line,
   * opposite and at the same speed is Mirror; else Break. A choice the data cannot show (Mirror or Break on a plain key, Break on a
   * mirrored one) is the one kept by the panel.
   */
  private keyMode(i: number): "mirror" | "break" | "plain" {
    const keys = this.keyNodes(), bone = this.session.selectedBone, k = keys?.[i];
    if (!keys || !k || bone === null) return "plain";
    const h = keyHandles(bone, keys)[i]!, c = keyChords(bone, keys)[i]!, chosen = this.keyModes.get(this.keyId(k));
    // Plain is the straight line, at whatever speed (step 8: a speed on a straight span sets its handle's length along the chord).
    const onChord = (v: Vec | null, chord: Vec | null, sign: number): boolean => !v || !chord || alongChord(v, chord, sign);
    if (onChord(h.out, c.out, 1) && onChord(h.in, c.in, -1)) return chosen ?? "plain";
    if (chosen === "break" || !h.in || !h.out) return chosen ?? "mirror";
    const li = Math.hypot(h.in[0], h.in[1]), lo = Math.hypot(h.out[0], h.out[1]);
    const inLine = Math.abs(h.in[0] * h.out[1] - h.in[1] * h.out[0]) <= 1e-3 * Math.max(1, li * lo) && h.in[0] * h.out[0] + h.in[1] * h.out[1] <= 0;
    // The path's own: the speeds are the speed graph's (step 11).
    return inLine ? "mirror" : "break";
  }

  /**
   * Key `i`'s speed legs on the graph (docs/FRAMEPATH-SPEED-PLAN.md, step 11), apart from the path's mode: Linked when the speed in
   * and out are equal, and the reaches too where both sides have one; else Broken. Broken chosen on equal values is kept by the panel.
   */
  private speedMode(i: number): "linked" | "broken" {
    const keys = this.keyNodes(), bone = this.session.selectedBone, k = keys?.[i];
    if (!keys || !k || bone === null) return "linked";
    if (this.speedModes.has(this.keyId(k))) return "broken";
    const pr = keySpeedPairs(bone, keys)[i]!, rc = keyReaches(bone, keys)[i]!;
    const same = (a: number | null, b: number | null, eps: number): boolean => a === null || b === null || Math.abs(a - b) <= eps;
    return same(pr.in, pr.out, 1e-3) && same(rc.in, rc.out, 1e-3) ? "linked" : "broken";
  }

  /** Linked: the speed and reach arriving take the ones leaving. Broken: each leg free. The path is not touched. */
  private setSpeedLegs(i: number, how: "linked" | "broken"): void {
    const keys = this.keyNodes(), bone = this.session.selectedBone, k = keys?.[i];
    if (!keys || !k || bone === null) return;
    const id = this.keyId(k);
    if (how === "broken") this.speedModes.set(id, "broken");
    else {
      this.speedModes.delete(id);
      const pr = keySpeedPairs(bone, keys)[i]!, rc = keyReaches(bone, keys)[i]!;
      if (pr.in !== null && pr.out !== null && Math.abs(pr.in - pr.out) > 1e-3) this.setKeySpeeds(i, { in: pr.out }, `Link the speeds of key ${i + 1}`);
      if (rc.in !== null && rc.out !== null && Math.abs(rc.in - rc.out) > 1e-3) this.setKeyReaches(i, { in: rc.out }, `Link the reaches of key ${i + 1}`);
    }
    this.slotSig = "";
    this.schedule();
  }

  /**
   * Mirror, Break or Plain on key `i`. Plain: both handles back on their chords (straight lines; the speeds stay). Mirror: the in
   * handle turns opposite the out handle at the same speed. Break: each handle free.
   */
  private setKeyLegs(i: number, how: "mirror" | "break" | "plain"): void {
    const keys = this.keyNodes(), bone = this.session.selectedBone, k = keys?.[i], a = this.session.animation;
    if (!keys || !k || bone === null || !a) return;
    const id = this.keyId(k), h = keyHandles(bone, keys)[i]!, c = keyChords(bone, keys)[i]!;
    if (how === "plain") {
      this.keyModes.delete(id);
      this.applyAtKey(i, `Make key ${i + 1} plain`, (index) => setKeyHandles(a.name, bone, index, {
        in: c.in && h.in ? [-c.in[0] / 3, -c.in[1] / 3] : undefined, out: c.out && h.out ? [c.out[0] / 3, c.out[1] / 3] : undefined,
      }));
    } else {
      this.keyModes.set(id, how);
      if (how === "mirror" && h.in && h.out && c.in && c.out) {
        // The handles only: the speeds are the speed graph's Linked · Broken (step 11).
        this.setKeyHandleAt(i, "out", h.out, `Mirror the handles of key ${i + 1}`, true);
      }
    }
    this.slotSig = "";
    this.schedule();
  }

  /** Handle `side` of key `i` set to `v` (translate units); in Mirror (or with `mirror`) the other handle turns opposite at the same speed. */
  private setKeyHandleAt(i: number, side: "in" | "out", v: Vec, label: string, mirror = false): void {
    const keys = this.keyNodes(), bone = this.session.selectedBone, a = this.session.animation;
    if (!keys || bone === null || !a) return;
    const c = keyChords(bone, keys)[i]!, other = side === "out" ? "in" : "out", co = c[other], cs = c[side];
    const set: { in?: Vec; out?: Vec } = { [side]: v };
    if ((mirror || this.keyMode(i) !== "break") && co && cs) {
      const l = Math.hypot(v[0], v[1]), ls = Math.hypot(cs[0], cs[1]), lo = Math.hypot(co[0], co[1]);
      // The same speed: the length in proportion to the other side's chord.
      const k = l > 1e-9 && ls > 1e-9 ? lo / ls : 0;
      set[other] = [-v[0] * k, -v[1] * k];
    }
    this.applyAtKey(i, label, (index) => setKeyHandles(a.name, bone, index, set));
  }

  /** The parent bone's matrix at each key's frame: what takes a handle from translate units to the panel's space and back. */
  private keyMatrices(keys: readonly Key[]): (Matrix | null)[] {
    const s = this.session, a = s.animation, bone = s.selectedBone, sig = `${a?.name}/${bone}/${keys.map((k) => keyTime(k)).join(",")}/${s.skin}`;
    if (this.keyMats && this.keyMats.doc === s.doc && this.keyMats.sig === sig) return this.keyMats.mats;
    const poser = this.posers(), mats = keys.map((k) => {
      if (!a || bone === null) return null;
      const p = poser.pose(s.skin, a.name, keyTime(k), "none"), index = p.bones.get(bone);
      return index === undefined ? null : parentMatrix(p, index);
    });
    this.keyMats = { doc: s.doc, sig, mats };
    return mats;
  }

  /** FramePath's handles on the picture (step 5): from each key that is not Plain, a line to each handle's tip and a ring there. */
  private drawKeyHandles(g: CanvasRenderingContext2D, trail: BoneTrail, at: (x: number, y: number) => [number, number], colour: string): void {
    this.keyHandlePts = [];
    const s = this.session, bone = s.selectedBone, keys = this.keyNodes();
    if (!keys || keys.length < 2 || bone === null) return;
    const hs = keyHandles(bone, keys), mats = this.keyMatrices(keys), legs = this.legColours(colour);
    g.save();
    g.lineWidth = 1.5;
    keys.forEach((k, i) => {
      const f = timeFrame(keyTime(k), s.fps), m = mats[i];
      // Only the picked key's handles (step 12).
      if (i !== this.selKey || f > trail.frames || !m || this.keyMode(i) === "plain") return;
      const jx = trail.joint[f * 2]!, jy = trail.joint[f * 2 + 1]!;
      if (!Number.isFinite(jx) || !Number.isFinite(jy)) return;
      const [cx, cy] = at(jx, jy);
      for (const side of ["in", "out"] as const) {
        const h = hs[i]![side];
        if (!h) continue;
        const [tx, ty] = at(jx + m[0] * h[0] + m[1] * h[1], jy + m[2] * h[0] + m[3] * h[1]);
        const lit = this.keyHandleDrag?.i === i && this.keyHandleDrag.side === side;
        g.globalAlpha = lit || f === s.frame ? 1 : 0.75;
        g.strokeStyle = legs[side];
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(tx, ty); g.stroke();
        g.fillStyle = lit ? "#ffffff" : legs[side];
        g.beginPath(); g.arc(tx, ty, lit ? 6 : 4.5, 0, Math.PI * 2); g.fill();
        this.keyHandlePts.push({ i, side, x: tx, y: ty, jx, jy, m });
      }
    });
    g.restore();
  }

  /** A handle tip on the picture under a canvas point, or null. */
  private keyHandleAt(x: number, y: number): { i: number; side: "in" | "out"; x: number; y: number; jx: number; jy: number; m: Matrix } | null {
    let best: { i: number; side: "in" | "out"; x: number; y: number; jx: number; jy: number; m: Matrix } | null = null, bestD = 9;
    for (const q of this.keyHandlePts) { const d = Math.hypot(q.x - x, q.y - y); if (d <= bestD) { best = q; bestD = d; } }
    return best;
  }

  /** A handle tip dragged to a canvas point: the handle is the offset from the key's joint, taken back through the parent's matrix at that key. */
  private dragKeyHandle(x: number, y: number): void {
    const d = this.keyHandleDrag, here = this.spaceAt(x, y);
    if (!d || !here) return;
    const [lx, ly] = moveDelta(d.m, here[0] - d.jx, here[1] - d.jy), v: Vec = [tidy(lx, 3), tidy(ly, 3)];
    this.setKeyHandleAt(d.i, d.side, v, `Shape the path at key ${d.i + 1}`);
    this.onStatus(`Key ${d.i + 1} · handle ${d.side}: x ${v[0]}, y ${v[1]}${this.keyMode(d.i) === "break" ? "" : " (the other handle follows: Break frees it)"}`);
  }



  /** Delete FramePath key `i` (Shift + click on its point or diamond); one undo step. */
  private deleteKeyAt(i: number): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, k = this.keyNodes()?.[i];
    if (!a || bone === null || !k || !s.history) return;
    s.history.apply(`Delete key ${i + 1} of ${bone}`, deleteKeys(a.name, [{ path: { section: "bones", owner: bone, timeline: "translate" }, time: keyTime(k) }]));
    this.delHover = null;
    s.changed();
    this.onStatus(`${bone}: the translate key on frame ${timeFrame(keyTime(k), s.fps)} is deleted.`);
  }

  /** The red key under the pointer, from where it last was and whether Shift is held. */
  private updateDelHover(shift: boolean): void {
    let next: { where: "graph" | "strip"; i: number } | null = null;
    const o = this.lastOver;
    if (shift && o) {
      if (o.where === "graph") { const i = this.speedDotAt(o.x, o.y); if (i >= 0) next = { where: "graph", i }; }
      else { const d = this.stripDots.find((q) => Math.abs(q.x - o.x) <= 7 && Math.abs(o.y - KEY_Y) <= 9); if (d) next = { where: "strip", i: d.i }; }
    }
    if (next?.where === this.delHover?.where && next?.i === this.delHover?.i) return;
    this.delHover = next;
    this.speedCanvas.style.cursor = next?.where === "graph" ? "pointer" : this.speedCanvas.style.cursor;
    this.keyStrip.style.cursor = next?.where === "strip" ? "pointer" : "";
    this.schedule();
  }

  /** The in and out legs' colours (Preferences, FRAMEPATH-SPEED-PLAN step 19); a leg set to Automatic takes `path`. */
  private legColours(path: string): { in: string; out: string } {
    const css = getComputedStyle(this.element), v = (n: string): string => css.getPropertyValue(n).trim() || path;
    return { in: v("--leg-in"), out: v("--leg-out") };
  }

  /**
   * The preview of a ⌘ or Shift click at the pointer (step 21), by the rule `down` follows: ⌘ on a key's dot opens its menu, ⌘
   * elsewhere on the path adds a key, Shift on a key's dot deletes it. True when there is one (the cursor is set for it).
   */
  private updatePathHover(cmd: boolean, shift: boolean): boolean {
    const p = this.picPointer, f = p && (cmd || shift) ? this.markAt(p.x, p.y) : -1, k = f >= 0 ? this.keyAtFrame(f) : -1;
    const next = f < 0 ? null : cmd ? { kind: k >= 0 ? "menu" as const : "add" as const, frame: f } : shift && k >= 0 ? { kind: "delete" as const, frame: f } : null;
    if (next?.kind !== this.pathHover?.kind || next?.frame !== this.pathHover?.frame) { this.pathHover = next; this.schedule(); }
    // The hand for every preview, the arrow otherwise: the drawing says which (the owner: more cursors are clutter).
    if (next) this.canvas.style.cursor = "pointer";
    else if (this.canvas.style.cursor === "pointer") this.canvas.style.cursor = "";
    return next !== null;
  }

  /** The ⌘ / Shift preview (for tests). */
  get pathHoverNow(): { kind: "add" | "menu" | "delete"; frame: number } | null {
    return this.pathHover;
  }

  /** ⌘ + click on a key's dot: the playhead goes to it and its path mode is chosen from a menu (step 19). */
  private legMenu(i: number, frame: number, cx: number, cy: number): void {
    this.session.seek(frame);
    const current = this.keyMode(i);
    showContextMenu(cx, cy, [
      { label: `Mirror: key ${i + 1}'s legs linked`, checked: current === "mirror", run: () => this.setKeyLegs(i, "mirror") },
      { label: `Break: key ${i + 1}'s legs free`, checked: current === "break", run: () => this.setKeyLegs(i, "break") },
      { label: `Plain: key ${i + 1} with no legs`, checked: current === "plain", run: () => this.setKeyLegs(i, "plain") },
      {},
      { label: `Delete key ${i + 1} (Shift + click)`, run: () => this.deleteKeyAt(i) },
    ]);
  }

  /** The span the playhead is in, as frames [from key, to the next key), or null (no keys, or past the last key): lit on the strip and on the path. */
  private litSpan(): [number, number] | null {
    const s = this.session, keys = this.keyNodes();
    if (!keys) return null;
    const frames = keys.map((k) => timeFrame(keyTime(k), s.fps));
    for (let i = 0; i + 1 < frames.length; i++) if (s.frame >= frames[i]! && s.frame < frames[i + 1]!) return [frames[i]!, frames[i + 1]!];
    return null;
  }



  /**
   * The last-frame popup (docs/FRAME-LIMIT-PLAN.md, step 3), by the strip's button: the frame, and when the animation's keys run past it,
   * Pack (every key scaled into it), Trim (the keys after it cut, the value at it keyed) or Set only (the keys kept). Pack and Trim are one
   * undo step each; the frame itself is the project's view, not the document. Escape, Close or a click outside closes it.
   */
  private openLimitPopup(): void {
    const s = this.session, a = s.animation;
    if (!a) return;
    const doc = this.element.ownerDocument, name = a.name, end = timeFrame(animationDuration(a), s.fps);
    doc.querySelector(".lp-limit-popup")?.remove();
    const pop = doc.createElement("div"), input = doc.createElement("input"), info = doc.createElement("p"), row = doc.createElement("div"), msg = doc.createElement("p");
    pop.className = "lp-limit-popup";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Last frame");
    const title = Object.assign(doc.createElement("div"), { className: "title", textContent: `${name}: last frame` });
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value = String(s.frameLimitOf(name));
    input.setAttribute("aria-label", "Last frame");
    info.className = "info";
    msg.className = "msg";
    row.className = "row";
    const close = (): void => { pop.remove(); doc.removeEventListener("pointerdown", outside, true); };
    const outside = (e: Event): void => { if (!pop.contains(e.target as Node) && e.target !== this.limitBtn) close(); };
    const done = (n: number, said: string): void => { s.setFrameLimit(name, n); s.seek(s.frame); close(); this.onStatus(said); };
    const run = (label: string, edit: (d: Skeleton) => Skeleton, n: number, said: string): void => {
      try { s.history?.apply(label, edit); } catch (err) { if (!(err instanceof EditRefused)) throw err; msg.textContent = err.message; return; }
      s.changed();
      done(n, said);
    };
    const button = (text: string, tip: string, act: () => void): HTMLButtonElement => { const b = this.button(text, tip); b.addEventListener("click", act); return b; };
    const update = (): void => {
      const n = Math.round(Number(input.value)), ok = Number.isFinite(n) && n >= 1;
      msg.textContent = "";
      info.textContent = `Its keys run to frame ${end}.`;
      if (!ok) { row.replaceChildren(); return; }
      if (n >= end) { row.replaceChildren(button("Set", `The playhead stops at frame ${n}`, () => done(n, `${name}: the playhead stops at frame ${n}.`))); return; }
      info.textContent = `Its keys run to frame ${end}, past ${n}:`;
      row.replaceChildren(
        button(`Pack into 0–${n}`, `Every key of ${name} scaled into frames 0 to ${n}: the whole motion plays in ${n} frames`, () => run(`Pack ${name} into ${n} frames`, packAnimation(name, n, s.fps), n, `${name} packed into frames 0–${n}.`)),
        button(`Trim after ${n}`, `The keys after frame ${n} cut; every list keyed at ${n} with its value there, so the motion up to it is the same`, () => run(`Trim ${name} after frame ${n}`, trimAnimation(name, n, s.fps), n, `${name} trimmed after frame ${n}.`)),
        button("Set only", `The keys stay; the playhead stops at frame ${n}`, () => done(n, `${name}: the playhead stops at frame ${n}; its keys after it stay.`)),
      );
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); (row.querySelector("button") as HTMLButtonElement | null)?.click(); } });
    // Escape closes it wherever the focus is in it (a button after a refused Pack too).
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } });
    const closeBtn = button("Close", "Close without changing anything", close);
    closeBtn.className = "close";
    pop.append(title, input, info, row, msg, closeBtn);
    update();
    doc.body.append(pop);
    const r = this.limitBtn.getBoundingClientRect(), k = pageScale();
    pop.style.top = `${(r.bottom + 4) / k}px`;
    pop.style.left = `${Math.max(8, Math.min(r.right / k - 260, (doc.defaultView?.innerWidth ?? 1000) / k - 268))}px`;
    setTimeout(() => doc.addEventListener("pointerdown", outside, true));
    input.focus();
    input.select();
  }

  /** The fps field committed: the document's frame rate, as the Inspector sets it (one undo step; keys keep their times). */
  private setFrameRate(v: string): void {
    const s = this.session, h = s.history, n = Number(v);
    if (!h || !s.doc) return;
    try {
      h.apply(`Set the frame rate to ${n} fps`, setFps(v.trim() === "" || (n === DEFAULT_FPS && s.doc.header?.fps === undefined) ? undefined : n));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      this.fpsInput.value = String(s.fps);
      return;
    }
    s.changed();
    const off = keysOffFrame(s.doc, s.fps);
    this.onStatus(`${s.fps} frames a second; keys keep their times${off ? `, and ${off} key${off === 1 ? " now falls" : "s now fall"} between frames` : ""}.`);
  }

  /** The strip's diamond under a point of the strip, or -1. */
  private stripDotAt(x: number, y: number): number {
    return this.stripDots.find((q) => Math.abs(q.x - x) <= 7 && Math.abs(y - KEY_Y) <= 9)?.i ?? -1;
  }

  /** ⌘ held over a diamond: the strip shows that a drag slides the key in time (step 16). */
  private updateRetimeHover(cmd: boolean): void {
    if (this.retimeDrag !== null) return;
    const o = this.lastOver, on = cmd && o?.where === "strip" && this.stripDotAt(o.x, o.y) >= 0;
    if (on) this.keyStrip.style.cursor = "ew-resize";
    else if (this.keyStrip.style.cursor === "ew-resize") this.keyStrip.style.cursor = "";
  }

  /**
   * Key `i` slid to the frame under the strip's x, held a frame from each neighbour (the first key down to 0, the last up to the
   * animation's end): its time only, so FramePath's picture does not move (`retimeTranslateKey`). The playhead goes with it.
   */
  private retimeKeyTo(i: number, x: number): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, keys = this.keyNodes(), k = keys?.[i];
    if (!a || bone === null || !keys || !k || !s.history) return;
    const f = (key: Key): number => timeFrame(keyTime(key), s.fps), prev = keys[i - 1], next = keys[i + 1];
    const lo = prev ? f(prev) + 1 : 0, hi = next ? f(next) - 1 : timeFrame(s.length(a), s.fps);
    const to = Math.min(hi, Math.max(lo, this.stripFrame(x))), from = f(k);
    if (to === from) return;
    try {
      s.history.apply("step", retimeTranslateKey(a.name, bone, i, frameTime(to, s.fps)));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return;
    }
    s.seek(to);
    this.onStatus(`${bone}: key ${i + 1} on frame ${to}; its place and the path stay.`);
  }

  /** FramePath's lower area (docs/FRAMEPATH-SPEED-PLAN.md, step 2): the ◆ toggle and the frame strip, the key on the playhead's frame and the speed graph. */
  private renderKeyStrip(): void {
    // Always shown (the owner, 2026-10-09): with no bone, no animation or split keys the strip and the graph are empty and the data says why.
    const s = this.session, a = s.animation, bone = s.selectedBone, keys = this.keyNodes(), show = !!keys;
    // The picked key is the one on the playhead's frame; a hand-broken leg is remembered only while the bone and animation stay.
    this.selKey = keys ? this.keyAtFrame(s.frame) : -1;
    if (`${a?.name}/${bone}` !== this.keyBrokenFor) { this.keyBrokenFor = `${a?.name}/${bone}`; this.keyModes.clear(); this.speedModes.clear(); }
    if (this.keyStrip.parentElement !== this.slotBar) this.slotBar.replaceChildren(this.keyToggle, this.keyStrip, this.fpsBox, this.limitBtn, this.stripFit);
    if (this.fpsInput.ownerDocument.activeElement !== this.fpsInput) this.fpsInput.value = String(s.fps);
    this.fpsInput.disabled = !s.doc;
    const limit = a ? s.frameLimitOf(a.name) : null;
    this.limitBtn.textContent = limit === null ? "–" : String(limit);
    this.limitBtn.disabled = !a;
    this.limitBtn.title = a ? `${a.name}'s last frame: the playhead stops at frame ${limit}, and Q / W wrap round to 0 after it. Click to change it` : "An animation's last frame (in Animate mode)";
    this.keyToggle.disabled = !show;
    this.keyToggle.classList.toggle("on", this.selKey >= 0);
    this.keyToggle.title = this.selKey >= 0 ? `Delete the translate key on frame ${s.frame}` : `Key ${bone ?? "the bone"}'s place on frame ${s.frame} (where it is there now, so the motion does not change)`;
    const sig = !show ? "k" : `k|${a?.name}/${bone}|${JSON.stringify(keys)}|${s.frame}|${this.framesClosed}|${[...this.keyModes]}|${[...this.speedModes.keys()]}`;
    if (sig === this.slotSig) return;
    this.slotSig = sig;
    this.renderKeyData(keys ?? []);
  }

  /** ◆: key the bone's place on the playhead's frame, or delete the translate key there; one undo step. */
  private toggleKey(): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, h = s.history, keys = this.keyNodes();
    if (!a || bone === null || !h || !keys) return;
    const i = this.keyAtFrame(s.frame), path = { section: "bones" as const, owner: bone, timeline: "translate" };
    try {
      if (i >= 0) h.apply(`Delete the translate key of ${bone} on frame ${s.frame}`, deleteKeys(a.name, [{ path, time: keyTime(keys[i]!) }]));
      else { this.keyPlaceAt(s.frame); return; }
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return;
    }
    s.changed();
    this.onStatus(`${bone}: the translate key on frame ${s.frame} is deleted.`);
  }

  /** A translate key on `frame` where the bone is there now, so the path does not change; the playhead goes there. One undo step. */
  private keyPlaceAt(frame: number): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, h = s.history;
    if (!a || bone === null || !h) return;
    s.seek(frame);
    const p = s.pose(), index = p?.bones.get(bone);
    if (!p || index === undefined) return;
    try {
      h.apply(`Key ${bone}'s place on frame ${frame}`, keyBone(a.name, bone, ["translate"], animatedLocal(p, index), s.keyTime));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return;
    }
    s.changed();
    this.onStatus(`${bone}: keyed on frame ${frame}.`);
  }

  /** The strip's x of a frame: the speed graph's x of it, moved by how far the graph's canvas is from the strip's (so both line up). */
  private stripX(frame: number): number {
    const a = this.session.animation, d = a ? this.session.length(a) : 0;
    const k = pageScale(), off = (this.speedCanvas.getBoundingClientRect().left - this.keyStrip.getBoundingClientRect().left) / k;
    return off + this.gx(d > 0 ? frame / this.session.fps / d : 0);
  }

  /** The frame under a strip x (held to the animation). */
  private stripFrame(x: number): number {
    const s = this.session, a = s.animation, d = a ? s.length(a) : 0;
    const k = pageScale(), off = (this.speedCanvas.getBoundingClientRect().left - this.keyStrip.getBoundingClientRect().left) / k;
    return Math.min(timeFrame(d, s.fps), Math.max(0, Math.round(this.gp(x - off) * d * s.fps)));
  }

  /**
   * FramePath's frame strip, drawn as the Timeline's top (src/ui/timeline/timeline.ts, paintRuler, paintTabs and paintPlayheadBadge):
   * the ruler with its frame numbers, the green playhead tag with the time since the key before, and under it a tab for each span between
   * two keys (its length in frames and seconds, the playhead's span lit) with a diamond on each key.
   */
  private drawKeyStrip(): void {
    const s = this.session, a = s.animation, keys = this.keyNodes(), c = this.keyStrip;
    this.stripDots = [];
    if (!c.isConnected) return;
    this.blank(c);
    if (!keys || !a) return;
    const w = Math.max(1, Math.floor(c.clientWidth)), h = Math.max(1, Math.floor(c.clientHeight)), dpr = (window.devicePixelRatio || 1) * pageScale();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.element), col = (n: string, f: string): string => css.getPropertyValue(n).trim() || f;
    const panel = col("--panel", "#2a2a2a"), bg = col("--bg", "#1e1e1e"), line = col("--line", "#555"), muted = col("--muted", "#999"), text = col("--text", "#ddd"), accent = col("--accent", "#4c9bff"), hover = col("--hover", "#333"), mono = col("--font-mono", "monospace");
    const end = timeFrame(s.length(a), s.fps), fw = Math.abs(this.stripX(1) - this.stripX(0)), step = labelStep(fw);
    g.fillStyle = panel;
    g.fillRect(0, 0, w, h);
    // The ruler.
    g.fillStyle = bg;
    g.fillRect(0, 0, w, RULER);
    g.font = `11px ${mono}`;
    g.textBaseline = "middle";
    g.textAlign = "center";
    for (let f = 0; f <= end; f++) {
      const x = Math.round(this.stripX(f)) + 0.5;
      if (x < -20 || x > w + 20) continue;
      const major = f % step === 0;
      if (!major && fw < 5) continue;
      g.strokeStyle = line;
      g.beginPath(); g.moveTo(x, major ? 0 : 17); g.lineTo(x, RULER); g.stroke();
      if (major) {
        const label = String(f), lw = Math.ceil(g.measureText(label).width) + 6;
        g.fillStyle = bg;
        g.fillRect(Math.round(x - lw / 2), 2, lw, 14);
        g.fillStyle = muted;
        g.fillText(label, x, 9.5);
      }
    }
    // The tabs: one for each span between two keys.
    const frames = keys.map((k) => timeFrame(keyTime(k), s.fps)), y0 = RULER + 4, th = KEY_TABS - 8, lit = this.litSpan();
    g.font = `10px ${mono}`;
    for (let i = 0; i + 1 < frames.length; i++) {
      const f0 = frames[i]!, f1 = frames[i + 1]!, x0 = this.stripX(f0) + 1.5, x1 = this.stripX(f1) - 1.5;
      if (x1 < 0 || x0 > w || x1 - x0 < 3) continue;
      const here = lit?.[0] === f0;
      g.fillStyle = here ? accent : hover;
      g.globalAlpha = here ? 0.35 : 1;
      g.beginPath(); g.roundRect(x0, y0, x1 - x0, th, 3); g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = here ? accent : line;
      g.beginPath(); g.roundRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, th - 1, 3); g.stroke();
      const n = f1 - f0, long = `${n}f · ${(n / s.fps).toFixed(2)}s`, short = `${n}f`, room = x1 - x0 - 14;
      const label = g.measureText(long).width <= room ? long : g.measureText(short).width <= room ? short : g.measureText(String(n)).width <= room ? String(n) : "";
      if (label) { g.fillStyle = text; g.fillText(label, (x0 + x1) / 2, y0 + th / 2 + 0.5); }
    }
    // A diamond on each key, between its tabs: white on the playhead's frame, red with Shift over it.
    for (const [i, f] of frames.entries()) {
      const x = this.stripX(f);
      if (x < -6 || x > w + 6) continue;
      this.stripDots.push({ i, x });
      // No diamond at a key (step 22): it is where two tabs meet; its place still works, and the one Shift would delete is drawn red.
      if (this.delHover?.where === "strip" && this.delHover.i === i) {
        g.fillStyle = DELETE_RED;
        g.beginPath(); g.moveTo(x, KEY_Y - 5); g.lineTo(x + 5, KEY_Y); g.lineTo(x, KEY_Y + 5); g.lineTo(x - 5, KEY_Y); g.closePath(); g.fill();
      }
    }
    // The playhead: the green tag on the ruler with the time since the key before beside it, and its line down.
    const px = Math.round(this.stripX(s.frame)) + 0.5;
    if (px >= -40 && px <= w + 40) {
      g.strokeStyle = PLAYHEAD_GREEN;
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, 9 + 15 / 2); g.lineTo(px, h); g.stroke();
      g.lineWidth = 1;
      const label = String(s.frame);
      g.font = `600 11px ${mono}`;
      const tw = Math.ceil(g.measureText(label).width) + 10, tx = Math.min(Math.max(px, tw / 2), w - tw / 2), ty = 9 - 15 / 2;
      g.fillStyle = PLAYHEAD_GREEN;
      g.beginPath(); g.roundRect(tx - tw / 2, ty, tw, 15, 4); g.fill();
      g.fillStyle = "#ffffff";
      g.fillText(label, tx, ty + 8);
      const since = secondsSinceLastKey(a, s.frame, s.fps);
      if (since !== null) {
        const note = `+${since.toFixed(2)}s`;
        g.font = `10px ${mono}`;
        g.fillStyle = muted;
        const nw = g.measureText(note).width;
        if (tx + tw / 2 + 6 + nw <= w) { g.textAlign = "left"; g.fillText(note, tx + tw / 2 + 6, ty + 8); }
        else { g.textAlign = "right"; g.fillText(note, tx - tw / 2 - 6, ty + 8); }
        g.textAlign = "center";
      }
    }
  }

  /** The strip's mouse: a press or a drag puts the playhead on the frame under it. */
  private keyStripEvents(): void {
    const c = this.keyStrip;
    let held = false;
    const go = (e: PointerEvent): void => { const [x] = localPoint(c, e), f = this.stripFrame(x); if (f !== this.session.frame) this.session.seek(f); };
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const [x, y] = localPoint(c, e);
      this.lastOver = { where: "strip", x, y };
      this.updateDelHover(e.shiftKey);
      if (this.delHover?.where === "strip") { this.deleteKeyAt(this.delHover.i); return; }
      // ⌘ (Ctrl elsewhere) on a diamond: the key slides in time, the path stays (step 16).
      const dot = (e.metaKey || e.ctrlKey) ? this.stripDotAt(x, y) : -1;
      if (dot >= 0) {
        this.retimeDrag = dot;
        this.session.pause();
        this.session.history?.begin(`Move key ${dot + 1} of ${this.session.selectedBone} in time`);
        c.setPointerCapture(e.pointerId);
        return;
      }
      held = true;
      this.session.pause();
      c.setPointerCapture(e.pointerId);
      go(e);
    });
    c.addEventListener("pointermove", (e) => {
      if (this.retimeDrag !== null) { this.retimeKeyTo(this.retimeDrag, localPoint(c, e)[0]); return; }
      if (held) { go(e); return; }
      const [x, y] = localPoint(c, e);
      this.lastOver = { where: "strip", x, y };
      this.updateDelHover(e.shiftKey);
      this.updateRetimeHover(e.metaKey || e.ctrlKey);
    });
    c.addEventListener("pointerleave", () => { if (!held && this.retimeDrag === null) { this.lastOver = null; this.updateDelHover(false); this.updateRetimeHover(false); } });
    const up = (): void => {
      held = false;
      if (this.retimeDrag === null) return;
      this.retimeDrag = null;
      this.session.history?.end();
      this.slotSig = "";
      this.schedule();
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
  }

  /** The picked FramePath key's data beside the speed graph: its frame, its place and its speed. A field commits on Enter or when it loses focus. */
  private renderKeyData(keys: readonly Key[]): void {
    const box = this.dataBox, doc = box.ownerDocument, s = this.session, a = s.animation, bone = s.selectedBone;
    if (doc.activeElement instanceof HTMLInputElement && box.contains(doc.activeElement)) return;
    const i = this.selKey, k = keys[i];
    if (!k || !a || bone === null) {
      const hint = doc.createElement("span");
      // Not the Stage's .hint, which is placed over the whole box.
      hint.className = "lp-keyhint";
      hint.textContent = !this.keyNodes() ? this.keyHint() : `Frame ${s.frame}: no translate key. ◆ keys the bone's place here; a diamond on the strip, a point on the graph or a dot in the picture goes to a key.`;
      box.replaceChildren(this.speedColumn(doc), hint);
      this.drawSpeed();
      return;
    }
    const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
    const num = (value: number, aria: string, run: (v: number) => void): HTMLInputElement => {
      const input = doc.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.value = String(r4(value));
      input.setAttribute("aria-label", aria);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } if (e.key === "Escape") { input.value = String(r4(value)); input.blur(); } });
      input.addEventListener("change", () => { const v = Number(input.value); if (Number.isFinite(v)) run(r4(v)); else input.value = String(r4(value)); });
      return input;
    };
    const row = (name: string, ...kids: (HTMLElement | string)[]): HTMLElement => {
      const r = doc.createElement("div"), l = doc.createElement("span");
      r.className = "row";
      l.className = "k";
      l.textContent = name;
      r.append(l, ...kids.map((c) => { if (typeof c !== "string") return c; const t = doc.createElement("span"); t.textContent = c; return t; }));
      return r;
    };
    const path = { section: "bones" as const, owner: bone, timeline: "translate" };
    const place = (x: number, y: number): void => this.applyAtKey(i, `Move key ${i + 1} of ${bone}`, (_, key) => setKey(a.name, path, keyTime(key), { x, y }));
    const title = doc.createElement("div");
    title.className = "title";
    const frame = timeFrame(keyTime(k), s.fps), end = timeFrame(s.length(a), s.fps);
    title.textContent = `Key ${i + 1} of ${keys.length} · frame ${frame} of ${end}${this.framesClosed && (i === 0 || i === keys.length - 1) ? " · closed: moves with key " + (i === 0 ? keys.length : 1) : ""}`;
    // The speed arriving and leaving (docs/FRAMEPATH-SPEED-PLAN.md, step 3): an end key has one side; a stepped span's side reads "stepped".
    const pr = keySpeedPairs(bone, keys)[i]!, current = this.keyMode(i), broken = this.speedMode(i) === "broken";
    const side = (which: "in" | "out"): (HTMLElement | string)[] => {
      const v = pr[which], read = doc.createElement("span");
      read.className = "read";
      const missing = which === "in" ? i === 0 : i === keys.length - 1;
      read.textContent = missing ? "—" : v === null ? "stepped" : `×${Math.round(multiplierOf(clampSpeed(v)) * 100) / 100}`;
      const input = num(v === null ? 0 : clampSpeed(v), which === "in" ? "Speed in" : "Speed out", (n) => (broken ? this.setKeySpeeds(i, { [which]: n }) : this.setKeySpeed(i, n)));
      input.min = String(SPEED_MIN);
      input.max = String(SPEED_MAX);
      input.step = "0.05";
      input.disabled = missing;
      return [which === "in" ? "in" : "out", input, read];
    };
    // The reach each side, % of its span (step 10): only a straight span has one.
    const rc = keyReaches(bone, keys)[i]!;
    const reach = (which: "in" | "out"): (HTMLElement | string)[] => {
      const v = rc[which], input = num(v === null ? 0 : Math.round(v * 1000) / 10, which === "in" ? "Reach in" : "Reach out", (n) => this.setKeyReaches(i, broken || rc.in === null || rc.out === null ? { [which]: n / 100 } : { in: n / 100, out: n / 100 }));
      input.min = "2";
      input.max = "100";
      input.step = "1";
      input.disabled = v === null;
      input.title = v === null ? "A curved or missing span has no reach: its time handle is its speed" : "How far into the span the key's speed lasts, % of the span's time (the leg's length on the graph)";
      return [which, input, "%"];
    };
    const modes = doc.createElement("div");
    modes.className = "row buttons";
    const mode = (label: string, how: "mirror" | "break" | "plain", tip: string, on: boolean): void => {
      const b = this.button(label, tip);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => this.setKeyLegs(i, how));
      modes.append(b);
    };
    mode("Mirror", "mirror", "The path's two handles, linked: dragging either moves both (the speeds are the speed legs')", current === "mirror");
    mode("Break", "break", "The path's two handles, each free (the speeds are the speed legs')", current === "break");
    mode("Plain", "plain", "No handles on the path: a straight line to the keys either side (the speed stays as it is)", current === "plain");
    // The speed graph's own legs (step 11): apart from the path's mode.
    const legs = doc.createElement("div");
    legs.className = "row buttons";
    const legMode = (label: string, how: "linked" | "broken", tip: string): void => {
      const b = this.button(label, tip), on = (how === "broken") === broken;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => this.setSpeedLegs(i, how));
      legs.append(b);
    };
    legMode("Linked", "linked", "The speed legs linked: the speed and reach arriving are the ones leaving; dragging either of the key's handles in Curves moves both");
    legMode("Broken", "broken", "The speed legs free: the speed and reach arriving and leaving differ; a handle dragged in Curves moves only its side");
    const fields = doc.createElement("div");
    fields.className = "lp-fields";
    fields.append(title,
      row("Place", "x", num(k.x ?? 0, "Key x", (v) => place(v, k.y ?? 0)), "y", num(k.y ?? 0, "Key y", (v) => place(k.x ?? 0, v))),
      row("Speed", ...side("in"), ...side("out")), row("Reach", ...reach("in"), ...reach("out")), row("Speed legs", legs), row("Path", modes));
    box.replaceChildren(this.speedColumn(doc), fields);
    this.drawSpeed();
  }

  /** A canvas sized to its box and filled with the theme's panel colour (`graph`: the graphs' own), read now from the window the panel is in. */
  private blank(c: HTMLCanvasElement, graph = false): void {
    const w = Math.max(1, Math.floor(c.clientWidth)), h = Math.max(1, Math.floor(c.clientHeight)), dpr = (window.devicePixelRatio || 1) * pageScale();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.element);
    g.fillStyle = (graph ? graphColours(css)("--panel") : css.getPropertyValue("--panel").trim()) || "#2a2a2a";
    g.fillRect(0, 0, w, h);
  }

  /** FramePath's speed graph: the speed the keys' curves give across the animation's frames, a point on each key (the picked one lit). */
  private drawKeySpeed(): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, keys = this.keyNodes(), c = this.speedCanvas;
    this.speedDots = [];
    if (!c.isConnected || this.dataBox.hidden) return;
    // Painted empty first: with nothing to draw it shows the theme's panel, never the last picture in old colours.
    this.blank(c, true);
    if (!keys || !a || bone === null) return;
    const d = s.length(a);
    if (d <= 0) return;
    if (this.gViewFor !== `${a.name}/${bone}`) { this.gViewFor = `${a.name}/${bone}`; this.gView = { x0: 0, x1: 1 }; }
    const w = Math.max(1, Math.floor(c.clientWidth)), h = Math.max(1, Math.floor(c.clientHeight)), dpr = (window.devicePixelRatio || 1) * pageScale();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Drawn as the Timeline's graph (src/ui/timeline/timeline.ts, paint and paintGraph): the panel's colour, the frame lines down
    // through it, past the end dimmed, a 1.5 px curve, square keys (white when picked), thin handles with small rings, the green playhead.
    // The graph colours: the theme's, or a background of its own with lines and text that read on it (Hybrid, docs/HYBRID-THEME-PLAN.md).
    const gc = graphColours(getComputedStyle(this.element)), col = (n: string, f: string): string => gc(n) || f;
    const panel = col("--panel", "#2a2a2a"), bg = col("--bg", "#1e1e1e"), line = col("--line", "#555"), muted = col("--muted", "#999"), text = col("--text", "#ddd"), mono = col("--font-mono", "monospace");
    g.fillStyle = panel;
    g.fillRect(0, 0, w, h);
    const { l, r, t, b } = this.plot(), X = (time: number): number => this.gx(time / d), Y = (v: number): number => t + ((SPEED_MAX - Math.min(SPEED_MAX, Math.max(SPEED_MIN, v))) / (SPEED_MAX - SPEED_MIN)) * (b - t);
    const end = timeFrame(d, s.fps);
    const ex = X(end / s.fps);
    if (ex < r) { g.fillStyle = bg; g.globalAlpha = 0.5; g.fillRect(Math.max(l, ex), 0, r - Math.max(l, ex), h); g.globalAlpha = 1; }
    g.strokeStyle = line;
    g.globalAlpha = 0.35;
    g.beginPath();
    // A guide line at each key, the edges of its spans (CURVES-PANEL-PLAN step 7), in place of a line every few frames.
    for (const k of keys) { const x = Math.round(X(keyTime(k))) + 0.5; if (x >= l && x <= r) { g.moveTo(x, 0); g.lineTo(x, h); } }
    g.stroke();
    g.globalAlpha = 1;
    // The speed values: 0 (the even pace) a full line, the limits dashed, the rest faint.
    g.font = `10px ${mono}`;
    g.textBaseline = "middle";
    g.textAlign = "left";
    for (const v of [SPEED_MIN, 0, 1, 2, 3, 4, SPEED_MAX]) {
      const y = Math.round(Y(v)) + 0.5, edge = v === SPEED_MIN || v === SPEED_MAX;
      g.strokeStyle = line;
      g.globalAlpha = v === 0 ? 1 : edge ? 0.8 : 0.35;
      g.setLineDash(edge ? [4, 3] : []);
      g.beginPath(); g.moveTo(l, y); g.lineTo(r, y); g.stroke();
      g.globalAlpha = 1;
      g.setLineDash([]);
      g.fillStyle = v === 0 ? text : muted;
      g.fillText(String(v), r + 6, y);
    }
    g.save();
    g.beginPath(); g.rect(l, 0, r - l, h); g.clip();
    const pairs = keySpeedPairs(bone, keys), colour = this.stagePath.colour, { x0, x1 } = this.gView;
    // Each span's speed across its time; a stepped span has none.
    g.strokeStyle = colour;
    g.lineWidth = 1.5;
    g.lineJoin = "round";
    keys.forEach((k, i) => {
      const next = keys[i + 1];
      if (!next) return;
      const pts = spanSpeedSamples(bone, k, next, Math.max(8, Math.round(((keyTime(next) - keyTime(k)) / d) * (r - l) / ((x1 - x0) * 4))));
      if (!pts.length) return;
      // Coloured by its value (step 7): the path colour at the even pace, toward green above it, toward red below.
      for (let j = 1; j < pts.length; j++) {
        const p0 = pts[j - 1]!, p1 = pts[j]!;
        g.strokeStyle = speedColour(colour, (p0.v + p1.v) / 2);
        g.beginPath(); g.moveTo(X(p0.t), Y(p0.v)); g.lineTo(X(p1.t), Y(p1.v)); g.stroke();
      }
    });
    // Each key's place on the curve, for a click (no legs and no square on the preview: CURVES-PANEL-PLAN step 8).
    keys.forEach((k, i) => {
      const v = this.keyPoint(pairs[i]!), x = X(keyTime(k)), y = Y(v ?? 0);
      const red = this.delHover?.where === "graph" && this.delHover.i === i;
      // No square at a key (step 7): its place still picks it; the one Shift would delete is shown red.
      if (red) { g.fillStyle = DELETE_RED; g.beginPath(); g.rect(x - 4, y - 4, 8, 8); g.fill(); }
      this.speedDots.push({ i, x, y });
    });
    g.restore();
    // The playhead: the Timeline's green line.
    const px = Math.round(X(frameTime(s.frame, s.fps))) + 0.5;
    if (px >= l && px <= r) {
      g.strokeStyle = PLAYHEAD_GREEN;
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
      g.lineWidth = 1;
    }
  }

  /** The speed graph's column in the data box: a title line over the canvas. */
  private speedColumn(doc: Document): HTMLElement {
    const col = doc.createElement("div"), head = doc.createElement("div");
    col.className = "lp-speed";
    head.className = "lp-speed-bar";
    const title = doc.createElement("span");
    title.className = "title";
    title.textContent = `Speed · ${SPEED_MIN} to ${SPEED_MAX}: the bone goes 1 + it times as fast`;
    title.title = "A preview of every span's speed: click a point or a span to pick it; its timing is eased in Curves, on the left";
    // Fit is an icon at the strip's right end (step 15); Node stays here.
    const fitNode = this.button("Node", "Fit the picked key's span: from it to the next key");
    fitNode.addEventListener("click", () => this.fitGraph(true));
    fitNode.disabled = this.selKey < 0;
    // Stage draws the bone's path on the Stage; the swatch is its colour, the speed curve's and the handles' (docs/STAGE-PATH-PLAN.md).
    const stage = this.button("Stage", this.stagePath.on ? "Hide the bone's path on the Stage" : "Show the bone's path on the Stage, in the swatch's colour");
    stage.className = "lp-stagepath";
    stage.setAttribute("aria-label", "Path on Stage");
    stage.classList.toggle("on", this.stagePath.on);
    stage.setAttribute("aria-pressed", String(this.stagePath.on));
    stage.addEventListener("click", () => this.setStagePath({ on: !this.stagePath.on }));
    const swatch = this.button("", "The path's colour: on the Stage, the speed curve and the handles on the picture");
    swatch.className = "lp-swatch";
    swatch.setAttribute("aria-label", "Path colour");
    swatch.style.background = this.stagePath.colour;
    swatch.addEventListener("click", () => pickColour(swatch, this.stagePath.colour, (hex) => this.setStagePath({ colour: hex })));
    head.append(title, stage, swatch, fitNode);
    col.append(head, this.graphRow, this.speedGrip);
    return col;
  }

  /** What the Curves view shows: the span the playhead is in (the strip's lit tab), its ease, and the playhead across it; or why nothing. */
  private curveSpan(): { index: number; ease: SpanEase; at: number; from: number; to: number } | string {
    const s = this.session, bone = s.selectedBone, keys = this.keyNodes();
    if (!keys || bone === null || !s.animation) return this.keyHint();
    const span = this.litSpan();
    if (!span) return `Frame ${s.frame}: past the last key, so there is no span to ease. Pick a span on the strip or the graph.`;
    const index = keys.findIndex((k) => timeFrame(keyTime(k), s.fps) === span[0]);
    if (index < 0 || !keys[index + 1]) return "No span here.";
    return { index, ease: spanEase(bone, keys[index]!, keys[index + 1]!), at: (s.frame - span[0]) / Math.max(1, span[1] - span[0]), from: span[0], to: span[1] };
  }

  /**
   * A span's ease written from the Curves view (docs/CURVES-PANEL-PLAN.md): its kind (one undo step), or one handle while a drag is
   * under way. The handle is a key's leg (out: the span's first key, in: its last); when that key's speed legs are Linked, its other
   * leg, in the span on its other side, takes the same speed and reach (Decision 2).
   */
  private applySpanEase(index: number, ease: { kind: SpanEase["kind"]; out?: Vec; in?: Vec }, side?: "out" | "in"): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, h = s.history;
    if (!a || bone === null || !h) return;
    const key = side === "out" ? index : side === "in" ? index + 1 : -1, linked = key >= 0 && this.speedMode(key) === "linked";
    try {
      h.apply(side ? "step" : `Make the span after key ${index + 1} ${ease.kind}`, setSpanEase(a.name, bone, index, ease));
      if (linked && side) {
        const keys = this.keyNodes()!, other = side === "out" ? "in" : "out", pr = keySpeedPairs(bone, keys)[key]!, rc = keyReaches(bone, keys)[key]!;
        const v = pr[side], r = rc[side];
        if (v !== null && pr[other] !== null) h.apply("step", setTranslateKeySpeeds(a.name, bone, key, { [other]: v }));
        if (r !== null && rc[other] !== null) h.apply("step", setTranslateKeyReaches(a.name, bone, key, { [other]: r }));
      }
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return;
    }
    s.changed();
  }

  /** The Curves view's width, held so the speed graph keeps room. */
  private applyCurvesWidth(): void {
    this.curves.element.style.width = `${this.curvesWidth}px`;
  }

  /** The line between the Curves view and the speed graph is dragged: right gives Curves more room. */
  private curvesSplitDrag(): void {
    const g = this.curvesSplit;
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = this.curvesWidth, room = this.graphRow.getBoundingClientRect().width / pageScale();
      const move = (ev: PointerEvent): void => {
        this.curvesWidth = Math.round(Math.max(MIN_CURVES, Math.min(room - MIN_GRAPH_WIDTH, w0 + (ev.clientX - x0) / pageScale())));
        this.applyCurvesWidth();
        this.schedule();
      };
      const up = (): void => {
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        try { localStorage.setItem(CURVES_KEY, String(this.curvesWidth)); } catch { /* not kept */ }
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
    g.addEventListener("dblclick", () => {
      this.curvesWidth = DEFAULT_CURVES;
      this.applyCurvesWidth();
      try { localStorage.removeItem(CURVES_KEY); } catch { /* not kept */ }
      this.schedule();
    });
  }

  /** The Curves view's handles on its canvas (for tests). */
  get curveHandles(): readonly { side: "out" | "in"; x: number; y: number }[] {
    return this.curves.handlePoints;
  }

  /** The Curves view's frame numbers on top (for tests). */
  get curveFrameLabels(): readonly string[] {
    return this.curves.frameLabels;
  }

  /** The graph's own height, when set; the area under the picture then scrolls if the graph is taller than it. */
  private applyGraph(): void {
    this.graphRow.style.flex = this.graphHeight === null ? "" : "none";
    this.graphRow.style.height = this.graphHeight === null ? "" : `${this.graphHeight}px`;
    this.dataBox.classList.toggle("tall", this.graphHeight !== null);
  }

  /** The green line under the graph is dragged: down makes the graph taller, up shorter. */
  private gripDrag(): void {
    const g = this.speedGrip, root = g.ownerDocument.documentElement;
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      root.classList.add("bb-gripping-row");
      const y0 = e.clientY, h0 = this.graphRow.getBoundingClientRect().height / pageScale();
      const move = (ev: PointerEvent): void => { this.graphHeight = Math.max(MIN_GRAPH, Math.round(h0 + (ev.clientY - y0) / pageScale())); this.applyGraph(); this.schedule(); };
      const up = (): void => {
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        root.classList.remove("bb-gripping-row");
        try { if (this.graphHeight !== null) localStorage.setItem(GRAPH_KEY, String(this.graphHeight)); } catch { /* not kept */ }
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
    g.addEventListener("dblclick", () => {
      this.graphHeight = null;
      this.applyGraph();
      try { localStorage.removeItem(GRAPH_KEY); } catch { /* not kept */ }
      this.schedule();
    });
  }

  /** The height of the area under the picture: its wish as a flex basis, so a small panel takes it down (to its least) and the picture keeps its least. */
  private applyLower(): void {
    this.lower.style.flex = `0 1 ${Math.max(MIN_LOWER, this.lowerSet ? this.lowerHeight : DEFAULT_LOWER)}px`;
    this.lower.style.minHeight = `${MIN_LOWER}px`;
  }

  private setLower(h: number, keep = false): void {
    this.lowerHeight = Math.max(MIN_LOWER, Math.round(h));
    this.lowerSet = true;
    this.applyLower();
    if (keep) { try { localStorage.setItem(LOWER_KEY, String(this.lowerHeight)); } catch { /* not kept */ } }
    this.schedule();
  }

  /** The line between the picture and the frame strip is dragged: the picture takes what the area under it gives up. */
  private splitDrag(): void {
    const root = this.split.ownerDocument.documentElement;
    this.split.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.split.setPointerCapture(e.pointerId);
      root.classList.add("bb-gripping-row");
      const y0 = e.clientY, h0 = this.lower.getBoundingClientRect().height / pageScale();
      // As tall as it can get with the picture keeping its least.
      const most = h0 + Math.max(0, this.body.getBoundingClientRect().height / pageScale() - MIN_PICTURE);
      const move = (ev: PointerEvent): void => this.setLower(Math.min(most, h0 - (ev.clientY - y0) / pageScale()));
      const up = (): void => {
        this.split.removeEventListener("pointermove", move);
        this.split.removeEventListener("pointerup", up);
        this.split.removeEventListener("pointercancel", up);
        root.classList.remove("bb-gripping-row");
        this.setLower(this.lowerHeight, true);
      };
      this.split.addEventListener("pointermove", move);
      this.split.addEventListener("pointerup", up);
      this.split.addEventListener("pointercancel", up);
    });
    this.split.addEventListener("dblclick", () => { this.setLower(DEFAULT_LOWER, true); this.lowerSet = false; this.applyLower(); });
  }

  /** The graph's plot box on its canvas (CSS pixels): where the visible time and the speed range are drawn. It has no ruler of its own: the frame strip above it is its ruler, as on the Timeline. */
  private plot(): { l: number; r: number; t: number; b: number } {
    const c = this.speedCanvas;
    // Room on the right for the strip's Fit and lock icons, so no frame is drawn under them (step 15).
    // The value labels on the right (step 3 of docs/CURVES-PANEL-PLAN.md: the Curves view is on the left).
    return { l: 10, r: Math.max(11, c.clientWidth - 40), t: 10, b: Math.max(11, c.clientHeight - 8) };
  }

  /** The canvas x of a share of the animation (0..1) in the visible window, and back. */
  private gx(p: number): number {
    const { l, r } = this.plot(), { x0, x1 } = this.gView;
    return l + ((p - x0) / (x1 - x0)) * (r - l);
  }

  private gp(x: number): number {
    const { l, r } = this.plot(), { x0, x1 } = this.gView;
    return x0 + ((x - l) / (r - l)) * (x1 - x0);
  }

  /** The visible window set (at least 2% of the animation, inside 0..1). */
  private setView(x0: number, x1: number): void {
    const w = Math.min(1, Math.max(0.02, x1 - x0)), a = Math.min(1 - w, Math.max(0, x0));
    this.gView = { x0: a, x1: a + w };
    this.schedule();
  }

  /** The whole animation across the graph, or (with `section`) the picked key's span: from it to the next key. */
  private fitGraph(section: boolean): void {
    const keys = this.keyNodes(), a = this.session.animation, d = a ? this.session.length(a) : 0, k = keys?.[this.selKey], next = keys?.[this.selKey + 1];
    if (!section || !k || !next || d <= 0) { this.setView(0, 1); return; }
    const p0 = keyTime(k) / d, p1 = keyTime(next) / d, pad = Math.max(0.01, (p1 - p0) * 0.08);
    this.setView(p0 - pad, p1 + pad);
  }

  /** The speed graph and the frame strip above it. */
  private drawSpeed(): void {
    this.drawKeySpeed();
    this.curves.draw();
    this.drawKeyStrip();
  }

  /** The names of the bones whose bones and images are drawn round the selected bone, above (root-most first) and below (for tests). */
  get shownTiers(): { bones: string[]; images: string[] } {
    const s = this.session, bone = s.selectedBone, anim = s.animation;
    if (!bone) return { bones: [], images: [] };
    const p = this.posers().pose(s.skin, anim?.name ?? null, 0, "none"), i = p.bones.get(bone);
    if (i === undefined) return { bones: [], images: [] };
    const parents = p.rig.data.bones.map((b) => b.parent), names = (l: number[]) => l.map((b) => p.rig.data.bones[b]!.name);
    return { bones: names(setOf(parents, i, this.counts.bone.a, this.counts.bone.b)), images: names(setOf(parents, i, this.counts.image.a, this.counts.image.b)) };
  }

  /** The speed graph's points on its canvas as last drawn (CSS pixels), for tests. */
  get speedPoints(): readonly { i: number; x: number; y: number }[] {
    return this.speedDots;
  }

  /** FramePath's handle tips on the picture as last drawn (canvas CSS pixels), for tests. */
  get keyHandlePoints(): readonly { i: number; side: "in" | "out"; x: number; y: number }[] {
    return this.keyHandlePts;
  }

  /** FramePath's strip diamonds as last drawn (CSS pixels across the strip; their middle is `KEY_Y` down), for tests. */
  get stripPoints(): readonly { i: number; x: number }[] {
    return this.stripDots;
  }







  /** The point of the graph under a canvas point, or -1. */
  private speedDotAt(x: number, y: number): number {
    let best = -1, bestD = 11;
    for (const d of this.speedDots) { const q = Math.hypot(d.x - x, d.y - y); if (q <= bestD) { best = d.i; bestD = q; } }
    return best;
  }

  /**
   * The speed graph's mouse (docs/CURVES-PANEL-PLAN.md, step 3: a preview, nothing on it is dragged): a click on a key's point goes to
   * that key, a click elsewhere puts the playhead on the frame under it (so the Curves view shows that span); Shift + click on a point
   * deletes its key; double-click on a point links its speed legs, elsewhere fits the graph; ⌘ + click or right-click opens the menu;
   * the middle button pans and the wheel zooms over the frames (a sideways wheel or Shift + wheel pans).
   */
  private speedEvents(): void {
    const c = this.speedCanvas, at = (e: PointerEvent | MouseEvent): [number, number] => localPoint(c, e as PointerEvent);
    c.addEventListener("contextmenu", (e) => { e.preventDefault(); const [x, y] = at(e); this.graphMenu(x, y, e.clientX, e.clientY); });
    c.addEventListener("pointerdown", (e) => {
      const [x, y] = at(e);
      if (e.button === 1) {
        e.preventDefault();
        this.graphPan = { x: e.clientX, x0: this.gView.x0, x1: this.gView.x1 };
        c.setPointerCapture(e.pointerId);
        c.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0) return;
      if (e.metaKey) { e.preventDefault(); this.graphMenu(x, y, e.clientX, e.clientY); return; }
      const i = this.speedDotAt(x, y);
      if (e.shiftKey && i >= 0) { e.preventDefault(); this.deleteKeyAt(i); return; }
      e.preventDefault();
      if (i >= 0) { this.pickKey(i); return; }
      const a = this.session.animation;
      if (a) { this.session.pause(); this.session.seek(timeFrame(Math.min(1, Math.max(0, this.gp(x))) * this.session.length(a), this.session.fps)); }
    });
    c.addEventListener("pointermove", (e) => {
      const [x, y] = at(e);
      if (this.graphPan) {
        const { l, r } = this.plot(), span = this.graphPan.x1 - this.graphPan.x0, d = ((e.clientX - this.graphPan.x) / pageScale() / (r - l)) * span;
        this.setView(this.graphPan.x0 - d, this.graphPan.x1 - d);
        return;
      }
      this.lastOver = { where: "graph", x, y };
      this.updateDelHover(e.shiftKey);
      // The hand over a point (a click goes to its key), the arrow elsewhere.
      c.style.cursor = this.speedDotAt(x, y) >= 0 ? "pointer" : "";
    });
    const end = (): void => {
      if (!this.graphPan) return;
      this.graphPan = null;
      c.style.cursor = "";
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [x] = at(e), { l, r } = this.plot(), { x0, x1 } = this.gView, span = x1 - x0;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY) ? e.deltaY : e.deltaX) / pageScale();
        this.setView(x0 + (d / (r - l)) * span, x1 + (d / (r - l)) * span);
        return;
      }
      const k = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), anchor = this.gp(x), w = Math.min(1, Math.max(0.02, span * k)), f = (x - l) / (r - l);
      this.setView(anchor - f * w, anchor + (1 - f) * w);
    }, { passive: false });
    c.addEventListener("pointerleave", () => { this.lastOver = null; this.updateDelHover(false); });
    c.addEventListener("dblclick", (e) => {
      const [x, y] = at(e), i = this.speedDotAt(x, y);
      if (i >= 0) { this.setSpeedLegs(i, "linked"); return; }
      this.fitGraph(false);
    });
  }

  /** The menu of the speed graph over a key's point: its speed legs' mode (not the path's), and its delete. */
  private graphMenu(x: number, y: number, cx: number, cy: number): void {
    const i = this.speedDotAt(x, y);
    if (i < 0) return;
    const current = this.speedMode(i);
    showContextMenu(cx, cy, [
      { label: `Linked: key ${i + 1}'s speed legs move together`, checked: current === "linked", run: () => this.setSpeedLegs(i, "linked") },
      { label: `Broken: key ${i + 1}'s speed legs free`, checked: current === "broken", run: () => this.setSpeedLegs(i, "broken") },
      {},
      { label: `Delete key ${i + 1} (Shift + click)`, run: () => this.deleteKeyAt(i) },
    ]);
  }

  /** What the panel keeps of how it was left, for the project's remembered view (ui/viewMemory.ts). */
  get memory(): MotionMemory {
    return { zoom: this.zoom, pan: { ...this.pan }, axes: this.axes, lower: this.lowerHeight };
  }

  /** Put that back. */
  restoreMemory(m: MotionMemory): void {
    this.zoom = Number.isFinite(m.zoom) && m.zoom > 0 ? m.zoom : 1;
    this.pan = Number.isFinite(m.pan.x) && Number.isFinite(m.pan.y) ? { x: m.pan.x, y: m.pan.y } : { x: 0, y: 0 };
    if (m.axes === "parent" || m.axes === "world") this.axes = m.axes;
    this.hold = false;
    if (typeof m.lower === "number" && m.lower >= MIN_LOWER) { this.lowerHeight = m.lower; this.lowerSet = true; this.applyLower(); }
    this.slotSig = "";
    this.schedule();
  }

  /** In a closed FramePath, the time of the other end of a first or last frame; null for any other frame or when open. */
  private otherEndTime(frame: number): number | null {
    const s = this.session, a = s.animation;
    if (!this.framesClosed || !a) return null;
    const last = timeFrame(s.length(a), s.fps);
    if (last <= 0) return null;
    if (frame === 0) return frameTime(last, s.fps);
    return frame === last ? 0 : null;
  }

  /** FramePath ⋮ ▸ Closed: on, the last frame takes the first frame's place (one undo step) and the two move together from then on. */
  private setFramesClosed(on: boolean): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, h = s.history;
    this.framesClosed = on;
    if (!on) { this.onStatus("FramePath is open: the first and the last frame move on their own."); return; }
    if (!a || bone === null || !h) return;
    const last = timeFrame(s.length(a), s.fps), back = s.frame;
    if (last > 0) {
      s.seek(0);
      const p = s.pose(), index = p?.bones.get(bone);
      if (p && index !== undefined) h.apply(`Close the FramePath of ${bone}`, keyBone(a.name, bone, ["translate"], animatedLocal(p, index), frameTime(last, s.fps)));
      s.seek(back);
      s.changed();
    }
    this.onStatus(`FramePath is closed: frame ${last} is frame 0, and a drag of either moves both.`);
  }

  /** FramePath ⋮ ▸ Delete FramePath data: the bone's translate keys in the animation, one undo step. */
  private deleteKeyData(): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, h = s.history;
    if (!a || !bone || !h) return;
    const n = translateKeyCount(a, bone);
    if (n === 0 || !confirm(`Delete the ${n} translate key${n === 1 ? "" : "s"} of ${bone} in ${a.name}? Undo brings them back.`)) return;
    h.apply(`Delete the translate keys of ${bone}`, deleteTranslateKeys(a.name, bone));
    s.changed();
    this.onStatus(`${bone}: ${n} translate key${n === 1 ? "" : "s"} deleted.`);
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
      // First, so a key under the frame tag can still be picked: ⌘ (Ctrl elsewhere) + click: on a key's dot its leg mode from a menu (step 19); elsewhere on the path a new key (step 20).
      if (e.metaKey || e.ctrlKey) {
        const f = this.markAt(x, y), k = f >= 0 ? this.keyAtFrame(f) : -1;
        if (k >= 0) { e.preventDefault(); this.legMenu(k, f, e.clientX, e.clientY); return; }
        if (f >= 0) { e.preventDefault(); this.keyPlaceAt(f); this.updatePathHover(true, e.shiftKey); return; }
      }
      // Shift + click on a key's dot deletes the key (step 20); Shift elsewhere still holds a drag to one axis.
      if (e.shiftKey) {
        const f = this.markAt(x, y), k = f >= 0 ? this.keyAtFrame(f) : -1;
        if (k >= 0) { e.preventDefault(); this.deleteKeyAt(k); this.updatePathHover(e.metaKey || e.ctrlKey, true); return; }
      }
      if (this.onTag(x, y)) {
        this.session.pause();
        this.scrubbing = true;
        this.grab(e);
        return;
      }
      // A handle's tip shapes the path at its key (docs/FRAMEPATH-SPEED-PLAN.md, step 5); Alt breaks the key's handles first.
      const kh = this.keyHandleAt(x, y);
      if (kh) {
        const k = this.keyNodes()?.[kh.i];
        if (e.altKey && k) this.keyModes.set(this.keyId(k), "break");
        this.session.pause();
        this.hold = true;
        this.keyHandleDrag = { i: kh.i, side: kh.side, jx: kh.jx, jy: kh.jy, m: kh.m };
        this.session.history?.begin(`Shape the path at key ${kh.i + 1}`);
        this.grab(e);
        return;
      }
      const h = this.handle;
      if (h && Math.hypot(h.x - x, h.y - y) <= 11 && this.beginEdit(x, y, "rotate", this.session.frame)) { this.grab(e); return; }
      const sc = this.scaleHandle, sh = this.shearHandle;
      if (sc && Math.hypot(sc.x - x, sc.y - y) <= 11 && this.beginEdit(x, y, "scale", this.session.frame)) { this.grab(e); return; }
      if (sh && Math.hypot(sh.x - x, sh.y - y) <= 11 && this.beginEdit(x, y, "shear", this.session.frame)) { this.grab(e); return; }
      const arrow = this.arrowAt(x, y);
      if (arrow !== null && this.beginEdit(x, y, "move", this.session.frame, arrow)) { this.grab(e); return; }
      const best = this.markAt(x, y);
      if (best >= 0) {
        // Drag a dot to move the bone at that frame.
        const k = this.keyAtFrame(best);
        if (k !== this.selKey && k >= 0) { this.selKey = k; this.slotSig = ""; }
        if (this.beginEdit(x, y, "move", best)) { this.grab(e); return; }
        this.session.seek(best);
        return;
      }
    }
    // Only the middle button pans: a left press on empty space does nothing, so a slip never moves the view.
    if (e.button !== 1) return;
    e.preventDefault();
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
    if (this.keyHandleDrag) {
      const [x, y] = localPoint(this.canvas, e);
      this.dragKeyHandle(x, y);
      return;
    }
    if (this.edit) {
      const [x, y] = localPoint(this.canvas, e);
      this.editTo(x, y, e.shiftKey);
      return;
    }
    if (!this.dragging) {
      const [x, y] = localPoint(this.canvas, e), h = this.handle;
      this.picPointer = { x, y };
      if (this.updatePathHover(e.metaKey || e.ctrlKey, e.shiftKey)) return;
      this.canvas.style.cursor = this.onTag(x, y) || this.keyHandleAt(x, y) ? "grab" : (h && Math.hypot(h.x - x, h.y - y) <= 11) || this.arrowAt(x, y) !== null || this.markAt(x, y) >= 0 ? "grab" : "";
      return;
    }
    this.pan = { x: this.pan.x + e.clientX - this.dragging.x, y: this.pan.y + e.clientY - this.dragging.y };
    this.dragging = { x: e.clientX, y: e.clientY };
    this.schedule();
  }

  private up(e: PointerEvent): void {
    this.scrubbing = false;
    // A handle dragged is one step, taken when it is let go.
    if (this.keyHandleDrag) this.session.history?.end();
    this.keyHandleDrag = null;
    const edit = this.edit;
    if (edit) {
      this.edit = null;
      this.session.history?.end();
      this.session.changed();
    }
    this.dragging = null;
    this.canvas.style.cursor = "";
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  }

  /** Zoom about the picture's centre by `factor` (the + and − buttons in the view bar). */
  private zoomBy(factor: number): void {
    const next = Math.min(200, Math.max(0.05, this.zoom * factor)), ratio = next / this.zoom;
    this.pan = { x: this.pan.x * ratio, y: this.pan.y * ratio };
    this.zoom = next;
    this.schedule();
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
