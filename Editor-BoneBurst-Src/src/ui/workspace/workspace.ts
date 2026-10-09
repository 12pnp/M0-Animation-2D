import type { DockviewApi, DockviewTheme, IContentRenderer, ITabRenderer } from "dockview-core";
import { createDockview, themeDark, themeLight } from "dockview-core";
// Dockview's own styles, taken from its package at build time (vite.config.ts, E7-PLAN step 3).
import "virtual:dockview.css";
import { arrivalPlacement, DEFAULT_ORDER, type Deferred, defaultPlacement, type Placement, restoreWorkspace, saveWorkspace } from "./layout";
import { icon } from "../icons";
import { PANEL_ICONS, PANEL_TITLES, type PanelId } from "./panelIds";
import { panelMenu } from "./panelMenu";

/** Where the browser keeps the workspace (view-only state of the app, not of a document). */
export const WORKSPACE_KEY = "boneburst.workspace";

/** Each mode keeps its own layout: the setup pose's (the original key) and the animation's. */
export type WorkspaceMode = "pose" | "animate";
const animateKey = `${WORKSPACE_KEY}.animate`;
/** The projects whose layouts are kept (the oldest go first) and how many. */
const PROJECTS_KEY = `${WORKSPACE_KEY}.projects`;
const KEEP_PROJECTS = 40;

/** A built panel: its element, and what it does when the dock lays it out. */
export interface PanelContent {
  readonly element: HTMLElement;
  /** The panel's size, whenever Dockview lays it out (also in a floating group or popout window). */
  layout?(width: number, height: number): void;
  /** Put the panel's own layout back (its view, columns, floating cards): the panel menu's Reset This Panel's Layout. */
  reset?(): void;
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
  private mode: WorkspaceMode = "pose";
  /** The open project whose layout this is (each project keeps its own, per mode); null: the general one, before any project is open. */
  private project: string | null = null;
  /** Panels the saved layout had closed: they are not brought back with the panels a build adds. */
  private closed = new Set<PanelId>();
  /** The popout windows Dockview opened, for the theme to follow them. */
  private readonly popouts = new Set<Window>();

  constructor(
    host: HTMLElement,
    private readonly panels: ReadonlyMap<PanelId, PanelContent>,
    /** Called for every popout window Dockview opens, so it can listen there (keys). */
    onWindow: (w: Window) => void,
    /** The extra menu's Info: show what a panel is for. */
    onInfo: (id: PanelId) => void = () => {},
  ) {
    this.api = createDockview(host, {
      theme: themeFor(prefersDark()),
      createComponent: ({ name }) => this.renderer(name as PanelId),
      createTabComponent: ({ id }) => tabRenderer(id as PanelId),
      defaultTabComponent: "tab",
      createRightHeaderActionComponent: panelMenu({
        info: onInfo,
        canReset: (id) => this.panels.has(id),
        // A panel without a layout of its own is scrolled back to its top and left.
        reset: (id) => {
          const p = this.panels.get(id);
          if (p?.reset) { p.reset(); return; }
          p?.element.querySelectorAll<HTMLElement>("*").forEach((n) => { n.scrollTop = 0; n.scrollLeft = 0; });
        },
        putBack: (id) => { this.close(id); this.show(id); },
        resetLayout: () => this.reset(),
      }),
      getTabContextMenuItems: () => ["float", "popout", "maximize", "separator", "close"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", () => this.api.updateOptions({ theme: themeFor(prefersDark()) }));
    // A popout window is a document of its own: its <html> takes the main page's theme and appearance values, now and on every change
    // (docs/POPOUT-THEME-PLAN.md).
    this.api.onDidAddPopoutGroup((p) => { this.popouts.add(p.window); mirrorRoot(p.window); onWindow(p.window); });
    new MutationObserver(() => {
      for (const w of this.popouts) { if (w.closed) this.popouts.delete(w); else mirrorRoot(w); }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
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
    try { text = localStorage.getItem(this.storageKey()); } catch { /* storage blocked: the default */ }
    const saved = restoreWorkspace(text, new Set(this.built));
    if (saved) {
      try {
        this.api.fromJSON(saved.dockview);
        this.deferred = saved.deferred;
        this.closed = new Set(saved.closed);
      } catch {
        this.api.clear();
      }
    }
    if (!this.api.panels.length) { this.defaultLayout(); return; }
    for (const id of this.built) {
      if (this.isOpen(id) || this.closed.has(id)) continue;
      this.add(id, arrivalPlacement(id, this.deferred, this.present()));
      this.sizeAlone(id);
    }
  }

  private storageKey(): string {
    const base = this.mode === "pose" ? WORKSPACE_KEY : animateKey;
    return this.project === null ? base : `${base}.project.${this.project}`;
  }

  private saveNow(): void {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(saveWorkspace(this.api.toJSON(), this.deferred, this.built.filter((id) => !this.isOpen(id)))));
      if (this.project !== null) this.trimProjects();
    } catch { /* storage full or blocked: the layout is not kept */ }
  }

  /** The projects whose layouts are kept, oldest first: past KEEP_PROJECTS the oldest are let go. */
  private trimProjects(): void {
    const index = (JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "[]") as string[]).filter((n) => n !== this.project);
    index.push(this.project!);
    for (const old of index.splice(0, Math.max(0, index.length - KEEP_PROJECTS))) { localStorage.removeItem(`${WORKSPACE_KEY}.project.${old}`); localStorage.removeItem(`${animateKey}.project.${old}`); }
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(index));
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 250);
  }

  /**
   * Switch to a mode's layout: the one it was left with, or, the first time, the layout as it is now
   * (which it then keeps). The layout being left is saved first.
   */
  setMode(mode: WorkspaceMode): void {
    if (mode === this.mode) return;
    clearTimeout(this.saveTimer);
    this.saveNow();
    this.mode = mode;
    this.loadScope();
  }

  /**
   * Switch to a project's layout (null: the general one): the one that project was left with, or, the first time, the layout
   * as it is now (which it then keeps). The layout being left is saved first.
   */
  setProject(project: string | null): void {
    if (project === this.project) return;
    clearTimeout(this.saveTimer);
    this.saveNow();
    this.project = project;
    this.loadScope();
  }

  /** Take the layout kept for the current mode and project; with none, keep this one and save it there. */
  private loadScope(): void {
    let text: string | null = null;
    try { text = localStorage.getItem(this.storageKey()); } catch { /* storage blocked: keep this layout */ }
    const saved = restoreWorkspace(text, new Set(this.built));
    if (!saved) { this.saveNow(); return; }
    try {
      this.api.fromJSON(saved.dockview);
      this.deferred = saved.deferred;
      this.closed = new Set(saved.closed);
    } catch {
      return;
    }
    for (const id of this.built) {
      if (this.isOpen(id) || this.closed.has(id)) continue;
      this.add(id, arrivalPlacement(id, this.deferred, this.present()));
      this.sizeAlone(id);
    }
  }
}

/** A popout window's <html> made like the main page's: the theme forced (or not) and the inline appearance values. */
function mirrorRoot(w: Window): void {
  const from = document.documentElement, to = w.document?.documentElement;
  if (!to) return;
  for (const name of ["data-theme", "style"]) {
    const v = from.getAttribute(name);
    if (v === null) to.removeAttribute(name);
    else if (to.getAttribute(name) !== v) to.setAttribute(name, v);
  }
}

function prefersDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function themeFor(dark: boolean): DockviewTheme {
  return dark ? themeDark : themeLight;
}

/**
 * A panel's tab: its icon and title, no close button. Middle click closes the panel (Shift+click
 * too, for a mouse without a middle button); the right-click menu is Dockview's own.
 */
function tabRenderer(id: PanelId): ITabRenderer {
  const element = document.createElement("div");
  element.className = "panel-tab";
  const title = document.createElement("span");
  title.textContent = PANEL_TITLES[id];
  element.append(icon(PANEL_ICONS[id]), title);
  return {
    element,
    init: ({ api }) => {
      title.textContent = api.title || PANEL_TITLES[id];
      // A middle press would start the browser's autoscroll; the close is on its release.
      element.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
      element.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); api.close(); } });
      element.addEventListener("click", (e) => { if (e.shiftKey) { e.preventDefault(); e.stopPropagation(); api.close(); } }, true);
    },
  };
}
