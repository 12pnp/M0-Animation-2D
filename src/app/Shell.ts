import { clear, cls, drag, h, on } from "@/view/widgets/dom";
import { icon, type IconName } from "@/view/icons";
import { Dock, type MenuEntry, type Panel, showMenu } from "@/view/widgets/Dock";
import { type ShellSizes, type Workspace, clampRightWidth } from "@/view/widgets/workspaces";
import type { DockLayout } from "@/view/widgets/dockDrop";
import { onAccelChange, withAccel } from "@/view/widgets/accel";
import { APP_NAME, documentTitle } from "@/core/about";
// The glyph alone, no rounded-square background: the menu bar already is a
// dark bar, and the app icon's own panel inside it reads as a second one.
import markSvg from "@/assets/amino-mark.svg?raw";
import type { Store } from "./Store";
import { SetStageSkins } from "@/core/history/commands";
import { skinsOf, stageSkinOf } from "@/core/spine/spinePose";

export interface MenuItemDef {
  label: string;
  accel?: string;
  /** Registered command; its current key is shown unless `accel` is set. */
  command?: string;
  /** Omitted for a row that only opens `items`. */
  run?: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** A submenu, resolved when the parent menu opens like everything else. */
  items?: Array<MenuItemDef | "-">;
}

export interface MenuDef {
  label: string;
  /**
   * A function when the entries themselves change — the recent-files list
   * grows, panels come and go. Resolved when the menu opens, not when the
   * menu bar is built.
   */
  items: Array<MenuItemDef | "-"> | (() => Array<MenuItemDef | "-">);
}

/** `MenuItemDef` -> what `showMenu` wants: the lazy `enabled`/`checked`
 *  predicates are called now, as the menu opens, submenus included. */
function resolveMenuItem(it: MenuItemDef | "-"): MenuEntry | "-" {
  if (it === "-") return "-";
  return {
    label: it.label,
    accel: it.accel,
    command: it.command,
    run: it.run,
    enabled: it.enabled ? it.enabled() : true,
    checked: it.checked ? it.checked() : false,
    items: it.items?.map(resolveMenuItem),
  };
}

/**
 * Builds and owns the application chrome: menu bar, tool rail, stage host,
 * bottom dock and right dock. Panels are supplied by App; the Shell only
 * knows how to arrange them.
 */
export class Shell {
  readonly el: HTMLElement;
  readonly stageHost: HTMLElement;
  readonly bottomDock: Dock;
  /** The right dock's columns, left to right; a workspace sets how many. */
  private rightDocks: Dock[] = [];
  private rightCols: HTMLElement = h("div", { class: "dock-cols" });
  /** The left panel: a dock column between the tool rail and the stage. The
   *  AI panel starts in it; any panel can be dragged in or out. */
  readonly leftDock: Dock;
  private leftWrap: HTMLElement = h("div", { class: "dock-left collapsed" });
  /** The two side toggles and the panel buttons under each: the same
   *  component on both sides (`railButton`), rebuilt by `syncRails`. */
  private leftToggle: HTMLElement;
  private rightToggle: HTMLElement;
  private leftPanelsEl: HTMLElement = h("div", { class: "rail-panels" });
  private rightPanelsEl: HTMLElement = h("div", { class: "rail-panels" });

  private crumbEl: HTMLElement;
  private menubarEl: HTMLElement;
  private rightRail: HTMLElement;
  private rightWrap: HTMLElement;
  private bottomWrap: HTMLElement;
  private menus: MenuDef[] = [];
  private docNameEl: HTMLElement;
  private docTabEl: HTMLElement;
  /** Each panel's place in its rail: the order it was added in. */
  private panelOrder = new Map<string, number>();
  /** The left panel's width while it is closed (a hidden element measures 0). */
  private leftWidth = 380;
  private syncAiButton: () => void = () => {};
  /** Where App puts the Play-mode transport, built after the shell. */
  readonly playSlot: HTMLElement = h("div", { class: "stage-play" });
  /** The name of the file on disk. Supplied by App, because ProjectService —
   *  which owns the file handle — is built after the shell. */
  docTitle: (() => string) | null = null;
  /** What the brand in the menu bar does. Set by `App`, which owns the About
   *  dialog: the shell knows the layout, not what is in it. */
  onBrand: (() => void) | null = null;
  /** What the gear at the right of the menu bar opens. Set by `App`. */

  constructor(private readonly store: Store) {
    this.leftDock = new Dock("animo.dock.left", "vertical");
    for (let i = 0; i < storedColumnCount(); i++) this.addRightColumn();
    this.bottomDock = new Dock("animo.dock.bottom", "vertical");
    this.leftWrap.appendChild(this.leftDock.el);
    for (const d of [this.leftDock, this.bottomDock]) d.onLayoutChange = () => this.syncRails();
    this.leftToggle = this.railButton("sidebarLeft", "Show / hide the left panel", () => this.setLeftOpen(!this.leftOpen));
    this.rightToggle = this.railButton("sidebarRight", "Show / hide the right panels", () => this.setRightOpen(this.rightCollapsed));

    this.menubarEl = h("div", { class: "menubar" });
    this.docNameEl = h("span", { class: "docname" });
    this.crumbEl = h("div", { class: "crumb" });
    this.docTabEl = this.buildDocTab();
    this.syncDocName();
    this.stageHost = h("div", { class: "stage-host", tabIndex: 0 });
    this.rightRail = h("div", { class: "rail-right" });

    const toolsEl = this.buildTools();
    const stageRegion = this.buildStageRegion();

    this.bottomWrap = h("div", { class: "bottom" });
    this.bottomWrap.appendChild(this.bottomDock.el);

    this.rightWrap = h("div", { class: "dock-right" });
    this.rightWrap.appendChild(this.rightCols);

    const vSplit = this.buildVerticalSplitter();
    const hSplit = this.buildHorizontalSplitter();
    const leftSplit = this.buildLeftSplitter();

    this.el = h("div", { class: "shell" },
      this.menubarEl,
      toolsEl,
      this.leftWrap,
      leftSplit,
      stageRegion,
      hSplit,
      this.bottomWrap,
      vSplit,
      this.rightWrap,
      this.rightRail,
    );

    this.buildRightRail();
    this.restoreSizes();
    this.syncRails();
    this.store.subscribe((topic) => {
      if (topic === "doc" || topic === "ui") { this.syncCrumb(); this.syncMenus(); }
    });
  }

  // ── Menu bar ───────────────────────────────────────────────────────────

  setMenus(menus: MenuDef[]): void {
    this.menus = menus;
    this.renderMenubar();
  }

  private renderMenubar(): void {
    clear(this.menubarEl);
    const brand = h("button", { class: "brand", title: `About ${APP_NAME}` });
    const mark = h("span", { class: "brand-mark" });
    // `innerHTML`, not `svg()` from dom.ts: that helper forces a 16x16 viewBox.
    mark.innerHTML = markSvg;
    brand.append(mark);
    on(brand, "pointerup", () => this.onBrand?.());
    this.menubarEl.appendChild(brand);
    for (const m of this.menus) {
      const btn = h("button", { class: "menu-item" }, m.label);
      on(btn, "click", () => {
        const items = typeof m.items === "function" ? m.items() : m.items;
        showMenu(btn, items.map(resolveMenuItem));
      });
      this.menubarEl.appendChild(btn);
    }
    this.menubarEl.append(this.docTabEl);
  }

  private syncMenus(): void { /* enabled/checked are read lazily on open */ }

  /**
   * One document per window, so no tab strip: the FILE on disk and whether it
   * has unsaved changes sit at the right end of the menu bar.
   *
   * The file name, not the project name: those two drifted apart the moment
   * anyone used Save As, and this is the one place that has to say which
   * file a ⌘S will overwrite. The project name lives on as the exported
   * skeleton's name and is edited in Document settings.
   */
  private buildDocTab(): HTMLElement {
    const tab = h("div", { class: "doctab" }, this.docNameEl);
    this.store.subscribe((t) => { if (t === "doc" || t === "library") this.syncDocName(); });
    return tab;
  }

  syncDocName(): void {
    const name = this.docTitle?.() ?? this.store.project.name;
    const dirty = this.store.history.isDirty;
    this.docNameEl.textContent = name + (dirty ? " *" : "");
    this.docTabEl.title = name;
    document.title = documentTitle(name, dirty);
  }

  // ── Left rail ──────────────────────────────────────────────────────────

  /** The rail left of everything: the left panel's toggle on top, its panel
   *  buttons at the foot. The tools are on the stage (`StageToolbar`). */
  private buildTools(): HTMLElement {
    return h("div", { class: "tools" }, this.leftToggle, this.leftPanelsEl);
  }

  // ── Stage region ───────────────────────────────────────────────────────

  private buildStageRegion(): HTMLElement {
    const zoomSel = h("select", { class: "zoomsel", title: "Zoom" });
    for (const z of [10, 25, 50, 75, 100, 200, 400, 800]) {
      zoomSel.appendChild(h("option", { value: String(z) }, `${z}%`));
    }
    zoomSel.value = "100";
    on(zoomSel, "change", () => {
      this.store.setUi({ zoom: Number(zoomSel.value) / 100 }, "stage");
    });
    this.store.subscribe((t) => {
      if (t === "stage" || t === "ui") {
        const pct = Math.round(this.store.ui.zoom * 100);
        if (zoomSel.value !== String(pct)) {
          const has = Array.from(zoomSel.options).some((o) => o.value === String(pct));
          if (!has) zoomSel.appendChild(h("option", { value: String(pct) }, `${pct}%`));
          zoomSel.value = String(pct);
        }
      }
    });

    const toggles = h("div", { class: "stage-toggles" },
      this.toggleBtn("ruler", "Rulers", () => this.store.ui.showRulers,
        (v) => this.store.setViewFlag("showRulers", v)),
      this.toggleBtn("grid", "Grid", () => this.store.ui.showGrid,
        (v) => this.store.setViewFlag("showGrid", v)),
      this.toggleBtn("snap", "Snapping (choose what to snap to in View ▸ Snap To)",
        () => this.store.snappingOn,
        () => this.store.toggleSnapping()),
      this.toggleBtn("bone", "Show bones", () => this.store.ui.showBones,
        (v) => this.store.setViewFlag("showBones", v)),
      this.toggleBtn("axes",
        "Show gizmos: the axes of the selected object and the directions its X and Y move in",
        () => this.store.ui.showGizmos,
        (v) => this.store.setViewFlag("showGizmos", v)),
      this.toggleBtn("bonePath",
        "Show bone paths (⌥B): where each selected bone moves over the animation",
        () => this.store.ui.showBonePaths,
        (v) => this.store.setViewFlag("showBonePaths", v)),
    );

    // Two spacers, so the play cluster is CENTRED rather than pushed to one
    // side: it is the mode the whole stage is in, not another toggle.
    const aiBtn = h("button", { class: "ai-toggle", title: "Show or hide the AI panel" }, "✦ AI");
    on(aiBtn, "click", () => this.togglePanel(AI_PANEL));
    this.syncAiButton = () => cls(aiBtn, "on", this.isPanelShown(AI_PANEL));

    const bar = h("div", { class: "stage-bar" },
      aiBtn,
      h("div", { class: "sep-v" }),
      this.crumbEl,
      h("div", { class: "spacer" }),
      this.playSlot,
      h("div", { class: "spacer" }),
      this.buildSkinPicker(),
      this.buildModeSwitch(),
      h("div", { class: "sep-v" }),
      toggles,
      h("div", { class: "sep-v" }),
      zoomSel,
    );
    this.syncCrumb();
    return h("div", { class: "stage-region" }, bar, this.stageHost);
  }

  /**
   * Setup / Animate, as a segmented switch.
   *
   * The mode changes what every drag writes — the bone's rest pose or a
   * keyframe at the playhead — so it cannot live only as a checkmark inside a
   * menu nobody has open. The stage grows a coloured edge to match while
   * Setup is on.
   */
  private buildModeSwitch(): HTMLElement {
    const seg = (label: string, mode: "setup" | "animate", name: string, rest: string) => {
      const btn = h("button", { class: "seg" }, label);
      const title = () => { btn.title = `${withAccel(name, "modify.setupMode")}: ${rest}`; };
      title();
      onAccelChange(title);
      on(btn, "click", () => this.store.setMode(mode));
      return btn;
    };
    const setup = seg("Setup", "setup", "Setup pose",
      "edits the rest pose: where each bone sits before any animation");
    const animate = seg("Animate", "animate", "Animate",
      "every change sets a keyframe at the current frame");

    const el = h("div", { class: "modesw" }, setup, animate);
    const sync = () => {
      cls(setup, "on", this.store.ui.mode === "setup");
      cls(animate, "on", this.store.ui.mode === "animate");
      cls(el, "setup", this.store.ui.mode === "setup");
    };
    this.store.subscribe((t) => { if (t === "doc" || t === "ui" || t === "stage") sync(); });
    sync();
    return el;
  }

  /**
   * An opened rig's skins, for the stage and the Preview: none, one, or
   * several combined, as a game combines them. Skins named with a folder
   * ("accessories/bag") are grouped by it. Only shown for a rig that has
   * skins beyond the default one.
   */
  private buildSkinPicker(): HTMLElement {
    const btn = h("button", { class: "skinpick" }) as HTMLButtonElement;
    const sync = () => {
      const sym = this.store.currentSymbol;
      const named = sym.spine ? skinsOf(sym).filter((n) => n !== "default") : [];
      btn.style.display = named.length ? "" : "none";
      const shown = stageSkinOf(sym);
      const label = shown.length ? shown.join(" + ") : "default";
      btn.textContent = `Skin: ${label} ▾`;
      btn.title = `The skins the stage and Preview show: ${label}${sym.stageSkins ? "" : " (automatic)"}`;
    };
    on(btn, "click", () => {
      const sym = this.store.currentSymbol;
      const named = skinsOf(sym).filter((n) => n !== "default");
      const shown = stageSkinOf(sym);
      const set = (skins: string[] | null) => this.store.apply(new SetStageSkins(sym.id, skins));
      const toggle = (name: string) => {
        const next = shown.includes(name) ? shown.filter((n) => n !== name) : [...shown, name];
        set(named.filter((n) => next.includes(n)));
      };
      const entry = (name: string, label: string): MenuEntry => ({ label, checked: shown.includes(name), run: () => toggle(name) });
      const folders = new Map<string, MenuEntry[]>();
      const items: Array<MenuEntry | "-"> = [
        { label: "Default skin only", checked: shown.length === 0, run: () => set([]) },
        { label: "Automatic", checked: !sym.stageSkins, run: () => set(null) },
        "-",
      ];
      for (const name of named) {
        const slash = name.indexOf("/");
        if (slash < 0) { items.push(entry(name, name)); continue; }
        const folder = name.slice(0, slash);
        if (!folders.has(folder)) {
          const sub: MenuEntry[] = [];
          folders.set(folder, sub);
          // Ticked while any skin inside is shown.
          items.push({ label: folder, items: sub, checked: named.some((n) => n.startsWith(`${folder}/`) && shown.includes(n)) });
        }
        folders.get(folder)!.push(entry(name, name.slice(slash + 1)));
      }
      showMenu(btn, items);
    });
    this.store.subscribe((t) => { if (t === "doc" || t === "ui" || t === "stage") sync(); });
    sync();
    return btn;
  }

  private toggleBtn(
    name: IconName, title: string, get: () => boolean, set: (v: boolean) => void,
  ): HTMLElement {
    const btn = h("button", { class: "iconbtn", title });
    btn.appendChild(icon(name, 13));
    const sync = () => cls(btn, "on", get());
    on(btn, "click", () => { set(!get()); sync(); });
    this.store.subscribe((t) => { if (t === "stage" || t === "ui") sync(); });
    sync();
    return btn;
  }

  private syncCrumb(): void {
    clear(this.crumbEl);
    const back = h("button", { class: "iconbtn", title: "Back" });
    back.appendChild(icon("back", 13));
    const depth = this.store.ui.editPath.length;
    (back as HTMLButtonElement).disabled = depth <= 1;
    on(back, "click", () => this.store.exitToDepth(depth - 2));
    this.crumbEl.appendChild(back);

    this.store.ui.editPath.forEach((id, i) => {
      const item = this.store.project.items[id];
      if (i > 0) {
        const chev = h("span", { class: "chev" });
        chev.appendChild(icon("chevRight", 10));
        this.crumbEl.appendChild(chev);
      } else {
        const sc = h("span", { class: "chev" });
        sc.appendChild(icon("scene", 13));
        this.crumbEl.appendChild(sc);
      }
      const last = i === this.store.ui.editPath.length - 1;
      const step = h("button", { class: `step${last ? " current" : ""}` }, item?.name ?? "?");
      on(step, "click", () => this.store.exitToDepth(i));
      this.crumbEl.appendChild(step);
    });
  }

  // ── Docks ──────────────────────────────────────────────────────────────

  /** The right dock's first column. */
  get rightDock(): Dock { return this.rightDocks[0]!; }

  private get docks(): Dock[] { return [this.leftDock, ...this.rightDocks, this.bottomDock]; }

  private addRightColumn(): Dock {
    const n = this.rightDocks.length;
    const dock = new Dock(n === 0 ? "animo.dock.right" : `animo.dock.right.${n + 1}`, "vertical");
    // Equal shares of the dock's width, whatever the panels inside would like.
    dock.el.style.flex = "1 1 0";
    dock.el.style.minWidth = "0";
    dock.onLayoutChange = () => this.syncRails();
    this.rightDocks.push(dock);
    this.rightCols.appendChild(dock.el);
    return dock;
  }

  addRightPanel(panel: Panel): void {
    this.panelOrder.set(panel.id, this.panelOrder.size);
    this.homeDock(panel.id, this.rightDock).register(panel);
  }

  addBottomPanel(panel: Panel): void {
    this.panelOrder.set(panel.id, this.panelOrder.size);
    this.homeDock(panel.id, this.bottomDock).register(panel);
  }

  addLeftPanel(panel: Panel): void {
    this.panelOrder.set(panel.id, this.panelOrder.size);
    this.homeDock(panel.id, this.leftDock).register(panel);
  }

  /** A panel's tab can be dragged to another dock or column; the saved
   *  layouts say where it went. */
  private homeDock(id: string, usual: Dock): Dock {
    if (usual.stores(id)) return usual;
    return this.docks.find((d) => d !== usual && d.stores(id)) ?? usual;
  }

  private dockOf(id: string): Dock | undefined {
    return this.docks.find((d) => d.has(id));
  }

  // ── Panel visibility (the Window menu) ─────────────────────────────────

  /**
   * Bring a panel on screen: reopen it if it was closed, expand its group,
   * make it the active tab — and, easy to forget, un-collapse the side column
   * it is in, without which every one of these does its job invisibly.
   */
  showPanel(id: string): void {
    const dock = this.dockOf(id);
    if (!dock) return;
    if (!dock.isFloating(id)) {
      if (this.rightDocks.includes(dock)) this.expandRightDock();
      if (dock === this.leftDock && !this.leftOpen) this.setLeftOpen(true);
    }
    dock.focus(id);
  }

  /** Hide a panel that is on screen, show one that is not. Closing the last
   *  panel in the left column folds the column away rather than leaving it empty. */
  togglePanel(id: string): void {
    const dock = this.dockOf(id);
    if (!dock) return;
    if (!this.isPanelShown(id)) { this.showPanel(id); return; }
    dock.close(id);
    if (dock === this.leftDock && this.leftDock.isEmpty()) this.setLeftOpen(false);
  }

  /** On screen right now: open, its tab active, and its column not hidden. */
  isPanelShown(id: string): boolean {
    const dock = this.dockOf(id);
    if (!dock || !dock.isOpen(id)) return false;
    if (dock.isFloating(id)) return true;
    return dock.isVisible(id) && this.columnShown(dock);
  }

  private columnShown(dock: Dock): boolean {
    if (dock === this.leftDock) return this.leftOpen;
    if (this.rightDocks.includes(dock)) return !this.rightCollapsed;
    return true;
  }

  floatPanel(id: string): void {
    const dock = this.dockOf(id);
    if (!dock) return;
    if (dock.isFloating(id)) dock.dockPanel(id);
    else dock.float(id);
  }

  isPanelOpen(id: string): boolean {
    const dock = this.dockOf(id);
    return !!dock && dock.isOpen(id) && (dock.isFloating(id) || this.columnShown(dock));
  }

  isPanelFloating(id: string): boolean {
    return !!this.dockOf(id)?.isFloating(id);
  }

  private get rightCollapsed(): boolean {
    return this.rightWrap.classList.contains("collapsed");
  }

  private expandRightDock(): void {
    if (this.rightCollapsed) this.setRightOpen(true);
  }

  setRightOpen(open: boolean): void {
    this.rightWrap.classList.toggle("collapsed", !open);
    this.saveSizes();
    this.syncRails();
    window.dispatchEvent(new Event("resize"));
  }

  layoutDocks(right: string[][], bottom: string[][], left: string[][]): void {
    this.leftDock.setDefault(left);
    this.rightDocks.forEach((d, i) => d.setDefault(i === 0 ? right : []));
    this.bottomDock.setDefault(bottom);
    this.syncRails();
  }

  private buildRightRail(): void {
    this.rightRail.append(this.rightToggle, this.rightPanelsEl);
  }

  /** A rail button: the side toggles and the panel buttons look alike on both
   *  sides, lit (`on`) while what they control is on screen. */
  private railButton(name: IconName, title: string, run: () => void): HTMLElement {
    const btn = h("button", { class: "rail-btn", title });
    btn.appendChild(icon(name, 16));
    on(btn, "click", run);
    return btn;
  }

  /** One button per panel a side holds, wherever it was dragged: click shows
   *  the panel (opening its column) or hides it. Rebuilt on every layout change. */
  private fillRail(el: HTMLElement, panels: Panel[]): void {
    clear(el);
    if (panels.length === 0) return;
    el.appendChild(h("div", { class: "rule" }));
    // In the order the panels were added, not the layout's: closing, floating
    // or dragging a tab within a side must not move its button.
    const order = (p: Panel) => this.panelOrder.get(p.id) ?? Infinity;
    for (const p of [...panels].sort((a, b) => order(a) - order(b))) {
      const btn = this.railButton(p.icon, `Show / hide ${p.title}`, () => this.togglePanel(p.id));
      cls(btn, "on", this.isPanelShown(p.id));
      el.appendChild(btn);
    }
  }

  private syncRails(): void {
    cls(this.leftToggle, "on", this.leftOpen);
    cls(this.rightToggle, "on", !this.rightCollapsed);
    this.fillRail(this.leftPanelsEl, this.leftDock.panelList());
    this.fillRail(this.rightPanelsEl, this.rightDocks.flatMap((d) => d.panelList()));
    this.syncAiButton();
  }

  // ── Region splitters ───────────────────────────────────────────────────

  private buildVerticalSplitter(): HTMLElement {
    const sp = h("div", { class: "splitter v" });
    let start = 268;
    drag(sp, {
      cursor: "ew-resize",
      onStart: () => { start = this.rightWrap.offsetWidth; sp.classList.add("dragging"); },
      onMove: (dx) => {
        const w = clampRightWidth(start - dx, this.rightDocks.length, innerWidth);
        this.rightWrap.style.width = `${w}px`;
      },
      onEnd: () => { sp.classList.remove("dragging"); this.saveSizes(); },
    });
    return sp;
  }

  /** The left panel's right edge. */
  private buildLeftSplitter(): HTMLElement {
    const sp = h("div", { class: "splitter v left-split" });
    let start = 380;
    drag(sp, {
      cursor: "ew-resize",
      onStart: () => { start = this.leftWrap.offsetWidth; sp.classList.add("dragging"); },
      onMove: (dx) => {
        const w = Math.max(220, Math.min(900, innerWidth - 480, start + dx));
        this.leftWrap.style.width = `${w}px`;
      },
      onEnd: () => { sp.classList.remove("dragging"); this.saveSizes(); },
    });
    return sp;
  }

  get leftOpen(): boolean { return !this.leftWrap.classList.contains("collapsed"); }

  setLeftOpen(open: boolean): void {
    this.leftWrap.classList.toggle("collapsed", !open);
    this.el.classList.toggle("left-open", open);
    this.saveSizes();
    this.syncRails();
    // The stage canvas measures its host on resize.
    window.dispatchEvent(new Event("resize"));
  }

  private buildHorizontalSplitter(): HTMLElement {
    const sp = h("div", { class: "splitter h" });
    sp.style.gridArea = "bottom";
    sp.style.alignSelf = "start";
    sp.style.marginTop = "-3px";
    sp.style.zIndex = "6";
    let start = 200;
    drag(sp, {
      cursor: "ns-resize",
      onStart: () => { start = this.bottomWrap.offsetHeight; sp.classList.add("dragging"); },
      onMove: (_dx, dy) => {
        const hgt = Math.max(84, Math.min(innerHeight - 220, start - dy));
        this.bottomWrap.style.height = `${hgt}px`;
      },
      onEnd: () => { sp.classList.remove("dragging"); this.saveSizes(); },
    });
    return sp;
  }

  private sizes(): ShellSizes {
    if (this.leftOpen && this.leftWrap.offsetWidth) this.leftWidth = this.leftWrap.offsetWidth;
    return {
      right: this.rightWrap.offsetWidth,
      bottom: this.bottomWrap.offsetHeight,
      rightHidden: this.rightWrap.classList.contains("collapsed"),
      ai: this.leftWidth,
      aiOpen: this.leftOpen,
      rightColumns: this.rightDocks.length,
    };
  }

  private saveSizes(): void {
    try { localStorage.setItem("animo.sizes", JSON.stringify(this.sizes())); } catch { /* private mode */ }
  }

  private restoreSizes(): void {
    this.bottomWrap.style.height = "200px";
    try {
      const raw = localStorage.getItem("animo.sizes");
      if (!raw) return;
      const s = JSON.parse(raw) as ShellSizes;
      if (s.ai) { this.leftWidth = s.ai; this.leftWrap.style.width = `${s.ai}px`; }
      if (s.aiOpen) { this.leftWrap.classList.remove("collapsed"); this.el.classList.add("left-open"); }
      if (s.right) this.rightWrap.style.width = `${s.right}px`;
      if (s.bottom) this.bottomWrap.style.height = `${s.bottom}px`;
      if (s.rightHidden) this.rightWrap.classList.add("collapsed");
    } catch { /* ignore */ }
  }

  // ── Workspaces ─────────────────────────────────────────────────────────

  /** The current arrangement of both docks and the regions around the stage. */
  workspace(): Workspace {
    const [first, ...rest] = this.rightDocks;
    return {
      left: this.leftDock.snapshot(),
      right: first!.snapshot(),
      ...(rest.length ? { columns: rest.map((d) => d.snapshot()) } : {}),
      bottom: this.bottomDock.snapshot(),
      sizes: this.sizes(),
    };
  }

  /** Arrange the window as `ws` was saved. Live, without a reload: a reload
   *  would put unsaved work through the restore banner. */
  applyWorkspace(ws: Workspace): void {
    const columns = [ws.right, ...(ws.columns ?? [])];
    while (this.rightDocks.length < columns.length) this.addRightColumn();
    const retiring = this.rightDocks.splice(columns.length);
    Dock.applyLayouts([
      // A workspace saved before the left panel existed leaves it as it is.
      [this.leftDock, ws.left ?? this.leftDock.snapshot()],
      ...this.rightDocks.map((d, i): [Dock, DockLayout] => [d, columns[i]!]),
      [this.bottomDock, ws.bottom],
    ], retiring);
    const s = ws.sizes;
    if (s.ai) { this.leftWidth = s.ai; this.leftWrap.style.width = `${s.ai}px`; }
    if (s.right) this.rightWrap.style.width = `${clampRightWidth(s.right, columns.length, innerWidth)}px`;
    if (s.bottom) this.bottomWrap.style.height = `${s.bottom}px`;
    if (s.rightHidden !== undefined) this.rightWrap.classList.toggle("collapsed", s.rightHidden);
    // setLeftOpen saves the sizes and tells the stage to re-measure.
    this.setLeftOpen(s.aiOpen ?? this.leftOpen);
  }

  resetLayout(): void {
    for (const d of this.docks) d.resetLayout();
    try { localStorage.removeItem("animo.sizes"); } catch { /* ignore */ }
    location.reload();
  }
}

/** The AI panel's dock id: the stage bar's AI button shows and hides it. */
export const AI_PANEL = "ai";

/** Columns the right dock had when the page last saved its sizes. */
function storedColumnCount(): number {
  try {
    const n = (JSON.parse(localStorage.getItem("animo.sizes") ?? "{}") as ShellSizes).rightColumns;
    return typeof n === "number" ? Math.max(1, Math.min(4, Math.round(n))) : 1;
  } catch { return 1; }
}

