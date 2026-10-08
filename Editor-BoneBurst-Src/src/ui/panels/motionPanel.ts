import { breakLegs, clampSpeed, curveOf, handleOffsets, mergeNodes, midAfter, mirrorLegs, moveNode, multiplierOf, nodeLabels, nodeProgress, progressAtTime, renumberNodes, reversePath, setSpeedLegs, slopesOf, SPEED_MAX, SPEED_MIN, speedAt, speedOf, pathTime, timeMap, withDuration, withLoop, withNode, withOrigin, withSpeedSlope } from "@/motion";
import { type BoneProperty, keyBone, type LocalPose } from "@/edit/boneKeys";
import { EditRefused } from "@/edit/history";
import { drawnVertices } from "@/engine/draw";
import { boneInherit } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import type { MotionNode, MotionPath } from "@/model/sidecar";
import { frameTime, keyLists, keyTime, timeFrame } from "@/model/timelines";
import { iconButton } from "../icons";
import { showContextMenu } from "../contextMenu";
import type { MenuItem } from "../menubar";
import { pickColour } from "../colourPopup";
import type { MotionMemory } from "../viewMemory";
import { makeKeysFromPath, pathDrive, pathFromKeys, currentNode, dropMotion, keepMotion, motionFor, nodeAfter, parentChoices, pathFromView, pathToView, poseAtNode, refBoneName, refMatrix, startMotion, toView } from "../motion";
import { deleteTranslateKeys, translateKeyCount } from "@/edit/pathKeys";
import { localPoint, pageScale } from "../pageScale";
import type { Session } from "../session";
import { type Matrix, type Point, localRotation, scaleAlong, scaleFactors, shearAlong, shearDelta, spaceAxes, tidy, turn, turnSign } from "../stage/gizmo";
import { animatedLocal, boneMatrix, boneTip, parentMatrix, type Posed, Poser } from "../stage/posed";
import { axisLocked, constraintDriving, shiftedLocal } from "../stage/trailEdit";
import { drawBackdrop } from "../stage/canvasBackdrop";
import { NO_LOOK, type StageLook } from "../stage/look";
import { type OnionOptions, onionFrames } from "../stage/onion";
import { type BoneTrail, boneTrail, drivenPose, type DrivenTrail, fromParent, type TrailSpace } from "../stage/trail";

/** The path with its `active` mark taken off: the bone uses it (the default). */
function withoutInactive(m: MotionPath): MotionPath {
  const { active: _a, ...rest } = m;
  return rest;
}

/** The layers the panel can show: the bone's image, the bone itself, its path, and onion skin (the bone at frames either side of the playhead). */
export type Layer = "image" | "bone" | "parentBone" | "parentImage" | "path" | "spline" | "length" | "onion" | "children" | "rotate" | "move" | "scale" | "shear";
const LAYERS: readonly Layer[] = ["image", "bone", "parentBone", "parentImage", "path", "spline", "length", "onion", "children", "rotate", "move", "scale", "shear"];
/** The four handles the panel can show on the bone (each a toggle in the header, the Stage's tool icons): rotate ring, move arrows, scale square, shear diamond. */
const GIZMOS = ["rotate", "move", "scale", "shear"] as const;
/** The path's dots and the lengths between them. */
const DOT = "#ff2bd6";
/** The height of what is under the picture at first, and the least of it and of the picture. */
const DEFAULT_LOWER = 270, MIN_LOWER = 150, MIN_PICTURE = 120, MIN_GRAPH = 60;
const LOWER_KEY = "boneburst.motionPath.lower";
const GRAPH_KEY = "boneburst.motionPath.graphHeight";
/** A node's speed as the field it is stored in: nothing for 0, an even pace. */
const speedPatch = (v: number): { speed?: number } => (v ? { speed: v } : {});
/** The part of the spline that belongs to the picked node. */
const SPAN = "#2f80ed";
const PAST = "rgb(230, 64, 51)", FUTURE = "rgb(51, 179, 77)";
const LAYERS_KEY = "boneburst.motionPath.layers";
const STAGE_LINE_KEY = "boneburst.motionPath.stageLine";
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
  /** The animation and time to key, or null to pose without keying (Auto Key off). */
  readonly key: { animation: string; time: number } | null;
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
 * The bones from `parent` down to `bone` along the tree, `parent` first and `bone` left out: the parent, then each bone under it on the
 * way (hips, thigh, shin for a foot). A parent that is not above the bone is alone.
 */
function chainTo(p: Posed, parent: number, bone: number): number[] {
  const up: number[] = [];
  for (let b = p.rig.data.bones[bone]!.parent, guard = 0; b >= 0 && guard < 1000; b = p.rig.data.bones[b]!.parent, guard++) {
    up.push(b);
    if (b === parent) return up.reverse();
  }
  return [parent];
}

/**
 * The box round the bone's images and the bone itself at some frames of the trail, in `space`: the
 * panel is scaled to hold them all, so what is drawn does not change size from frame to frame.
 */
function extentOf(poser: Poser, skin: string | null, animation: string | null, bone: string, space: TrailSpace, origin: string | null, fps: number, frames: number, children: boolean): Box | null {
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
  private readonly layerBtns: Record<Layer, HTMLButtonElement>;
  /** Everything is in the parent bone's space (the World view was removed: the path follows its parent). */
  private readonly space: TrailSpace = "parent";
  /** The parent bone picker: the bone whose space the path's nodes are in (docs/MOTION-PARENT-PLAN.md); required before a path can be made. */
  private readonly parentPick = document.createElement("select");
  /** The parent chosen for a bone before its path exists, by "animation|bone". */
  private readonly parentChoice = new Map<string, string>();
  private show: Record<Layer, boolean> = { image: true, bone: true, parentBone: false, parentImage: false, path: true, spline: true, length: true, onion: false, children: false, rotate: true, move: true, scale: true, shear: true };
  /** What onion skin shows (frames before and after, keyed only, colour-coded); set by the app from the preferences. */
  onion: () => OnionOptions = () => ({ before: 2, after: 2, keyedOnly: false, colour: true });
  /** What the Stage draws behind the skeleton (checkerboard, grid, centre axes), from the preferences; set by the app. */
  background: () => { look: StageLook; grid: number | null } = () => ({ look: NO_LOOK, grid: null });
  private scratch: HTMLCanvasElement | null = null;
  /** The view on top of the fit: a zoom (1 = fitted) and a pan in pixels; wheel, drag and Fit change them. */
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private dragging: { x: number; y: number } | null = null;
  /** The tab shown when the bone has no path (a bone with a path shows the one it uses: the path's `active`, docs/MOTION-MODES-PLAN.md). */
  private noPathTab: "keys" | "twin" = "twin";
  /** The bone and animation the mode was chosen for, and whether the person chose it (else it follows the bone's data). */
  private modeFor = "";
  /** The two tabs in the header, each a button with a ⋮ menu button at its end, and the card the body shows when the open tab has nothing to edit. */
  private readonly tabs = document.createElement("div");
  private readonly tabBtns = {} as Record<"keys" | "twin", { box: HTMLElement; main: HTMLButtonElement; more: HTMLButtonElement }>;
  private readonly card = document.createElement("div");
  private cached: { doc: Skeleton; images: unknown; skin: string | null; animation: string | null; bone: string; space: TrailSpace; origin: string | null; trail: BoneTrail | null; extent: Box | null; children: boolean; motion: MotionPath | undefined; kFrame: number } | null = null;
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
  /** The scale square and the shear diamond on the canvas as last drawn (null when hidden). */
  private scaleHandle: { x: number; y: number } | null = null;
  private shearHandle: { x: number; y: number } | null = null;
  /** The drag in progress that edits the animation (docs/LOCALPATH-EDIT-PLAN.md). */
  private edit: BoneEdit | null = null;
  /** The frame tag at the playhead's dot, on the canvas as last drawn; a press on it scrubs along the path. */
  private tag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private scrubbing = false;
  /** The motion path's own row of buttons (docs/PATH-SPEED-PLAN.md), and the node picked on the canvas (-1: none). */
  private readonly motionBar = document.createElement("div");
  private readonly motionInfo = document.createElement("span");
  /** The path bar's sections, and the line that takes their place when the bar has nothing to edit (so the bar keeps its height). */
  private barSections: HTMLElement[] = [];
  private readonly hint = document.createElement("span");
  private readonly motionBtns: Record<"del", HTMLButtonElement>;
  /** The duration in seconds, and whether the spline is a ring. */
  private readonly durationField = document.createElement("input");
  /** The path's own Play (docs/TWO-SYSTEMS-PLAN.md): Play or Pause, Stop, whether the path loops, and its clock. */
  private readonly playBtn = document.createElement("button");
  private readonly stopBtn = document.createElement("button");
  private readonly bothBtn = document.createElement("button");
  private readonly clockLabel = document.createElement("span");
  private readonly durationBox = document.createElement("label");
  private readonly durationHint = document.createElement("span");
  /** The capture bar (docs/PATH-CAPTURE-PLAN.md): a numbered button for each node (press: put the bone there), a green + to add a slot. */
  private readonly slotBar = document.createElement("div");
  /** Under the node numbers: the picked node's numbers and the speed graph (docs/TWINSPLINE-PLAN.md). */
  private readonly dataBox = document.createElement("div");
  /** Everything under the picture (the node numbers and the data), and the line above it that is dragged to give it more or less room. */
  private readonly lower = document.createElement("div");
  private readonly split = document.createElement("div");
  private lowerHeight = DEFAULT_LOWER;
  /** The height was set by a drag (or kept from before); until then the area is the usual height, or less in a small panel. */
  private lowerSet = false;
  /** The speed spline's graph, and its points on the canvas as last drawn; the point being dragged. */
  private readonly speedCanvas = document.createElement("canvas");
  /** The green line under the speed graph: drag it to make the graph taller or shorter (double-click: it fills the room again). */
  private readonly speedGrip = document.createElement("div");
  /** The graph's own height in pixels, or null to fill what the area gives it. */
  private graphHeight: number | null = null;
  private readonly viewBar = document.createElement("div");
  private readonly zoomLabel = document.createElement("span");
  private speedDots: { i: number; x: number; y: number }[] = [];
  private speedDrag: number | null = null;
  /** The speed graph's legs as last drawn, the one being dragged, the visible window along the path (0..1), a pan in progress and the cap being dragged. */
  private speedLegs: { i: number; side: "out" | "in"; x: number; y: number }[] = [];
  private legDrag: { i: number; side: "out" | "in" } | null = null;
  private gView = { x0: 0, x1: 1 };
  private graphPan: { x: number; x0: number; x1: number } | null = null;
  private capDrag = false;
  private gViewFor = "";
  private slotSig = "";
  /** The path as a held number would leave it (and the two nodes), drawn dashed on the canvas while it is dragged. */
  private nodePreview: { motion: MotionPath; from: number } | null = null;
  /** The click that ends a drag of a number is ignored. */
  private suppressClick = false;
  private selNode = -1;
  /** Whether the Stage draws the bone's spline, and in what colour (the button and swatch in the header; kept between sessions). */
  private stageOn = false;
  private stageColour = "#ff9f1c";
  private readonly stageBtn = document.createElement("button");
  private readonly stageSwatch = document.createElement("button");
  private readonly stageRow = document.createElement("div");
  /** The Stage's redraw: called when the line is toggled or recoloured. */
  onStageLine: () => void = () => {};
  /** The numbers of the spline nodes picked together with Command + click (for Merge); empty = just the picked node. */
  private multi = new Set<number>();
  /** The path's nodes on the canvas as last drawn (Local space only). */
  private nodePts: { x: number; y: number }[] = [];
  /** The curve's handles at the nodes on the canvas (Edit Path, Local), and the one being dragged. */
  private handlePts: { slot: number; side: "out" | "in"; x: number; y: number }[] = [];
  private handleDrag: { slot: number; side: "out" | "in" } | null = null;
  /** A node being dragged, or a dot being slid along the path (the speed). */
  private nodeDrag: number | null = null;
  private syncRev = -1;
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
    try {
      const k = JSON.parse(localStorage.getItem(STAGE_LINE_KEY) ?? "{}") as { on?: unknown; colour?: unknown };
      if (typeof k.on === "boolean") this.stageOn = k.on;
      if (typeof k.colour === "string" && /^#[0-9a-f]{6}$/i.test(k.colour)) this.stageColour = k.colour;
    } catch { /* storage blocked: the defaults */ }
    this.head.className = "lp-head";
    this.stageBtn.type = "button";
    this.stageBtn.textContent = "Stage";
    this.stageBtn.title = "Show this bone's path as a line on the Stage";
    this.stageBtn.setAttribute("aria-pressed", String(this.stageOn));
    this.stageBtn.addEventListener("click", () => { this.stageOn = !this.stageOn; this.keepStageLine(); });
    this.stageSwatch.type = "button";
    this.stageSwatch.className = "stage-line-colour";
    this.stageSwatch.title = "The colour of the path line on the Stage";
    this.stageSwatch.setAttribute("aria-label", "Path line colour on the Stage");
    this.stageSwatch.style.background = this.stageColour;
    this.stageSwatch.addEventListener("click", () => pickColour(this.stageSwatch, this.stageColour, (hex) => { this.stageColour = hex; this.keepStageLine(); }));
    this.layerBtns = { image: this.button("Image", "Show the bone's image"), bone: this.button("Bone", "Show the bone"), parentBone: this.button("Bone", "Show the parent bone the path is relative to and the bones from it down to this bone (fainter), where they are at the playhead"), parentImage: this.button("Image", "Show the images of the parent bone and the bones from it down to this bone (behind the bone's own)"), path: this.button("Path", "Show the bone's path over the animation (where it goes, frame by frame)"), spline: this.button("Spline", "Show the spline you draw with Edit Path: its curve, nodes and handles"), length: this.button("Length", "Show the distance between each pair of dots along the path (in the panel's space)"), onion: this.button("Onion", "Show the bone at the frames before (red) and after (green) the playhead; the count is set in Preferences ▸ Behavior"), children: this.button("Children", "Show every bone under the selected one, with their images"), rotate: this.button("Rotate", "Show the rotation handle (the ring beyond the bone's tip)"), move: this.button("Move", "Show the move arrows (when the bone has no path)"), scale: this.button("Scale", "Show the scale handle (the square beside the bone's tip)"), shear: this.button("Shear", "Show the shear handle (the diamond on the other side of the tip)") };
    for (const g of GIZMOS) {
      this.layerBtns[g].setAttribute("aria-label", `Show ${g} handle`);
      iconButton(this.layerBtns[g], g, false);
    }
    try { if (localStorage.getItem(AXES_KEY) === "world") this.axes = "world"; } catch { /* storage blocked: the default */ }
    this.axesBtn.type = "button";
    this.axesBtn.addEventListener("click", () => {
      this.axes = this.axes === "parent" ? "world" : "parent";
      try { localStorage.setItem(AXES_KEY, this.axes); } catch { /* not kept */ }
      this.schedule();
    });
    // The parent's two buttons share their names with the bone's: the groups tell them apart, and so do their accessible names.
    this.layerBtns.parentBone.setAttribute("aria-label", "Parent bone");
    this.layerBtns.parentImage.setAttribute("aria-label", "Parent image");
    // Title and the Stage line on top; under them the toggles in groups: what is shown, the parent's, the handles.
    const tools = document.createElement("div");
    tools.className = "lp-tools";
    tools.append(
      this.group("Show", [this.layerBtns.image, this.layerBtns.bone, this.layerBtns.length, this.layerBtns.onion, this.layerBtns.children]),
      this.group("Parent", [this.layerBtns.parentBone, this.layerBtns.parentImage]),
      this.group("Handles", [this.layerBtns.rotate, this.layerBtns.move, this.layerBtns.scale, this.layerBtns.shear], this.axesBtn),
    );
    // Path and Spline are icons by the tab they belong to: the bone's keyed trail by Key frame, the drawn curve by TwinSpline.
    this.layerBtns.path.setAttribute("aria-label", "Path");
    this.layerBtns.spline.setAttribute("aria-label", "Spline");
    iconButton(this.layerBtns.path, "keyTranslate", false);
    iconButton(this.layerBtns.spline, "path", false);
    this.layerBtns.path.classList.add("lp-layer");
    this.layerBtns.spline.classList.add("lp-layer");
    // The two tabs (docs/MOTION-MODES-PLAN.md): the bone's key frames (a Spine import's included) and its TwinSpline path; each ⋮ opens that tab's menu.
    this.tabs.className = "lp-tabs";
    this.tabs.setAttribute("role", "tablist");
    for (const [id, label, tip, menu] of [
      ["keys", "Key frame", "The bone's motion as keyed in the animation (a Spine file's keys included)", () => this.keysMenu()],
      ["twin", "TwinSpline", "The bone's motion as a path with a speed spline, played on its own clock", () => this.twinMenu()],
    ] as const) {
      const box = document.createElement("div"), main = this.button(label, tip), more = this.button("⋮", `${label}: more`);
      box.className = "lp-tab";
      main.className = "main";
      main.setAttribute("role", "tab");
      main.addEventListener("click", () => this.setMode(id));
      more.className = "more";
      more.setAttribute("aria-label", `${label} menu`);
      more.setAttribute("aria-haspopup", "menu");
      more.addEventListener("click", () => { const r = more.getBoundingClientRect(); showContextMenu(r.left, r.bottom, menu()); });
      box.append(main, more);
      this.tabs.append(id === "keys" ? this.layerBtns.path : this.layerBtns.spline, box);
      this.tabBtns[id] = { box, main, more };
    }
    this.card.className = "lp-card";
    this.head.append(this.title, this.tabs, tools);
    // The Stage line sits under the speed graph, where its colour is also the graph's line.
    this.stageRow.className = "lp-stagerow";
    this.stageRow.append(this.group("Stage line", [this.stageBtn], this.stageSwatch));
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
    // Beside the zoom: the path's transport, since it is the picture's playhead it moves (shown with a path, in the TwinSpline tab).
    const gap = document.createElement("span");
    gap.className = "lp-gap";
    this.viewBar.append(zoomBtn("−", "Zoom out", 1 / 1.25), this.zoomLabel, zoomBtn("+", "Zoom in", 1.25), gap, this.playBtn, this.bothBtn, this.stopBtn, this.clockLabel, this.durationBox, fit);
    this.body.append(this.canvas, this.note, this.card);
    this.motionBar.className = "lp-motion";
    this.motionInfo.className = "lp-motion-info";
    this.motionBtns = {
      del: this.button("− Node", "Remove the picked spline node (a path keeps two)"),
    };
    this.slotBar.className = "lp-slots";
    this.dataBox.className = "lp-data";
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
    field(this.durationField, this.durationBox, "Duration (s)", "How long the path takes, in seconds: the bone is at the start at 0 and, for a ring, back there at the end. The frames shown beside it are at the animation's rate", "Duration", "0.05", "0.1", () => this.setDuration(), this.durationHint);
    // The path's own Play: the path plays on its own clock, with no keys; Stop puts it back at its start.
    this.playBtn.type = "button";
    this.playBtn.className = "lp-play";
    this.playBtn.addEventListener("click", () => { if (this.session.pathClock.playing) this.session.pausePath(); else this.session.playPath(); });
    this.bothBtn.type = "button";
    this.bothBtn.addEventListener("click", () => {
      if (this.session.playing && this.session.pathClock.playing) { this.session.pause(); this.session.pausePath(); } else this.session.playBoth();
    });
    this.stopBtn.type = "button";
    this.stopBtn.textContent = "■ Stop";
    this.stopBtn.title = "Stop the path's clock: back to 0, the bone at the path's start";
    this.stopBtn.addEventListener("click", () => this.session.stopPath());
    this.clockLabel.className = "lp-clock";
    this.clockLabel.title = "The path's own time in seconds";
    this.parentPick.className = "lp-parent";
    this.parentPick.setAttribute("aria-label", "Parent bone");
    this.parentPick.title = "The parent bone the path is relative to: its nodes are in that bone\'s space and follow it. Required before a path can be made";
    this.parentPick.addEventListener("change", () => this.chooseParent(this.parentPick.value));
    // Three sections: the path (parent, start, nodes), its time (total frames, ring), what to do with it (make keys, remove); then what it says.
    const section = (...kids: HTMLElement[]): HTMLElement => { const d = document.createElement("div"); d.className = "lp-sect"; d.append(...kids); return d; };
    this.barSections = [section(this.parentPick, this.motionBtns.del)];
    this.hint.className = "lp-hint";
    this.motionBar.append(...this.barSections, this.hint, this.motionInfo);
    this.motionBtns.del.addEventListener("click", () => this.removeNode());
    // The picture on top; under it the node numbers, and under them the picked node's data.
    this.split.className = "lp-split";
    this.split.title = "Drag to give the node numbers and the speed graph more or less room (double-click: back to the usual)";
    this.split.setAttribute("role", "separator");
    this.split.setAttribute("aria-orientation", "horizontal");
    this.lower.className = "lp-lower";
    this.lower.append(this.slotBar, this.dataBox);
    this.speedCanvas.className = "lp-speed-canvas";
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
    this.element.append(this.head, this.motionBar, this.body, this.viewBar, this.split, this.lower);
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
    this.canvas.addEventListener("dblclick", (e) => {
      const [x, y] = localPoint(this.canvas, e);
      if (this.resetHandleAt(x, y) || this.insertNodeAt(x, y)) return;
      this.fitView();
    });
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("keydown", (e) => {
      if ((e.key !== "Delete" && e.key !== "Backspace") || !this.path()) return;
      if (this.selNode >= 0) { e.preventDefault(); e.stopPropagation(); this.removeNode(); }
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
    requestAnimationFrame(() => { this.queued = false; this.draw(); this.drawSpeed(); });
  }

  /** The bone the selected bone's path is relative to: its path's own, else the choice made in the picker; null when none is chosen yet. */
  private chosenParent(): string | null {
    const s = this.session, a = s.animation, bone = s.selectedBone;
    if (!bone || !a) return null;
    const m = this.path();
    return m ? refBoneName(s.doc, m) : this.parentChoice.get(`${a.name}|${bone}`) ?? null;
  }

  /** The bone the panel measures from: the chosen parent, else the bone's own parent (null: the skeleton's origin). */
  private originName(): string | null {
    const s = this.session, bone = s.selectedBone, chosen = this.chosenParent();
    if (chosen !== null || !bone) return chosen;
    return s.doc?.bones?.find((b) => b.name === bone)?.parent ?? null;
  }

  /** The parent bone's matrix at the playhead (the skeleton's own space when there is none). */
  private refM(parent: string | null): Matrix {
    const p = this.session.pose();
    return p ? refMatrix(p, parent) : [1, 0, 0, 1, 0, 0];
  }

  /** The selected bone's path with its nodes and handles as the panel shows them: through the parent bone's matrix at the playhead. */
  private viewMotion(): MotionPath | undefined {
    const s = this.session, m = this.path();
    return m ? pathToView(m, this.refM(refBoneName(s.doc, m))) : undefined;
  }

  /** A path changed in the view, kept in the parent bone's space (a node that did not move keeps its stored numbers). */
  private keepView(next: MotionPath, label?: string, join = false): void {
    const s = this.session;
    keepMotion(s, pathFromView(next, this.refM(refBoneName(s.doc, next)), this.path()), label, join);
  }

  private posers(): Poser {
    const s = this.session, doc = s.closedDoc()!;
    if (this.poser?.doc !== doc || this.poser.images !== s.images) this.poser = { doc, images: s.images, value: new Poser(doc, s.images) };
    return this.poser.value;
  }

  /** Whether the bone has translate keys in the animation shown: the key frames this panel's other tab can convert (a bone keyed only in rotation or scale is empty here). */
  private hasKeys(): boolean {
    const a = this.session.animation, bone = this.session.selectedBone;
    return !!a && bone !== null && translateKeyCount(a, bone) > 0;
  }

  /**
   * The tab open: for a bone with a path, the system the bone uses (`active`: the TwinSpline, or false for its key frames, the path kept); for a
   * bone with none, the one the person last chose, or by what it has (docs/MOTION-MODES-PLAN.md).
   */
  private get tab(): "keys" | "twin" {
    const m = motionFor(this.session);
    return m ? (m.active === false ? "keys" : "twin") : this.noPathTab;
  }

  /** On a bone or animation not seen yet with no path: Key frame when it has translate keys, else TwinSpline (to create one). */
  private syncMode(): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, key = a && bone ? `${a.name}|${bone}` : "";
    if (key === this.modeFor) return;
    this.modeFor = key;
    this.noPathTab = !key || this.hasKeys() ? (key ? "keys" : "twin") : "twin";
  }

  /**
   * A tab pressed. It is the choice of which system the bone uses: with a path the path's `active` is set (one undo step, both kept); with none it
   * is only the view.
   */
  private setMode(mode: "keys" | "twin"): void {
    const s = this.session, m = motionFor(s);
    if (m) {
      if ((m.active !== false) !== (mode === "twin")) keepMotion(s, mode === "twin" ? withoutInactive(m) : { ...m, active: false }, mode === "twin" ? `Use the TwinSpline of ${m.bone}` : `Use the key frames of ${m.bone}`);
    } else this.noPathTab = mode;
    this.slotSig = "";
    this.schedule();
  }

  /** The Key frame tab's ⋮ menu: make a TwinSpline from the keys, or delete the keys. */
  private keysMenu(): MenuItem[] {
    const s = this.session, a = s.animation, bone = s.selectedBone, keys = a && bone ? translateKeyCount(a, bone) : 0;
    return [
      { label: "Create new TwinSpline from Key frame", disabled: keys === 0, run: () => void this.createPathFromKeys() },
      { label: "Delete Key frame data", disabled: keys === 0, run: () => this.deleteKeyData() },
    ];
  }

  /** The TwinSpline tab's ⋮ menu: make a path or a node, make key frames from the path, or delete the path. */
  private twinMenu(): MenuItem[] {
    const has = !!motionFor(this.session), m = this.path();
    return [
      { label: "Create new TwinSpline", disabled: has, run: () => void this.enterDraw() },
      { label: "Add a spline node", disabled: !has, run: () => this.addNode() },
      {},
      { label: "Closed", checked: !!m?.closed, disabled: !m, run: () => { const c = this.path(); if (c) this.setClosed(!c.closed); } },
      { label: "Loop", checked: !!m?.loop, disabled: !m, run: () => { const c = this.path(); if (c) this.timeEdit(withLoop(c, !c.loop), !c.loop ? "The path starts over at its end." : "The path stops at its end.", "Set the path's loop"); } },
      {},
      { label: "Create new Key frame from TwinSpline", disabled: !has, run: () => this.createKeysFromPath() },
      { label: "Delete TwinSpline data", disabled: !has, run: () => this.deletePathData() },
    ];
  }

  /** The card over the picture when the open tab has nothing to edit: what there is, and the way on. */
  private updateCard(): void {
    const s = this.session, bone = s.selectedBone, a = s.animation, raw = motionFor(s);
    const can = !!a && bone !== null && !(s.doc && constraintDriving(s.doc, bone));
    this.card.replaceChildren();
    this.card.hidden = true;
    if (!can) return;
    const line = (text: string): void => { const p = document.createElement("p"); p.textContent = text; this.card.append(p); };
    const btn = (text: string, title: string, run: () => void, primary = false): void => { const b = this.button(text, title); if (primary) b.classList.add("primary"); b.addEventListener("click", run); this.card.append(b); };
    if (this.tab === "keys" && raw) {
      line(`${bone} uses its key frames. Its TwinSpline is kept, not used.`);
      btn("Use TwinSpline", "Switch the bone to its TwinSpline (the key frames are kept)", () => this.setMode("twin"), true);
      this.card.hidden = false;
    } else if (this.tab === "twin" && !raw) {
      const keys = translateKeyCount(a!, bone!);
      line(`No TwinSpline for ${bone} in ${a!.name}.`);
      btn("Create new", "Make a TwinSpline for this bone: node 1 is where it is, node 2 that plus an offset", () => void this.enterDraw(), true);
      if (keys > 0) btn("Create from Key frame", `Make a TwinSpline through the ${keys} translate keys of ${bone} (the keys are kept)`, () => void this.createPathFromKeys());
      this.card.hidden = false;
    }
  }

  /** The selected bone's path, when the TwinSpline tab is the one open: what the editor and the picture work on. The Key frame tab sees no path. */
  private path(): MotionPath | undefined {
    return this.tab === "twin" ? motionFor(this.session) : undefined;
  }

  /** What a path-driven trail or pose needs (docs/TWO-SYSTEMS-PLAN.md): the key animation held at the playhead, the path at its own time. */
  private drivenOf(m: MotionPath): DrivenTrail {
    const s = this.session;
    return { time: Math.fround(frameTime(s.frame, s.fps)), drive: (p, t) => pathDrive(s.doc, [m], m.animation, p, t) };
  }

  /** The path's frame (at the animation's rate) the path clock is at, held to the trail. */
  private pathFrame(m: MotionPath, trail: BoneTrail): number {
    return Math.min(trail.frames, Math.round(pathTime(m, this.session.pathClock.time) * trail.fps));
  }

  /** The trail of the selected bone in the animation shown, worked out again only when the document, skin, animation, bone or space changed. */
  private trail(): { trail: BoneTrail | null; bone: string; extent: Box | null } | string {
    const s = this.session, doc = s.closedDoc(), anim = s.animation, bone = s.selectedBone;
    if (!doc) return "Nothing open.";
    if (bone === null) return anim ? "Select a bone to see its path." : "Select a bone to see it on the setup pose.";
    const name = anim?.name ?? null, c = this.cached, m = anim ? this.path() : undefined;
    // A bone a path drives has the path's trail (over the path's time), and the key playhead matters to it only through the parent's place.
    const kFrame = m ? s.frame : 0;
    if (!c || c.doc !== doc || c.images !== s.images || c.skin !== s.skin || c.animation !== name || c.bone !== bone || c.space !== this.space || c.origin !== this.originName() || c.children !== this.show.children || c.motion !== m || c.kFrame !== kFrame) {
      const poser = this.posers();
      const origin = this.originName(), trail = anim ? boneTrail(poser, s.skin, anim.name, bone, s.fps, m ? m.duration : s.length(anim), this.space, origin, m ? this.drivenOf(m) : undefined) : null;
      const extent = extentOf(poser, s.skin, name, bone, this.space, origin, s.fps, trail?.frames ?? 0, this.show.children);
      this.cached = { doc, images: s.images, skin: s.skin, animation: name, bone, space: this.space, origin, trail, extent, children: this.show.children, motion: m, kFrame };
      // New content: shown whole.
      if (!c || c.bone !== bone || c.animation !== name || c.space !== this.space || c.origin !== origin) { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.hold = false; }
    }
    const c2 = this.cached!;
    return c2.trail || (!anim && c2.extent) ? { trail: c2.trail, bone, extent: c2.extent } : `${bone} has no pose in this skin.`;
  }

  private draw(): void {
    this.syncMode();
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    const s = this.session, r = this.trail();
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
    this.title.textContent = `${bone}${this.originName() ? ` · Parent ${this.originName()}` : " · Parent"}${trail ? "" : " · Pose"}`;
    // The box round the trails and the bone's image, drawn at one scale (y up) with room round it.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const grow = (x: number, y: number) => { if (Number.isFinite(x) && Number.isFinite(y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } };
    for (const a of trail ? [trail.joint, trail.tip] : []) for (let i = 0; i < a.length; i += 2) grow(a[i]!, a[i + 1]!);
    if (extent) { grow(extent.minX, extent.minY); grow(extent.maxX, extent.maxY); }
    // The parent bone, when shown, is in view too (its joint and tip at the playhead).
    const parentName = this.originName();
    if ((this.show.parentBone || this.show.parentImage) && parentName && trail) {
      const pp = this.posers().pose(s.skin, s.animation!.name, Math.fround(frameTime(this.path() ? s.frame : Math.min(s.frame, trail.frames), trail.fps)), "none"), pi = pp.bones.get(parentName), bi = pp.bones.get(bone);
      if (pi !== undefined && pp.rig.active[pi]) {
        // The parent and the bones under it on the way down to the bone (not the branches beside them).
        for (const b of bi === undefined ? [pi] : chainTo(pp, pi, bi)) {
          if (!pp.rig.active[b]) continue;
          const mm = boneMatrix(pp, b), tip = boneTip(pp, b);
          for (const [x, y] of [[mm[4], mm[5]], tip] as const) { const [qx, qy] = this.space === "parent" && bi !== undefined ? fromParent(pp, bi, x, y, parentName) : [x, y]; grow(qx, qy); }
        }
      }
    }
    // The stored poses are in view too, so a node can always be reached.
    const path = this.viewMotion();
    if (path && this.space === "parent") {
      for (const n of path.nodes) grow(n.x, n.y);
      // The curve's handles too (Edit Path), so each can be reached however the parent is turned.
      handleOffsets(path.nodes, path.closed).forEach((o, i) => { const n = path.nodes[i]!; grow(n.x + o.out.x, n.y + o.out.y); grow(n.x + o.in.x, n.y + o.in.y); });
    }
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
    this.nodePts = [];
    this.handlePts = [];
    drawBackdrop(g, { width, height, left: cx + (-width / 2 - this.pan.x) / k, right: cx + (width / 2 - this.pan.x) / k, top: cy + (height / 2 + this.pan.y) / k, bottom: cy + (-height / 2 + this.pan.y) / k, scale: k, ...this.background(), background: stageBg, light: lightColour(stageBg) });
    // A bone with a path is at the path's own time (the path clock), the rest of the rig at the key playhead (docs/TWO-SYSTEMS-PLAN.md).
    const own = trail && s.animation ? this.path() : undefined, here = trail ? (own ? this.pathFrame(own, trail) : Math.min(s.frame, trail.frames)) : 0;
    // At the playhead: the pose the image and the bone are drawn from (the setup pose in Pose mode).
    const poser = this.posers(), p = trail ? (own ? drivenPose(poser, s.skin, s.animation!.name, this.drivenOf(own), here / trail.fps) : poser.pose(s.skin, s.animation!.name, Math.fround(frameTime(here, trail.fps)), "none")) : poser.pose(s.skin, null, 0, "none"), index = p.bones.get(bone);
    const to = (x: number, y: number): [number, number] => (this.space === "parent" && index !== undefined ? fromParent(p, index, x, y, this.originName()) : [x, y]);
    if (this.show.onion && trail && index !== undefined) this.drawOnion(g, poser, bone, trail, here, at, dpr, boneColour);
    const set = index === undefined ? [] : withChildren(p, index, this.show.children);
    // The parent bone the path is relative to and the bones under it down to the bone (hips, thigh, shin for a foot), behind the bone's own: the images, then the bones, fainter.
    const parentIdx = parentName ? p.bones.get(parentName) : undefined;
    if (parentIdx !== undefined && p.rig.active[parentIdx] && parentIdx !== index) {
      const tree = (index === undefined ? [parentIdx] : chainTo(p, parentIdx, index)).filter((b) => p.rig.active[b]);
      if (this.show.parentImage) { g.save(); g.globalAlpha = 0.6; this.drawImage(g, p, tree, to, at, dpr); g.restore(); }
      if (this.show.parentBone) {
        for (const b of tree) {
          const m = boneMatrix(p, b), [jx, jy] = at(...to(m[4], m[5])), [tx, ty] = at(...to(...boneTip(p, b)));
          if ([jx, jy, tx, ty].every(Number.isFinite)) { g.save(); g.globalAlpha = b === parentIdx ? 0.6 : 0.4; this.drawBone(g, jx, jy, tx, ty, boneColour); g.restore(); }
        }
      }
    }
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
    // The spline is its own layer: it shows with the bone's path off, and the path with the spline off.
    // The spline's curve, nodes and handles are in the colour set for the Stage's line (the swatch in the header).
    if (trail) this.drawMotion(g, at, this.stageColour);
    if (trail && index !== undefined && p.rig.active[index] && !constraintDriving(s.doc!, bone)) {
      if (!this.path() && this.show.move) this.drawArrows(g, p, index, to, at);
      if (this.show.rotate) this.drawHandle(g, p, index, to, at, accent);
      if (this.show.scale || this.show.shear) this.drawScaleShear(g, p, index, to, at, accent);
    }
    g.fillStyle = text;
    g.font = `11px "JetBrains Mono", monospace`;
    g.textBaseline = "top";
    g.fillText(trail ? `${own ? "path " : ""}frame ${here} of ${trail.frames} · ${trail.fps} fps · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}` : `setup pose · ${Math.round(w * 10) / 10} × ${Math.round(h * 10) / 10}`, 8, 6);
  }

  /** Onion skin: the bone (its image, and the bone) at the frames either side of the playhead, farthest first, past red and future green when colour-coded. */
  private drawOnion(g: CanvasRenderingContext2D, poser: Poser, bone: string, trail: BoneTrail, here: number, at: (x: number, y: number) => [number, number], dpr: number, boneColour: string): void {
    const s = this.session, a = s.animation!, o = this.onion(), own = this.path(), end = own ? trail.frames : timeFrame(s.length(a), trail.fps);
    // A bone with a path has no keys that count: its ghosts are at the path's own times.
    const keyed = o.keyedOnly && !own ? keyLists(a).flatMap((l) => l.keys.map((k) => timeFrame(keyTime(k), trail.fps))) : [];
    const frames = onionFrames(here, end, o, keyed, own ? own.loop : s.loop).sort((x, y) => x.opacity - y.opacity);
    for (const f of frames) {
      const p = own ? drivenPose(poser, s.skin, a.name, this.drivenOf(own), f.frame / trail.fps) : poser.pose(s.skin, a.name, Math.fround(frameTime(f.frame, trail.fps)), "none"), i = p.bones.get(bone);
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
    // A bone with a path has no keys that count: no mark is larger.
    for (const group of this.path() ? [] : this.session.animation?.bones ?? []) if (group.name === bone) for (const t of group.timelines) for (const key of t.keys) keyed.add(Math.round((key.time ?? 0) * trail.fps));
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
  get grabPoints(): { marks: readonly number[]; handle: { x: number; y: number } | null; scaleHandle: { x: number; y: number } | null; shearHandle: { x: number; y: number } | null; tag: { x0: number; y0: number; x1: number; y1: number } | null; nodes: readonly { x: number; y: number }[]; handles: readonly { slot: number; side: "out" | "in"; x: number; y: number }[];  arrows: readonly { axis: 0 | 1; x0: number; y0: number; x1: number; y1: number }[] } {
    return { marks: [...this.marks], handle: this.handle, scaleHandle: this.scaleHandle, shearHandle: this.shearHandle, tag: this.tag, nodes: this.nodePts, handles: this.handlePts, arrows: this.arrows };
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
    const parent = parentMatrix(p, index), matrix = boneMatrix(p, index), unkeyed = !this.autoKey() || this.drawing, [ox, oy] = fromParent(p, index, 0, 0, this.originName());
    const to = (px: number, py: number): [number, number] => (this.space === "parent" ? fromParent(p, index, px, py, this.originName()) : [px, py]);
    const joint = to(matrix[4], matrix[5]), at = this.spaceAt(x, y) ?? joint;
    this.edit = {
      bone, kind, frame: s.frame, from: animatedLocal(p, index), parent, origin: [-ox, -oy], axis, axes: spaceAxes(this.axes, matrix, parent), start: [x, y],
      key: unkeyed ? null : { animation: anim.name, time: s.keyTime },
      joint, matrix, sign: turnSign(parent, boneInherit(b), p.rig.scaleX * p.rig.scaleY < 0), inherit: boneInherit(b), last: at, turned: 0, lock: null,
    };
    if (unkeyed) this.onStatus(`Unkeyed pose of ${bone}: press Key to key it; moving the playhead drops it.`);
    else s.history!.begin(`${{ move: "Move", rotate: "Rotate", scale: "Scale", shear: "Shear" }[kind]} ${bone} at frame ${s.frame}`);
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
    if (best < 0) return;
    const m = this.path();
    // A bone with a path: the dot is a time of the path, and the path's clock goes there (not the animation's playhead).
    if (m) this.session.seekPath(best / this.session.fps); else if (best !== this.session.frame) this.session.seek(best);
  }

  /** The picker's bones (every bone but the selected one and those under it), and what is chosen. */
  private syncParentPick(): void {
    const s = this.session, bone = s.selectedBone, chosen = this.chosenParent() ?? "";
    const names = bone ? parentChoices(s.doc, bone) : [], sig = `${bone}|${names.join(",")}`;
    if (this.parentPick.dataset.sig !== sig) {
      this.parentPick.dataset.sig = sig;
      this.parentPick.replaceChildren(new Option("Parent bone…", ""), ...names.map((n) => new Option(n, n)));
    }
    this.parentPick.value = names.includes(chosen) ? chosen : "";
    this.parentPick.classList.toggle("attention", !this.parentPick.value && !this.path());
  }

  /** A parent bone was picked: the choice for a bone with no path yet; for one with a path, the path moves to the new bone's space and stays where it is on screen (one undo step). */
  private chooseParent(name: string): void {
    const s = this.session, a = s.animation, bone = s.selectedBone;
    if (!a || !bone || !name) return;
    const m = this.path();
    if (!m) { this.parentChoice.set(`${a.name}|${bone}`, name); this.schedule(); return; }
    if (name === refBoneName(s.doc, m)) return;
    const v = this.viewMotion();
    if (!v) return;
    // The view is measured from the parent\'s joint: the nodes (not the handle offsets) are shifted by how far the two joints are apart.
    const was = this.refM(refBoneName(s.doc, m)), now = this.refM(name), dx = was[4] - now[4], dy = was[5] - now[5];
    const moved = { ...v, parent: name, nodes: v.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })) };
    keepMotion(s, pathFromView(moved, now), `Make the path of ${bone} relative to ${name}`);
    this.onStatus(`The path of ${bone} is relative to ${name} now, and stays where it is on screen at this frame.`);
    this.schedule();
  }

  /** The row of path buttons: what can be done for the selected bone in the animation shown, and what the path is. */
  private updateMotionBar(): void {
    const s = this.session, m = this.path(), bone = s.selectedBone, anim = s.animation;
    const can = !!anim && bone !== null && !(s.doc && constraintDriving(s.doc, bone));
    // The tabs, and under the Key frame tab no path bar: the path is the other tab's.
    // Nothing here comes and goes (the header and the bar keep their size, docs/MOTION-MODES-PLAN.md): what does not apply is dimmed, and the bar says why.
    for (const id of ["keys", "twin"] as const) { this.tabBtns[id].main.disabled = !can; this.tabBtns[id].more.disabled = !can; }
    this.layerBtns.path.disabled = !can;
    this.layerBtns.spline.disabled = !can;
    for (const id of ["keys", "twin"] as const) { this.tabBtns[id].main.setAttribute("aria-selected", String(this.tab === id)); this.tabBtns[id].main.classList.toggle("on", this.tab === id); }
    const controls = can && this.tab === "twin";
    this.motionBar.hidden = false;
    for (const el of this.barSections) el.hidden = !controls;
    this.hint.hidden = controls;
    this.hint.textContent = !can ? (anim ? "Select a bone to see its motion." : "Select a bone in Animate mode to see its motion.") : "Key frames: the bone's keyed motion. A tab's ⋮ makes the other kind from it.";
    this.updateCard();
    this.syncParentPick();
    const has = !!m;
    this.motionBtns.del.hidden = !has;
    this.motionBtns.del.disabled = !m || m.nodes.length <= 2 || this.selNode < 0;
    this.durationBox.hidden = !has;
    this.playBtn.hidden = !has;
    this.stopBtn.hidden = !has;
    this.clockLabel.hidden = !has;
    const clock = this.session.pathClock;
    this.playBtn.textContent = clock.playing ? "❚❚ Pause" : "▶ Play";
    this.playBtn.title = clock.playing ? "Pause the path's clock (the path keeps the bone)" : "Play the path on its own clock: no keys needed";
    this.playBtn.setAttribute("aria-pressed", String(clock.playing));
    this.stopBtn.disabled = !clock.playing && clock.time === 0;
    const both = this.session.playing && clock.playing;
    this.bothBtn.hidden = !has;
    this.bothBtn.textContent = both ? "❚❚ Both" : "▶ Both";
    this.bothBtn.title = both ? "Pause the animation and the path together" : "Play the animation (keys) and the path together: two clocks, one button";
    this.bothBtn.setAttribute("aria-pressed", String(both));
    this.clockLabel.textContent = `${(m ? (m.loop ? clock.time % m.duration : Math.min(clock.time, m.duration)) : 0).toFixed(2)} s`;
    const idle = (el: HTMLInputElement) => el.ownerDocument.activeElement !== el;
    if (m) {
      if (idle(this.durationField)) this.durationField.value = String(m.duration);
      this.durationHint.textContent = `(${Math.round(m.duration * this.session.fps)} frames at ${this.session.fps} fps)`;
    }
    this.renderStrip(m);
    if (!m) { this.motionInfo.textContent = "\u00a0"; return; }
    this.motionInfo.textContent = `${m.nodes.length} spline nodes${this.stray !== null ? ` · the keys made from it stray ${Math.round(this.stray * 10) / 10}` : ""}`;
  }

  /**
   * The strip under the path row: in Edit Path a green numbered button for each spline node and the green + (the capture bar,
   * docs/PATH-CAPTURE-PLAN.md).
   */
  private renderStrip(m: MotionPath | undefined): void {
    // An undo can take a node away: what was picked goes with it.
    if (!m || this.selNode >= m.nodes.length) this.selNode = -1;
    if (this.multi.size) this.multi = new Set([...this.multi].filter((l) => !!m && nodeLabels(m).includes(l)));
    this.slotBar.hidden = !m;
    this.dataBox.hidden = !m;
    this.lower.hidden = !m;
    this.split.hidden = !m;
    const sig = !m ? "" : `d|${JSON.stringify(m.nodes)}|${this.selNode}|${[...this.multi]}`;
    if (sig === this.slotSig) return;
    this.slotSig = sig;
    this.renderData(m);
    const make = (cls: string, text: string, title: string, run: (e: MouseEvent) => void): HTMLButtonElement => {
      const b = this.button(text, title);
      b.className = cls;
      b.addEventListener("click", run);
      return b;
    };
    if (!m) { this.slotBar.replaceChildren(); return; }
    {
      const items = m.nodes.map((n, i) => {
        const label = nodeLabels(m)[i]!;
        const b = make(`slot node${i === this.selNode ? " picked" : ""}${this.multi.has(label) ? " multi" : ""}`, `${label}`,
          `Spline node ${label}: x ${n.x}, y ${n.y}. Press to put the bone there; then moving the bone moves the node. Drag it along the numbers to move it in the order.`,
          (e) => {
            if (this.suppressClick) { this.suppressClick = false; return; }
            if (e.metaKey || e.ctrlKey) { this.toggleMulti(i); return; }
            this.multi.clear();
            this.pickSlot(i);
          });
        b.setAttribute("aria-label", `Spline node ${label}`);
        this.nodeDragStart(b, i);
        // Right-click: merge the nodes picked with Command + click, run the ring the other way, or make this node the origin.
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const cur = this.path(), ring = cur?.closed ?? false, picked = this.pickedPlaces();
          const items: MenuItem[] = [];
          if (picked.length >= 2 && this.multi.has(label)) items.push({ label: `Merge ${picked.map((k) => nodeLabels(cur!)[k]).join(" + ")}`, run: () => this.mergePicked() });
          if (cur) items.push({ label: `Reverse Direction (${nodeLabels(reversePath(cur)).join(" ")})`, run: () => this.reverse() });
          if (cur) items.push({ label: `Sort Numbers (${nodeLabels(renumberNodes(cur)).join(" ")})`, disabled: nodeLabels(cur).every((l, k) => l === k + 1), run: () => this.sortNumbers() });
          if (cur) { const broken = cur.nodes[i]?.bx !== undefined; items.push({ label: broken ? `Mirror the legs of ${label}` : `Break the legs of ${label}`, run: () => this.setLegs(i, !broken) }); }
          items.push({ label: `Set ${label} to Origin`, disabled: i === 0 || !ring, run: () => this.setOrigin(i) });
          showContextMenu(e.clientX, e.clientY, items);
        });
        return b;
      });
      this.slotBar.replaceChildren(...items);
      return;
    }
  }

  private keepStageLine(): void {
    this.stageBtn.setAttribute("aria-pressed", String(this.stageOn));
    this.stageSwatch.style.background = this.stageColour;
    try { localStorage.setItem(STAGE_LINE_KEY, JSON.stringify({ on: this.stageOn, colour: this.stageColour })); } catch { /* not kept */ }
    this.onStageLine();
    this.schedule();
  }

  /** The bone's spline as a line in the world, for the Stage (a flat list of x, y), or null when it is off or the bone has no path or pose. The nodes are in the parent bone's space, so the parent's joint is added back. */
  stageLine(): { points: number[]; colour: string } | null {
    const s = this.session, m = this.path(), p = s.pose();
    if (!this.stageOn || !m || !p) return null;
    const i = p.bones.get(m.bone);
    if (i === undefined || !p.rig.active[i]) return null;
    // The nodes are in the parent bone's space: through that bone's matrix as it is now, so the line follows it.
    const curve = curveOf(m), R = refMatrix(p, refBoneName(s.doc, m)), steps = Math.max(24, Math.min(400, m.nodes.length * 48)), points: number[] = [];
    for (let k = 0; k <= steps; k++) { const q = curve.at((curve.length * k) / steps), [vx, vy] = toView(R, q.x, q.y); points.push(R[4] + vx, R[5] + vy); }
    return points.every(Number.isFinite) ? { points, colour: this.stageColour } : null;
  }

  /**
   * The panel's keys (the pointer over it): what each does. False when the key has nothing to do here, so it
   * goes on to its other meaning.
   */
  hotkey(id: "add" | "remove" | "reverse" | "merge" | "origin"): boolean {
    if (this.tab !== "twin") return false;
    const m = this.path();
    if (!m) {
      if (id === "add") { void this.enterDraw(); return true; }
      return false;
    }
    switch (id) {
      case "add": this.addNode(); return true;
      case "remove": this.removeNode(); return true;
      case "reverse": this.reverse(); return true;
      case "merge": this.mergePicked(); return true;
      case "origin": if (this.selNode < 0) this.onStatus("Pick a node first (press its number)."); else this.setOrigin(this.selNode); return true;
    }
  }

  /**
   * The picked node's data under the numbers: its place, both handles (the way in follows the way out until the legs are
   * broken), the legs' state, and the span to the next node. A field commits on Enter or when it loses focus, as one undo step.
   */
  private renderData(m: MotionPath | undefined): void {
    const box = this.dataBox, doc = box.ownerDocument;
    if (!m) return;
    // Not under a field being typed in: it is drawn again once that is done.
    if (doc.activeElement instanceof HTMLInputElement && box.contains(doc.activeElement)) return;
    const i = this.selNode, n = m.nodes[i];
    if (!n) { const hint = doc.createElement("span"); hint.className = "hint"; hint.textContent = "Press a number to see that node's data."; box.replaceChildren(hint, this.stageRow); return; }
    const s = this.session, label = nodeLabels(m)[i]!, h = handleOffsets(m.nodes, m.closed)[i]!, broken = n.bx !== undefined;
    const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
    const patch = (change: Partial<MotionNode>, why: string, pose = false): void => {
      const cur = this.path();
      if (!cur?.nodes[i]) return;
      keepMotion(s, { ...cur, nodes: cur.nodes.map((q, k) => (k === i ? { ...q, ...change } : q)) }, why, true);
      if (pose) { const q = this.path()!.nodes[i]!; poseAtNode(s, q.x, q.y, this.chosenParent()); }
      setTimeout(() => { this.slotSig = ""; this.schedule(); });
    };
    const num = (value: number, off: boolean, aria: string, run: (v: number) => void): HTMLInputElement => {
      const input = doc.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.value = String(r4(value));
      input.disabled = off;
      input.setAttribute("aria-label", aria);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } if (e.key === "Escape") { input.value = String(r4(value)); input.blur(); } });
      input.addEventListener("change", () => { const v = Number(input.value); if (Number.isFinite(v)) run(r4(v)); else input.value = String(r4(value)); });
      return input;
    };
    const pair = (name: string, a: HTMLInputElement, b: HTMLInputElement, extra?: HTMLElement): HTMLElement => {
      const row = doc.createElement("div"), l = doc.createElement("span"), ax = doc.createElement("span"), bx = doc.createElement("span");
      row.className = "row";
      l.className = "k";
      l.textContent = name;
      ax.textContent = "x";
      bx.textContent = "y";
      row.append(l, ax, a, bx, b);
      if (extra) row.append(extra);
      return row;
    };
    const last = i === m.nodes.length - 1, first = i === 0, noOut = !m.closed && last, noIn = !m.closed && first;
    const title = doc.createElement("div");
    title.className = "title";
    const curve = curveOf(m), a0 = curve.nodeAt[i], a1 = curve.nodeAt[i + 1], next = m.nodes[(i + 1) % m.nodes.length];
    title.textContent = `Node ${label} · place ${i + 1} of ${m.nodes.length}${a0 !== undefined && a1 !== undefined && next && (m.closed || !last) ? ` · span to node ${nodeLabels(m)[(i + 1) % m.nodes.length]}: ${r4(a1 - a0)} long` : ""}`;
    const auto = this.button("Auto", "Put both handles back to automatic (the curve decides)");
    auto.disabled = n.tx === undefined && !broken;
    auto.addEventListener("click", () => { const cur = this.path(); if (cur) { keepMotion(s, { ...cur, nodes: cur.nodes.map((q, k) => { if (k !== i) return q; const { tx: _a, ty: _b, bx: _c, by: _d, ...rest } = q; return rest; }) }, "Reset a handle"); } });
    const legs = this.button(broken ? "Mirror legs" : "Break legs", broken ? "The way in follows the way out again" : "Each handle moves on its own");
    legs.addEventListener("click", () => this.setLegs(i, !broken));
    const ox = num(h.out.x, noOut, "Way out, x", (v) => patch({ tx: v, ty: h.out.y }, "Bend the path")), oy = num(h.out.y, noOut, "Way out, y", (v) => patch({ tx: h.out.x, ty: v }, "Bend the path"));
    const ix = num(h.in.x, noIn || !broken, "Way in, x", (v) => patch({ bx: v, by: h.in.y }, "Bend the path")), iy = num(h.in.y, noIn || !broken, "Way in, y", (v) => patch({ bx: h.in.x, by: v }, "Bend the path"));
    const buttons = doc.createElement("div");
    buttons.className = "row buttons";
    buttons.append(legs, auto);
    // The speed spline's value at this node: -0.99 to 5; the bone goes 1 + it times as fast here.
    const speed = speedOf(n), sRow = doc.createElement("div"), sName = doc.createElement("span"), sRead = doc.createElement("span");
    sRow.className = "row";
    sName.className = "k";
    sName.textContent = "Speed";
    sRead.className = "read";
    sRead.textContent = `×${Math.round(multiplierOf(speed) * 100) / 100}`;
    sRead.title = "How many times as fast the bone goes through this node";
    const sIn = num(speed, false, "Node speed", (v) => patch({ speed: clampSpeed(v) }, "Set the speed of a node"));
    sIn.min = String(SPEED_MIN);
    sIn.max = String(SPEED_MAX);
    sIn.step = "0.05";
    sRow.append(sName, sIn, sRead);
    const fields = doc.createElement("div");
    fields.className = "lp-fields";
    fields.append(title,
      pair("Place", num(n.x, false, "Node x", (v) => patch({ x: v, y: n.y }, "Move a spline node", true)), num(n.y, false, "Node y", (v) => patch({ x: n.x, y: v }, "Move a spline node", true))),
      sRow, pair("Way out", ox, oy), pair(broken ? "Way in" : "Way in (mirror)", ix, iy), buttons);
    box.replaceChildren(this.speedColumn(doc), this.stageRow, fields);
    this.drawSpeed();
  }

  /** The speed graph's column in the data box: a title line over the canvas. */
  private speedColumn(doc: Document): HTMLElement {
    const col = doc.createElement("div"), head = doc.createElement("div");
    col.className = "lp-speed";
    head.className = "lp-speed-bar";
    const title = doc.createElement("span");
    title.className = "title";
    title.textContent = `Speed spline · ${SPEED_MIN} to ${SPEED_MAX}: the bone goes 1 + it times as fast`;
    const fitAll = this.button("Fit", "Show the whole path across the graph (double-click on the graph does the same)"), fitNode = this.button("Node", "Fit the picked node's section: from it to the next node");
    fitAll.addEventListener("click", () => this.fitGraph(false));
    fitNode.addEventListener("click", () => this.fitGraph(true));
    fitNode.disabled = this.selNode < 0;
    head.append(title, fitAll, fitNode);
    col.append(head, this.speedCanvas, this.speedGrip);
    return col;
  }

  /** The graph's own height, when set; the area under the picture then scrolls if the graph is taller than it. */
  private applyGraph(): void {
    this.speedCanvas.style.flex = this.graphHeight === null ? "" : "none";
    this.speedCanvas.style.height = this.graphHeight === null ? "" : `${this.graphHeight}px`;
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
      const y0 = e.clientY, h0 = this.speedCanvas.getBoundingClientRect().height / pageScale();
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

  /** The line between the picture and the node numbers is dragged: the picture takes what the area under it gives up. */
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

  /** The graph's plot box on its canvas (CSS pixels): where the visible progress and the speed range are drawn; a ruler of lengths runs above it. */
  private plot(): { l: number; r: number; t: number; b: number } {
    const c = this.speedCanvas;
    return { l: 40, r: Math.max(41, c.clientWidth - 10), t: 28, b: Math.max(29, c.clientHeight - 20) };
  }

  /** The canvas x of a progress (0..1 along the ring) in the visible window, and back. */
  private gx(p: number): number {
    const { l, r } = this.plot(), { x0, x1 } = this.gView;
    return l + ((p - x0) / (x1 - x0)) * (r - l);
  }

  private gp(x: number): number {
    const { l, r } = this.plot(), { x0, x1 } = this.gView;
    return x0 + ((x - l) / (r - l)) * (x1 - x0);
  }

  /** The visible window set (at least 2% of the path, inside 0..1). */
  private setView(x0: number, x1: number): void {
    const w = Math.min(1, Math.max(0.02, x1 - x0)), a = Math.min(1 - w, Math.max(0, x0));
    this.gView = { x0: a, x1: a + w };
    this.schedule();
  }

  /** The whole path across the graph, or (with `section`) the picked node's section: from it to the next node. */
  private fitGraph(section: boolean): void {
    const m = this.path();
    if (!section || !m || this.selNode < 0) { this.setView(0, 1); return; }
    const xs = nodeProgress(m), a = xs[this.selNode] ?? 0, b = xs[this.selNode + 1] ?? (m.closed ? 1 : a), pad = Math.max(0.01, (b - a) * 0.08);
    if (b - a < 1e-6) { this.setView(0, 1); return; }
    this.setView(a - pad, b + pad);
  }

  /** Draw the speed spline: the value (-0.99 to 5) up, the path's length across (the ruler above shows it, and the cap is the playhead); a point and two legs for each node, the picked one lit, a line at 0 (an even pace). */
  private drawSpeed(): void {
    const s = this.session, m = this.path(), c = this.speedCanvas;
    this.speedDots = [];
    this.speedLegs = [];
    if (!m || !c.isConnected || this.dataBox.hidden) return;
    // Another path starts with the whole of it in view.
    if (this.gViewFor !== `${m.animation}/${m.bone}`) { this.gViewFor = `${m.animation}/${m.bone}`; this.gView = { x0: 0, x1: 1 }; }
    const w = Math.max(1, Math.floor(c.clientWidth)), h = Math.max(1, Math.floor(c.clientHeight)), dpr = (window.devicePixelRatio || 1) * pageScale();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(this.element), accent = css.getPropertyValue("--accent").trim() || "#4c9bff", text = css.getPropertyValue("--text").trim() || "#ddd", line = css.getPropertyValue("--line").trim() || "#555", muted = css.getPropertyValue("--muted").trim() || "#999";
    const { l, r, t, b } = this.plot(), X = (p: number): number => this.gx(p), Y = (v: number): number => t + ((SPEED_MAX - v) / (SPEED_MAX - SPEED_MIN)) * (b - t);
    const length = curveOf(m).length, { x0, x1 } = this.gView, kx = (r - l) / (x1 - x0), ky = (b - t) / (SPEED_MAX - SPEED_MIN);
    g.font = `10px "JetBrains Mono", monospace`;
    g.textBaseline = "middle";
    g.textAlign = "right";
    // The value lines: the limits dashed, 0 (the even pace) solid, the whole numbers between faint.
    for (const v of [SPEED_MIN, 0, 1, 2, 3, 4, SPEED_MAX]) {
      const y = Math.round(Y(v)) + 0.5, edge = v === SPEED_MIN || v === SPEED_MAX;
      g.strokeStyle = v === 0 ? accent : line;
      g.globalAlpha = v === 0 ? 0.8 : edge ? 1 : 0.5;
      g.setLineDash(edge ? [4, 3] : []);
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(l, y); g.lineTo(r, y); g.stroke();
      g.globalAlpha = 1;
      g.setLineDash([]);
      g.fillStyle = v === 0 ? text : muted;
      g.fillText(String(v), l - 5, y);
    }
    // The ruler: the length along the ring (the path's own units), not frames.
    g.fillStyle = muted;
    g.strokeStyle = line;
    g.textAlign = "center";
    g.textBaseline = "top";
    const raw = ((x1 - x0) * length) / Math.max(1, (r - l) / 80), mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-6))), step = (raw / mag <= 1 ? 1 : raw / mag <= 2 ? 2 : raw / mag <= 5 ? 5 : 10) * mag;
    g.beginPath(); g.moveTo(l, 18.5); g.lineTo(r, 18.5); g.stroke();
    if (length > 0 && step > 0) for (let v = Math.ceil((x0 * length) / step) * step; v <= x1 * length + 1e-9; v += step) {
      const x = Math.round(X(v / length)) + 0.5;
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x, 19); g.stroke();
      g.fillText(String(Math.round(v * 1e3) / 1e3), x, 3);
    }
    g.save();
    g.beginPath(); g.rect(l, t, r - l, b - t); g.clip();
    const xs = nodeProgress(m), labels = nodeLabels(m);
    // Where each node is along the path.
    xs.forEach((p) => {
      const x = Math.round(X(p)) + 0.5;
      g.strokeStyle = line;
      g.globalAlpha = 0.6;
      g.beginPath(); g.moveTo(x, t); g.lineTo(x, b); g.stroke();
      g.globalAlpha = 1;
    });
    // The curve through the points.
    g.strokeStyle = this.stageColour;
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.beginPath();
    const steps = Math.max(200, Math.round(r - l));
    for (let k = 0; k <= steps; k++) { const p = x0 + ((x1 - x0) * k) / steps, x = X(p), y = Y(speedAt(m, p)); if (k === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
    // The legs: a hollow round handle each side of a node, on a thin stem, in the slope the curve leaves and arrives by.
    const LEG = 34;
    xs.forEach((p, i) => {
      const sl = slopesOf(m, i), x = X(p), y = Y(speedOf(m.nodes[i]!)), on = i === this.selNode;
      for (const side of ["out", "in"] as const) {
        if ((side === "in" && i === 0 && !m.closed) || (side === "out" && i === xs.length - 1 && !m.closed)) continue;
        const slope = side === "out" ? sl.out : sl.into, dx = kx, dy = -slope * ky, len = Math.hypot(dx, dy) || 1, sign = side === "out" ? 1 : -1;
        const hx = x + (sign * dx * LEG) / len, hy = y + (sign * dy * LEG) / len;
        g.strokeStyle = this.stageColour;
        g.lineWidth = 1;
        g.globalAlpha = on ? 1 : 0.55;
        g.beginPath(); g.moveTo(x, y); g.lineTo(hx, hy); g.stroke();
        g.beginPath(); g.arc(hx, hy, on ? 5 : 4, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = 1;
        this.speedLegs.push({ i, side, x: hx, y: hy });
      }
    });
    // A point on each node's place (a ring's last span comes back to the first).
    xs.forEach((p, i) => {
      const x = X(p), y = Y(speedOf(m.nodes[i]!)), on = i === this.selNode, half = on ? 6 : 5;
      g.fillStyle = accent;
      g.beginPath(); g.rect(x - half, y - half, half * 2, half * 2); g.fill();
      if (on) { g.strokeStyle = "#ffffff"; g.lineWidth = 1.5; g.stroke(); }
      this.speedDots.push({ i, x, y });
    });
    g.restore();
    g.textAlign = "center";
    g.textBaseline = "top";
    xs.forEach((p, i) => {
      const x = X(p);
      if (x < l - 4 || x > r + 4) return;
      g.fillStyle = i === this.selNode ? text : muted;
      g.fillText(String(labels[i]), Math.round(x) + 0.5, b + 4);
    });
    // The cap: the playhead, as on the Timeline, dragged along the ruler; it says how far along the ring the bone is, in the path's units, not the frame.
    const hp = progressAtTime(m, pathTime(m, s.pathClock.time)), hx = Math.round(X(hp)) + 0.5;
    if (hx >= l - 1 && hx <= r + 1) {
      g.strokeStyle = DOT;
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(hx, 19); g.lineTo(hx, b); g.stroke();
      g.setLineDash([]);
      const label = String(Math.round(hp * length * 100) / 100), cw = Math.max(26, label.length * 6 + 10);
      g.fillStyle = DOT;
      g.beginPath();
      g.moveTo(hx - cw / 2, 1); g.lineTo(hx + cw / 2, 1); g.lineTo(hx + cw / 2, 14); g.lineTo(hx, 20); g.lineTo(hx - cw / 2, 14); g.closePath(); g.fill();
      g.fillStyle = "#ffffff";
      g.textBaseline = "middle";
      g.fillText(label, hx, 8);
    }
  }

  /** The names of the bones the Parent buttons draw: the parent, then the bones under it down to the selected bone (for tests). */
  get parentTree(): string[] {
    const s = this.session, bone = s.selectedBone, name = this.originName(), anim = s.animation;
    if (!bone || !name || !anim) return [];
    const p = this.posers().pose(s.skin, anim.name, 0, "none"), pi = p.bones.get(name), bi = p.bones.get(bone);
    if (pi === undefined || bi === undefined) return [];
    return chainTo(p, pi, bi).map((b) => p.rig.data.bones[b]!.name);
  }

  /** The speed graph's points on its canvas as last drawn (CSS pixels), for tests. */
  get speedPoints(): readonly { i: number; x: number; y: number }[] {
    return this.speedDots;
  }

  /** The speed graph's legs on its canvas as last drawn (CSS pixels), for tests. */
  get speedHandles(): readonly { i: number; side: "out" | "in"; x: number; y: number }[] {
    return this.speedLegs;
  }

  /** The speed value a point of the graph's canvas stands for, not held to the range. */
  private valueAtY(y: number): number {
    const { t, b } = this.plot();
    return SPEED_MAX - ((y - t) / (b - t)) * (SPEED_MAX - SPEED_MIN);
  }

  /** The speed value a point of the graph's canvas stands for (held to the range). */
  private speedAtY(y: number): number {
    return clampSpeed(this.valueAtY(y));
  }

  /** The point of the graph under a canvas point, or -1. */
  private speedDotAt(x: number, y: number): number {
    let best = -1, bestD = 11;
    for (const d of this.speedDots) { const q = Math.hypot(d.x - x, d.y - y); if (q <= bestD) { best = d.i; bestD = q; } }
    return best;
  }

  /** The leg under a canvas point, or null. */
  private speedLegAt(x: number, y: number): { i: number; side: "out" | "in" } | null {
    let best: { i: number; side: "out" | "in" } | null = null, bestD = 9;
    for (const d of this.speedLegs) { const q = Math.hypot(d.x - x, d.y - y); if (q <= bestD) { best = { i: d.i, side: d.side }; bestD = q; } }
    return best;
  }

  /** A node's speed set (one undo step); the picked node follows. */
  private setSpeed(i: number, v: number, join = false): void {
    const s = this.session, m = this.path();
    if (!m?.nodes[i]) return;
    keepMotion(s, { ...m, nodes: m.nodes.map((n, k) => (k === i ? { ...n, speed: v } : n)) }, `Set the speed of node ${nodeLabels(m)[i]}`, join);
  }

  /** A leg dragged to the pointer: the slope from its node to the pointer (Alt breaks the node's legs first, so only the one held moves). */
  private dragLeg(x: number, y: number): void {
    const d = this.legDrag, s = this.session, m = this.path();
    if (!d || !m?.nodes[d.i]) return;
    const np = nodeProgress(m)[d.i]!, v0 = speedOf(m.nodes[d.i]!), dp = d.side === "out" ? this.gp(x) - np : np - this.gp(x), dv = d.side === "out" ? this.valueAtY(y) - v0 : v0 - this.valueAtY(y);
    keepMotion(s, withSpeedSlope(m, d.i, d.side, dv / Math.max(0.004, dp)), "Bend the speed spline", true);
  }

  /** The playhead goes to where the ruler was pressed: the frame the bone passes that place on. */
  private scrubGraph(x: number): void {
    const s = this.session, m = this.path();
    if (!m) return;
    const p = Math.min(1, Math.max(0, this.gp(x)));
    s.seekPath(timeMap(m).time(p) * m.duration);
  }

  /**
   * The graph's mouse: the ruler's cap scrubs, a leg bends the curve (Alt + drag breaks it first; double-click: automatic), a point drags up or down
   * for its speed (Shift: in steps of 0.1; double-click: 0), empty graph pans along the path (the middle button too); the wheel zooms along the
   * path (a sideways wheel or Shift + wheel pans); ⌘ + click or right-click opens the menu.
   */
  private speedEvents(): void {
    const c = this.speedCanvas, at = (e: PointerEvent | MouseEvent): [number, number] => localPoint(c, e as PointerEvent);
    c.addEventListener("contextmenu", (e) => { e.preventDefault(); const [x, y] = at(e); this.graphMenu(x, y, e.clientX, e.clientY); });
    c.addEventListener("pointerdown", (e) => {
      const [x, y] = at(e), { t } = this.plot();
      if (e.button === 1 || (e.button === 0 && !e.metaKey && y >= t && this.speedLegAt(x, y) === null && this.speedDotAt(x, y) < 0)) {
        e.preventDefault();
        this.graphPan = { x: e.clientX, x0: this.gView.x0, x1: this.gView.x1 };
        c.setPointerCapture(e.pointerId);
        c.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0) return;
      if (e.metaKey) { e.preventDefault(); this.graphMenu(x, y, e.clientX, e.clientY); return; }
      if (y < t && this.speedLegAt(x, y) === null && this.speedDotAt(x, y) < 0) {
        e.preventDefault();
        this.session.pause();
        this.capDrag = true;
        c.setPointerCapture(e.pointerId);
        this.scrubGraph(x);
        return;
      }
      const leg = this.speedLegAt(x, y);
      if (leg) {
        e.preventDefault();
        this.pickSlot(leg.i);
        this.legDrag = leg;
        this.session.history?.begin("Bend the speed spline");
        const cur = this.path();
        if (e.altKey && cur) keepMotion(this.session, setSpeedLegs(cur, leg.i, "break"));
        c.setPointerCapture(e.pointerId);
        this.slotSig = "";
        this.schedule();
        return;
      }
      const i = this.speedDotAt(x, y);
      if (i < 0) return;
      e.preventDefault();
      this.pickSlot(i);
      this.speedDrag = i;
      this.session.history?.begin(`Set the speed of node ${nodeLabels(this.path()!)[i]}`);
      c.setPointerCapture(e.pointerId);
      this.slotSig = "";
      this.schedule();
    });
    c.addEventListener("pointermove", (e) => {
      const [x, y] = at(e);
      if (this.graphPan) {
        const { l, r } = this.plot(), span = this.graphPan.x1 - this.graphPan.x0, d = ((e.clientX - this.graphPan.x) / pageScale() / (r - l)) * span;
        this.setView(this.graphPan.x0 - d, this.graphPan.x1 - d);
        return;
      }
      if (this.capDrag) { this.scrubGraph(x); return; }
      if (this.legDrag) { this.dragLeg(x, y); this.schedule(); return; }
      if (this.speedDrag === null) { c.style.cursor = y < this.plot().t ? "ew-resize" : this.speedLegAt(x, y) ? "pointer" : this.speedDotAt(x, y) >= 0 ? "ns-resize" : "grab"; return; }
      const raw = this.speedAtY(y), v = e.shiftKey ? clampSpeed(Math.round(raw * 10) / 10) : Math.round(raw * 100) / 100;
      this.setSpeed(this.speedDrag, clampSpeed(v));
      this.schedule();
    });
    const end = (): void => {
      this.graphPan = null;
      this.capDrag = false;
      c.style.cursor = "";
      if (this.legDrag) { this.legDrag = null; this.session.history?.end(); this.slotSig = ""; this.schedule(); return; }
      if (this.speedDrag === null) return;
      this.speedDrag = null;
      this.session.history?.end();
      this.slotSig = "";
      this.schedule();
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
    c.addEventListener("dblclick", (e) => {
      const [x, y] = at(e), leg = this.speedLegAt(x, y), i = this.speedDotAt(x, y), m = this.path();
      if (leg && m) { keepMotion(this.session, setSpeedLegs(m, leg.i, "auto"), "Automatic speed legs"); this.slotSig = ""; this.schedule(); return; }
      if (i >= 0) { this.setSpeed(i, 0); this.slotSig = ""; this.schedule(); return; }
      if (y >= this.plot().t) this.fitGraph(false);
    });
  }

  /** The menu of the speed graph at a canvas point: a node added at that place along the path, and over a point its delete and its legs (the curve's, drawn on the graph). */
  private graphMenu(x: number, y: number, cx: number, cy: number): void {
    const m = this.path();
    if (!m) return;
    const i = this.speedDotAt(x, y), p = Math.min(1, Math.max(0, this.gp(x))), items: MenuItem[] = [];
    items.push({ label: "Add a node here", run: () => this.addNodeAtProgress(p) });
    if (i >= 0) {
      const label = nodeLabels(m)[i]!, sl = slopesOf(m, i);
      this.pickSlot(i);
      items.push({ label: `Delete node ${label}`, disabled: m.nodes.length <= 2, run: () => this.removeNode() });
      items.push({ label: sl.broken ? `Mirror the legs of ${label}` : `Break the legs of ${label}`, run: () => this.setSpeedLegsOf(i, sl.broken ? "mirror" : "break") });
      items.push({ label: `Automatic legs for ${label}`, disabled: !sl.own, run: () => this.setSpeedLegsOf(i, "auto") });
    }
    showContextMenu(cx, cy, items);
  }

  /** Break, mirror or automatic: the speed spline's legs at node `i`, one undo step. */
  private setSpeedLegsOf(i: number, how: "break" | "mirror" | "auto"): void {
    const m = this.path();
    if (!m?.nodes[i]) return;
    keepMotion(this.session, setSpeedLegs(m, i, how), how === "break" ? "Break the speed legs" : how === "mirror" ? "Mirror the speed legs" : "Automatic speed legs");
    this.slotSig = "";
    this.schedule();
  }

  /** A spline node on the ring where `p` (0 to 1 along its length) is, keeping the speed the graph shows there. */
  private addNodeAtProgress(p: number): void {
    const s = this.session, m = this.path();
    if (!m) return;
    const curve = curveOf(m), at = curve.length * p, q = curve.at(at);
    const i = curve.nodeAt.slice(0, m.nodes.length).filter((v) => v <= at).length, speed = Math.round(speedAt(m, p) * 100) / 100;
    const next = withNode(m, { x: Math.round(q.x * 1e4) / 1e4, y: Math.round(q.y * 1e4) / 1e4 }, i);
    keepMotion(s, { ...next, nodes: next.nodes.map((n, k) => (k === i ? { ...n, speed } : n)) }, "Add a spline node");
    this.selNode = i;
    this.multi.clear();
    this.slotSig = "";
    this.schedule();
  }

  /** What the panel keeps of how it was left, for the project's remembered view (ui/viewMemory.ts). */
  get memory(): MotionMemory {
    return { node: this.selNode, zoom: this.zoom, pan: { ...this.pan }, axes: this.axes, lower: this.lowerHeight };
  }

  /** Put that back. */
  restoreMemory(m: MotionMemory): void {
    this.zoom = Number.isFinite(m.zoom) && m.zoom > 0 ? m.zoom : 1;
    this.pan = Number.isFinite(m.pan.x) && Number.isFinite(m.pan.y) ? { x: m.pan.x, y: m.pan.y } : { x: 0, y: 0 };
    if (m.axes === "parent" || m.axes === "world") this.axes = m.axes;
    this.hold = false;
    this.selNode = m.node;
    if (typeof m.lower === "number" && m.lower >= MIN_LOWER) { this.lowerHeight = m.lower; this.lowerSet = true; this.applyLower(); }
    this.slotSig = "";
    this.schedule();
  }

  /**
   * An arrow key while the pointer is over this panel: in Edit Path the picked node moves by one step (Shift: the big step) and the bone
   * goes with it. False when the bone has no path, so the key goes on to the bone as anywhere else.
   */
  nudge(dir: "left" | "right" | "up" | "down", big: boolean, step: number, bigFactor: number): boolean {
    // The arrows move the node in the parent bone\'s own space (the numbers it is stored in), whichever way that bone is turned on screen.
    const s = this.session, m = this.path();
    if (!m) return false;
    const n = m.nodes[this.selNode];
    if (!n) { this.onStatus("Pick a node first (press its number, or Q and W)."); return true; }
    const d = step * (big ? bigFactor : 1), dx = dir === "left" ? -d : dir === "right" ? d : 0, dy = dir === "up" ? d : dir === "down" ? -d : 0;
    const x = Math.round((n.x + dx) * 1e4) / 1e4, y = Math.round((n.y + dy) * 1e4) / 1e4;
    keepMotion(s, { ...m, nodes: m.nodes.map((q, i) => (i === this.selNode ? { ...q, x, y } : q)) }, "Move a spline node", true);
    poseAtNode(s, x, y, this.chosenParent());
    return true;
  }

  /**
   * Q and W while this panel has the keys: the previous or next node (the bone goes to it). A ring goes round; an open path stops at its ends. False when there is nothing to step through here.
   */
  stepNode(dir: -1 | 1): boolean {
    const m = this.path();
    if (!m) return false;
    const count = m.nodes.length, at = this.selNode;
    if (count < 1) return false;
    let next = at < 0 ? (dir > 0 ? 0 : count - 1) : at + dir;
    if (next < 0 || next >= count) next = m.closed ? (next + count) % count : Math.min(count - 1, Math.max(0, next));
    this.pickSlot(next);
    return true;
  }

  /**
   * Pick a spline node (the one the bone and the node now follow each other for) and pose the bone at it, at
   * the playhead's frame: then dragging the bone moves the node and dragging the node moves the bone.
   */
  private pickSlot(i: number): void {
    const s = this.session, n = this.path()?.nodes[i];
    this.selNode = i;
    if (!n) return;
    s.pause();
    poseAtNode(s, n.x, n.y, this.chosenParent());
  }

  /** The bone was dragged (unkeyed) on the Stage while a node is picked: the node follows it. */
  private syncFromBone(): void {
    const s = this.session;
    if (!this.drawing || this.selNode < 0 || !s.hasUnkeyed || this.nodeDrag !== null) return;
    // Only when the bone was posed since last time: another session change (a node picked, a handle dragged) must not copy its pose into a node.
    if (s.unkeyedRevision === this.syncRev) return;
    this.syncRev = s.unkeyedRevision;
    const m = this.path(), n = m?.nodes[this.selNode];
    if (!m || !n) return;
    const cur = currentNode(s, this.chosenParent());
    if (!cur || Math.hypot(cur.x - n.x, cur.y - n.y) < 1e-3) return;
    keepMotion(s, { ...m, nodes: m.nodes.map((x, i) => (i === this.selNode ? { ...n, x: cur.x, y: cur.y } : x)) }, "Move a spline node", true);
  }

  /**
   * Edit Path: start a path for the bone (two spline nodes: where it is, and that plus an offset), or go back to drawing the one it has.
   * A bone with translate keys in the animation is asked once (docs/TWO-SYSTEMS-PLAN.md, Q2): the path drives its translation from now on, so the
   * keys are silenced (kept, dimmed in the Timeline, playing again if the path is removed) or deleted (one undo step).
   */
  private async enterDraw(): Promise<void> {
    const s = this.session, existing = motionFor(s);
    if (existing && existing.active === false) this.setMode("twin");
    if (!motionFor(s)) {
      // No path can be made until the parent bone it is relative to is chosen.
      this.noPathTab = "twin";
      const parent = this.chosenParent();
      if (parent === null) { this.onStatus("Choose the parent bone first (Parent bone ▾ in the panel's head): the path is drawn relative to it."); this.parentPick.focus(); this.schedule(); return; }
      const started = startMotion(s, parent);
      if (!started) { this.onStatus("Select a bone in Animate mode, then Edit Path."); return; }
      keepMotion(s, started, `Start a path for ${started.bone}`);
      // Node 2 is picked and the bone goes to it; node 1 is one press away.
      this.pickSlot(1);
      const keys = s.animation ? translateKeyCount(s.animation, started.bone) : 0;
      this.onStatus(`${started.bone}: two spline nodes (where it is, and an offset). Press a number to put the bone on that node, then move the bone or drag the node; + adds a node; Play runs it.${keys > 0 ? " Its key frames are kept: the Key frame tab uses them instead." : ""}`);
    }
    this.slotSig = "";
    this.schedule();
  }

  /** Key frame ⋮ ▸ Create new TwinSpline from Key frame: a path through the bone's keyed poses; the keys are kept and the bone uses the new path (docs/MOTION-MODES-PLAN.md). */
  private async createPathFromKeys(): Promise<void> {
    const s = this.session, bone = s.selectedBone;
    if (!bone || !s.animation) return;
    const old = motionFor(s);
    if (old && !confirm(`Replace the TwinSpline of ${bone} with one made from its key frames? Undo brings it back.`)) return;
    // The parent bone: the one chosen, else the bone's own (the TwinSpline tab's picker changes it).
    const parent = old ? refBoneName(s.doc, old) : this.parentChoice.get(`${s.animation.name}|${bone}`) ?? refBoneName(s.doc, { bone });
    let made: { path: MotionPath; stray: number } | null = null;
    try { made = pathFromKeys(s, parent); } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); return; }
    if (!made) return;
    keepMotion(s, made.path, `Make a TwinSpline of ${bone} from its key frames`);
    this.noPathTab = "twin";
    this.selNode = -1;
    this.slotSig = "";
    this.onStatus(`${bone}: a TwinSpline of ${made.path.nodes.length} nodes${made.path.closed ? " (a ring)" : ""} over ${made.path.duration} s made from the key frames, within ${Math.round(made.stray * 10) / 10} units of them at worst, relative to ${parent ?? "the skeleton"}. The key frames are kept; the tabs choose which one the bone uses.`);
    this.schedule();
  }

  /** TwinSpline ⋮ ▸ Create new Key frame from TwinSpline: the path's keys written as translate keys; the path is kept, and the tabs choose which one the bone uses. */
  private createKeysFromPath(): void {
    const s = this.session, m = motionFor(s);
    if (!m || !s.animation) return;
    const had = translateKeyCount(s.animation, m.bone);
    if (had > 0 && !confirm(`Replace the ${had} translate key${had === 1 ? "" : "s"} of ${m.bone} with keys made from its TwinSpline? Undo brings them back.`)) return;
    try {
      const { stray, keys } = makeKeysFromPath(s, m);
      this.stray = stray;
      this.onStatus(`${m.bone}: ${keys} key frames made from the TwinSpline${had ? ` (its ${had} translate key${had === 1 ? "" : "s"} were replaced)` : ""}. The TwinSpline is kept; press the Key frame tab to use the keys.`);
    } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  /** Key frame ⋮ ▸ Delete Key frame data: the bone's translate keys in the animation, one undo step. */
  private deleteKeyData(): void {
    const s = this.session, a = s.animation, bone = s.selectedBone, h = s.history;
    if (!a || !bone || !h) return;
    const n = translateKeyCount(a, bone);
    if (n === 0 || !confirm(`Delete the ${n} translate key${n === 1 ? "" : "s"} of ${bone} in ${a.name}? Undo brings them back.`)) return;
    h.apply(`Delete the translate keys of ${bone}`, deleteTranslateKeys(a.name, bone));
    s.changed();
    this.onStatus(`${bone}: ${n} translate key${n === 1 ? "" : "s"} deleted.`);
  }

  /** TwinSpline ⋮ ▸ Delete TwinSpline data: the bone's path; its key frames (if any) are what plays then. */
  private deletePathData(): void {
    const s = this.session, m = motionFor(s);
    if (!m || !confirm(`Delete the TwinSpline of ${m.bone} in ${m.animation}? Undo brings it back.`)) return;
    dropMotion(s, m.animation, m.bone);
    this.selNode = -1;
    this.onStatus(`${m.bone}: the TwinSpline is deleted.`);
  }

  /**
   * Drag a numbered button along the strip to move that node to another place in the path's order. While it is held a red
   * arrow carrying its number shows the gap it would go into; the status line says the order the path would run in
   * and the canvas draws that path. Let go outside the strip, or press Escape, to leave it as it was.
   */
  private nodeDragStart(b: HTMLButtonElement, from: number): void {
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const m0 = this.path();
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
    const s = this.session, m = this.path();
    if (!m) return;
    try {
      const next = withOrigin(m, i);
      keepMotion(s, next, `Set ${nodeLabels(m)[i]} to origin`);
      if (this.selNode >= 0) this.selNode = nodeLabels(next).indexOf(nodeLabels(m)[this.selNode]!);
      this.slotSig = "";
      this.onStatus(`The path now starts at ${nodeLabels(next)[0]} and runs ${nodeLabels(next).join(", ")}.`);
      this.schedule();
    } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  /** The node at place `from` moved to place `to` in the path's order (a number dragged to a gap); it stays the picked one if it was. */
  private moveNodeTo(from: number, to: number): void {
    const s = this.session, m = this.path();
    if (!m || from === to || from < 0 || to < 0 || from >= m.nodes.length || to >= m.nodes.length) return;
    const next = moveNode(m, from, to);
    keepMotion(s, next, "Reorder the spline nodes");
    // The picked node keeps its place in the order as the others shift.
    if (this.selNode === from) this.selNode = to;
    else if (this.selNode >= 0) this.selNode = nodeLabels(next).indexOf(nodeLabels(m)[this.selNode]!);
    this.slotSig = "";
    this.onStatus(`The path now runs ${nodeLabels(next).join(", ")}.`);
    this.schedule();
  }

  /** Command (or Ctrl) + click on a node's number: it joins, or leaves, the nodes picked together; the node picked before it is the first of them. */
  private toggleMulti(i: number): void {
    const m = this.path();
    if (!m) return;
    const labels = nodeLabels(m), label = labels[i]!;
    if (this.multi.size === 0 && this.selNode >= 0 && this.selNode !== i) this.multi.add(labels[this.selNode]!);
    if (this.multi.has(label)) this.multi.delete(label); else this.multi.add(label);
    this.slotSig = "";
    this.onStatus(this.multi.size >= 2 ? "Right-click one of them to Merge." : "Command + click another node to pick it too.");
    this.schedule();
  }

  /** The places (in the path's order) of the nodes picked together. */
  private pickedPlaces(): number[] {
    const m = this.path();
    return m ? nodeLabels(m).flatMap((l, i) => (this.multi.has(l) ? [i] : [])) : [];
  }

  /** The nodes picked together become one at their centre. */
  private mergePicked(): void {
    const s = this.session, m = this.path();
    if (!m) return;
    try {
      const next = mergeNodes(m, this.pickedPlaces()), keep = nodeLabels(m)[this.pickedPlaces()[0]!]!;
      keepMotion(s, next, "Merge spline nodes");
      this.multi.clear();
      this.selNode = nodeLabels(next).indexOf(keep);
      this.slotSig = "";
      this.onStatus(`Merged: the path now runs ${nodeLabels(next).join(", ")}.`);
      this.schedule();
    } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  /** Only the numbers are put back in order; the nodes, their places and the path stay as they are. */
  private sortNumbers(): void {
    const s = this.session, m = this.path();
    if (!m) return;
    keepMotion(s, renumberNodes(m), "Sort the node numbers");
    this.multi.clear();
    this.slotSig = "";
    this.onStatus("The numbers are 1 to " + m.nodes.length + " again; the path is unchanged.");
    this.schedule();
  }

  /** Break the legs of the node at place `i` (each handle on its own), or mirror them again. */
  private setLegs(i: number, broken: boolean): void {
    const s = this.session, m = this.path();
    if (!m) return;
    const label = nodeLabels(m)[i];
    try {
      keepMotion(s, broken ? breakLegs(m, i) : mirrorLegs(m, i), broken ? `Break the legs of ${label}` : `Mirror the legs of ${label}`);
      this.onStatus(broken ? `Node ${label}: each leg moves on its own now. Right-click its number to mirror them again.` : `Node ${label}: the way in mirrors the way out again.`);
      this.schedule();
    } catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); }
  }

  /** The path runs the other way round; the picked node stays the picked one. */
  private reverse(): void {
    const s = this.session, m = this.path();
    if (!m) return;
    const next = reversePath(m);
    keepMotion(s, next, "Reverse the path");
    if (this.selNode >= 0) this.selNode = nodeLabels(next).indexOf(nodeLabels(m)[this.selNode]!);
    this.slotSig = "";
    this.onStatus(`The path now runs ${nodeLabels(next).join(", ")}.`);
    this.schedule();
  }

  /** The green +: a node after the picked one, halfway to the next (before the first on a ring's closing span); with none picked, or at an open path's end, after the last by the same offset. */
  private addNode(): void {
    const s = this.session, m = this.path();
    if (!m) return;
    const mid = this.selNode >= 0 ? midAfter(m, this.selNode) : null;
    if (mid) {
      const at = this.selNode + 1;
      // The new node takes the speed spline's value halfway to the next node, so the pace along the path stays as it was.
      const xs = nodeProgress(m), pace = clampSpeed(speedAt(m, (xs[this.selNode]! + (xs[this.selNode + 1] ?? 1)) / 2));
      keepMotion(s, withNode(m, { x: Math.round(mid.x * 1e4) / 1e4, y: Math.round(mid.y * 1e4) / 1e4, ...speedPatch(pace) }, at), "Add a spline node");
      this.selNode = at;
    } else {
      const last = m.nodes.at(-1)!;
      keepMotion(s, withNode(m, { ...nodeAfter(s, last), ...speedPatch(speedOf(last)) }), "Add a spline node");
      this.selNode = m.nodes.length;
    }
    this.multi.clear();
    this.slotSig = "";
    this.onStatus("Added a spline node: move the bone (or drag the node) to place it.");
    this.schedule();
  }

  /** Whether a path is being drawn for the selected bone: its nodes are stored by posing it, so dragging it writes no keys. */
  get drawing(): boolean {
    return !!this.path();
  }

  /** The spline: its curve, the picked node's span lit, the nodes and their handles. */
  private drawMotion(g: CanvasRenderingContext2D, at: (x: number, y: number) => [number, number], accent: string): void {
    const m = this.viewMotion();
    if (!m || this.space !== "parent" || !this.show.spline) return;
    const curve = curveOf(m);
    g.save();
    // The picked node's span (to the next node; the last of an open path: the span into it) lit under the curve, so a number shows which part of the path it owns.
    const lit = this.selNode;
    if (lit >= 0 && lit < m.nodes.length) {
      const end = !m.closed && lit === m.nodes.length - 1, from = curve.nodeAt[end ? lit - 1 : lit], to = curve.nodeAt[end ? lit : lit + 1];
      if (from !== undefined && to !== undefined && to > from) {
        g.save();
        g.strokeStyle = SPAN;
        g.globalAlpha = 0.9;
        g.lineWidth = 6;
        g.lineCap = "round";
        g.lineJoin = "round";
        g.beginPath();
        for (let k = 0; k <= 48; k++) {
          const p = curve.at(from + ((to - from) * k) / 48), [x, y] = at(p.x, p.y);
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
        g.restore();
      }
    }
    // Edit Path draws the curve as a graph editor does: a solid line in the accent colour, filled square nodes, hollow round handles on thin stems.
    g.strokeStyle = accent;
    g.globalAlpha = 1;
    g.lineWidth = 2;
    g.setLineDash([]);
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
    if (pre) {
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
    const ink = getComputedStyle(g.canvas).getPropertyValue("--text").trim() || "#ffffff";
    m.nodes.forEach((n, i) => {
      const [x, y] = at(n.x, n.y);
      this.nodePts.push({ x, y });
      g.strokeStyle = accent;
      g.lineWidth = 2;
      {
        // A filled square in the curve's colour; the picked one a little larger, with a white edge.
        const on = i === this.selNode, half = on ? 6 : 5;
        g.fillStyle = accent;
        g.beginPath(); g.rect(x - half, y - half, half * 2, half * 2); g.fill();
        if (on) { g.strokeStyle = "#ffffff"; g.lineWidth = 1.5; g.stroke(); }
        // The number is in the theme's text colour (white on a light picture is not there).
        g.fillStyle = ink;
        g.font = `10px "JetBrains Mono", monospace`;
        g.textAlign = "left";
        g.textBaseline = "bottom";
        g.fillText(String(nodeLabels(m)[i]), x + 7, y - 4);
      }
    });
    // The curve's hand tools: a handle each side of a node, joined to it by a line; drag one to bend the curve there.
    {
      const offs = handleOffsets(m.nodes, m.closed);
      g.lineWidth = 1;
      m.nodes.forEach((n, slot) => {
        const [nx, ny] = at(n.x, n.y);
        for (const side of ["out", "in"] as const) {
          const o = offs[slot]![side];
          if (!o.x && !o.y) continue;
          const [hx, hy] = at(n.x + o.x, n.y + o.y);
          g.strokeStyle = accent;
          g.globalAlpha = slot === this.selNode ? 1 : 0.6;
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(nx, ny); g.lineTo(hx, hy); g.stroke();
          // A hollow ring: the curve shows through it.
          g.lineWidth = 1.5;
          g.beginPath(); g.arc(hx, hy, 5, 0, Math.PI * 2); g.stroke();
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
    const hd = this.handleDrag, m = this.viewMotion(), at = this.spaceAt(x, y);
    if (!hd || !m || !at) return;
    const n = m.nodes[hd.slot];
    if (!n) return;
    const dx = at[0] - n.x, dy = at[1] - n.y, broken = n.bx !== undefined;
    // A broken leg is moved on its own; a mirrored pair moves together (the way in is the way out turned round).
    const patch = broken && hd.side === "in" ? { bx: dx, by: dy } : { tx: (hd.side === "out" ? 1 : -1) * dx, ty: (hd.side === "out" ? 1 : -1) * dy };
    this.keepView({ ...m, nodes: m.nodes.map((o, i) => (i === hd.slot ? { ...o, ...patch } : o)) }, "Bend the path");
  }

  /** Back to the automatic handle at the one under the point (a double click on it). */
  private resetHandleAt(x: number, y: number): boolean {
    const h = this.handleAt(x, y), m = this.path();
    if (!h || !m) return false;
    keepMotion(this.session, { ...m, nodes: m.nodes.map((o, i) => { if (i !== h.slot) return o; const { tx: _a, ty: _b, bx: _c, by: _d, ...rest } = o; return rest; }) }, "Reset a handle");
    return true;
  }

  /** The spline node under a canvas point, or -1. */
  private nodeAt(x: number, y: number): number {
    let best = -1, bestD = 9;
    this.nodePts.forEach((n, i) => { const d = Math.hypot(n.x - x, n.y - y); if (d <= bestD) { best = i; bestD = d; } });
    return best;
  }

  /** Keep a changed path (the keys are only written by Make keys from path). */
  private timeEdit(next: MotionPath, say?: string, label = `Edit the timing of ${next.bone}`, join = false): void {
    keepMotion(this.session, next, label, join);
    if (say) this.onStatus(say);
  }

  /** Duration was typed, in seconds: the speed spline stays as it is. */
  private setDuration(): void {
    const m = this.path();
    if (!m) return;
    const v = Number(this.durationField.value);
    try { this.timeEdit(withDuration(m, v), `${v} seconds.`, "Set the duration", true); }
    catch (err) { if (!(err instanceof EditRefused)) throw err; this.onStatus(err.message); this.durationField.value = String(m.duration); }
  }

  /** Closed: the spline is a ring (the last node joins the first); off, it is a path with two ends. */
  private setClosed(on: boolean): void {
    const m = this.path();
    if (!m) return;
    this.timeEdit({ ...m, closed: on }, on ? "The spline is a ring." : "The spline is open: it ends on its last node.", on ? "Close the path into a ring" : "Open the ring");
  }

  private removeNode(): void {
    const m = this.path();
    if (!m || this.selNode < 0 || this.selNode >= m.nodes.length) return;
    if (m.nodes.length <= 2) { this.onStatus("A path keeps two spline nodes."); return; }
    keepMotion(this.session, { ...m, nodes: m.nodes.filter((_, i) => i !== this.selNode) }, "Remove a spline node");
    this.selNode = -1;
  }

  /** Whether a canvas point is on the spline's curve (within 10 px), in Edit Path. */
  private onSpline(x: number, y: number): boolean {
    const m = this.viewMotion(), at = this.spaceAt(x, y);
    if (!m || !at || this.space !== "parent") return false;
    return curveOf(m).project({ x: at[0], y: at[1] }).distance * (this.mapping?.k ?? 1) <= 10;
  }

  /** Put a spline node where a double click on the curve is (Edit Path). */
  private insertNodeAt(x: number, y: number): boolean {
    const m = this.viewMotion(), at = this.spaceAt(x, y);
    if (!m || !at || this.space !== "parent") return false;
    const curve = curveOf(m), hit = curve.project({ x: at[0], y: at[1] }), k = this.mapping?.k ?? 1;
    if (hit.distance * k > 10) return false;
    const i = curve.nodeAt.slice(0, m.nodes.length).filter((v) => v <= hit.s).length, p = curve.at(hit.s);
    // The new node takes the speed spline's value where it lands, so the pace along the path stays as it was.
    this.keepView(withNode(m, { x: p.x, y: p.y, ...speedPatch(clampSpeed(speedAt(m, hit.s / Math.max(curve.length, 1e-9)))) }, i), "Add a spline node");
    this.selNode = i;
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
      const hnd = this.handleAt(x, y);
      if (hnd) {
        this.selNode = hnd.slot;
        this.handleDrag = hnd;
        this.session.history?.begin("Bend the path");
        // Alt + drag breaks the node's legs first: only the one held moves.
        const cur = this.path();
        if (e.altKey && cur) keepMotion(this.session, breakLegs(cur, hnd.slot));
        this.grab(e);
        return;
      }
      const node = this.nodeAt(x, y);
      // ⌘ + click on a node: the menu for its legs (break each handle on its own, or mirror them again).
      if (node >= 0 && e.metaKey) { this.legMenu(node, e.clientX, e.clientY); return; }
      // ⌘ + click on the curve itself: the menu to insert a node there.
      if (node < 0 && e.metaKey && this.onSpline(x, y)) {
        showContextMenu(e.clientX, e.clientY, [{ label: "Insert a node here", run: () => { if (this.insertNodeAt(x, y)) { this.slotSig = ""; this.schedule(); } } }]);
        return;
      }
      if (node >= 0) { this.pickSlot(node); this.nodeDrag = node; this.session.history?.begin("Move a spline node"); this.grab(e); return; }
      const h = this.handle;
      if (h && Math.hypot(h.x - x, h.y - y) <= 11 && this.beginEdit(x, y, "rotate", this.session.frame)) { this.grab(e); return; }
      const sc = this.scaleHandle, sh = this.shearHandle;
      if (sc && Math.hypot(sc.x - x, sc.y - y) <= 11 && this.beginEdit(x, y, "scale", this.session.frame)) { this.grab(e); return; }
      if (sh && Math.hypot(sh.x - x, sh.y - y) <= 11 && this.beginEdit(x, y, "shear", this.session.frame)) { this.grab(e); return; }
      const arrow = this.arrowAt(x, y);
      if (arrow !== null && this.beginEdit(x, y, "move", this.session.frame, arrow)) { this.grab(e); return; }
      const best = this.markAt(x, y);
      if (best >= 0) {
        // With a path a dot only puts the path's clock there; with none, drag it to move the bone at that frame.
        if (this.path()) { this.session.seekPath(best / this.session.fps); return; }
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

  /** The menu of a node's legs, opened by ⌘ + click on the node: the node is picked, and its legs broken or mirrored from the menu. */
  private legMenu(i: number, cx: number, cy: number): void {
    const m = this.path();
    if (!m) return;
    this.multi.clear();
    this.pickSlot(i);
    const label = nodeLabels(m)[i]!, broken = m.nodes[i]?.bx !== undefined;
    showContextMenu(cx, cy, [{ label: broken ? `Mirror the legs of ${label}` : `Break the legs of ${label}`, run: () => this.setLegs(i, !broken) }]);
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
      const [x, y] = localPoint(this.canvas, e), at = this.spaceAt(x, y), m = this.viewMotion();
      if (at && m) {
        this.keepView({ ...m, nodes: m.nodes.map((n, i) => (i === this.nodeDrag && n ? { ...n, x: at[0], y: at[1] } : n)) });
        // The bone goes with the node (at the playhead's frame): the node as stored, in the parent bone's space.
        const kept = this.path()?.nodes[this.nodeDrag];
        if (kept) poseAtNode(this.session, kept.x, kept.y, this.chosenParent());
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
      this.canvas.style.cursor = this.onTag(x, y) || this.nodeAt(x, y) >= 0 ? "grab" : (h && Math.hypot(h.x - x, h.y - y) <= 11) || this.arrowAt(x, y) !== null || this.markAt(x, y) >= 0 ? "grab" : "";
      return;
    }
    this.pan = { x: this.pan.x + e.clientX - this.dragging.x, y: this.pan.y + e.clientY - this.dragging.y };
    this.dragging = { x: e.clientX, y: e.clientY };
    this.schedule();
  }

  private up(e: PointerEvent): void {
    this.scrubbing = false;
    // A node or a handle dragged is one step, taken when it is let go.
    if (this.nodeDrag !== null || this.handleDrag) this.session.history?.end();
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
