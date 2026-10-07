import { subtree, updateBone } from "@/edit/bones";
import { type BoneProperty, keyBone, type LocalPose } from "@/edit/boneKeys";
import { EditRefused } from "@/edit/history";
import { findAttachment } from "@/edit/attachments";
import { deformWithVertexAt, keyDeform } from "@/edit/deformKeys";
import { addHullVertex, addVertex, deleteVertex, moveVertex } from "@/edit/mesh";
import { setWeights } from "@/edit/weights";
import { addGuide, moveGuide, removeGuide, updateReference } from "@/edit/sidecar";
import type { Reference } from "@/model/sidecar";
import { axisOf, guideScreen, hitGuide, RULER, rulerAt, rulerOf, tickStep } from "./guides";
import { boneInherit, boneNumber } from "@/model/defaults";
import type { Session } from "../session";
import { type Camera, fit, pan, toScreen, toWorld, zoomAt } from "./camera";
import { asWritten, localRotation, type Matrix, moveDelta, pickBone, type Point, lockToAxis, scaleAlong, scaleFactors, type ScreenBone, shearAlong, shearDelta, type Space, spaceAxes, tidy, type Tool, turn, turnSign } from "./gizmo";
import { drawnVertices } from "@/engine/draw";
import { compensated } from "../compensate";
import { CLICK_PX, createBone, type CreateKind, createShape } from "./create";
import { createPath } from "./pathCreate";
import { animatedLocal, boneMatrix, boneTip, bounds, parentMatrix, type Posed } from "./posed";
import { type ConstraintShape, constraintShapes, hitConstraint } from "./constraintShapes";
import { animatedMeshView, hitMesh, meshView, type MeshView, toBone, weightOf } from "./meshMode";
import { movePathPoint, movePathVertex } from "@/edit/path";
import { boneColourOf } from "../boneLook";
import { localPoint, pageScale } from "../pageScale";
import { hitPath, type PathView, pathView, toSlot } from "./pathView";
import { boneHalfWidth, jointRadius } from "./boneScale";
import { NO_LOOK, type StageLook } from "./look";
import { type Backdrop, Renderer } from "./renderer";
import { ghostsFor, type OnionOptions } from "./onion";
import { type SnapOptions, type Snapped, type SnapTargets, snapPoint } from "./snap";
import { brush, brushWeights } from "./weightBrush";
import { hitReference, movedReference, type Placed, referenceCorner, referenceQuad, scaledReference } from "./references";
import { keysOf } from "../shortcuts";

/** How far from the selected bone's origin a press still grabs it, in pixels (the gizmo's ring). */
const GRAB = 56;
/** The gizmo arrows' colours, after Godot's: x red, y green. */
const AXIS_X = "#f53352", AXIS_Y = "#87d603";
/** A Scale drag that began nearer than this to the bone's origin (pixels) scales nothing: its ratio would jump. */
const MIN_SCALE_START = 12;
const LABEL: Record<Tool, string> = { move: "Move", rotate: "Rotate", scale: "Scale", shear: "Shear" };
/** The property each tool keys in Animate mode. */
const KEYED: Record<Tool, BoneProperty> = { move: "translate", rotate: "rotate", scale: "scale", shear: "shear" };

interface Drag {
  bone: string;
  tool: Tool;
  start: Point;
  /** The pointer's last world position (rotate adds the turn since). */
  last: Point;
  turned: number;
  x: number; y: number; rotation: number; scaleX: number; scaleY: number;
  /** The bone's and its parent's world matrices when the drag began. */
  matrix: Matrix;
  parent: Matrix;
  /** Which way a world turn moves the local rotation, for inherit modes other than normal. */
  sign: number;
  inherit: string;
  shearX: number;
  shearY: number;
  /** Animate mode: the animation and time the drag keys at. */
  key: { animation: string; time: number } | null;
  /** Move along an axis of `space` (local, world), chosen at the drag's start; null until then. */
  space: Space;
  lock: 0 | 1 | null;
  /** Auto Key off in an animation: the drag poses the bone without writing the document. */
  unkeyed: boolean;
  /** The keys as the file had them (absent: undefined), for an axis that ends where it began. */
  written: Dragged;
  /** What the bone's origin may snap to (E6 step 4e): the bones that do not move with it, the guides. */
  targets: SnapTargets;
}

/** The setup values a drag sets. */
type Dragged = { [K in "x" | "y" | "rotation" | "scaleX" | "scaleY" | "shearX" | "shearY"]?: number | undefined };

/**
 * The canvas viewport: the skeleton's images (WebGL2) with the bones and the gizmo drawn over
 * them (2D canvas). A press on a bone selects it and drags it with the current tool, one undo
 * step per drag; a press elsewhere pans, as do the middle and right buttons. The wheel zooms at
 * the pointer.
 */
export class Stage {
  readonly element: HTMLDivElement;
  tool: Tool = "move";
  /** With an animation chosen: a drag keys it (on), or poses the bone unkeyed until Key (off). */
  autoKey = true;
  /** True while a motion path is being drawn: the bone is posed to store it, so a drag writes no keys (docs/PATH-CAPTURE-PLAN.md). */
  forceUnkeyed: () => boolean = () => false;
  /** Whether the bone cannot be dragged now (Motion Path's Adjust time edits the path's timing only). */
  dragLocked: () => boolean = () => false;
  /** The Move tool's axes: parent's is the free drag; local and world hold it to one axis. */
  space: Space = "parent";
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  /** The pointer's world position, for the status line. */
  pointer: Point | null = null;
  /** Preferences (E4 step 10): rulers and bones drawn or not. Hidden bones are still picked. */
  show = { rulers: true, bones: true, constraints: true };
  /** The Select column of the Stage matrix: what a press picks. A bone already selected keeps its gizmo, picked or not. */
  select = { bones: true, images: true, others: true };
  /** The Names column: bones draw their names. */
  names = { bones: false };
  /** A press picked something (a bone, an image, a constraint): the app shows its name for a moment. */
  onPick: () => void = () => {};
  /** The Create group's tool: what a press on the stage makes (null: none, the transform tools work). */
  createKind: CreateKind | null = null;
  private createDrag: { from: Point; to: Point | null; target: string | null; screen: [number, number] } | null = null;

  /** Choose what a press makes, or (null) go back to the transform tools. */
  setCreate(kind: CreateKind | null): void {
    this.createKind = kind;
    this.createDrag = null;
    this.overlay.style.cursor = kind ? "crosshair" : "";
    this.redraw();
  }
  /** With an animation shown, the bones IK constraints drive are neither drawn nor picked (they are not animated). */
  hideIkBones = false;
  /** The motion path's line to draw over the skeleton (world points, x then y), or null. */
  motionLine: () => { points: readonly number[]; colour: string } | null = () => null;
  /** Onion skin (E6 step 4d): which ghosts to draw, or null when off. */
  onion: OnionOptions | null = null;
  /** Snapping (E6 step 4e): what a dragged origin or vertex snaps to, or null when off. */
  snap: SnapOptions | null = null;
  /** The grid's spacing in skeleton units, or null when the grid is not shown. */
  grid: number | null = null;
  /** The checkerboard, centre axes and grid lines' colours and thickness (View and Preferences). */
  look: StageLook = NO_LOOK;
  /** The colour bones are drawn in unless they have their own; null: the theme's. */
  boneColour: string | null = null;
  /** The colour the selected bone and its gizmo are drawn in; null: the theme's accent. */
  selectedBoneColour: string | null = null;
  /** What the drag snapped to this step, drawn until the drag ends. */
  private snapped: Snapped | null = null;
  /** A weight-brush stroke under way (E6 step 4f), and where the pointer is on screen for the circle. */
  private stroke: { takeAway: boolean } | null = null;
  private brushAt: [number, number] | null = null;
  /** A message for the status line (a refused edit). */
  /** A right click without a drag (a drag pans): where, the world point there, and the bone under it. */
  onContextMenu: (client: Point, world: Point, bone: string | null) => void = () => {};
  private rightDown: { x: number; y: number } | null = null;
  onStatus: (message: string) => void = () => {};
  /** The pointer's world position or the zoom, for the status line's corner. */
  onPointer: (text: string) => void = () => {};
  private readonly gl: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private renderer: Renderer;
  private size = { width: 1, height: 1 };
  private dpr = 1;
  private drag: Drag | null = null;
  /** Mesh mode: the vertex being dragged. The selected one is the session's. */
  /** A guide being dragged (out of a ruler, or moved), by its index in the sidecar. */
  private guideDrag: { index: number; overRuler: boolean } | null = null;
  private pathDrag: { view: PathView; index: number } | null = null;
  private vertexDrag: { view: MeshView; index: number; time?: number; animation?: string } | null = null;
  private panning: { x: number; y: number } | null = null;
  /** The chosen reference being moved, or sized by a corner (E4 step 13); `from` is where it was. */
  private refDrag: { index: number; from: Reference; start: Point; corner: boolean } | null = null;
  /** The last left press hit nothing: a double-click there may choose a reference. */
  private emptyPress = false;
  private queued = false;
  private fitted = false;

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "stage";
    this.gl = document.createElement("canvas");
    this.overlay = document.createElement("canvas");
    this.overlay.className = "overlay";
    this.overlay.tabIndex = 0;
    this.element.append(this.gl, this.overlay);
    this.renderer = new Renderer(this.gl);
    // A browser may drop the WebGL context (a popout window, a GPU reset): draw again on a new one.
    this.gl.addEventListener("webglcontextlost", (e) => e.preventDefault());
    this.gl.addEventListener("webglcontextrestored", () => { this.renderer = new Renderer(this.gl); this.redraw(); });
    this.overlay.addEventListener("pointerdown", (e) => this.down(e));
    this.overlay.addEventListener("pointermove", (e) => this.move(e));
    this.overlay.addEventListener("pointerup", (e) => this.up(e));
    this.overlay.addEventListener("pointercancel", () => this.cancel());
    this.overlay.addEventListener("pointerleave", () => { this.pointer = null; this.onPointer(""); });
    this.overlay.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    this.overlay.addEventListener("dblclick", (e) => this.chooseReference(e));
    session.onChange(() => this.redraw());
  }

  /** Show the whole skeleton. */
  fitView(): void {
    const p = this.session.pose();
    this.camera = fit(this.size, p ? bounds(p) : null);
    this.redraw();
  }

  /** Centre the view on the selected bone, at the zoom it has; with no bone selected, show the whole skeleton. */
  focusSelected(): void {
    const i = this.selectedIndex(), p = this.session.pose();
    if (!p || i < 0) { this.fitView(); return; }
    const m = boneMatrix(p, i);
    this.camera = { ...this.camera, x: m[4], y: m[5] };
    this.redraw();
  }

  /** A short label by the selected bone (the stage's middle with none), gone after 0.4 s. */
  flash(text: string): void {
    const i = this.selectedIndex(), p = this.session.pose();
    let x = this.size.width / 2, y = this.size.height / 2;
    if (p && i >= 0) { const m = boneMatrix(p, i); [x, y] = toScreen(this.camera, this.size, m[4], m[5]); }
    this.flashEl?.remove();
    const el = document.createElement("div");
    el.className = "stage-flash";
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y - 28}px`;
    this.element.append(el);
    this.flashEl = el;
    setTimeout(() => { if (this.flashEl === el) this.flashEl = null; el.remove(); }, 400);
  }
  private flashEl: HTMLElement | null = null;

  /** A new document: fit it once the stage has a size. */
  opened(): void {
    // The camera the opened sidecar kept, else fit the skeleton once the stage has a size.
    const cam = this.session.openedCamera;
    this.session.openedCamera = null;
    this.fitted = !!cam;
    if (cam) this.camera = cam;
    this.renderer.keepOnly(this.session.pages, this.session.referenceImages.values());
    this.redraw();
  }

  /** Abandon a drag in progress (Escape): the bone goes back, nothing recorded. */
  cancel(): boolean {
    if (this.createDrag) { this.createDrag = null; this.redraw(); return true; }
    const rd = this.refDrag;
    if (rd) {
      this.refDrag = null;
      this.session.setSidecar(updateReference(this.session.sidecar, rd.index, rd.from));
      return true;
    }
    if (!this.drag && !this.vertexDrag && !this.pathDrag) return false;
    this.drag = null;
    this.vertexDrag = null;
    this.pathDrag = null;
    this.session.history?.cancel();
    this.session.changed();
    return true;
  }

  redraw(): void {
    if (this.queued) return;
    this.queued = true;
    this.view().requestAnimationFrame(() => { this.queued = false; this.paint(); });
  }

  /** The window the stage is in: the main one, or a popout window it was moved to. */
  private view(): Window {
    return this.element.ownerDocument.defaultView ?? window;
  }

  /** The panel's size, from the dock (Dockview calls this whenever it lays the panel out). */
  resize(width: number, height: number): void {
    this.size = { width: Math.max(1, width), height: Math.max(1, height) };
    this.dpr = (this.view().devicePixelRatio || 1) * pageScale(this.element.ownerDocument);
    for (const c of [this.gl, this.overlay]) {
      c.width = Math.round(this.size.width * this.dpr);
      c.height = Math.round(this.size.height * this.dpr);
    }
    this.paint();
  }

  private paint(): void {
    const p = this.session.pose();
    if (p && !this.fitted && this.size.width > 1) {
      this.fitted = true;
      this.camera = fit(this.size, bounds(p));
    }
    const css = this.view().getComputedStyle(this.element);
    const refs: Backdrop[] = [];
    for (const r of this.session.sidecar.references) {
      const bitmap = this.session.referenceImages.get(r.path);
      if (bitmap) refs.push({ bitmap, ...referenceQuad(r, bitmap.width, bitmap.height), opacity: r.opacity });
    }
    this.renderer.draw(p, this.session.pages, this.camera, this.size, this.dpr, rgb(css.getPropertyValue("--stage-bg")), refs, ghostsFor(this.session, this.onion), this.grid, this.look);
    const g = this.overlay.getContext("2d")!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.size.width, this.size.height);
    if (!p) return;
    const bone = css.getPropertyValue("--bone").trim(), selected = css.getPropertyValue("--accent").trim();
    if (this.show.bones) {
      // A bone with a colour of its own keeps it; the rest take the preference, else the theme's.
      const unit = this.session.boneUnit(), size = this.session.boneSize;
      const own = new Map<string, string>();
      for (const b of this.session.doc?.bones ?? []) { const c = boneColourOf(b); if (c) own.set(b.name, c); }
      for (const b of this.screenBones()) {
        const on = b.name === this.session.selectedBone;
        drawBone(g, b, on ? this.selectedBoneColour ?? selected : own.get(b.name) ?? this.boneColour ?? bone, on, boneHalfWidth(unit, size, this.camera.zoom), jointRadius(unit, size, this.camera.zoom));
      }
    }
    if (this.session.pinned.size && !this.session.animation) this.drawPins(g);
    if (this.names.bones) this.drawBoneNames(g, css.getPropertyValue("--text").trim() || "#ffffff");
    if (this.show.constraints) { this.drawShapes(g, p, selected); this.drawConstraints(g, p, css, selected); }
    this.drawMotionLine(g);
    const sel = this.selectedIndex();
    // No gizmo on a bone without a pose: nothing to grab it by (E8-PLAN step 2).
    if (sel >= 0 && boneMatrix(p, sel).every(Number.isFinite)) this.drawGizmo(g, sel, this.selectedBoneColour ?? selected);
    const mesh = this.meshMode();
    if (mesh) this.drawMesh(g, mesh, selected, bone);
    const path = this.pathMode();
    if (path) this.drawPath(g, path, this.selectedBoneColour ?? selected);
    this.drawCreatePreview(g, selected);
    this.drawGuides(g, css.getPropertyValue("--guide").trim() || "#36c2d9");
    if (this.snapped && (this.drag || this.vertexDrag)) this.drawSnapped(g, this.snapped, selected);
    this.drawChosenReference(g, selected);
    if (this.show.rulers) this.drawRulers(g, css);
  }

  /** The motion path of the selected bone, as a line in the colour chosen in the Motion Path panel. */
  private drawMotionLine(g: CanvasRenderingContext2D): void {
    const line = this.motionLine();
    if (!line || line.points.length < 4) return;
    g.save();
    g.strokeStyle = line.colour;
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.beginPath();
    for (let i = 0; i + 1 < line.points.length; i += 2) {
      const [x, y] = toScreen(this.camera, this.size, line.points[i]!, line.points[i + 1]!);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.restore();
  }

  /** Each reference with its picture's size; null where the picture is missing. */
  private placed(): (Placed | null)[] {
    return this.session.sidecar.references.map((r) => {
      const b = this.session.referenceImages.get(r.path);
      return b ? { r, width: b.width, height: b.height } : null;
    });
  }

  /** The chosen reference and its picture's size, when it has one. */
  private chosenReference(): Placed | null {
    const i = this.session.reference;
    return i === null ? null : this.placed()[i] ?? null;
  }

  /** The chosen reference's outline and corner handles, over the skeleton. */
  private drawChosenReference(g: CanvasRenderingContext2D, color: string): void {
    const p = this.chosenReference();
    if (!p) return;
    const { xy } = referenceQuad(p.r, p.width, p.height);
    const pts = [0, 1, 2, 3].map((k) => toScreen(this.camera, this.size, xy[k * 2]!, xy[k * 2 + 1]!));
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.stroke();
    for (const [x, y] of pts) g.fillRect(x - 4, y - 4, 8, 8);
    g.restore();
  }

  /** A double-click where a press hit nothing chooses the topmost reference under it. */
  private chooseReference(e: MouseEvent): void {
    if (!this.emptyPress || !this.session.history) return;
    const [sx, sy] = this.local(e as PointerEvent);
    const [wx, wy] = toWorld(this.camera, this.size, sx, sy);
    const i = hitReference(this.placed(), wx, wy);
    if (i < 0) return;
    this.session.selectReference(i);
    this.onStatus("Reference chosen: drag it to move it, a corner to size it; Escape while dragging puts it back.");
  }

  /** A press on the chosen reference's corner (size it) or inside it (move it); false when on neither. */
  private referenceDown(sx: number, sy: number): boolean {
    const p = this.chosenReference(), i = this.session.reference;
    if (!p || i === null) return false;
    const corner = referenceCorner(p, (x, y) => toScreen(this.camera, this.size, x, y), sx, sy) >= 0;
    const start = toWorld(this.camera, this.size, sx, sy);
    if (!corner && hitReference([p], start[0], start[1]) < 0) return false;
    this.refDrag = { index: i, from: p.r, start, corner };
    return true;
  }

  private referenceTo(at: Point): void {
    const d = this.refDrag!, s = this.session;
    const patch = d.corner ? { scale: scaledReference(d.from, d.start, at) } : movedReference(d.from, d.start, at);
    try {
      s.setSidecar(updateReference(s.sidecar, d.index, patch));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
  }

  private drawGuides(g: CanvasRenderingContext2D, color: string): void {
    const guides = this.session.sidecar.guides, { width, height } = this.size;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 1;
    guides.forEach((gd, i) => {
      const at = Math.round(guideScreen(gd, this.camera, this.size)) + 0.5;
      // A guide dragged back onto its ruler is about to go.
      g.globalAlpha = this.guideDrag?.index === i && this.guideDrag.overRuler ? 0.3 : 0.9;
      g.beginPath();
      if (gd.axis === "x") { g.moveTo(at, 0); g.lineTo(at, height); } else { g.moveTo(0, at); g.lineTo(width, at); }
      g.stroke();
    });
    g.restore();
  }

  /** What the drag snapped to: the grid or guide line (dashed, across the stage), or the joint (a ring). */
  private drawSnapped(g: CanvasRenderingContext2D, s: Snapped, color: string): void {
    const { width, height } = this.size;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    if (s.x !== undefined) { const x = Math.round(toScreen(this.camera, this.size, s.x, 0)[0]) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke(); }
    if (s.y !== undefined) { const y = Math.round(toScreen(this.camera, this.size, 0, s.y)[1]) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke(); }
    g.setLineDash([]);
    if (s.to) { const [x, y] = toScreen(this.camera, this.size, s.to[0], s.to[1]); g.lineWidth = 2; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke(); }
    g.restore();
  }

  /** Rulers along the top and left edges, in skeleton units: where guides are dragged out of. */
  private drawRulers(g: CanvasRenderingContext2D, css: CSSStyleDeclaration): void {
    const { width, height } = this.size, c = this.camera;
    const bg = css.getPropertyValue("--ruler-bg").trim() || "transparent", text = css.getPropertyValue("--ruler-text").trim() || css.getPropertyValue("--text").trim() || "#ddd", line = text;
    g.save();
    g.fillStyle = bg;
    g.fillRect(0, 0, width, RULER);
    g.fillRect(0, 0, RULER, height);
    g.strokeStyle = line;
    g.fillStyle = text;
    g.font = `600 11px "JetBrains Mono", monospace`;
    g.lineWidth = 1;
    const step = tickStep(c.zoom);
    const label = (v: number) => String(Math.round(v * 1000) / 1000);
    g.beginPath();
    // Top ruler: x.
    for (let v = Math.ceil((c.x - width / 2 / c.zoom) / step) * step; ; v += step) {
      const x = Math.round(toScreen(c, this.size, v, 0)[0]) + 0.5;
      if (x > width) break;
      if (x < RULER) continue;
      g.moveTo(x, RULER - 6); g.lineTo(x, RULER);
      g.fillText(label(v), x + 3, 12);
    }
    // Left ruler: y, labels turned to read upwards.
    for (let v = Math.floor((c.y + height / 2 / c.zoom) / step) * step; ; v -= step) {
      const y = Math.round(toScreen(c, this.size, 0, v)[1]) + 0.5;
      if (y > height) break;
      if (y < RULER) continue;
      g.moveTo(RULER - 6, y); g.lineTo(RULER, y);
      g.save(); g.translate(12, y - 3); g.rotate(-Math.PI / 2); g.fillText(label(v), 0, 0); g.restore();
    }
    g.moveTo(0, RULER + 0.5); g.lineTo(width, RULER + 0.5);
    g.moveTo(RULER + 0.5, 0); g.lineTo(RULER + 0.5, height);
    g.stroke();
    g.restore();
  }

  /** The constraint shapes to draw and pick: without the IK ones while Hide IK is on in an animation. */
  private shownShapes(p: Posed): ConstraintShape[] {
    const shapes = constraintShapes(p);
    return this.hideIkBones && this.session.animation ? shapes.filter((s) => s.type !== "ik") : shapes;
  }

  /** The slot whose image is topmost under the screen point, or null. */
  private imageAt(sx: number, sy: number): string | null {
    const p = this.session.pose();
    if (!p) return null;
    const [wx, wy] = toWorld(this.camera, this.size, sx, sy);
    for (let i = p.draw.slots.length - 1; i >= 0; i--) {
      const d = p.draw.slots[i]!, v = new Float32Array(d.vertexCount * 2);
      drawnVertices(p.rig, d, v);
      for (let t = 0; t < d.triangles.length; t += 3) {
        const a = d.triangles[t]! * 2, b = d.triangles[t + 1]! * 2, c = d.triangles[t + 2]! * 2;
        if (inTriangle(wx, wy, v[a]!, v[a + 1]!, v[b]!, v[b + 1]!, v[c]!, v[c + 1]!)) return p.rig.data.slots[d.slot]!.name;
      }
    }
    return null;
  }

  /** A press on a drawn constraint selects it; false when on none (or constraints are hidden). */
  private constraintDown(sx: number, sy: number): boolean {
    const p = this.session.pose();
    const hit = this.show.constraints && this.select.others && p ? hitConstraint(this.shownShapes(p), (x, y) => toScreen(this.camera, this.size, x, y), sx, sy) : null;
    if (hit) { this.session.select({ kind: "constraint", type: hit.type, name: hit.name }); this.onPick(); }
    return !!hit;
  }

  /** A press on a ruler (a new guide) or on a guide (move it); false when on neither. */
  private guideDown(sx: number, sy: number): boolean {
    const s = this.session, ruler = this.show.rulers ? rulerAt(sx, sy) : null;
    if (ruler) {
      const [wx, wy] = toWorld(this.camera, this.size, sx, sy);
      s.setSidecar(addGuide(s.sidecar, axisOf(ruler), ruler === "top" ? wy : wx));
      this.guideDrag = { index: s.sidecar.guides.length - 1, overRuler: true };
      return true;
    }
    const i = hitGuide(s.sidecar.guides, this.camera, this.size, sx, sy);
    if (i < 0) return false;
    this.guideDrag = { index: i, overRuler: false };
    return true;
  }

  private guideTo(sx: number, sy: number): void {
    const d = this.guideDrag!, s = this.session, gd = s.sidecar.guides[d.index];
    if (!gd) return;
    const [wx, wy] = toWorld(this.camera, this.size, sx, sy);
    // Back onto its ruler removes it; with the rulers hidden there is nowhere to drop it.
    d.overRuler = this.show.rulers && (rulerAt(sx, sy) === rulerOf(gd.axis) || (gd.axis === "y" ? sy < RULER : sx < RULER));
    s.setSidecar(moveGuide(s.sidecar, d.index, gd.axis === "x" ? wx : wy));
    this.redraw();
  }

  /** Each active constraint's shape (E4 step 12), coloured by kind; the selected one in the accent colour. */
  /** Bounding boxes, clipping polygons and points of the shown slots, as outlines (the Others row of the matrix). */
  private drawShapes(g: CanvasRenderingContext2D, p: Posed, accent: string): void {
    const sel = this.session.selected, rig = p.rig;
    const at = (x: number, y: number) => toScreen(this.camera, this.size, x, y);
    for (const slot of rig.drawOrder) {
      const att = rig.attachmentOf(slot);
      if (!att || (att.kind !== "box" && att.kind !== "clipping" && att.kind !== "point")) continue;
      const on = sel?.kind === "attachment" && sel.slot === rig.data.slots[slot]!.name && sel.key === this.keyOf(slot);
      g.save();
      g.lineWidth = on ? 2 : 1.5;
      if (att.kind === "point") {
        const w = rig.pointWorld(slot, att), [x, y] = at(w.x, w.y), a = (-w.rotation * Math.PI) / 180;
        g.strokeStyle = g.fillStyle = on ? accent : "#36c2d9";
        g.beginPath(); g.moveTo(x - 6, y); g.lineTo(x + 6, y); g.moveTo(x, y - 6); g.lineTo(x, y + 6); g.stroke();
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 16, y + Math.sin(a) * 16); g.stroke();
      } else {
        const n = att.vertexCount, out = new Float32Array(n * 2);
        rig.vertexWorld(slot, att, 0, n * 2, out, 0);
        g.strokeStyle = on ? accent : att.kind === "box" ? "#3ddc84" : "#e5484d";
        g.setLineDash(att.kind === "clipping" ? [6, 4] : []);
        g.beginPath();
        for (let i = 0; i < n; i++) { const [x, y] = at(out[i * 2]!, out[i * 2 + 1]!); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
        g.closePath();
        g.stroke();
      }
      g.restore();
    }
  }

  /** The key of the attachment a slot shows now (what the skeleton file calls it). */
  private keyOf(slot: number): string | null {
    return this.session.pose()?.rig.attachment[slot] ?? null;
  }

  private drawConstraints(g: CanvasRenderingContext2D, p: Posed, css: CSSStyleDeclaration, accent: string): void {
    const sel = this.session.selected;
    const at = (x: number, y: number) => toScreen(this.camera, this.size, x, y);
    for (const s of this.shownShapes(p)) {
      const on = sel?.kind === "constraint" && sel.type === s.type && sel.name === s.name;
      g.save();
      g.strokeStyle = g.fillStyle = on ? accent : css.getPropertyValue(`--c-${s.type}`).trim() || "#d08a2b";
      g.lineWidth = on ? 2.5 : 1.25;
      g.globalAlpha = on ? 1 : 0.85;
      g.setLineDash([5, 4]);
      for (const [x0, y0, x1, y1] of s.links) {
        const a = at(x0, y0), b = at(x1, y1);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
      g.setLineDash([]);
      for (const c of s.curves) {
        const a = at(c[0], c[1]), h1 = at(c[2], c[3]), h2 = at(c[4], c[5]), b = at(c[6], c[7]);
        g.beginPath(); g.moveTo(a[0], a[1]); g.bezierCurveTo(h1[0], h1[1], h2[0], h2[1], b[0], b[1]); g.stroke();
      }
      for (const m of s.marks) {
        const [x, y] = at(m.x, m.y);
        g.beginPath();
        if (m.mark === "ring") { g.arc(x, y, 6, 0, Math.PI * 2); g.stroke(); }
        else if (m.mark === "dot") { g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
        else g.strokeRect(x - 4, y - 4, 8, 8);
      }
      g.restore();
    }
  }

  /**
   * Mesh mode: the selected attachment is a mesh and the setup pose is shown. Its vertices are
   * edited on the stage (E4-PLAN step 5); in Animate mode the bone tools stay.
   */
  private meshMode(): MeshView | null {
    const s = this.session, sel = s.selected, doc = s.doc;
    if (sel?.kind !== "attachment" || !doc) return null;
    const p = s.pose();
    if (!p) return null;
    // Animate mode: the mesh where its vertices are at the playhead, when its slot shows it (step 11).
    if (s.animation) return animatedMeshView(doc, p, sel, s.skin).view;
    return meshView(doc, p, sel);
  }

  /**
   * Path mode (docs/PATH-PLAN.md): the selected attachment is a path and the setup pose is shown. Its
   * points and handles are dragged on the stage; in Animate mode the path's curve is drawn as a
   * constraint shows it and the bone tools stay.
   */
  private pathMode(): PathView | null {
    const s = this.session, sel = s.selected, doc = s.doc;
    if (sel?.kind !== "attachment" || !doc || s.animation) return null;
    const p = s.pose();
    return p ? pathView(doc, p, sel) : null;
  }

  private pathScreen(view: PathView): number[] {
    const out: number[] = [];
    for (let i = 0; i < view.world.length; i += 2) out.push(...toScreen(this.camera, this.size, view.world[i]!, view.world[i + 1]!));
    return out;
  }

  /** The path: its curve, the handles on lines from their points, the points as discs; the chosen vertex in `accent`. */
  private drawPath(g: CanvasRenderingContext2D, view: PathView, accent: string): void {
    const sp = this.pathScreen(view), n = sp.length / 2, points = Math.floor(n / 3), chosen = this.session.pathVertex;
    const at = (i: number): [number, number] => [sp[i * 2]!, sp[i * 2 + 1]!];
    g.save();
    g.strokeStyle = accent;
    g.fillStyle = accent;
    g.lineWidth = 2;
    g.globalAlpha = 0.9;
    const segments = view.closed ? points : points - 1;
    g.beginPath();
    for (let c = 0; c < segments; c++) {
      const j = (c + 1) % points, [x0, y0] = at(c * 3 + 1), [x1, y1] = at(c * 3 + 2), [x2, y2] = at(j * 3), [x3, y3] = at(j * 3 + 1);
      g.moveTo(x0, y0);
      g.bezierCurveTo(x1, y1, x2, y2, x3, y3);
    }
    g.stroke();
    g.lineWidth = 1;
    g.globalAlpha = 0.7;
    for (let p = 0; p < points; p++) {
      const [px, py] = at(p * 3 + 1);
      for (const k of [0, 2]) { const [hx, hy] = at(p * 3 + k); g.beginPath(); g.moveTo(px, py); g.lineTo(hx, hy); g.stroke(); }
    }
    g.globalAlpha = 1;
    for (let i = 0; i < n; i++) {
      const [x, y] = at(i), isPoint = i % 3 === 1, on = i === chosen;
      g.fillStyle = on ? "#ffffff" : accent;
      g.strokeStyle = on ? accent : "#000000";
      g.lineWidth = on ? 3 : 1;
      g.beginPath();
      if (isPoint) g.arc(x, y, on ? 6 : 5, 0, Math.PI * 2); else g.rect(x - 3.5, y - 3.5, 7, 7);
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  /** A press in path mode: on a point or handle selects and drags it. False when the press is off them. */
  private pathDown(view: PathView, sx: number, sy: number): boolean {
    const i = hitPath(this.pathScreen(view), sx, sy);
    if (i < 0) return false;
    this.session.pathVertex = i;
    const h = this.session.history!;
    h.begin(i % 3 === 1 ? `Move point ${Math.floor(i / 3)} of ${view.ref.key}` : `Move handle ${i} of ${view.ref.key}`);
    this.pathDrag = { view, index: i };
    this.session.changed();
    return true;
  }

  /** One step of a path drag: the point (with its handles) or the handle goes where the pointer is, in the slot bone's space. */
  private pathTo(at: Point): void {
    const d = this.pathDrag!, [x, y] = toSlot(d.view, at), bones = this.session.setupBones() ?? undefined;
    try {
      this.session.history!.apply("step", d.index % 3 === 1 ? movePathPoint(d.view.ref, Math.floor(d.index / 3), x, y, bones) : movePathVertex(d.view.ref, d.index, x, y, bones));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
    this.session.changed();
  }

  /** The selected vertex of `view`, or -1. */
  private selectedVertex(view: MeshView): number {
    const v = this.session.vertex;
    return v !== null && v < view.world.length / 2 ? v : -1;
  }

  private screenOf(view: MeshView): number[] {
    const out: number[] = [];
    for (let i = 0; i < view.world.length; i += 2) out.push(...toScreen(this.camera, this.size, view.world[i]!, view.world[i + 1]!));
    return out;
  }

  private drawMesh(g: CanvasRenderingContext2D, view: MeshView, accent: string, muted: string): void {
    const sp = this.screenOf(view), at = (i: number) => [sp[i * 2]!, sp[i * 2 + 1]!] as const;
    g.save();
    g.lineWidth = 1;
    g.strokeStyle = muted;
    g.globalAlpha = 0.6;
    g.beginPath();
    for (let k = 0; k + 2 < view.triangles.length; k += 3) {
      const [a, b, c] = [at(view.triangles[k]!), at(view.triangles[k + 1]!), at(view.triangles[k + 2]!)];
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.closePath();
    }
    g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = accent;
    g.lineWidth = 1.5;
    if (view.hull >= 2) {
      g.beginPath();
      for (let i = 0; i < view.hull; i++) { const [x, y] = at(i); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.closePath();
      g.stroke();
    }
    const chosen = this.selectedVertex(view);
    // Weights of the bone the properties panel shows: none (dark blue) to full (red).
    const doc = this.session.doc!, wb = this.session.weightBone;
    const weightBone = view.binds && wb !== null ? (doc.bones ?? []).findIndex((b) => b.name === wb) : -1;
    for (let i = 0; i < sp.length / 2; i++) {
      const [x, y] = at(i), r = i === chosen ? 4.5 : 3;
      g.fillStyle = weightBone >= 0 ? heat(weightOf(view, i, weightBone)) : i === chosen ? accent : view.locked ? muted : "#ffffff";
      g.strokeStyle = accent;
      g.beginPath(); g.rect(x - r, y - r, r * 2, r * 2); g.fill(); g.stroke();
    }
    // The weight brush's circle where the pointer is (E6 step 4f).
    if (brush.on && this.brushAt) {
      g.strokeStyle = accent;
      g.lineWidth = 1.5;
      g.setLineDash(this.brushBlocked(view) ? [3, 3] : []);
      g.beginPath(); g.arc(this.brushAt[0], this.brushAt[1], brush.radius, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
    g.restore();
  }

  /** Why the weight brush cannot paint `view` now, or null when it can. */
  private brushBlocked(view: MeshView): string | null {
    if (!view.binds) return "Bind the mesh to bones first (Properties ▸ Bind); then its weights can be painted.";
    if (view.animated) return "Weights are the setup pose's: choose Setup pose in the timeline to paint them.";
    if (this.session.weightBone === null) return "Choose the bone to paint in Properties ▸ Show weights.";
    return null;
  }

  /** A press with the weight brush on (E6 step 4f): a stroke begins, one undo step until let go. */
  private brushDown(view: MeshView, sx: number, sy: number, takeAway: boolean): boolean {
    if (!brush.on) return false;
    const why = this.brushBlocked(view);
    if (why) { this.onStatus(why); return true; }
    this.session.history!.begin(`${takeAway ? "Take" : "Paint"} ${this.session.weightBone}'s weights on ${view.ref.key}`);
    this.stroke = { takeAway };
    this.brushStep([sx, sy]);
    return true;
  }

  /** One step of the stroke at screen point `at`: the vertices under the brush, re-weighted. */
  private brushStep(at: readonly [number, number]): void {
    const view = this.meshMode(), bone = this.session.weightBone, doc = this.session.doc;
    if (!view || bone === null || !doc || !this.stroke) return;
    const index = (doc.bones ?? []).findIndex((b) => b.name === bone), sp = this.screenOf(view);
    const changes = brushWeights(sp.length / 2, (v) => [sp[v * 2]!, sp[v * 2 + 1]!], (v) => weightOf(view, v, index), at, brush, this.stroke.takeAway);
    if (!changes.size) return;
    try {
      this.session.history!.apply("step", setWeights(view.ref, bone, changes, this.session.setupBones()!));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
    this.session.changed();
  }

  /** Delete the selected mesh vertex (Delete on the stage); false when none is selected. */
  deleteVertex(): boolean {
    const view = this.meshMode(), h = this.session.history;
    const i = view ? this.selectedVertex(view) : -1;
    if (!view || i < 0 || !h) return false;
    if (view.animated) { this.onStatus("Vertices are added and deleted on the setup pose."); return true; }
    try {
      if (h.apply(`Delete vertex ${i} of ${view.ref.key}`, deleteVertex(view.ref, i, this.session.setupBones() ?? undefined))) this.session.vertex = null;
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
    this.session.changed();
    return true;
  }

  /**
   * A press in mesh mode: on a vertex selects and drags it; on the outline adds a vertex there,
   * inside adds one, and drags the new one. False when the press is not on the mesh.
   */
  private meshDown(view: MeshView, sx: number, sy: number): boolean {
    const hit = hitMesh(this.screenOf(view), view.triangles, view.hull, sx, sy);
    if (!hit) return false;
    const h = this.session.history!, bones = this.session.setupBones() ?? undefined;
    if (hit.kind === "vertex") { this.session.vertex = hit.index; this.session.changed(); }
    if (view.locked) { this.onStatus(view.locked); return true; }
    if (view.animated) {
      // Animate mode keys deforms; the vertices themselves are the setup pose's.
      // Off a vertex the press is the bones' (keying bones is what Animate mode is mostly for).
      if (hit.kind !== "vertex") return false;
      this.session.pause();
      h.begin(`Key deform of ${view.ref.key} at frame ${this.session.frame}`);
      this.vertexDrag = { view, index: hit.index, time: this.session.keyTime, animation: this.session.animation!.name };
      return true;
    }
    const n = view.world.length / 2;
    h.begin(hit.kind === "vertex" ? `Move vertex ${hit.index} of ${view.ref.key}` : `Add a vertex to ${view.ref.key}`);
    try {
      if (hit.kind === "edge") {
        h.apply("step", addHullVertex(view.ref, hit.after, hit.t, bones));
        this.session.vertex = hit.after + 1;
      } else if (hit.kind === "inside") {
        const [x, y] = toBone(view, toWorld(this.camera, this.size, sx, sy));
        h.apply("step", addVertex(view.ref, x, y, bones));
        this.session.vertex = n;
      }
    } catch (err) {
      h.cancel();
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return true;
    }
    this.vertexDrag = { view, index: this.session.vertex! };
    this.session.changed();
    return true;
  }

  /** One step of a vertex drag: Alt stretches the image, otherwise it stays put. */
  private vertexTo(at: Point, stretch: boolean): void {
    at = this.snapAt(at, this.snapTargets(new Set()));
    const d = this.vertexDrag!, [x, y] = toBone(d.view, at);
    try {
      const anim = d.view.animated;
      if (anim && d.animation !== undefined && d.time !== undefined) {
        // From the deform as it was when the drag began, the vertex where the pointer is now.
        const a = findAttachment(this.session.doc!, d.view.ref)!;
        const offsets = deformWithVertexAt(a, anim.deform, anim.bones, anim.slotBone, d.index, at[0], at[1]);
        this.session.history!.apply("step", keyDeform(d.animation, d.view.ref, d.time, offsets));
        this.session.changed();
        return;
      }
      this.session.history!.apply("step", moveVertex(d.view.ref, d.index, x, y, !stretch, this.session.setupBones() ?? undefined));
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
    this.session.changed();
  }

  /** What a dragged point may snap to: the joints and tips of the bones not in `moving`, and the guides. */
  private snapTargets(moving: ReadonlySet<string>): SnapTargets {
    const p = this.session.pose(), points: [number, number][] = [];
    if (p) {
      for (const b of p.rig.data.bones) {
        if (!p.rig.active[b.index] || moving.has(b.name)) continue;
        const m = boneMatrix(p, b.index);
        points.push([m[4], m[5]]);
        if (b.length > 0) points.push(boneTip(p, b.index));
      }
    }
    return { points, guides: this.session.sidecar.guides };
  }

  /** `at` snapped (when snapping is on), what it snapped to kept for drawing. */
  private snapAt(at: Point, targets: SnapTargets): Point {
    if (!this.snap) { this.snapped = null; return at; }
    this.snapped = snapPoint(at, targets, this.snap, this.camera.zoom);
    return this.snapped.point as Point;
  }

  /** Every active bone, origin to tip, in screen pixels, in the skeleton's order. */
  /** The names of the bones IK constraints drive (their chains; the targets are not among them). */
  private ikDrivenBones(): Set<string> {
    const names = new Set<string>();
    for (const c of this.session.doc?.constraints ?? []) {
      if (c.type === "ik") for (const n of c.bones ?? []) names.add(n);
    }
    return names;
  }

  private screenBones(): ScreenBone[] {
    const p = this.session.pose();
    if (!p) return [];
    const out: ScreenBone[] = [];
    const driven = this.hideIkBones && this.session.animation ? this.ikDrivenBones() : null;
    for (const b of p.rig.data.bones) {
      if (!p.rig.active[b.index]) continue;
      if (driven?.has(b.name)) continue;
      const m = boneMatrix(p, b.index), tip = boneTip(p, b.index);
      const [x0, y0] = toScreen(this.camera, this.size, m[4], m[5]);
      const [x1, y1] = toScreen(this.camera, this.size, tip[0], tip[1]);
      // A bone the pose leaves without one is neither drawn nor picked; the notes say so (E8-PLAN step 2).
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      out.push({ name: b.name, x0, y0, x1, y1 });
    }
    return out;
  }

  /** A ring on the origin of each pinned bone. */
  private drawPins(g: CanvasRenderingContext2D): void {
    g.save();
    g.strokeStyle = "#f5a623";
    g.lineWidth = 2;
    for (const b of this.screenBones()) {
      if (!this.session.pinned.has(b.name)) continue;
      g.beginPath(); g.arc(b.x0, b.y0, 9, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(b.x0, b.y0 - 9); g.lineTo(b.x0, b.y0 - 16); g.stroke();
    }
    g.restore();
  }

  /** Each bone's name at its middle, above the bone (Names ▸ Bones). */
  private drawBoneNames(g: CanvasRenderingContext2D, colour: string): void {
    g.save();
    g.font = `11px "Inter", sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.fillStyle = colour;
    g.lineWidth = 3;
    g.strokeStyle = "rgb(0 0 0 / 0.55)";
    g.lineJoin = "round";
    for (const b of this.screenBones()) {
      const x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2 - 6;
      g.strokeText(b.name, x, y);
      g.fillText(b.name, x, y);
    }
    g.restore();
  }

  private selectedIndex(): number {
    const p = this.session.pose(), s = this.session.selectedBone;
    return p && s !== null ? p.bones.get(s) ?? -1 : -1;
  }

  /** The move, scale and shear gizmo's two arrows on screen: direction, length, letter, colour. Scale and Shear in the Parent space work along the bone's own axes, so they show those. */
  private gizmoArrows(p: Posed, bone: number): { angle: number; len: number; name: "x" | "y"; colour: string }[] {
    const m = boneMatrix(p, bone), shown: Space = this.tool === "move" || this.space !== "parent" ? this.space : "local";
    const [u, v] = spaceAxes(shown, m, parentMatrix(p, bone));
    return [
      { angle: Math.atan2(-u[1], u[0]), len: GRAB - 12, name: "x", colour: AXIS_X },
      { angle: Math.atan2(-v[1], v[0]), len: GRAB - 24, name: "y", colour: AXIS_Y },
    ];
  }

  private drawGizmo(g: CanvasRenderingContext2D, bone: number, color: string): void {
    const p = this.session.pose()!;
    const m = boneMatrix(p, bone);
    const [ox, oy] = toScreen(this.camera, this.size, m[4], m[5]);
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.5;
    if (this.tool === "rotate") {
      g.beginPath(); g.arc(ox, oy, GRAB - 8, 0, Math.PI * 2); g.stroke();
      // A radius to the ring along the bone's own direction, so the angle can be seen, with its value (the Rotation field's) above its middle, in white.
      const r = GRAB - 8, angle = Math.atan2(-m[1], m[0]), ex = ox + Math.cos(angle) * r, ey = oy + Math.sin(angle) * r;
      g.beginPath(); g.moveTo(ox, oy); g.lineTo(ex, ey); g.stroke();
      g.beginPath(); g.arc(ex, ey, 4, 0, Math.PI * 2); g.fill();
      g.font = `10px "JetBrains Mono", monospace`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#ffffff";
      g.fillText(String(Math.round(animatedLocal(p, bone).rotation * 10) / 10), (ox + ex) / 2, (oy + ey) / 2 - 10);
    } else {
      // The two arrows, in Godot's colours (x red, y green), no letters; a press on one drags along it only.
      for (const { angle, len, colour } of this.gizmoArrows(p, bone)) {
        const ex = ox + Math.cos(angle) * len, ey = oy + Math.sin(angle) * len;
        g.strokeStyle = colour;
        g.fillStyle = colour;
        g.lineWidth = 2;
        g.lineCap = "round";
        g.beginPath(); g.moveTo(ox, oy); g.lineTo(ex, ey); g.stroke();
        if (this.tool === "scale") g.fillRect(ex - 4, ey - 4, 8, 8);
        else if (this.tool === "shear") { g.beginPath(); g.moveTo(ex, ey - 5); g.lineTo(ex + 5, ey); g.lineTo(ex, ey + 5); g.lineTo(ex - 5, ey); g.closePath(); g.fill(); }
        else arrowHead(g, ex, ey, angle);
      }
      g.fillStyle = color;
    }
    // The arrows meet at the origin without a dot over the join; the rotate ring keeps its centre dot.
    if (this.tool === "rotate") { g.beginPath(); g.arc(ox, oy, 3, 0, Math.PI * 2); g.fill(); }
    g.restore();
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    return localPoint(this.overlay, e);
  }

  /** A press with a Create tool: the bone under it (else the selected one, else the root) is what the new thing hangs on. */
  private createDown(sx: number, sy: number): void {
    const doc = this.session.doc;
    if (!doc) return;
    const picked = pickBone(this.screenBones(), sx, sy, 8, this.session.selectedBone);
    const target = picked ?? this.session.selectedBone ?? doc.bones?.[0]?.name ?? null;
    this.createDrag = { from: toWorld(this.camera, this.size, sx, sy), to: null, target, screen: [sx, sy] };
  }

  /** Let go with a Create tool: a click makes the default of its kind, a drag sizes it. */
  private createUp(): void {
    const d = this.createDrag, kind = this.createKind;
    this.createDrag = null;
    if (!d || !kind) return;
    let message: string;
    if (kind === "bone") message = createBone(this.session, d.target, d.from, d.to);
    else if (d.target === null) message = "Add a bone first: shapes hang on one.";
    else if (kind === "path") message = createPath(this.session, { bone: d.target }, d.from);
    else message = createShape(this.session, kind, d.target, d.from, d.to);
    this.onStatus(message);
    this.redraw();
  }

  /** The rubber band while a Create press is held: a bone's line, a box's rectangle. */
  private drawCreatePreview(g: CanvasRenderingContext2D, colour: string): void {
    const d = this.createDrag;
    if (!d?.to || !this.createKind) return;
    const [x0, y0] = toScreen(this.camera, this.size, d.from[0], d.from[1]), [x1, y1] = toScreen(this.camera, this.size, d.to[0], d.to[1]);
    g.save();
    g.strokeStyle = colour;
    g.fillStyle = colour;
    g.lineWidth = 1.5;
    if (this.createKind === "boundingbox" || this.createKind === "clipping") {
      g.setLineDash([5, 4]);
      g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else {
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.beginPath(); g.arc(x0, y0, 4, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }

  private down(e: PointerEvent): void {
    this.overlay.focus();
    const [sx, sy] = this.local(e);
    this.rightDown = e.button === 2 ? { x: e.clientX, y: e.clientY } : null;
    this.overlay.setPointerCapture(e.pointerId);
    this.emptyPress = false;
    if (e.button === 1 || e.button === 2 || !this.session.history) {
      this.panning = { x: sx, y: sy };
      return;
    }
    if (this.show.rulers && rulerAt(sx, sy) && this.guideDown(sx, sy)) return;
    if (this.createKind) { this.createDown(sx, sy); return; }
    const path = this.pathMode();
    if (path && this.pathDown(path, sx, sy)) return;
    const mesh = this.meshMode();
    if (mesh && this.brushDown(mesh, sx, sy, e.altKey)) return;
    if (mesh && this.meshDown(mesh, sx, sy)) return;
    const screenBones = this.screenBones();
    const pickable = this.select.bones ? screenBones : screenBones.filter((b) => b.name === this.session.selectedBone);
    let name = pickBone(pickable, sx, sy, 6, this.session.selectedBone);
    // With the selection locked only the selected bone can be pressed: another bone is an empty press (it pans).
    if (name !== null && this.session.selectionLocked && name !== this.session.selectedBone) name = null;
    // A drawn constraint (E4 step 12) comes before a bone picked only by its segment: path bones
    // lie along their curve. The selected bone and a bone's origin (an IK target) keep the press.
    if (name !== null && name !== this.session.selectedBone) {
      const b = screenBones.find((x) => x.name === name)!;
      if (Math.hypot(sx - b.x0, sy - b.y0) > 6 && this.constraintDown(sx, sy)) return;
    }
    // A press on one of the gizmo's arrows drags along that axis only.
    let armed: 0 | 1 | null = null;
    if (this.tool !== "rotate" && this.selectedIndex() >= 0 && this.session.selectedBone !== null) {
      const sel = this.selectedIndex(), pose = this.session.pose()!, m = boneMatrix(pose, sel);
      const [ox, oy] = toScreen(this.camera, this.size, m[4], m[5]);
      this.gizmoArrows(pose, sel).forEach((a, k) => {
        const ex = ox + Math.cos(a.angle) * (a.len + 8), ey = oy + Math.sin(a.angle) * (a.len + 8);
        if (armed === null && Math.hypot(sx - ox, sy - oy) > 10 && distToSegment(sx, sy, ox, oy, ex, ey) <= 8) { armed = k as 0 | 1; name = this.session.selectedBone; }
      });
    }
    if (name === null) {
      const sel = this.selectedIndex();
      if (sel >= 0) {
        const m = boneMatrix(this.session.pose()!, sel);
        const [ox, oy] = toScreen(this.camera, this.size, m[4], m[5]);
        if (Math.hypot(sx - ox, sy - oy) <= GRAB) name = this.session.selectedBone;
      }
    }
    if (name === null) {
      if (this.constraintDown(sx, sy)) return;
      // A corner of the chosen reference may lie on a guide: the reference comes first.
      if (this.referenceDown(sx, sy)) return;
      if (this.guideDown(sx, sy)) return;
      // An image under the press picks its slot (Select ▸ Images); the press still pans, as on empty ground.
      const slot = this.select.images ? this.imageAt(sx, sy) : null;
      if (slot !== null) {
        this.session.selectReference(null);
        this.session.select({ kind: "slot", name: slot });
        this.onPick();
        this.panning = { x: sx, y: sy };
        return;
      }
      this.emptyPress = true;
      this.session.selectReference(null);
      this.session.select(null);
      this.panning = { x: sx, y: sy };
      return;
    }
    this.session.selectBone(name);
    this.onPick();
    this.session.pause();
    if (this.dragLocked()) return;
    const p = this.session.pose()!, index = p.bones.get(name)!;
    const b = this.session.doc!.bones!.find((x) => x.name === name)!;
    const at = toWorld(this.camera, this.size, sx, sy), parent = parentMatrix(p, index);
    const anim = this.session.animation?.name ?? null, unkeyed = anim !== null && (!this.autoKey || this.forceUnkeyed());
    // Animate mode starts from the pose at the playhead; setup mode from the setup values.
    const from = anim !== null ? animatedLocal(p, index) : {
      x: boneNumber(b, "x"), y: boneNumber(b, "y"), rotation: boneNumber(b, "rotation"),
      scaleX: boneNumber(b, "scaleX"), scaleY: boneNumber(b, "scaleY"),
      shearX: boneNumber(b, "shearX"), shearY: boneNumber(b, "shearY"),
    };
    this.drag = {
      bone: name, tool: this.tool, start: at, last: at, turned: 0, ...from,
      matrix: boneMatrix(p, index), parent,
      sign: turnSign(parent, boneInherit(b), p.rig.scaleX * p.rig.scaleY < 0),
      inherit: boneInherit(b),
      written: { x: b.x, y: b.y, rotation: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY, shearX: b.shearX, shearY: b.shearY },
      key: anim !== null && !unkeyed ? { animation: anim, time: this.session.keyTime } : null,
      unkeyed,
      // The bone and the bones under it move together: they are not targets.
      targets: this.tool === "move" ? this.snapTargets(new Set(subtree(this.session.doc!, name))) : { points: [], guides: [] },
      // Pressed on an arrow in the Parent space, Scale and Shear work along the bone's own axes, as the arrows show.
      space: armed !== null && this.tool !== "move" && this.space === "parent" ? "local" : this.space,
      lock: armed,
    };
    if (unkeyed) { this.onStatus(`Unkeyed pose of ${name}: press Key (${keysOf("key")}) to key it; moving the playhead drops it.`); return; }
    this.session.history!.begin(anim !== null
      ? `Key ${KEYED[this.tool]} of ${name} at frame ${this.session.frame}`
      : `${LABEL[this.tool]} bone ${name}`);
  }

  private move(e: PointerEvent): void {
    const [sx, sy] = this.local(e);
    this.pointer = toWorld(this.camera, this.size, sx, sy);
    if (brush.on) { this.brushAt = [sx, sy]; if (!this.stroke) this.redraw(); }
    if (this.createDrag) {
      const d = this.createDrag;
      if (d.to || Math.hypot(sx - d.screen[0], sy - d.screen[1]) >= CLICK_PX) d.to = this.pointer;
      this.redraw();
      return;
    }
    if (this.stroke) { this.brushStep([sx, sy]); this.onPointer(`${this.pointer[0].toFixed(1)}, ${this.pointer[1].toFixed(1)}`); return; }
    if (this.panning) {
      this.camera = pan(this.camera, sx - this.panning.x, sy - this.panning.y);
      this.panning = { x: sx, y: sy };
      this.redraw();
    } else if (this.drag) {
      this.dragTo(this.pointer, e.shiftKey);
    } else if (this.pathDrag) {
      this.pathTo(this.pointer);
    } else if (this.vertexDrag) {
      this.vertexTo(this.pointer, e.altKey);
    } else if (this.guideDrag) {
      this.guideTo(sx, sy);
    } else if (this.refDrag) {
      this.referenceTo(this.pointer);
    }
    this.onPointer(`${this.pointer[0].toFixed(1)}, ${this.pointer[1].toFixed(1)}`);
  }

  /** One step of the drag: the bone's new local values, measured from where the drag began. */
  private dragTo(at: Point, shift: boolean): void {
    const d = this.drag!, h = this.session.history!;
    let patch: Dragged;
    if (d.tool === "move") {
      // The origin's new place, snapped; the pointer moved by as much.
      const o: Point = [d.matrix[4] + at[0] - d.start[0], d.matrix[5] + at[1] - d.start[1]], to = this.snapAt(o, d.targets);
      at = [at[0] + to[0] - o[0], at[1] + to[1] - o[1]];
      if (d.space !== "parent" || d.lock !== null) {
        const held = lockToAxis([at[0] - d.start[0], at[1] - d.start[1]], spaceAxes(d.space, d.matrix, d.parent), d.lock, 4 / this.camera.zoom);
        d.lock = held.lock;
        at = [d.start[0] + held.delta[0], d.start[1] + held.delta[1]];
      }
      const [dx, dy] = moveDelta(d.parent, at[0] - d.start[0], at[1] - d.start[1]);
      patch = { x: tidy(d.x + dx, 2), y: tidy(d.y + dy, 2) };
    } else if (d.tool === "rotate") {
      // Summed step by step, so a drag round the bone more than half a turn keeps going.
      d.turned += turn([d.matrix[4], d.matrix[5]], d.last, at);
      d.last = at;
      const rough = d.rotation + d.turned * d.sign;
      let r = d.inherit === "normal"
        ? localRotation(d.parent, (Math.atan2(d.matrix[2], d.matrix[0]) * 180) / Math.PI + d.turned, d.shearX, d.scaleX, rough)
        : rough;
      if (shift) r = Math.round(r / 15) * 15;
      patch = { rotation: tidy(r, 2) };
    } else if (d.tool === "shear") {
      let lx: number, ly: number;
      if (d.space === "parent") [lx, ly] = shearDelta((Math.atan2(d.matrix[2], d.matrix[0]) * 180) / Math.PI, at[0] - d.start[0], at[1] - d.start[1], shift);
      else {
        const held = shearAlong(d.space, d.matrix, d.parent, d.start, at, d.lock, 4 / this.camera.zoom);
        [lx, ly] = held.delta;
        d.lock = held.lock;
      }
      patch = { shearX: tidy(d.shearX + lx, 2), shearY: tidy(d.shearY + ly, 2) };
    } else {
      let fx: number, fy: number;
      if (d.space === "parent" || shift) [fx, fy] = scaleFactors(d.matrix, d.start, at, shift, MIN_SCALE_START / this.camera.zoom);
      else {
        const held = scaleAlong(d.space, d.matrix, d.parent, d.start, at, d.lock, 4 / this.camera.zoom, MIN_SCALE_START / this.camera.zoom);
        [fx, fy] = held.factors;
        d.lock = held.lock;
      }
      patch = { scaleX: tidy(d.scaleX * fx, 3), scaleY: tidy(d.scaleY * fy, 3) };
    }
    try {
      if (d.unkeyed) {
        this.session.setUnkeyed(d.bone, { x: d.x, y: d.y, rotation: d.rotation, scaleX: d.scaleX, scaleY: d.scaleY, shearX: d.shearX, shearY: d.shearY, ...patch } as LocalPose);
      } else if (d.key) {
        const local = { x: d.x, y: d.y, rotation: d.rotation, scaleX: d.scaleX, scaleY: d.scaleY, shearX: d.shearX, shearY: d.shearY, ...patch };
        h.apply("step", keyBone(d.key.animation, d.bone, [KEYED[d.tool]], local as LocalPose, d.key.time));
      } else {
        patch = asWritten(patch, { x: d.x, y: d.y, rotation: d.rotation, scaleX: d.scaleX, scaleY: d.scaleY, shearX: d.shearX, shearY: d.shearY }, d.written);
        h.apply("step", compensated(this.session, d.bone, updateBone(d.bone, patch)));
      }
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
    }
    this.session.changed();
  }

  private up(e: PointerEvent): void {
    if (this.overlay.hasPointerCapture(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId);
    if (this.createDrag) { this.createUp(); return; }
    const right = this.rightDown;
    this.rightDown = null;
    if (e.button === 2 && right && Math.hypot(e.clientX - right.x, e.clientY - right.y) < 4) {
      const [sx, sy] = this.local(e);
      this.onContextMenu([e.clientX, e.clientY], toWorld(this.camera, this.size, sx, sy), pickBone(this.screenBones(), sx, sy));
    }
    this.panning = null;
    this.refDrag = null;
    const gd = this.guideDrag;
    if (gd) {
      this.guideDrag = null;
      // Let go over its ruler: the guide is removed.
      if (gd.overRuler) this.session.setSidecar(removeGuide(this.session.sidecar, gd.index));
      this.redraw();
    }
    if (this.stroke) { this.stroke = null; this.session.history?.end(); this.session.changed(); }
    if (this.drag || this.vertexDrag || this.pathDrag) {
      this.snapped = null;
      const unkeyed = this.drag?.unkeyed ?? false;
      this.drag = null;
      this.vertexDrag = null;
      this.pathDrag = null;
      if (!unkeyed) this.session.history?.end();
      this.session.changed();
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const [sx, sy] = this.local(e);
    // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse wheels as larger steps.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    this.camera = zoomAt(this.camera, this.size, sx, sy, factor);
    this.redraw();
    this.onPointer(`${Math.round(this.camera.zoom * 100)}%`);
  }
}

function drawBone(g: CanvasRenderingContext2D, b: ScreenBone, color: string, selected: boolean, halfWidth: number, joint: number): void {
  const dx = b.x1 - b.x0, dy = b.y1 - b.y0, len = Math.hypot(dx, dy);
  g.save();
  g.fillStyle = color;
  g.strokeStyle = color;
  g.globalAlpha = selected ? 0.95 : 0.7;
  if (len < 4) {
    g.beginPath(); g.arc(b.x0, b.y0, joint * 1.6, 0, Math.PI * 2); g.stroke();
  } else {
    // A thin kite: widest a fifth of the way along.
    const w = Math.min(halfWidth, len * 0.18), ux = dx / len, uy = dy / len;
    const mx = b.x0 + dx * 0.2, my = b.y0 + dy * 0.2;
    g.beginPath();
    g.moveTo(b.x0, b.y0);
    g.lineTo(mx - uy * w, my + ux * w);
    g.lineTo(b.x1, b.y1);
    g.lineTo(mx + uy * w, my - ux * w);
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;
  g.beginPath(); g.arc(b.x0, b.y0, joint, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** A weight as a colour: 0 dark blue, through green and yellow, to 1 red. */
function heat(w: number): string {
  const t = Math.max(0, Math.min(1, w));
  const hue = 240 * (1 - t);
  return `hsl(${hue}, 90%, ${t === 0 ? 30 : 50}%)`;
}

function inTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function arrowHead(g: CanvasRenderingContext2D, x: number, y: number, angle: number): void {
  g.beginPath();
  g.moveTo(x + Math.cos(angle) * 6, y + Math.sin(angle) * 6);
  g.lineTo(x + Math.cos(angle + 2.5) * 6, y + Math.sin(angle + 2.5) * 6);
  g.lineTo(x + Math.cos(angle - 2.5) * 6, y + Math.sin(angle - 2.5) * 6);
  g.closePath();
  g.fill();
}

/** A CSS colour (`#rrggbb`) as 0..1 channels; mid grey when unreadable. */
function rgb(css: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
