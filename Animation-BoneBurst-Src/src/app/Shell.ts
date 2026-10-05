import { clear, cls, drag, h, on } from "@/view/widgets/dom";
import { icon, type IconName } from "@/view/icons";
import { Dock, type MenuEntry, type Panel, showMenu } from "@/view/widgets/Dock";
import {
  type ColumnKey, type ShellSizes, type Workspace, STAGE_MIN, clampColumnWidth, columnSizes, fitColumns,
  storedColumns,
} from "@/view/widgets/workspaces";
import { onAccelChange, withAccel } from "@/view/widgets/accel";
import { APP_NAME, documentTitle } from "@/core/about";
// The glyph alone, no rounded-square background: the menu bar already is a
// dark bar, and the app icon's own panel inside it reads as a second one.
import markSvg from "@/assets/boneburst-mark.svg?raw";
import type { Store } from "./Store";
import { SetStageSkins } from "@/core/history/settingsCommands";
import { skinsOf, stageSkinOf, toggledSkins } from "@/core/boneburst/boneburstPose";

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
  /**
   * The four side columns: L1 and L2 left of the stage (L1 by the rail, the
   * AI panel's home), R1 and R2 right of it (R2 by the rail). Each is a dock
   * with its own width, resize edge and rail toggle; any panel can be dragged
   * into any of them and stacked there.
   */
  private cols!: Record<ColumnKey, SideColumn>;
  private leftArea: HTMLElement = h("div", { class: "side side-left" });
  private rightArea: HTMLElement = h("div", { class: "side side-right" });
  /** The panel buttons under each rail's toggles: the same component on both
   *  sides (`railButton`), rebuilt by `syncRails`. */
  private leftPanelsEl: HTMLElement = h("div", { class: "rail-panels" });
  private rightPanelsEl: HTMLElement = h("div", { class: "rail-panels" });

  private crumbEl: HTMLElement;
  private menubarEl: HTMLElement;
  private rightRail: HTMLElement;
  private toolsEl: HTMLElement | null = null;
  private bottomWrap: HTMLElement;
  private menus: MenuDef[] = [];
  private docNameEl: HTMLElement;
  private docTabEl: HTMLElement;
  /** Each panel's place in its rail: the order it was added in. */
  private panelOrder = new Map<string, number>();
  /** Where App puts the Play-mode transport, built after the shell. */
  /** The name of the file on disk. Supplied by App, because ProjectService —
   *  which owns the file handle — is built after the shell. */
  docTitle: (() => string) | null = null;
  /** What the brand in the menu bar does. Set by `App`, which owns the About
   *  dialog: the shell knows the layout, not what is in it. */
  onBrand: (() => void) | null = null;
  /** What the gear at the right of the menu bar opens. Set by `App`. */

  constructor(private readonly store: Store) {
    this.cols = {
      l1: this.buildColumn("l1", "animo.dock.left", "sidebarLeft", "the left panel"),
      l2: this.buildColumn("l2", "animo.dock.left.2", "sidebarLeft2", "the second left panel"),
      r1: this.buildColumn("r1", "animo.dock.right", "sidebarRight", "the right panel"),
      // The key R2 had when it was "the right dock's second column".
      r2: this.buildColumn("r2", "animo.dock.right.2", "sidebarRight2", "the second right panel"),
    };
    // Outer to inner on the left, inner to outer on the right: L1 and R2
    // stand by their rails.
    this.leftArea.append(this.cols.l1.wrap, this.cols.l2.wrap);
    this.rightArea.append(this.cols.r1.wrap, this.cols.r2.wrap);
    this.bottomDock = new Dock("animo.dock.bottom", "vertical");
    this.bottomDock.onLayoutChange = () => this.syncRails();

    this.menubarEl = h("div", { class: "menubar" });
    this.docNameEl = h("span", { class: "docname" });
    this.crumbEl = h("div", { class: "crumb" });
    this.docTabEl = this.buildDocTab();
    this.syncDocName();
    this.stageHost = h("div", { class: "stage-host", tabIndex: 0 });
    this.rightRail = h("div", { class: "rail-right" });

    const toolsEl = this.toolsEl = this.buildTools();
    const stageRegion = this.buildStageRegion();

    this.bottomWrap = h("div", { class: "bottom" });
    this.bottomWrap.appendChild(this.bottomDock.el);

    const hSplit = this.buildHorizontalSplitter();

    this.el = h("div", { class: "shell" },
      this.menubarEl,
      toolsEl,
      this.leftArea,
      stageRegion,
      hSplit,
      this.bottomWrap,
      this.rightArea,
      this.rightRail,
    );

    this.buildRightRail();
    this.restoreSizes();
    this.syncRails();
    window.addEventListener("resize", () => this.layoutColumns());
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
    return h("div", { class: "tools" }, this.cols.l1.toggle, this.cols.l2.toggle, this.leftPanelsEl);
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

    // The AI panel's button is on the left rail; the runtime plays in the
    // Preview panel.
    const bar = h("div", { class: "stage-bar" },
      this.crumbEl,
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
   * A rig's skins, for the stage and the Preview: none, one, or
   * several combined, as a game combines them. Skins named with a folder
   * ("accessories/bag") are grouped by it. Only shown for a rig that has
   * skins beyond the default one.
   */
  private buildSkinPicker(): HTMLElement {
    const btn = h("button", { class: "skinpick" }) as HTMLButtonElement;
    const sync = () => {
      const sym = this.store.currentSymbol;
      const named = skinsOf(sym).filter((n) => n !== "default");
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
      const toggle = (name: string) => set(toggledSkins(named, shown, name));
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

  /** The right panel (R1), where the right-hand panels start. */
  get rightDock(): Dock { return this.cols.r1.dock; }
  /** The left panel (L1), the AI panel's home. */
  get leftDock(): Dock { return this.cols.l1.dock; }

  private get docks(): Dock[] { return [...Object.values(this.cols).map((c) => c.dock), this.bottomDock]; }

  /**
   * One side column: its dock, in a box with a width of its own and a resize
   * edge on the side facing the stage, and its toggle for the rail.
   */
  private buildColumn(key: ColumnKey, storageKey: string, iconName: IconName, what: string): SideColumn {
    const left = key[0] === "l";
    const dock = new Dock(storageKey, "vertical");
    dock.onLayoutChange = () => this.syncRails();
    const edge = h("div", { class: "col-split" });
    const wrap = h("div", { class: `side-col ${left ? "left" : "right"}` }, dock.el, edge);
    wrap.hidden = true;
    // The columns in screen order, for the group menu's Move Group.
    dock.neighbour = (side) => {
      const order: ColumnKey[] = ["l1", "l2", "r1", "r2"];
      const next = order[order.indexOf(key) + side];
      return next ? this.cols[next].dock : null;
    };
    dock.onReveal = (d) => {
      const target = this.columnOf(d);
      if (target && target.wrap.hidden) this.setColumnOpen(target.key, true);
    };
    const col: SideColumn = {
      key, dock, wrap, width: 268,
      toggle: this.railButton(iconName, `Show / hide ${what}`, () => this.setColumnOpen(key, wrap.hidden)),
    };
    let start = 0;
    drag(edge, {
      cursor: "ew-resize",
      onStart: () => { start = wrap.offsetWidth; edge.classList.add("dragging"); },
      onMove: (dx) => {
        col.width = clampColumnWidth(left ? start + dx : start - dx, innerWidth);
        this.layoutColumns();
      },
      onEnd: () => {
        edge.classList.remove("dragging");
        this.saveSizes();
        window.dispatchEvent(new Event("resize"));
      },
    });
    return col;
  }

  private columnOf(dock: Dock): SideColumn | undefined {
    return Object.values(this.cols).find((c) => c.dock === dock);
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
    this.homeDock(panel.id, this.cols.l1.dock).register(panel);
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
    const col = this.columnOf(dock);
    if (col && !dock.isFloating(id) && col.wrap.hidden) this.setColumnOpen(col.key, true);
    dock.focus(id);
  }

  /** Hide a panel that is on screen, show one that is not. Closing the last
   *  panel in a column folds the column away rather than leaving it empty —
   *  all but R1, the right panel, which stays as the place panels go. */
  togglePanel(id: string): void {
    const dock = this.dockOf(id);
    if (!dock) return;
    if (!this.isPanelShown(id)) { this.showPanel(id); return; }
    dock.close(id);
    const col = this.columnOf(dock);
    if (col && col.key !== "r1" && dock.isEmpty()) this.setColumnOpen(col.key, false);
  }

  /** On screen right now: open, its tab active, and its column not hidden. */
  isPanelShown(id: string): boolean {
    const dock = this.dockOf(id);
    if (!dock || !dock.isOpen(id)) return false;
    if (dock.isFloating(id)) return true;
    return dock.isVisible(id) && this.columnShown(dock);
  }

  private columnShown(dock: Dock): boolean {
    const col = this.columnOf(dock);
    return col ? !col.wrap.hidden : true;
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

  /**
   * Draw the open columns at widths that fit the window beside the stage
   * (`fitColumns`); each keeps its own width for when there is room again.
   */
  private layoutColumns(): void {
    const sizes = Object.fromEntries(Object.values(this.cols).map((c) =>
      [c.key, { width: c.width, open: !c.wrap.hidden }])) as Record<ColumnKey, { width: number; open: boolean }>;
    // Before the first layout both rails measure 0: they are 30px each.
    const rails = (this.rightRail.offsetWidth + (this.toolsEl?.offsetWidth ?? 0)) || 60;
    const drawn = fitColumns(sizes, innerWidth - rails - STAGE_MIN);
    for (const c of Object.values(this.cols)) c.wrap.style.width = `${drawn[c.key]}px`;
  }

  /** Show or hide one side column. The stage measures its host again. */
  setColumnOpen(key: ColumnKey, open: boolean): void {
    this.cols[key].wrap.hidden = !open;
    this.layoutColumns();
    this.saveSizes();
    this.syncRails();
    window.dispatchEvent(new Event("resize"));
  }

  layoutDocks(right: string[][], bottom: string[][], left: string[][]): void {
    this.cols.l1.dock.setDefault(left);
    this.cols.l2.dock.setDefault([]);
    this.cols.r1.dock.setDefault(right);
    this.cols.r2.dock.setDefault([]);
    this.bottomDock.setDefault(bottom);
    this.syncRails();
  }

  private buildRightRail(): void {
    this.rightRail.append(this.cols.r1.toggle, this.cols.r2.toggle, this.rightPanelsEl);
  }

  /** Put `el` at the foot of the right rail (the quick layout buttons). */
  setRightRailFoot(el: HTMLElement): void {
    el.classList.add("rail-foot");
    this.rightRail.appendChild(el);
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
    for (const c of Object.values(this.cols)) cls(c.toggle, "on", !c.wrap.hidden);
    const { l1, l2, r1, r2 } = this.cols;
    this.fillRail(this.leftPanelsEl, [...l1.dock.panelList(), ...l2.dock.panelList()]);
    this.fillRail(this.rightPanelsEl, [...r1.dock.panelList(), ...r2.dock.panelList()]);
  }

  // ── Region splitters ───────────────────────────────────────────────────

  /** The left panel (L1), open or not. */
  get leftOpen(): boolean { return !this.cols.l1.wrap.hidden; }

  setLeftOpen(open: boolean): void { this.setColumnOpen("l1", open); }

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
    const c = this.cols;
    const size = (col: SideColumn) => ({ width: col.width, open: !col.wrap.hidden });
    return {
      ...storedColumns({ l1: size(c.l1), l2: size(c.l2), r1: size(c.r1), r2: size(c.r2) }),
      bottom: this.bottomWrap.offsetHeight,
    };
  }

  /** Widths and visibility of the four columns, as `columnSizes` reads them. */
  private applyColumns(s: ShellSizes): void {
    const sizes = columnSizes(s);
    for (const key of Object.keys(this.cols) as ColumnKey[]) {
      const col = this.cols[key];
      col.width = clampColumnWidth(sizes[key].width, innerWidth);
      col.wrap.hidden = !sizes[key].open;
    }
    this.layoutColumns();
  }

  private saveSizes(): void {
    try { localStorage.setItem("animo.sizes", JSON.stringify(this.sizes())); } catch { /* private mode */ }
  }

  private restoreSizes(): void {
    this.bottomWrap.style.height = "200px";
    let s: ShellSizes = {};
    try { s = JSON.parse(localStorage.getItem("animo.sizes") ?? "{}") as ShellSizes; } catch { /* ignore */ }
    this.applyColumns(s);
    if (s.bottom) this.bottomWrap.style.height = `${s.bottom}px`;
  }

  // ── Workspaces ─────────────────────────────────────────────────────────

  /** The current arrangement of every dock and the regions around the stage. */
  workspace(): Workspace {
    const c = this.cols;
    return {
      left: c.l1.dock.snapshot(),
      left2: c.l2.dock.snapshot(),
      right: c.r1.dock.snapshot(),
      columns: [c.r2.dock.snapshot()],
      bottom: this.bottomDock.snapshot(),
      sizes: this.sizes(),
    };
  }

  /** Arrange the window as `ws` was saved. Live, without a reload: a reload
   *  would put unsaved work through the restore banner. */
  applyWorkspace(ws: Workspace): void {
    const c = this.cols;
    const empty = { groups: [], floats: {}, closed: [] };
    // A column the workspace was saved without hands its panels to its
    // side's first column, so none is left in a column that is now hidden.
    const fallback = new Map<Dock, Dock>();
    if (!ws.left2) fallback.set(c.l2.dock, c.l1.dock);
    if (!ws.columns?.[0]) fallback.set(c.r2.dock, c.r1.dock);
    Dock.applyLayouts([
      // A workspace saved before the left panel existed leaves it as it is.
      [c.l1.dock, ws.left ?? c.l1.dock.snapshot()],
      [c.l2.dock, ws.left2 ?? empty],
      [c.r1.dock, ws.right],
      [c.r2.dock, ws.columns?.[0] ?? empty],
      [this.bottomDock, ws.bottom],
    ], fallback);
    const s = ws.sizes;
    // Sizes the workspace leaves out (a preset does not decide the left
    // panel or the timeline) stay as they are.
    this.applyColumns({ ...this.sizes(), ...s, rightColumns: s.rightColumns });
    // A column the workspace left empty folds away, as closing its last
    // panel does — all but R1, where panels go.
    for (const col of Object.values(c)) {
      if (col.key !== "r1" && col.dock.isEmpty()) col.wrap.hidden = true;
    }
    this.layoutColumns();
    if (s.bottom) this.bottomWrap.style.height = `${s.bottom}px`;
    this.saveSizes();
    this.syncRails();
    window.dispatchEvent(new Event("resize"));
  }

  resetLayout(): void {
    for (const d of this.docks) d.resetLayout();
    try { localStorage.removeItem("animo.sizes"); } catch { /* ignore */ }
    location.reload();
  }
}

/** The AI panel's dock id: the stage bar's AI button shows and hides it. */
export const AI_PANEL = "ai";

interface SideColumn {
  key: ColumnKey;
  dock: Dock;
  /** The column's box; `hidden` while the column is closed. */
  wrap: HTMLElement;
  /** Kept while the column is hidden, when the box measures 0. */
  width: number;
  toggle: HTMLElement;
}

