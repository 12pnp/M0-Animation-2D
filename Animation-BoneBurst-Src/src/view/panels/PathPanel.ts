import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import type { Panel } from "@/view/widgets/Dock";
import { h, on, raf } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import { Camera } from "@/view/viewport/Camera";
import { SceneRenderer } from "@/view/viewport/SceneRenderer";
import { PathCache } from "@/view/viewport/pathCache";
import type { PathZoomLink, ZoomLinked } from "./pathZoom";
import { PATH_GRID_MAJOR, pathGridStep } from "./pathGrid";
import { heldParent } from "./pathHeld";
import { openOnionFrames } from "./onionFramesPopup";
import { PATH_ONION_KEYS, pathOnionSpan } from "./pathOnion";
import { GhostPainter } from "@/view/viewport/ghost";
import { onionFrames } from "@/core/doc/onion";
import { clampPref } from "@/core/prefs/prefs";
import { keyIndexAt } from "@/core/doc/timeline";
import { pathScene } from "@/view/viewport/pathScene";
import { drawBonePaths } from "@/view/viewport/pathDraw";
import type { BonePathsDraw } from "@/view/viewport/Overlay";
import type { ToolContext } from "@/view/tools/Tool";
import { BakeDrag, HandleDrag, PathDrag, pathPick } from "@/view/tools/pathDrag";
import { DRAWN_BONE_LENGTH, pathBoneIds, pathFrames } from "@/core/doc/bonePath";
import { seamFrame } from "@/core/doc/cycle";
import { anchorOf } from "@/core/doc/displays";
import type { NodeId } from "@/core/doc/ids";
import { entryBox, type Pose } from "@/core/doc/pose";
import type { Animation } from "@/core/doc/types";
import type { SymbolItem } from "@/core/doc/types";
import { apply, mat, matOf, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { type Rect, transformCorners } from "@/core/math/geom";

/** Fit leaves the framed path at 65% of the zoom that would fill the view. */
const FIT_ZOOM_OUT = 0.65;

/** Local: the parent held still, only the bone's own motion. World: the parent's
 *  motion too, the path as the stage draws it. */
export type PathPanelSpace = "local" | "world";

export const PATH_PANELS: Record<PathPanelSpace, { id: string; title: string; hint: string }> = {
  local: { id: "path", title: "Local Path", hint: "The bone's motion against its parent: the parent holds still (as at frame 1) and only this bone moves" },
  world: { id: "worldPath", title: "World Path", hint: "The bone's motion with its parent's: the path as it moves on the stage" },
};

/**
 * A Bone Path panel (ARCHITECTURE ▸ Bone paths ▸ The Path panels): the one
 * bone the selection points at (a bone, or the bone a selected picture hangs
 * on), drawn alone with the artwork it carries, and its path over the whole
 * animation, in one space (Local or World). Its dots and handles edit as the
 * stage's do, through the same drags.
 */
export class PathPanel implements Panel, ZoomLinked {
  readonly id: string;
  readonly title: string;
  readonly icon = "bonePath" as const;
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly note: HTMLElement;
  private readonly nameEl: HTMLElement;
  readonly camera = new Camera();
  fitZoom: number | null = null;
  private readonly lock: HTMLButtonElement;
  private readonly gridBtn: HTMLButtonElement;
  private readonly onionBtn: HTMLButtonElement;
  private readonly ghosts = new GhostPainter();
  private readonly renderer: SceneRenderer;
  private readonly cache = new PathCache();
  private readonly invalidate: () => void;
  private dpr = 1;
  private scene: BonePathsDraw | null = null;
  /** Stage space at the playhead into what the panel draws: the parent's pose
   *  at frame 0 (relative), or nothing (where it goes on the stage). */
  private shown = mat();
  /** What the view was last fitted to; a new bone, animation or space fits again. */
  private fittedFor = "";
  private drag: PathDrag | HandleDrag | BakeDrag | null = null;
  private pan: { x: number; y: number } | null = null;
  private readonly toolCtx: ToolContext;

  constructor(
    private readonly store: Store, assets: AssetStore, notify: (message: string) => void,
    private readonly space: PathPanelSpace = "local",
    private readonly link?: PathZoomLink,
  ) {
    this.id = PATH_PANELS[space].id;
    this.title = PATH_PANELS[space].title;
    this.renderer = new SceneRenderer(() => store.project, assets);
    this.canvas = h("canvas", { style: "position:absolute;inset:0;width:100%;height:100%;touch-action:none" }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.note = h("div", { class: "hint", style: "position:absolute;left:8px;right:8px;top:8px;pointer-events:none" });
    this.nameEl = h("span", { style: "font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", title: PATH_PANELS[space].hint });
    const fit = h("button", { class: "iconbtn", title: "Fit: frame the bone and its path" }, icon("fit", 14));
    this.lock = h("button", { class: "iconbtn", title: "Lock zoom: the Local and World Path panels zoom together" }, icon("lock", 14)) as HTMLButtonElement;
    this.lock.hidden = !link;
    this.gridBtn = h("button", { class: "iconbtn", title: "Show grid (both Path panels)" }, icon("grid", 14)) as HTMLButtonElement;
    this.onionBtn = h("button", { class: "iconbtn", title: `Onion skin in ${PATH_PANELS[space].title}: the bone's artwork at the frames around the playhead (this panel's own, apart from the stage's)` }, icon("onion", 14)) as HTMLButtonElement;
    const framesBtn = h("button", { class: "iconbtn", title: "Onion settings: frames before and after the playhead, opacity and colours" }, icon("onionFrames", 14));
    framesBtn.dataset.onionFor = this.id;
    const keys = PATH_ONION_KEYS[space];
    on(framesBtn, "click", () => openOnionFrames(framesBtn, {
      get: () => {
        const g = store.prefs.value.gizmos;
        return {
          before: g[keys.before], after: g[keys.after], opacity: g[keys.opacity],
          past: g[keys.past], future: g[keys.future], falloff: g[keys.falloff], outline: g[keys.outline],
        };
      },
      set: (c) => store.prefs.set("gizmos", {
        ...(c.before !== undefined ? { [keys.before]: clampPref(`gizmos.${keys.before}`, c.before) } : {}),
        ...(c.after !== undefined ? { [keys.after]: clampPref(`gizmos.${keys.after}`, c.after) } : {}),
        ...(c.opacity !== undefined ? { [keys.opacity]: clampPref(`gizmos.${keys.opacity}`, c.opacity) } : {}),
        ...(c.past !== undefined ? { [keys.past]: c.past } : {}),
        ...(c.future !== undefined ? { [keys.future]: c.future } : {}),
        ...(c.falloff !== undefined ? { [keys.falloff]: clampPref(`gizmos.${keys.falloff}`, c.falloff) } : {}),
        ...(c.outline !== undefined ? { [keys.outline]: c.outline } : {}),
      }),
      subscribe: (fn) => store.prefs.subscribe(fn),
    }, `${PATH_PANELS[space].title} onion`));
    const bar = h("div", { style: "display:flex;align-items:center;gap:8px;padding:4px 8px;flex:none" },
      // The buttons first: a narrow column clips the bar's right end.
      fit,
      this.lock,
      this.gridBtn,
      this.onionBtn,
      framesBtn,
      this.nameEl);
    const area = h("div", { style: "position:relative;flex:1;min-height:0;overflow:hidden" }, this.canvas, this.note);
    this.el = h("div", { class: "path-panel", style: "display:flex;flex-direction:column;height:100%" }, bar, area);

    this.invalidate = raf(() => this.render());
    this.toolCtx = this.makeToolContext(assets, notify);

    on(fit, "click", () => { this.fittedFor = ""; this.invalidate(); });
    on(this.gridBtn, "click", () => store.prefs.set("gizmos", { pathGrid: !store.prefs.value.gizmos.pathGrid }));
    on(this.onionBtn, "click", () => store.prefs.set("gizmos", { [keys.on]: !store.prefs.value.gizmos[keys.on] }));
    on(this.lock, "click", () => {
      const locked = !store.prefs.value.gizmos.pathZoomLock;
      store.prefs.set("gizmos", { pathZoomLock: locked });
      // Locking takes this panel's zoom to the other.
      if (locked) this.link?.zoomed(this);
    });
    this.wireInput();
    new ResizeObserver(() => this.resize()).observe(area);
    store.subscribe(() => this.invalidate());
    store.prefs.subscribe(() => this.invalidate());
    this.resize();
  }

  // The dock may call this before the panel is back in the page, where it
  // measures 0; the observer sees no change once it is back at its old size.
  redraw(): void { this.invalidate(); }

  onShow(): void { this.resize(); requestAnimationFrame(() => this.resize()); }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.camera.width = Math.max(1, r.width);
    this.camera.height = Math.max(1, r.height);
    this.invalidate();
  }

  /** The bone shown: the first the selection points at. */
  private bone(): NodeId | null {
    return pathBoneIds(this.store.currentSymbol.nodes, this.store.selection.nodes)[0] ?? null;
  }

  /**
   * What is drawn with the bone: everything it carries (bones below it, and
   * pictures on any of them). A Spine rig often hangs a limb's picture on a
   * control bone above the bones that bend it (a mesh on `leg-control`,
   * weighted to the leg's bones), so a bone that carries no picture shows
   * its parent's, and so on up.
   */
  private carried(sym: SymbolItem, bone: NodeId, pose: Pose): Set<string> {
    const below = (top: NodeId) => {
      const out = new Set<string>([top]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of Object.values(sym.nodes)) {
          const a = anchorOf(n);
          if (!out.has(n.id) && a && out.has(a)) { out.add(n.id); grew = true; }
        }
      }
      return out;
    };
    const draws = (ids: Set<string>) => pose.entries.some((e) => ids.has(e.nodeId) && e.visible && !!(e.display || e.spine));
    let top: NodeId | null = bone;
    while (top) {
      const set = below(top);
      if (draws(set)) return set;
      top = sym.nodes[top]?.parentId ?? null;
    }
    return below(bone);
  }

  private render(): void {
    const { store, ctx } = this;
    this.lock.classList.toggle("on", store.prefs.value.gizmos.pathZoomLock);
    this.gridBtn.classList.toggle("on", store.prefs.value.gizmos.pathGrid);
    this.onionBtn.classList.toggle("on", store.prefs.value.gizmos[PATH_ONION_KEYS[this.space].on]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.scene = null;

    const sym = store.currentSymbol;
    const anim = store.currentAnimation;
    const bone = this.bone();
    this.nameEl.textContent = bone ? sym.nodes[bone]?.name ?? "" : "No bone";
    const say = (text: string) => { this.note.textContent = text; this.note.hidden = !text; };
    if (!bone) return say("Select a bone, or a picture on a bone, to see its path.");
    if (!anim || store.ui.mode !== "animate") return say("Paths are shown in Animate mode, over an animation.");
    say("");

    const g = store.prefs.value.gizmos;
    const relative = this.space === "local";
    const frame = store.ui.frame;
    const { frames, closed } = pathFrames(anim);
    const sample = this.cache.sampler(store.project, sym, anim, store.history.revision);
    const scene = pathScene({
      sym, anim, sample, ids: [bone], frames, closed, which: g.bonePathPoint,
      // The panel holds the parent still in its pose at frame 0: the path
      // does not move when the playhead does, and neither does the view.
      ...(relative ? { relativeAt: 0 } : {}), handlesFor: bone,
    });
    const t = store.prefs.value.timeline;
    this.scene = {
      ...scene, frame: frame === seamFrame(anim) ? 0 : frame,
      past: t.onionPastColor, future: t.onionFutureColor, current: t.playhead,
    };
    if (this.cache.pending) this.invalidate();

    // Only what the bone carries is drawn.
    const pose = sample(frame, true)!;
    // The artwork at the playhead, carried into that frame-0 parent pose.
    const parentId = sym.nodes[bone] ? anchorOf(sym.nodes[bone]!) : null;
    const m0 = relative && parentId ? sample(0, true)!.byNode.get(parentId)?.world : undefined;
    const held = (p: Pose) => (m0 && parentId ? heldParent(m0, p.byNode.get(parentId)?.world) : mat());
    this.shown = held(pose);
    const keep = this.carried(sym, bone, pose);
    const hidden = new Set<string>(sym.layers.map((l) => l.nodeId).filter((id) => !keep.has(id)));
    const fitKey = `${bone}|${anim.id}`;
    if (fitKey !== this.fittedFor) {
      this.fit(pose, keep, bone);
      // A big rig's path fills in over a few draws: fit again until it is whole.
      if (!this.cache.pending) this.fittedFor = fitKey;
    }

    if (store.prefs.value.gizmos.pathGrid) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawGrid();
    }
    const screen = mul(mat(), matOf(this.dpr, 0, 0, this.dpr, 0, 0), this.camera.matrix);
    if (g[PATH_ONION_KEYS[this.space].on]) this.drawGhosts(sym, anim, bone, keep, hidden, screen, (f) => held(sample(f, true)!));
    this.renderer.draw(ctx, sym, anim, frame, "animate", mul(mat(), screen, this.shown), { hiddenLayers: hidden });
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBones(pose, bone, this.shown);
    drawBonePaths(ctx, (x, y) => this.camera.toScreen(x, y), this.scene, { core: "#161616", handle: "#00bcd9" });
  }

  /**
   * This panel's onion skin: its own frame counts around the playhead
   * (`pathOnionSpan`), opacity, falloff, colours and outline, and the
   * timeline's "keyframes only", each with the artwork the
   * bone carries and the bone itself. In Local each is carried into the
   * frame-0 parent pose like the current frame.
   */
  private drawGhosts(
    sym: SymbolItem, anim: Animation, bone: NodeId, keep: Set<string>, hidden: Set<string>,
    screen: Matrix2D, heldAt: (frame: number) => Matrix2D,
  ): void {
    const { store } = this;
    const o = store.prefs.value.timeline;
    const tracks = [...keep].map((id) => anim.tracks[id as NodeId]).filter((t) => !!t);
    const isKey = o.onionKeyframesOnly ? (f: number) => tracks.some((t) => keyIndexAt(t, f) >= 0) : undefined;
    const sample = this.cache.sampler(store.project, sym, anim, store.history.revision);
    const keys = PATH_ONION_KEYS[this.space];
    const g = store.prefs.value.gizmos;
    const frame = store.ui.frame;
    for (const gh of onionFrames({
      frame, span: pathOnionSpan(frame, anim, g[keys.before], g[keys.after]),
      opacity: g[keys.opacity], falloff: g[keys.falloff], isKey, period: seamFrame(anim),
    })) {
      const tint = gh.side === "past" ? g[keys.past] : g[keys.future];
      const shown = heldAt(gh.frame);
      const pose = sample(gh.frame, true);
      this.ghosts.paint(this.ctx, this.dpr, { alpha: gh.alpha, tint, outline: g[keys.outline] }, (c) => {
        this.renderer.draw(c, sym, anim, gh.frame, "animate", mul(mat(), screen, shown), { hiddenLayers: hidden });
        if (!pose) return;
        c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.drawBones(pose, bone, shown, c, false);
      });
    }
  }

  /** Lines every `pathGridStep` stage pixels under the artwork, every fifth
   *  brighter. */
  private drawGrid(): void {
    const { ctx, camera } = this;
    const step = pathGridStep(camera.zoom);
    const tl = camera.toWorld(0, 0), br = camera.toWorld(camera.width, camera.height);
    const x0 = Math.min(tl.x, br.x), x1 = Math.max(tl.x, br.x), y0 = Math.min(tl.y, br.y), y1 = Math.max(tl.y, br.y);
    const lines = (major: boolean) => {
      ctx.beginPath();
      for (let i = Math.ceil(x0 / step); i * step <= x1; i++) {
        if ((i % PATH_GRID_MAJOR === 0) !== major) continue;
        const x = Math.round(camera.toScreen(i * step, 0).x) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, camera.height);
      }
      for (let i = Math.ceil(y0 / step); i * step <= y1; i++) {
        if ((i % PATH_GRID_MAJOR === 0) !== major) continue;
        const y = Math.round(camera.toScreen(0, i * step).y) + 0.5;
        ctx.moveTo(0, y); ctx.lineTo(camera.width, y);
      }
      ctx.stroke();
    };
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    lines(false);
    ctx.strokeStyle = "rgba(255,255,255,0.17)";
    lines(true);
  }

  /** The parent faint, the bone itself solid: the frame the path is read
   *  against. A ghost draws only the bone. */
  private drawBones(pose: Pose, bone: NodeId, shown: Matrix2D, ctx = this.ctx, parent = true): void {
    const line = (id: NodeId | null | undefined, color: string, width: number) => {
      const e = id ? pose.byNode.get(id) : undefined;
      if (!e) return;
      const len = e.node.kind === "bone" ? e.node.boneLength ?? DRAWN_BONE_LENGTH : 0;
      const w = mul(mat(), shown, e.world);
      const a = this.camera.toScreen(w.tx, w.ty);
      const tip = apply({ x: 0, y: 0 }, w, len, 0);
      const b = this.camera.toScreen(tip.x, tip.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(a.x, a.y, width + 1.5, 0, Math.PI * 2); ctx.fill();
    };
    const node = pose.byNode.get(bone)?.node;
    if (parent) line(node?.parentId, "rgba(255,255,255,0.35)", 2);
    line(bone, "rgba(255,214,102,0.95)", 2.5);
  }

  /**
   * Frame the path and the bone (joint to tip): what is edited here. The
   * artwork draws around it but does not set the zoom, or a head that barely
   * nods on its neck is a few pixels inside a big picture. With no path yet,
   * the artwork.
   */
  private fit(pose: Pose, keep: Set<string>, bone: NodeId): void {
    const xs: number[] = [], ys: number[] = [];
    for (const p of this.scene?.paths[0]?.points ?? []) { xs.push(p.x); ys.push(p.y); }
    const e = pose.byNode.get(bone);
    if (e) {
      const w = mul(mat(), this.shown, e.world);
      const tip = apply({ x: 0, y: 0 }, w, e.node.boneLength ?? DRAWN_BONE_LENGTH, 0);
      xs.push(w.tx, tip.x); ys.push(w.ty, tip.y);
    }
    if (xs.length < 3) {
      const when = { animationName: this.store.currentAnimation?.name ?? null, frame: this.store.ui.frame, mode: "animate" as const };
      for (const en of pose.entries) {
        if (!keep.has(en.nodeId) || !en.visible) continue;
        const b = entryBox(this.store.project, en, when);
        if (!b) continue;
        for (const c of transformCorners(mul(mat(), this.shown, en.world), b)) { xs.push(c.x); ys.push(c.y); }
      }
    }
    if (!xs.length) return;
    const r: Rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 1, h: Math.max(...ys) - Math.min(...ys) || 1 };
    this.camera.fit(r, 24);
    // Then 35% further out, about the centre: framed edge to edge the path
    // sat too close to read what is around it.
    this.camera.zoomAt(this.camera.width / 2, this.camera.height / 2, FIT_ZOOM_OUT);
    this.fitZoom = this.camera.zoom;
    this.link?.fitted(this);
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private wireInput(): void {
    const c = this.canvas;
    on(c, "wheel", (e: WheelEvent) => {
      e.preventDefault();
      const p = this.local(e);
      this.camera.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
      this.link?.zoomed(this);
      this.invalidate();
    });
    // The left button edits; the view pans with the middle or right button,
    // or Space + drag, as the stage does.
    let space = false;
    on(window, "keydown", (e: KeyboardEvent) => { if (e.code === "Space") space = true; });
    on(window, "keyup", (e: KeyboardEvent) => { if (e.code === "Space") space = false; });
    on(c, "contextmenu", (e: MouseEvent) => e.preventDefault());
    on(c, "pointerdown", (e: PointerEvent) => {
      try { c.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
      if (e.button === 1 || e.button === 2 || (e.button === 0 && space)) {
        this.pan = this.local(e);
        c.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0 || !this.scene) return;
      const world = this.toolCtx.toWorld(e);
      const pick = pathPick(this.toolCtx, world);
      if (pick && "handle" in pick) {
        const { handle } = pick;
        this.drag = handle.bake ? new BakeDrag(this.toolCtx, { ...handle, bake: handle.bake }, world) : new HandleDrag(this.toolCtx, handle, world, e.altKey);
        return;
      }
      if (pick) {
        this.drag = new PathDrag(this.toolCtx, pick.dot.id, pick.dot.frame, pick.dot, world, e);
        return;
      }
      // Anywhere else drags the bone itself at the playhead: its dot there
      // follows the pointer by as much as the pointer moves.
      const path = this.scene.paths[0];
      const dot = path?.points.find((q) => q.frame === this.scene!.frame);
      if (path && dot) {
        this.drag = new PathDrag(this.toolCtx, path.id, dot.frame, { x: dot.x, y: dot.y, ...(path.relativeAt !== undefined ? { relativeAt: path.relativeAt } : {}) }, world, e);
      }
    });
    on(c, "pointermove", (e: PointerEvent) => {
      if (this.pan) {
        const p = this.local(e);
        this.camera.panBy(p.x - this.pan.x, p.y - this.pan.y);
        this.pan = p;
        this.invalidate();
        return;
      }
      if (this.drag) {
        const world = this.toolCtx.toWorld(e);
        if (this.drag instanceof PathDrag) this.drag.move(e, world); else this.drag.move(world);
        return;
      }
      const world = this.toolCtx.toWorld(e);
      c.style.cursor = !this.scene ? "" : pathPick(this.toolCtx, world) ? "pointer" : space ? "grab" : "move";
    });
    const end = (e: PointerEvent) => {
      if (this.drag instanceof PathDrag) this.drag.up(e);
      else if (this.drag) this.drag.up(this.toolCtx.toWorld(e));
      this.drag = null;
      this.pan = null;
      c.releasePointerCapture?.(e.pointerId);
      this.invalidate();
    };
    on(c, "pointerup", end);
    on(c, "pointercancel", (e: PointerEvent) => {
      this.drag?.cancel();
      this.drag = null;
      this.pan = null;
      c.releasePointerCapture?.(e.pointerId);
    });
  }

  /** What the shared path drags need, over this panel's own view. */
  private makeToolContext(assets: AssetStore, notify: (message: string) => void): ToolContext {
    const toWorld = (e: PointerEvent | MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return this.camera.toWorld(e.clientX - r.left, e.clientY - r.top);
    };
    return {
      store: this.store,
      assets,
      camera: this.camera,
      pose: () => null,
      gizmo: () => null,
      toWorld,
      toContent: (e) => this.local(e as PointerEvent),
      toScreen: (p) => this.camera.toScreen(p.x, p.y),
      hitTest: () => null,
      nodesInRect: () => [],
      invalidate: () => this.invalidate(),
      setMarquee: () => {},
      setDraftBone: () => {},
      beginSnap: () => {},
      snapDelta: (dx, dy) => ({ dx, dy }),
      snapDot: (world) => world,
      endSnap: () => {},
      setCursor: (cursor) => { this.canvas.style.cursor = cursor; },
      bonePaths: () => this.scene?.paths ?? [],
      pathHandles: () => this.scene?.handles ?? [],
      notify,
    };
  }
}
