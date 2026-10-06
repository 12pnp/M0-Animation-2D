import type { DockviewApi, DockviewTheme, IContentRenderer } from "dockview-core";
// The UMD build: it carries Dockview's own styles (the ES module does not), injected on load.
import { createDockview, themeDark, themeLight } from "dockview-core/dist/dockview-core.js";
import { arrivalPlacement, DEFAULT_ORDER, type Deferred, defaultPlacement, type Placement, restoreWorkspace, saveWorkspace } from "./layout";
import { PANEL_TITLES, type PanelId } from "./panelIds";

/** Where the browser keeps the workspace (view-only state of the app, not of a document). */
export const WORKSPACE_KEY = "boneburst.workspace";

/** A built panel: its element, and what it does when the dock lays it out. */
export interface PanelContent {
  readonly element: HTMLElement;
  /** The panel's size, whenever Dockview lays it out (also in a floating group or popout window). */
  layout?(width: number, height: number): void;
}

/** The first-time sizes of the default layout's side panels, in pixels. */
const DEFAULT_SIZES: Partial<Record<PanelId, { width?: number; height?: number }>> = {
  rigTree: { width: 220 },
  properties: { width: 260 },
  timeline: { height: 230 },
};

/**
 * The docking shell (D6): Dockview owns splits, tabs, groups, drag and drop, floating groups and
 * popout windows; this only says which panels exist, where they first go, and how the layout is
 * kept. Float, pop out and maximize are on each tab's context menu (Dockview's own).
 */
export class Workspace {
  readonly api: DockviewApi;
  /** Panels a saved layout had and this build does not: applied when they arrive. */
  private deferred: Deferred = {};
  private saveTimer = 0;

  constructor(
    host: HTMLElement,
    private readonly panels: ReadonlyMap<PanelId, PanelContent>,
    /** Called for every popout window Dockview opens, so it can listen there (keys). */
    onWindow: (w: Window) => void,
  ) {
    this.api = createDockview(host, {
      theme: themeFor(prefersDark()),
      createComponent: ({ name }) => this.renderer(name as PanelId),
      getTabContextMenuItems: () => ["float", "popout", "maximize", "separator", "close"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", () => this.api.updateOptions({ theme: themeFor(prefersDark()) }));
    this.api.onDidAddPopoutGroup((p) => onWindow(p.window));
    this.restore();
    this.api.onDidLayoutChange(() => this.scheduleSave());
  }

  /** Take the page's theme again (a preference changed it). */
  refreshTheme(): void { this.api.updateOptions({ theme: themeFor(prefersDark()) }); }

  /** The built panels, in the reserved order. */
  get built(): PanelId[] { return DEFAULT_ORDER.filter((id) => this.panels.has(id)); }

  isOpen(id: PanelId): boolean { return !!this.api.getPanel(id); }

  /** Show a panel: bring it to the front, or put it back in its default place if it was closed. */
  show(id: PanelId): void {
    const open = this.api.getPanel(id);
    if (open) { open.api.setActive(); return; }
    this.add(id, defaultPlacement(id, this.present()), true);
    this.sizeAlone(id);
  }

  /** Close a panel (it can be shown again, in its default place). */
  close(id: PanelId): void { this.api.getPanel(id)?.api.close(); }

  /** Show the panel if it is closed, close it if it is open (the activity bar's buttons). */
  toggle(id: PanelId): void { if (this.isOpen(id)) this.close(id); else this.show(id); }

  /** Back to the default layout. */
  reset(): void {
    this.api.clear();
    this.deferred = {};
    this.defaultLayout();
  }

  private renderer(id: PanelId): IContentRenderer {
    const p = this.panels.get(id);
    if (!p) throw new Error(`No panel "${id}" in this build.`);
    return { element: p.element, init: () => {}, layout: (w: number, h: number) => p.layout?.(w, h) };
  }

  private present(): Set<string> { return new Set(this.api.panels.map((p) => p.id)); }

  /** Add a panel at `place`; tabbed in with another, it stays behind that one's tab unless `front`. */
  private add(id: PanelId, place: Placement, front = false): void {
    this.api.addPanel({
      id, component: id, title: PANEL_TITLES[id], inactive: !front && place.direction === "within",
      position: "referencePanel" in place ? { referencePanel: place.referencePanel, direction: place.direction } : { direction: place.direction },
    });
  }

  /** A panel alone in its group takes its default size (once the panels around it are placed). */
  private sizeAlone(id: PanelId): void {
    const size = DEFAULT_SIZES[id], group = this.api.getPanel(id)?.group;
    if (size && group && group.panels.length === 1) group.api.setSize(size);
  }

  private defaultLayout(): void {
    for (const id of this.built) this.add(id, defaultPlacement(id, this.present()));
    for (const id of this.built) this.sizeAlone(id);
    this.api.getPanel("stage")?.api.setActive();
  }

  /** The saved layout, or the default; then any built panel it lacks, where it belongs. */
  private restore(): void {
    let text: string | null = null;
    try { text = localStorage.getItem(WORKSPACE_KEY); } catch { /* storage blocked: the default */ }
    const saved = restoreWorkspace(text, new Set(this.built));
    if (saved) {
      try {
        this.api.fromJSON(saved.dockview);
        this.deferred = saved.deferred;
      } catch {
        this.api.clear();
      }
    }
    if (!this.api.panels.length) { this.defaultLayout(); return; }
    for (const id of this.built) {
      if (this.isOpen(id)) continue;
      this.add(id, arrivalPlacement(id, this.deferred, this.present()));
      this.sizeAlone(id);
    }
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(saveWorkspace(this.api.toJSON(), this.deferred)));
      } catch { /* storage full or blocked: the layout is not kept */ }
    }, 250);
  }
}

function prefersDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function themeFor(dark: boolean): DockviewTheme {
  return dark ? themeDark : themeLight;
}
