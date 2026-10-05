import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import type { PreviewHost } from "./previewHost";
import { buildExports, type ExportResult } from "@/io/export/ExportBundle";
import { symbolBounds } from "@/core/doc/pose";
import { boneburstBounds, stageSkinOf } from "@/core/boneburst/boneburstPose";
import { isSymbol, type SymbolItem } from "@/core/doc/types";
import type { ItemId } from "@/core/doc/ids";

/**
 * Which symbol a view wants: the whole scene, or the symbol being edited.
 *
 * They are genuinely different questions. "Is the rig right?" is asked of the
 * scene; "does the animation I am authoring inside this symbol run?" is asked
 * of the symbol, and previewing the scene for that seeks the runtime on a
 * timeline that is not the user's.
 */
export type PreviewScope = "scene" | "symbol";

export interface PreviewOptions {
  debugDraw: boolean;
  showStage: boolean;
  play: boolean;
  scope?: PreviewScope;
}

/** What one view of the runtime wants of it. */
export interface PreviewView {
  host: PreviewHost;
  /** On screen, and therefore worth loading into. */
  active(): boolean;
  options(): PreviewOptions;
  onStatus(text: string, isError?: boolean): void;
}

/** No slots and no atlas: there is nothing to render. */
function isEmpty(result: ExportResult): boolean {
  return result.pages.length === 0 && !result.skeleton.slots?.length;
}

/**
 * One build, many runtimes.
 *
 * Every preview view needs the project run through the ACTUAL Spine runtime,
 * fed the exact bytes that would go to disk — that is what makes it ground
 * truth. A Spine
 * file holds one skeleton, so each view gets the export of ITS symbol; what
 * they must not do is pack the atlas twice (by far the expensive half, and a
 * drag emits dozens of document changes a second), so one build exports
 * every symbol an active view needs over one shared atlas (`buildExports`).
 *
 * Each view keeps its own iframe. Sharing one would mean moving it between
 * the dock and the stage, and moving an iframe reloads it — the dock alone
 * rebuilds its DOM on every focus and every tab drag.
 */
export class PreviewSession {
  private views = new Set<PreviewView>();
  private stale = true;
  private busy = false;
  /** A refresh was asked for while a build ran; run again when it ends. */
  private rerun = false;
  private refreshTimer = 0;
  /** Animation names from the last successful load, for the transport menus. */
  private animations: string[] = [];
  private animListeners = new Set<(names: string[]) => void>();

  constructor(
    private readonly store: Store,
    private readonly assets: AssetStore,
    /** Every build's outcome: the error, or null when it succeeded. */
    private readonly onBuilt: (error: unknown) => void = () => {},
  ) {
    let { playSpeed: speed, playRate: fps } = store.prefs.value.timeline;
    this.store.prefs.subscribe(() => {
      const t = this.store.prefs.value.timeline;
      if (t.playSpeed !== speed) {
        speed = t.playSpeed;
        for (const v of this.views) v.host.post({ type: "setSpeed", speed });
      }
      if (t.playRate !== fps) {
        fps = t.playRate;
        for (const v of this.views) v.host.post({ type: "setFps", fps });
      }
    });
    this.store.subscribe((topic) => {
      // Every edit goes through History, which emits "doc" first. "stage" and
      // "timeline" also come from view state — a view flag, folding a
      // group — and each one rebuilt the export and restarted
      // the animation a quarter of a second after it had begun.
      if (topic === "doc" || topic === "library") {
        this.stale = true;
        if (this.hasActiveView) this.scheduleRefresh();
        return;
      }
      // While a view is paused, follow the editor's playhead: scrubbing the
      // timeline and watching the runtime agree frame by frame is the whole
      // point of having the real runtime on hand.
      if (topic === "frame") {
        for (const v of this.views) {
          if (v.active() && !v.options().play && this.followsPlayhead(v)) {
            v.host.post({ type: "seek", frame: this.store.ui.frame });
          }
        }
      }
    });
  }

  register(view: PreviewView): void {
    this.views.add(view);
    view.host.onMessage((msg) => {
      // The iframe may be new: it starts at 1×.
      if (msg.type === "loaded") {
        const t = this.store.prefs.value.timeline;
        view.host.post({ type: "setSpeed", speed: t.playSpeed });
        view.host.post({ type: "setFps", fps: t.playRate });
      }
      if (msg.type === "loaded") {
        this.animations = msg.animations;
        for (const fn of this.animListeners) fn(msg.animations);
        // The panel clears its status when the runtime reports a load; an
        // export error found for that load has to outlive it.
        const error = this.errorFor.get(view);
        if (error) view.onStatus(error, true);
      }
    });
  }

  unregister(view: PreviewView): void { this.views.delete(view); }

  onAnimations(fn: (names: string[]) => void): () => void {
    this.animListeners.add(fn);
    fn(this.animations);
    return () => this.animListeners.delete(fn);
  }

  /**
   * Whether the editor's playhead means anything to this view. A scene-scoped
   * view running the root while the user is inside a symbol is on a different
   * timeline, and seeking it to their frame would scrub something they are
   * not looking at.
   */
  followsPlayhead(view: PreviewView): boolean {
    if ((view.options().scope ?? "symbol") === "symbol") return true;
    return this.store.currentSymbolId === this.store.project.rootSymbolId;
  }

  private get hasActiveView(): boolean {
    for (const v of this.views) if (v.active()) return true;
    return false;
  }

  /** Rebuild when the document has moved on. */
  invalidate(): void {
    this.stale = true;
    if (this.hasActiveView) this.scheduleRefresh();
  }

  /** A view that has just come on screen wants whatever is current. */
  show(view: PreviewView): void {
    const built = this.builtFor(view);
    if (this.stale || !built) this.scheduleRefresh();
    else this.loadInto(view, built);
  }

  /**
   * `show`, without waiting for the coalescing timer. When nothing changed
   * only this view is loaded: rebuilding for everyone restarted the Preview
   * panel's animation every time another view came on screen.
   */
  present(view: PreviewView): void {
    const built = this.builtFor(view);
    if (!this.stale && built) this.loadInto(view, built);
    else void this.refresh(true);
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    // Coalesce: a drag emits dozens of changes a second, and each refresh
    // re-packs the atlas.
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 250);
  }

  /**
   * Build and load. `force` skips the "nothing changed" guard, which is what
   * revealing a view needs — the document may
   * be untouched but this view has never been given it.
   */
  async refresh(force = false): Promise<void> {
    clearTimeout(this.refreshTimer);
    if (this.busy) {
      // The build in flight started before this request, so what it produces
      // may already be out of date.
      this.rerun = true;
      if (force) this.loadAll();
      return;
    }
    if (!this.stale && !force) return;
    this.busy = true;
    // Cleared when the build STARTS: a change landing while it runs marks the
    // session stale again. Clearing it at the end swallowed that change, and
    // the preview stayed on the older document until the next edit.
    this.stale = false;
    this.status("Building…");
    try {
      const wanted = new Set<ItemId>();
      for (const v of this.views) if (v.active()) wanted.add(this.symbolFor(v).id);
      if (wanted.size === 0) wanted.add(this.store.currentSymbol.id);
      const results = await buildExports(this.store.project, this.assets, [...wanted]);
      for (const r of results.values()) reportDiagnostics(r.diagnostics);
      this.results = results;

      this.loadAll();
      this.onBuilt(null);
    } catch (err) {
      this.stale = true;
      this.status(err instanceof Error ? err.message : String(err), true);
      this.onBuilt(err);
    } finally {
      this.busy = false;
      if (this.rerun) {
        this.rerun = false;
        if (this.stale && this.hasActiveView) this.scheduleRefresh();
      }
    }
  }

  /** The export error each view was last loaded with, if any. */
  private errorFor = new Map<PreviewView, string>();

  /** The last build, per symbol. */
  private results = new Map<ItemId, ExportResult>();

  private builtFor(view: PreviewView): ExportResult | undefined {
    return this.results.get(this.symbolFor(view).id);
  }

  /** Every active view whose symbol the last build has. A view whose symbol
   *  it lacks (the user opened another one meanwhile) waits for the rebuild
   *  that change scheduled. */
  private loadAll(): void {
    for (const view of this.views) {
      if (!view.active()) continue;
      const built = this.builtFor(view);
      if (built) this.loadInto(view, built);
    }
  }

  private loadInto(view: PreviewView, result: ExportResult): void {
    // Nothing to show. The frame has to be told so: leaving the previous
    // load up is how a new project kept showing the old one, behind a
    // status line saying there was nothing to show.
    if (isEmpty(result)) {
      this.errorFor.delete(view);
      view.host.clear();
      // Say why when the export knows: a scene holding only symbol instances
      // is empty until they export, and "nothing on the stage" reads as a bug.
      const why = result.diagnostics.find((d) => d.severity === "warning" && !d.message.startsWith("No images"));
      view.onStatus(why ? `Nothing to preview: ${why.message}` : "Nothing on the stage to preview yet.");
      return;
    }

    const opts = view.options();
    const target = this.targetFor(opts.scope ?? "symbol");
    // An export error still leaves a skeleton to show, but not the one the
    // stage draws: the preview must not look authoritative then.
    const error = result.diagnostics.find((d) => d.severity === "error");
    const text = error ? `Export error: ${error.message}` : "";
    if (text) this.errorFor.set(view, text); else this.errorFor.delete(view);
    view.onStatus(text, !!error);
    view.host.load(
      result.skeleton,
      result.atlas,
      result.pages.map((p) => ({ name: p.info.imagePath, png: p.blob })),
      {
        animation: target.animation,
        debugDraw: opts.debugDraw,
        play: opts.play,
        frame: target.frame,
        // An opened Spine rig has no stage: it is framed on its own.
        stage: opts.showStage && !target.spine ? { ...this.store.project.stage } : undefined,
        fit: target.fit,
        ...(target.skins.length ? { skins: target.skins } : {}),
      },
    );
  }

  /** The symbol a view shows: the scene, or the one being edited. */
  private symbolFor(view: PreviewView): SymbolItem {
    const project = this.store.project;
    const root = project.items[project.rootSymbolId];
    return (view.options().scope ?? "symbol") === "scene" && root && isSymbol(root) ? root : this.store.currentSymbol;
  }

  /**
   * Which timeline, at which frame.
   *
   * In `"symbol"` scope this is what is being EDITED, not the scene: the
   * playhead belongs to the open symbol, so running the root while the user
   * is inside a symbol seeks the runtime on a timeline that is not theirs —
   * an animation authored inside `eye_left` then sits at whatever frame the
   * scene's own (often one-frame) animation wraps to, and looks like it is
   * simply not happening.
   *
   * In `"scene"` scope the root runs on its own clock. The editor's playhead
   * is only handed over when the two are the same timeline; otherwise it
   * means nothing here and the scene starts at 0.
   */
  private targetFor(
    scope: PreviewScope,
  ): { animation?: string; frame: number; fit: { x: number; y: number; w: number; h: number }; skins: string[]; spine: boolean } {
    const project = this.store.project;
    const edited = this.store.currentSymbol;
    const root = project.items[project.rootSymbolId];
    const sym = scope === "scene" && root && isSymbol(root) ? root : edited;
    const here = sym.id === edited.id;

    const animation = here
      ? this.store.currentAnimation?.name
      : sym.animations[0]?.name;
    // The editor knows the rig's extent; Pixi cannot measure it. An opened
    // Spine rig is measured as the runtime draws it (meshes included).
    const skins = stageSkinOf(sym);
    const b = (sym.spine ? boneburstBounds(project, sym, skins) : null) ?? symbolBounds(project, sym.id);
    return {
      animation,
      frame: here ? this.store.ui.frame : 0,
      fit: { x: b.x, y: b.y, w: b.w, h: b.h },
      skins,
      spine: !!sym.spine,
    };
  }

  private status(text: string, isError = false): void {
    for (const v of this.views) if (v.active()) v.onStatus(text, isError);
  }
}

function reportDiagnostics(diags: { severity: string; message: string }[]): void {
  for (const d of diags) {
    if (d.severity === "error") console.error(`[Export] ${d.message}`);
    else console.warn(`[Export] ${d.message}`);
  }
}
