import { cls, h, on, raf } from "@/view/widgets/dom";
import { livePhysics } from "@/core/boneburst/boneburstPose";
import { Camera } from "./Camera";
import { contentMatrixOf, SceneRenderer } from "./SceneRenderer";
import { type Guide, Overlay, RULER } from "./Overlay";
import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import { entryBox, type FrameContext, type Pose, type PoseEntry } from "@/core/doc/pose";
import { editedMesh } from "@/core/mesh/meshPlan";
import { stageSkinOf } from "@/core/doc/skins";
import { posedSymbol, boneburstBounds } from "@/core/boneburst/boneburstPose";
import type { NodeId } from "@/core/doc/ids";
import { mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { polygonContains, type Rect, rectContains, transformCorners } from "@/core/math/geom";
import { isSymbol, type MeshData, type Node as DocNode } from "@/core/doc/types";
import { meshView, verticesOf } from "@/view/tools/MeshTool";
import type { MeshDraw } from "./Overlay";
import { ToolManager } from "@/view/tools/ToolManager";
import type { ToolContext } from "@/view/tools/Tool";
import { buildGizmo, type Gizmo, type PoseAt, selectionBounds } from "@/view/tools/gizmo";
import { onionFrames } from "@/core/doc/onion";
import { keyIndexAt } from "@/core/doc/timeline";
import { GhostPainter } from "./ghost";
import { PathCache } from "./pathCache";
import { pathBoneIds, pathFrames } from "@/core/doc/bonePath";
import { pathScene } from "./pathScene";
import { pathDragAnchor } from "@/view/tools/pathDrag";
import { seamFrame } from "@/core/doc/cycle";
import type { BonePathsDraw } from "./Overlay";
import { drawReference } from "./reference";
import { type OverlayColors, resolveColors } from "./overlayColors";
import { promptNumber } from "@/view/widgets/promptNumber";
import { menuAnchor, showMenu } from "@/view/widgets/Dock";
import { pickNode } from "@/core/doc/pick";
import { SnapController } from "./SnapController";

/**
 * The stage: two stacked canvases (artwork, then chrome), a camera, and all
 * the navigation input. Tools plug in later; this owns the parts every tool
 * needs — coordinate conversion, hit testing, and the redraw loop.
 */
export class Viewport {
  readonly camera = new Camera();
  private sceneCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private sceneCtx: CanvasRenderingContext2D;
  private overlayCtx: CanvasRenderingContext2D;
  private renderer: SceneRenderer;
  private overlay = new Overlay();

  private dpr = 1;
  private lastPose: Pose | null = null;
  /** The other frames drawn under Edit Multiple Frames, with their poses. */
  private ghostPoses: Array<{ frame: number; pose: Pose }> = [];
  private ghosts = new GhostPainter();
  private pathCache = new PathCache();
  private lastBonePaths: BonePathsDraw | null = null;
  /** Where a tool's status messages go; the app points it at its toast. */
  onNotify: ((message: string) => void) | null = null;

  guides: Guide[] = [];
  private draftGuide: Guide | null = null;
  private marquee: Rect | null = null;
  private spaceDown = false;
  private tools = new ToolManager();

  /** Delete the Mesh tool's picked points; false when it is not editing any. */
  deleteMeshPoints(): boolean {
    return this.store.ui.tool === "mesh" && this.tools.mesh.deletePicked(this.toolCtx);
  }

  /** What the overlay draws of the mesh the Mesh tool edits. */
  private meshToDraw(): MeshDraw | null {
    if (this.store.ui.tool !== "mesh") return null;
    const box = this.store.selectedNodes.find((n) => n.box || n.path);
    const boxEntry = box ? this.lastPose?.byNode.get(box.id) : undefined;
    if (box && boxEntry) {
      const vertices = verticesOf(boxEntry);
      const path = !!box.path;
      return { vertices, triangles: [], hull: path ? 0 : vertices.length / 2, picked: meshView.node === box.id ? meshView.picked : new Set(), tint: null, ...(path ? { handles: true } : {}) };
    }
    // The mesh the stage shows on a selected node, a skin's included (`editedMesh`).
    const sym = this.store.currentSymbol;
    let found: { node: DocNode; entry: PoseEntry; mesh: MeshData } | null = null;
    for (const node of this.store.selectedNodes) {
      const entry = this.lastPose?.byNode.get(node.id);
      const mesh = entry?.spine ? editedMesh(sym, node, entry.displayIndex, stageSkinOf(sym))?.mesh : undefined;
      if (entry && mesh) { found = { node, entry, mesh }; break; }
    }
    if (!found) return null;
    const { node, entry, mesh } = found;
    const paint = this.store.ui.meshPaint;
    const tint = paint.on && paint.bone
      ? mesh.points.filter((_, i) => i % 2 === 0).map((_, i) => mesh.weights?.[i]?.find(([b]) => b === paint.bone)?.[1] ?? (paint.bone === node.id && !mesh.weights ? 1 : 0))
      : null;
    return { vertices: entry.spine!.vertices, triangles: mesh.triangles, hull: mesh.hull, picked: meshView.node === node.id ? meshView.picked : new Set(), tint };
  }
  private toolCtx: ToolContext;
  private lastGizmo: Gizmo | null = null;
  private draftBone: { ax: number; ay: number; bx: number; by: number } | null = null;
  /** Live coordinate readout while a guide is being placed or moved. */
  private guideTip: HTMLElement | null = null;
  private readonly snap: SnapController;
  private colors: OverlayColors;

  readonly invalidate: () => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: Store,
    private readonly assets: AssetStore,
  ) {
    this.renderer = new SceneRenderer(() => this.store.project, assets);
    this.snap = new SnapController({
      store, camera: this.camera,
      pose: () => this.lastPose,
      guides: () => this.guides,
      frameContext: () => this.frameContext,
      bonePath: (id) => this.lastBonePaths?.paths.find((p) => p.id === id)?.points,
    });
    this.colors = resolveColors(store.prefs.value);
    store.prefs.subscribe((p) => {
      this.colors = resolveColors(p);
      this.invalidate();
    });
    this.toolCtx = {
      store,
      assets,
      camera: this.camera,
      pose: () => this.lastPose,
      gizmo: () => this.lastGizmo,
      toWorld: (e) => this.toWorld(e),
      toContent: (e) => this.toContent(e),
      toScreen: (p) => this.camera.toScreen(p.x, p.y),
      hitTest: (wx, wy, exclude) => this.hitTest(wx, wy, assets, exclude),
      nodesInRect: (r, exclude) => this.nodesInRect(r, exclude),
      invalidate: () => this.invalidate(),
      setMarquee: (r) => { this.marquee = r; },
      setDraftBone: (segment) => { this.draftBone = segment; },
      beginSnap: (moving) => this.snap.begin(moving),
      snapDelta: (dx, dy, free) => this.snap.delta(dx, dy, free),
      endSnap: () => this.snap.end(),
      snapDot: (world, boneId, frame, free) => this.snap.snapDot(world, boneId as NodeId, frame, free),
      setCursor: (c) => { if (!this.spaceDown) this.host.style.cursor = c; },
      bonePaths: () => this.lastBonePaths?.paths ?? [],
      pathHandles: () => this.lastBonePaths?.handles ?? [],
      notify: (message) => this.onNotify?.(message),
    };

    this.sceneCanvas = h("canvas");
    this.overlayCanvas = h("canvas");
    host.appendChild(this.sceneCanvas);
    host.appendChild(this.overlayCanvas);

    this.sceneCtx = this.sceneCanvas.getContext("2d")!;
    this.overlayCtx = this.overlayCanvas.getContext("2d")!;

    this.invalidate = raf(() => this.render());

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.camera.centerOn(this.store.project.stage.width / 2, this.store.project.stage.height / 2);

    // Edit-in-place: keep the symbol's contents where they were on screen.
    // Descending into an instance only changes which space the camera is
    // looking through: the artwork keeps the exact position, size and
    // deformation it had, so there is no pan to compensate with.
    store.onEditContextChange = (base) => {
      this.camera.setBase(base);
      this.invalidate();
    };
    this.camera.setBase(store.editBase);

    this.wireInput();
    this.store.subscribe((topic) => {
      if (topic === "tool") this.tools.setActive(this.store.ui.tool, this.toolCtx);
      if (topic === "doc" || topic === "stage" || topic === "frame" ||
          topic === "selection" || topic === "ui" || topic === "library" || topic === "tool") {
        this.syncZoomFromStore();
        this.invalidate();
      }
    });
    this.invalidate();
  }

  // ── Sizing ─────────────────────────────────────────────────────────────

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [this.sceneCanvas, this.overlayCanvas]) {
      c.width = Math.max(1, Math.round(r.width * this.dpr));
      c.height = Math.max(1, Math.round(r.height * this.dpr));
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
    }
    const gutter = this.store.ui.showRulers ? RULER : 0;
    this.camera.width = Math.max(1, r.width - gutter);
    this.camera.height = Math.max(1, r.height - gutter);
    if (this.fitPending) this.fitToStage();
    this.invalidate();
  }

  private syncZoomFromStore(): void {
    if (Math.abs(this.camera.zoom - this.store.ui.zoom) > 1e-9) {
      this.camera.setZoom(this.store.ui.zoom);
    }
    const gutter = this.store.ui.showRulers ? RULER : 0;
    const r = this.host.getBoundingClientRect();
    this.camera.width = Math.max(1, r.width - gutter);
    this.camera.height = Math.max(1, r.height - gutter);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private render(): void {
    const { camera, store } = this;
    const gutter = store.ui.showRulers ? RULER : 0;
    const project = store.project;

    // Scene layer: pasteboard, stage, artwork.
    const sc = this.sceneCtx;
    sc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    sc.clearRect(0, 0, this.sceneCanvas.width, this.sceneCanvas.height);
    sc.save();
    sc.translate(gutter, gutter);
    sc.beginPath();
    sc.rect(0, 0, camera.width, camera.height);
    sc.clip();

    // The stage belongs to the SCENE, so while editing a symbol in place it
    // is drawn where the scene's origin actually falls, not at the symbol's
    // own (0,0) — which would put a white rectangle in the middle of nowhere
    // and make the contents look displaced.
    if (store.prefs.value.stage.fillStage) {
      const tl = camera.sceneToScreen(0, 0);
      sc.fillStyle = project.stage.background;
      sc.fillRect(tl.x, tl.y, project.stage.width * camera.zoom, project.stage.height * camera.zoom);
    }

    // World -> device pixels. drawEntry uses setTransform, so the DPR scale
    // and the ruler gutter have to be baked in here rather than left on the
    // context (where they would be wiped out).
    const view = mul(
      mat(),
      matOf(this.dpr, 0, 0, this.dpr, gutter * this.dpr, gutter * this.dpr),
      camera.matrix,
    );
    // Ancestors behind the symbol being edited, dimmed, so there is
    // something to align against. The instance we came in through is left
    // out, or it would draw on top of the contents in front of it.
    // Scene space -> device pixels: the camera without the edit base.
    const sceneView = mul(
      mat(),
      matOf(this.dpr, 0, 0, this.dpr, gutter * this.dpr, gutter * this.dpr),
      camera.sceneMatrix,
    );
    for (const ctx of store.editContext) {
      // Only levels entered through an instance on the stage: opening a
      // symbol from the library is meant to be an isolated environment.
      if (!ctx.ghost) continue;
      const ancestor = project.items[ctx.symbolId];
      if (!isSymbol(ancestor)) continue;
      const ancestorView = mul(mat(), sceneView, ctx.matrix);
      // At the pose the user descended out of, in the mode they are in — not
      // the bind pose at frame 0. A ghost drawn in Setup while the stage is in
      // Animate shows every keyed limb somewhere it is not, which is the whole
      // value of the reference gone.
      const anim = ancestor.animations.find((a) => a.id === ctx.animId)
        ?? ancestor.animations[0] ?? null;
      this.renderer.draw(
        sc, ancestor, anim, ctx.frame, store.ui.mode, ancestorView,
        { alpha: 0.3, hiddenLayers: ctx.hideNode ? new Set([ctx.hideNode]) : undefined },
      );
    }

    // Reference art (`Animation.reference`): behind the ghosts and the rig,
    // or over everything, by preference.
    const stagePrefs = store.prefs.value.stage;
    const ref = store.ui.mode === "animate" && stagePrefs.showReference ? store.currentAnimation?.reference : undefined;
    if (ref && !stagePrefs.referenceAbove) drawReference(sc, view, ref, store.ui.frame, this.assets, stagePrefs.referenceOpacity);

    this.ghostPoses = [];
    this.drawOtherFrames(sc, view);

    // The visibility table can hide every image and symbol, leaving the rig.
    const gizmoPrefs = store.prefs.value.gizmos;
    const hiddenArt = gizmoPrefs.showImages ? undefined : new Set(
      Object.values(store.currentSymbol.nodes).filter((n) => n.kind !== "bone").map((n) => n.id as string),
    );
    livePhysics.on = store.ui.playing;
    try {
      this.lastPose = this.renderer.draw(
        sc, store.currentSymbol, store.currentAnimation, store.stageFrame, store.ui.mode, view,
        { hiddenLayers: hiddenArt },
      );
    } finally {
      livePhysics.on = false;
    }
    if (ref && stagePrefs.referenceAbove) drawReference(sc, view, ref, store.ui.frame, this.assets, stagePrefs.referenceOpacity);
    sc.restore();

    // The transform box is rebuilt from the fresh pose every frame, so it
    // can never lag the artwork it is wrapped around.
    this.lastGizmo = this.tools.showsGizmo
      ? buildGizmo(project, this.editPoses(), store.selection.nodes)
      : null;

    // Overlay layer: chrome, guides, selection.
    const oc = this.overlayCtx;
    oc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    oc.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.overlay.draw(oc, camera, project, store.currentSymbol, this.lastPose, {
      bonePaths: (this.lastBonePaths = this.bonePathsToDraw()),
      showRulers: store.ui.showRulers,
      showGrid: store.ui.showGrid,
      showGuides: store.ui.showGuides,
      showBones: store.ui.showBones,
      showIk: gizmoPrefs.showIk,
      names: { bones: gizmoPrefs.nameBones, images: gizmoPrefs.nameImages, ik: gizmoPrefs.nameIk },
      primary: { show: gizmoPrefs.showPrimary, name: gizmoPrefs.namePrimary },
      showGizmos: store.ui.showGizmos,
      setupMode: store.ui.mode === "setup",
      showOrigin: store.prefs.value.stage.showOrigin,
      gridSize: store.prefs.value.stage.gridSize,
      gridSubdivisions: store.prefs.value.stage.gridSubdivisions,
      handleSize: store.prefs.value.gizmos.handleSize,
      colors: this.colors,
      fontSize: store.prefs.value.interface.fontSize,
      snapLines: this.snap.lines,
      selection: new Set(store.selection.nodes),

      when: this.frameContext,
      guides: this.guides,
      draftGuide: this.draftGuide,
      marquee: this.marquee,
      draftBone: this.draftBone,
      mesh: this.meshToDraw(),
      gizmo: this.lastGizmo,
      groupBox: this.ghostPoses.length && store.selection.nodes.length
        ? selectionBounds(project, this.editPoses(), store.selection.nodes) : null,
    });
  }

  /**
   * The bone paths for this draw (docs/CYCLE-PATH-PLAN.md, B4): the selected
   * bones, or every bone, by preference; never on a locked or hidden layer.
   * Over the onion span when the onion skin is on, else the whole animation.
   * Animate mode only, and off with the gizmos.
   */
  private bonePathsToDraw(): BonePathsDraw | null {
    const { store } = this;
    const anim = store.currentAnimation;
    const ui = store.ui;
    if (!anim || !ui.showBonePaths || !ui.showGizmos || ui.mode !== "animate") return null;
    const sym = store.currentSymbol;
    const g = store.prefs.value.gizmos;
    const shown = new Set(sym.layers.filter((l) => l.visible && !l.locked).map((l) => l.nodeId));
    const picked = pathBoneIds(sym.nodes, store.selection.nodes);
    const ids = (g.bonePathBones === "all"
      ? Object.values(sym.nodes).filter((n) => n.kind === "bone").map((n) => n.id)
      : picked).filter((id) => shown.has(id));
    if (!ids.length) return null;
    const { frames, closed } = pathFrames(anim, ui.onionSkin ? store.onionSpan : null);
    const scene = pathScene({
      sym, anim, sample: this.pathCache.sampler(store.project, sym, anim, store.history.revision),
      ids, frames, closed, which: g.bonePathPoint,
      ...(g.bonePathSpace === "parent" ? { relativeAt: pathDragAnchor ?? ui.frame } : {}),
      handlesFor: picked.length === 1 ? picked[0]! : null,
    });
    if (this.pathCache.pending) this.invalidate();
    const t = store.prefs.value.timeline;
    // On a cycle's join the stage shows frame 0, and that is the dot to fill.
    const frame = ui.frame === seamFrame(anim) ? 0 : ui.frame;
    return { ...scene, frame, past: t.onionPastColor, future: t.onionFutureColor, current: t.playhead };
  }

  /**
   * What the stage is currently showing: the playhead and the mode. Boxes and
   * hit tests are measured with it so they land on the artwork the renderer
   * drew, animated nested symbols included.
   */
  get frameContext(): FrameContext {
    return {
      animationName: this.store.currentAnimation?.name ?? null,
      frame: this.store.ui.frame,
      mode: this.store.ui.mode,
    };
  }

  /**
   * The frames around the playhead. Only in Animate — the setup pose has no
   * neighbours — and never while the runtime is driving the stage. Locked
   * layers are left out of both, as in Animate: locking is how a layer is
   * kept out of the onion skin.
   *
   * With Edit Multiple Frames on, every frame between the markers is drawn
   * opaque and its pose kept, because each of those instances is editable:
   * the hit test, the marquee and the transform box all look at them.
   * Otherwise the onion skin draws them faded and colour-coded.
   */
  private drawOtherFrames(sc: CanvasRenderingContext2D, view: Matrix2D): void {
    const { store } = this;
    const anim = store.currentAnimation;
    if (!anim || store.ui.mode !== "animate") return;
    if (!store.ui.onionSkin && !store.ui.editMultipleFrames) return;

    const sym = store.currentSymbol;
    const locked = new Set<string>(sym.layers.filter((l) => l.locked).map((l) => l.nodeId));
    const hiddenLayers = locked.size ? locked : undefined;
    const span = store.onionSpan;
    const frame = store.ui.frame;

    if (store.ui.editMultipleFrames) {
      for (let f = span.start; f <= span.end; f++) {
        if (f === frame) continue;
        const pose = this.renderer.draw(sc, sym, anim, f, "animate", view, { hiddenLayers });
        this.ghostPoses.push({ frame: f, pose });
      }
      return;
    }

    const o = store.prefs.value.timeline;
    const shown = sym.layers.filter((l) => l.visible && !l.locked).map((l) => anim.tracks[l.nodeId]);
    const isKey = o.onionKeyframesOnly
      ? (f: number) => shown.some((t) => !!t && keyIndexAt(t, f) >= 0)
      : undefined;
    for (const g of onionFrames({ frame, span, opacity: o.onionOpacity, falloff: o.onionFalloff, isKey, period: store.onionPeriod })) {
      const tint = o.onionTint ? (g.side === "past" ? o.onionPastColor : o.onionFutureColor) : null;
      this.ghosts.paint(sc, this.dpr, { alpha: g.alpha, tint, outline: o.onionOutline }, (ctx) => {
        this.renderer.draw(ctx, sym, anim, g.frame, "animate", view, { hiddenLayers });
      });
    }
  }

  /**
   * Every pose on stage that can be picked and edited: the playhead's first,
   * then the other frames Edit Multiple Frames drew. The hit test, the
   * marquee and the transform box read the ones the last render drew.
   * `fresh` evaluates them now instead, for a reader that runs between an
   * edit and the next render — the Properties panel syncs on the store event
   * that schedules that render.
   */
  editPoses(fresh = false): PoseAt[] {
    const ctx = this.frameContext;
    if (fresh) {
      const store = this.store;
      const anim = store.currentAnimation;
      const sym = store.currentSymbol;
      const out: PoseAt[] = [{ pose: posedSymbol(store.project, sym, anim, ctx.frame, ctx.mode), when: ctx }];
      if (anim && store.ui.editMultipleFrames && ctx.mode === "animate") {
        const span = store.onionSpan;
        for (let f = span.start; f <= span.end; f++) {
          if (f !== ctx.frame) out.push({ pose: posedSymbol(store.project, sym, anim, f, "animate"), when: { ...ctx, frame: f } });
        }
      }
      return out;
    }
    const out: PoseAt[] = [];
    if (this.lastPose) out.push({ pose: this.lastPose, when: ctx });
    for (const g of this.ghostPoses) out.push({ pose: g.pose, when: { ...ctx, frame: g.frame } });
    return out;
  }

  get pose(): Pose | null { return this.lastPose; }
  clearCaches(): void { this.renderer.clearCaches(); }

  // ── Coordinates ────────────────────────────────────────────────────────

  /** Mouse event -> content-area screen coordinates (rulers excluded). */
  private toContent(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    const gutter = this.store.ui.showRulers ? RULER : 0;
    return { x: e.clientX - r.left - gutter, y: e.clientY - r.top - gutter };
  }

  toWorld(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const c = this.toContent(e);
    return this.camera.toWorld(c.x, c.y);
  }

  // ── Hit testing ────────────────────────────────────────────────────────

  /** Topmost node under a world point (`pickNode`), over every pose the stage edits. */
  hitTest(wx: number, wy: number, assets: AssetStore, exclude?: Set<string>): NodeId | null {
    return pickNode(this.store.project, this.editPoses(), wx, wy, (id, x, y) => assets.alphaAt(id, x, y), 8 / this.camera.screenScale, exclude);
  }

  /** Nodes no pointer gesture may pick: hidden or locked layers. */
  private unpickable(): Set<string> {
    return new Set<string>(
      this.store.currentSymbol.layers
        .filter((l) => l.locked || !l.visible)
        .map((l) => l.nodeId as string),
    );
  }

  /** Every node whose transformed bounds intersect a screen-space marquee. */
  nodesInRect(screenRect: Rect, exclude?: Set<string>): NodeId[] {
    const project = this.store.project;
    const view = this.camera.matrix;
    const out = new Set<NodeId>();

    for (const { pose, when } of this.editPoses()) {
      for (const e of pose.entries) {
        if (!e.visible || e.node.kind === "bone" || out.has(e.nodeId)) continue;
        if (exclude?.has(e.nodeId)) continue;
        const box = entryBox(project, e, when);
        if (!box) continue;
        // The full product: inside an instance opened in place, the camera
        // carries the instance's rotation and skew, not just zoom and pan.
        const corners = transformCorners(mul(mat(), view, e.world), box);
        const inside = corners.some((p) => rectContains(screenRect, p.x, p.y));
        const surrounds = polygonContains(corners, screenRect.x + screenRect.w / 2,
                                                    screenRect.y + screenRect.h / 2);
        if (inside || surrounds) out.add(e.nodeId);
      }
    }
    return [...out];
  }

  // ── Input ──────────────────────────────────────────────────────────────

  private wireInput(): void {
    const host = this.host;

    on(window, "keydown", (e) => {
      const k = e as unknown as KeyboardEvent;
      if (k.code === "Space" && !this.spaceDown) {
        const t = k.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        this.spaceDown = true;
        host.style.cursor = "grab";
      }
    });
    on(window, "keyup", (e) => {
      if ((e as unknown as KeyboardEvent).code === "Space") {
        this.spaceDown = false;
        host.style.cursor = "";
      }
    });

    on(host, "wheel", (ev) => {
      const e = ev as unknown as WheelEvent;
      e.preventDefault();
      const c = this.toContent(e);
      // Lines (Firefox's mouse wheel) to pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      // A trackpad pinch arrives as ctrl + wheel: always a zoom. A plain
      // wheel zooms or pans by preference (`stage.wheel`); Shift pans
      // sideways either way; ⌘ does the other of the two.
      const zoomsHere = e.ctrlKey || (this.store.prefs.value.stage.wheel === "zoom"
        ? !e.metaKey && !e.shiftKey && !e.altKey
        : e.metaKey);
      if (zoomsHere) {
        this.camera.zoomAt(c.x, c.y, Math.exp(-dy * (e.ctrlKey ? 0.0035 : 0.0015)));
        this.store.setUi({ zoom: this.camera.zoom }, "ui");
      } else if (e.shiftKey) {
        this.camera.panBy(-dy - dx, 0);
      } else {
        this.camera.panBy(-dx, -dy);
      }
      this.invalidate();
    }, { passive: false });

    on(host, "pointermove", (ev) => {
      const e = ev as unknown as PointerEvent;
      if (e.buttons !== 0 || this.spaceDown) return;
      const g = this.guideAt(e);
      if (g >= 0) {
        host.style.cursor = this.guides[g]!.axis === "x" ? "ew-resize" : "ns-resize";
        return;
      }
      // Hand and Zoom are the viewport's own, not tools: their cursors here.
      const tool = this.store.ui.tool;
      if (tool === "hand") { host.style.cursor = "grab"; return; }
      if (tool === "zoom") { host.style.cursor = e.altKey ? "zoom-out" : "zoom-in"; return; }
      this.tools.active?.onHover?.(e, this.toolCtx);
    });

    on(host, "contextmenu", (ev) => {
      const e = ev as unknown as MouseEvent;
      e.preventDefault();

      // A guide owns the right button over its own line: it is not part of
      // the scene, so the stage menu's commands would all act on something
      // else entirely.
      const g = this.guideAt(e);
      if (g >= 0) { this.guideMenu(g, e.clientX, e.clientY); return; }

      this.store.clearFrameSelection();
      const w = this.toWorld(e);
      // Locked and hidden layers are skipped here exactly as they are for the
      // left button (`hitAt` in SelectTool): a lock that holds for a click and
      // not for a right-click is not a lock, and the menu would then act on a
      // node the tools refuse to move.
      const hit = this.assetsRef
        ? this.hitTest(w.x, w.y, this.assetsRef, this.unpickable()) : null;
      // Right-clicking an unselected object selects it first, so the menu
      // always acts on what is under the pointer.
      if (hit && !this.store.selection.nodes.includes(hit)) this.store.selectNodes([hit]);
      else if (!hit) this.store.clearSelection();
      this.onContextMenu?.(e.clientX, e.clientY);
    });

    on(host, "dblclick", (ev) => {
      const e = ev as unknown as MouseEvent;

      // A guide has no other way to be given an exact coordinate: dragging is
      // approximate by nature, and typing 240 is the whole reason guides are
      // worth placing.
      const g = this.guideAt(e);
      if (g >= 0) { e.preventDefault(); this.editGuide(g); return; }

      const w = this.toWorld(e);
      const hit = this.assetsRef
        ? this.hitTest(w.x, w.y, this.assetsRef, this.unpickable()) : null;
      // Edit in place: descend into the symbol the way Flash does — the one
      // the layer shows at this frame.
      const entry = hit ? this.lastPose?.byNode.get(hit) : undefined;
      const shown = entry?.display;
      if (entry && shown && isSymbol(this.store.project.items[shown.itemId])) {
        e.preventDefault();
        this.store.enterSymbol(shown.itemId, contentMatrixOf(entry.world, shown.pivot), entry.nodeId);
        this.onEnterSymbol?.();
        return;
      }

      // Nothing under the pointer: step back OUT one level, as Flash does.
      // Double-clicking empty space is how you leave a symbol without going
      // for the breadcrumb, and it is the only exit that needs no target.
      const depth = this.store.ui.editPath.length;
      if (!hit && depth > 1) {
        e.preventDefault();
        this.store.exitToDepth(depth - 2);
        this.onEnterSymbol?.();
      }
    });

    on(host, "pointerdown", (ev) => {
      const e = ev as unknown as PointerEvent;
      host.focus();

      // Guides drag out of the rulers — unless they are locked, which means
      // exactly what it says: nothing about the guides changes.
      if (this.store.ui.showRulers && this.guidesEditable) {
        const r = host.getBoundingClientRect();
        const lx = e.clientX - r.left, ly = e.clientY - r.top;
        if (lx < RULER || ly < RULER) {
          this.beginGuideDrag(e, ly < RULER ? "y" : "x");
          return;
        }
      }

      const tool = this.store.ui.tool;
      const panning = this.spaceDown || e.button === 1 || tool === "hand";
      if (panning) { this.beginPan(e); return; }

      // An existing guide under the pointer is picked up and moved. It comes
      // before the tools deliberately: a guide is a thin line drawn over the
      // artwork, and whatever is behind it is one pixel away.
      if (e.button === 0) {
        const hit = this.guideAt(e);
        if (hit >= 0) { this.beginGuideMove(e, hit); return; }
      }

      if (tool === "zoom" && e.button === 0) { this.beginZoom(e); return; }

      if (e.button === 0) {
        this.store.clearFrameSelection();
        this.beginTool(e);
      }
    });
  }

  /** The Zoom tool: a click zooms in at the pointer (Alt: out); a drag
   *  frames the rectangle it draws. */
  private beginZoom(e: PointerEvent): void {
    const start = this.toContent(e);
    this.host.setPointerCapture(e.pointerId);
    let rect: Rect | null = null;
    const move = (m: PointerEvent) => {
      const c = this.toContent(m);
      if (!rect && Math.hypot(c.x - start.x, c.y - start.y) < 4) return;
      rect = { x: Math.min(start.x, c.x), y: Math.min(start.y, c.y), w: Math.abs(c.x - start.x), h: Math.abs(c.y - start.y) };
      this.marquee = rect;
      this.invalidate();
    };
    const up = (m: PointerEvent) => {
      offMove(); offUp(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
      this.marquee = null;
      if (rect && rect.w > 4 && rect.h > 4) {
        const a = this.camera.screenToScene(rect.x, rect.y), b = this.camera.screenToScene(rect.x + rect.w, rect.y + rect.h);
        this.camera.fit({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }, 0);
      } else if (!rect) {
        this.camera.zoomAt(start.x, start.y, m.altKey ? 1 / 1.4 : 1.4);
      }
      this.store.setUi({ zoom: this.camera.zoom }, "ui");
      this.invalidate();
    };
    const offMove = on(this.host, "pointermove", move as (x: Event) => void);
    const offUp = on(this.host, "pointerup", up as (x: Event) => void);
    const offCancel = on(this.host, "pointercancel", (() => { offMove(); offUp(); offCancel(); this.marquee = null; this.invalidate(); }) as (x: Event) => void);
  }

  private beginPan(e: PointerEvent): void {
    const startPanX = this.camera.panX, startPanY = this.camera.panY;
    const sx = e.clientX, sy = e.clientY;
    this.host.setPointerCapture(e.pointerId);
    this.host.style.cursor = "grabbing";

    const move = (m: PointerEvent) => {
      this.camera.panX = startPanX + (m.clientX - sx);
      this.camera.panY = startPanY + (m.clientY - sy);
      this.invalidate();
    };
    const up = () => {
      offMove(); offUp(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
      this.host.style.cursor = this.spaceDown || this.store.ui.tool === "hand" ? "grab" : "";
    };
    const offMove = on(this.host, "pointermove", move as (x: Event) => void);
    const offUp = on(this.host, "pointerup", up);
    const offCancel = on(this.host, "pointercancel", up);
  }

  /** Hand every non-navigation pointer gesture to the active tool. */
  private beginTool(e: PointerEvent): void {
    const tool = this.tools.active;
    if (!tool) return;
    this.host.setPointerCapture(e.pointerId);
    tool.onPointerDown?.(e, this.toolCtx);

    const move = (m: PointerEvent) => tool.onPointerMove?.(m, this.toolCtx);
    const detach = () => {
      offMove(); offUp(); offKey(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
    };
    const up = (m: PointerEvent) => {
      detach();
      tool.onPointerUp?.(m, this.toolCtx);
    };
    const cancel = () => {
      detach();
      tool.onCancel?.(this.toolCtx);
    };
    const offMove = on(this.host, "pointermove", move as (x: Event) => void);
    const offUp = on(this.host, "pointerup", up as (x: Event) => void);
    // A pointer the browser takes away (a pen lifted out of range, a system
    // gesture) never sends pointerup: without this the move listener stayed
    // on, the object kept following a pointer with no button down, and the
    // open interaction swallowed the next edit of the same kind.
    const offCancel = on(this.host, "pointercancel", cancel);
    const offKey = on(window, "keydown", (k) => {
      if ((k as unknown as KeyboardEvent).key === "Escape") cancel();
    });
  }

  private beginGuideDrag(e: PointerEvent, axis: "x" | "y"): void {
    this.host.setPointerCapture(e.pointerId);
    const update = (m: PointerEvent) => {
      // Guides live in scene space, where the rulers that spawn them do.
      const c = this.toContent(m);
      const w = this.camera.screenToScene(c.x, c.y);
      this.draftGuide = { axis, at: this.snap.snapGuide(axis, axis === "x" ? w.x : w.y) };
      this.showGuideTip(m, this.draftGuide, false);
      this.invalidate();
    };
    update(e);
    const up = (m: PointerEvent, cancelled = false) => {
      offMove(); offUp(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
      this.hideGuideTip();
      const r = this.host.getBoundingClientRect();
      const inside = m.clientX - r.left > RULER && m.clientY - r.top > RULER;
      if (this.draftGuide && inside && !cancelled) this.guides.push(this.draftGuide);
      this.draftGuide = null;
      this.invalidate();
    };
    const offMove = on(this.host, "pointermove", update as (x: Event) => void);
    const offUp = on(this.host, "pointerup", ((m: PointerEvent) => up(m)) as (x: Event) => void);
    const offCancel = on(this.host, "pointercancel", ((m: PointerEvent) => up(m, true)) as (x: Event) => void);
  }

  clearGuides(): void { this.guides = []; this.invalidate(); }

  /** Guides can be picked up, moved and thrown away — unless locked. */
  private get guidesEditable(): boolean {
    return this.store.ui.showGuides && !this.store.prefs.value.stage.lockGuides;
  }

  /**
   * Index of the guide under the pointer, or -1.
   *
   * The tolerance is in SCREEN pixels — a guide is a one-pixel line, and
   * grabbing it must not get harder as the view zooms out. Searched from the
   * end so the most recently dropped guide, which is drawn last, wins.
   */
  private guideAt(e: PointerEvent | MouseEvent): number {
    if (!this.guidesEditable) return -1;
    const c = this.toContent(e);
    if (c.x < 0 || c.y < 0) return -1;             // in the rulers
    const TOL = 4;
    for (let i = this.guides.length - 1; i >= 0; i--) {
      const g = this.guides[i]!;
      const at = g.axis === "x"
        ? this.camera.sceneToScreen(g.at, 0).x - c.x
        : this.camera.sceneToScreen(0, g.at).y - c.y;
      if (Math.abs(at) <= TOL) return i;
    }
    return -1;
  }

  /**
   * Drag an existing guide.
   *
   * Dropping it back over a ruler removes it, which is where a guide came
   * from and the gesture every editor uses to get rid of one. Escape puts it
   * back where it started.
   */
  private beginGuideMove(e: PointerEvent, index: number): void {
    const guide = this.guides[index];
    if (!guide) return;
    const start = guide.at;
    this.host.setPointerCapture(e.pointerId);
    this.host.style.cursor = guide.axis === "x" ? "ew-resize" : "ns-resize";

    const overRuler = (m: PointerEvent) => {
      if (!this.store.ui.showRulers) return false;
      const r = this.host.getBoundingClientRect();
      return m.clientX - r.left < RULER || m.clientY - r.top < RULER;
    };

    const update = (m: PointerEvent) => {
      const c = this.toContent(m);
      const w = this.camera.screenToScene(c.x, c.y);
      guide.at = this.snap.snapGuide(guide.axis, guide.axis === "x" ? w.x : w.y, index);
      const doomed = overRuler(m);
      this.host.style.cursor = doomed ? "not-allowed" : (guide.axis === "x" ? "ew-resize" : "ns-resize");
      this.showGuideTip(m, guide, doomed);
      this.invalidate();
    };

    const finish = (m: PointerEvent | null, cancelled: boolean) => {
      offMove(); offUp(); offKey(); offCancel();
      this.host.releasePointerCapture?.(e.pointerId);
      this.host.style.cursor = "";
      this.hideGuideTip();
      if (cancelled) guide.at = start;
      else if (m && overRuler(m)) this.guides.splice(index, 1);
      this.invalidate();
    };

    const offMove = on(this.host, "pointermove", ((m: PointerEvent) => update(m)) as (x: Event) => void);
    const offUp = on(this.host, "pointerup", ((m: PointerEvent) => finish(m, false)) as (x: Event) => void);
    const offCancel = on(this.host, "pointercancel", () => finish(null, true));
    const offKey = on(window, "keydown", (k) => {
      if ((k as unknown as KeyboardEvent).key === "Escape") finish(null, true);
    });
  }

  /**
   * The coordinate under the pointer while a guide is being placed.
   *
   * Dropping a guide is a blind gesture otherwise: the ruler is at the far
   * edge of the stage, and reading a position off it is exactly the thing the
   * guide is being placed to avoid.
   */
  private showGuideTip(e: PointerEvent, guide: Guide, doomed: boolean): void {
    if (!this.guideTip) {
      this.guideTip = h("div", { class: "guide-tip" });
      this.host.appendChild(this.guideTip);
    }
    const r = this.host.getBoundingClientRect();
    this.guideTip.textContent = doomed
      ? "Release to delete"
      : `${guide.axis === "x" ? "X" : "Y"}: ${Math.round(guide.at)}`;
    cls(this.guideTip, "doomed", doomed);
    this.guideTip.style.left = `${e.clientX - r.left + 14}px`;
    this.guideTip.style.top = `${e.clientY - r.top + 16}px`;
  }

  private hideGuideTip(): void {
    this.guideTip?.remove();
    this.guideTip = null;
  }

  /** Right-click on a guide: the two things you can do to one. */
  private guideMenu(index: number, x: number, y: number): void {
    const guide = this.guides[index];
    if (!guide) return;
    const locked = this.store.prefs.value.stage.lockGuides;
    showMenu(menuAnchor(x, y), [
      {
        label: `Move ${guide.axis === "x" ? "X" : "Y"}: ${Math.round(guide.at)}…`,
        enabled: !locked,
        run: () => this.editGuide(index),
      },
      {
        label: "Delete Guide",
        enabled: !locked,
        run: () => { this.guides.splice(index, 1); this.invalidate(); },
      },
      "-",
      {
        label: "Clear Guides",
        enabled: !locked,
        run: () => this.clearGuides(),
      },
      {
        label: "Lock Guides",
        checked: locked,
        run: () => {
          this.store.prefs.set("stage", { lockGuides: !locked });
          this.store.emit("stage");
        },
      },
    ]);
  }

  /** The coordinate dialog behind a double click, with Delete beside it. */
  private editGuide(index: number): void {
    const guide = this.guides[index];
    if (!guide) return;
    promptNumber({
      title: guide.axis === "x" ? "Vertical Guide" : "Horizontal Guide",
      label: guide.axis === "x" ? "X" : "Y",
      value: guide.at,
      unit: "px",
      extra: {
        label: "Delete",
        run: () => { this.guides.splice(index, 1); this.invalidate(); },
      },
      onOk: (v) => {
        const g = this.guides[index];
        if (!g) return;
        g.at = Math.round(v);
        this.invalidate();
      },
    });
  }

  /** Set by App so hit testing can probe alpha. */
  assetsRef: AssetStore | null = null;
  /** Set by App, to refit the view after descending into a symbol. */
  onEnterSymbol: (() => void) | null = null;
  /** Set by App; opens the stage context menu at screen coordinates. */
  onContextMenu: ((x: number, y: number) => void) | null = null;

  /** A fit asked for while the stage had no size yet (a page loaded in a
   *  hidden pane): made on the first real resize, since fitting a 1px view
   *  clamped the zoom to 2% and left the stage a dot in the corner. */
  private fitPending = false;

  /** Screen pixels at the foot of the stage something covers (App sets it:
   *  the stage toolbar). Fit to Stage frames the space above. */
  fitInset: () => number = () => 0;

  fitToStage(): void {
    const s = this.store.project.stage;
    this.fitPending = this.camera.width < 100 || this.camera.height < 100;
    if (this.fitPending) return;
    // An opened Spine rig sits about its own origin, not on a stage: frame it.
    const sym = this.store.currentSymbol;
    const rig = sym.spine ? boneburstBounds(this.store.project, sym) : null;
    if (rig) {
      const m = Math.max(rig.w, rig.h) * 0.08;
      this.camera.fit({ x: rig.x - m, y: rig.y - m, w: rig.w + 2 * m, h: rig.h + 2 * m }, 40, this.fitInset());
    } else {
      this.camera.fit({ x: 0, y: 0, w: s.width, h: s.height }, 40, this.fitInset());
    }
    this.store.setUi({ zoom: this.camera.zoom }, "ui");
    this.invalidate();
  }
}
