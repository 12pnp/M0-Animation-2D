import { clear, cls, drag, h, on } from "@/view/widgets/dom";
import { icon, type IconName } from "@/view/icons";
import { Dock, type MenuEntry, type Panel, showMenu } from "@/view/widgets/Dock";
import { onAccelChange, withAccel } from "@/view/widgets/accel";
import { APP_NAME } from "@/core/about";
// The glyph alone, no rounded-square background: the menu bar already is a
// dark bar, and the app icon's own panel inside it reads as a second one.
import markSvg from "@/assets/amino-mark.svg?raw";
import type { Store, ToolId } from "./Store";
import { SetStageSkins } from "@/core/history/commands";
import { skinsOf, stageSkinOf } from "@/core/spine/spinePose";

interface ToolDef {
  id: ToolId;
  name: string;
  icon: IconName;
  /** Rule below this tool in the rail. */
  divider?: boolean;
  /** What the tool does, in the tooltip. The rail is sixteen pixels wide and
   *  an icon cannot say that clicking a bone with the IK tool CREATES a
   *  target, which is the one thing nothing else in the UI states. */
  hint?: string;
}

const TOOLS: ToolDef[] = [
  { id: "select",        name: "Selection",       icon: "select" },
  { id: "freeTransform", name: "Free Transform",  icon: "freeTransform" },
  { id: "pivot",         name: "Transform Point", icon: "pivot", divider: true },
  { id: "bone",          name: "Bone",            icon: "bone",
    hint: "Drag to draw a bone. Drag from the end of a bone to add the next one. Alt-drag an end to point it elsewhere." },
  { id: "ik",            name: "IK Target",       icon: "ik", divider: true,
    hint: "Click the last bone of a chain to give it a target. Drag the target and the chain follows. "
      + "In Animate mode the drag sets a keyframe; in Setup mode it changes the rest pose." },
  { id: "hand",          name: "Hand",            icon: "hand" },
  { id: "zoom",          name: "Zoom",            icon: "zoom" },
];

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
  readonly rightDock: Dock;
  readonly bottomDock: Dock;
  /** The AI panel's column, left of the stage; App fills it. */
  readonly aiWrap: HTMLElement = h("div", { class: "ai-side collapsed" });
  /** Notified when the AI column opens or closes. */
  onAiToggle: ((open: boolean) => void) | null = null;

  private toolButtons = new Map<ToolId, HTMLElement>();
  private crumbEl: HTMLElement;
  private menubarEl: HTMLElement;
  private rightRail: HTMLElement;
  private rightWrap: HTMLElement;
  private bottomWrap: HTMLElement;
  private menus: MenuDef[] = [];
  private railToggle: HTMLElement | null = null;
  private docNameEl: HTMLElement;
  private docTabEl: HTMLElement;
  /** The AI column's width while it is closed (a hidden element measures 0). */
  private aiWidth = 380;
  private syncAiButton: () => void = () => {};
  /** Where App puts the Play-mode transport, built after the shell. */
  readonly playSlot: HTMLElement = h("div", { class: "stage-play" });
  /** The name of the file on disk. Supplied by App, because ProjectService —
   *  which owns the file handle — is built after the shell. */
  docTitle: (() => string) | null = null;
  /** What the brand in the menu bar does. Set by `App`, which owns the About
   *  dialog: the shell knows the layout, not what is in it. */
  onBrand: (() => void) | null = null;

  constructor(private readonly store: Store) {
    this.rightDock = new Dock("animo.dock.right", "vertical");
    this.bottomDock = new Dock("animo.dock.bottom", "vertical");

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
    this.rightWrap.appendChild(this.rightDock.el);

    const vSplit = this.buildVerticalSplitter();
    const hSplit = this.buildHorizontalSplitter();
    const aiSplit = this.buildAiSplitter();

    this.el = h("div", { class: "shell" },
      this.menubarEl,
      toolsEl,
      this.aiWrap,
      aiSplit,
      stageRegion,
      hSplit,
      this.bottomWrap,
      vSplit,
      this.rightWrap,
      this.rightRail,
    );

    this.restoreSizes();
    this.syncAiButton();
    this.store.subscribe((topic) => {
      if (topic === "tool") this.syncTools();
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
    this.menubarEl.appendChild(this.docTabEl);
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
    this.docNameEl.textContent = name + (this.store.history.isDirty ? " *" : "");
    this.docTabEl.title = name;
  }

  // ── Tool rail ──────────────────────────────────────────────────────────

  private buildTools(): HTMLElement {
    const el = h("div", { class: "tools" });
    const titles: Array<() => void> = [];
    for (const t of TOOLS) {
      const btn = h("button", { class: "tool" });
      const title = () => {
        btn.title = withAccel(t.name, `tool.${t.id}`) + (t.hint ? `\n${t.hint}` : "");
      };
      title();
      titles.push(title);
      btn.appendChild(icon(t.icon, 16));
      on(btn, "click", () => this.store.setTool(t.id));
      this.toolButtons.set(t.id, btn);
      el.appendChild(btn);
      if (t.divider) el.appendChild(h("div", { class: "rule" }));
    }
    this.syncTools();
    onAccelChange(() => titles.forEach((f) => f()));
    return el;
  }

  private syncTools(): void {
    for (const [id, btn] of this.toolButtons) {
      cls(btn, "active", this.store.ui.tool === id);
    }
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
    on(aiBtn, "click", () => this.setAiOpen(!this.aiOpen));
    this.syncAiButton = () => cls(aiBtn, "on", this.aiOpen);

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

  addRightPanel(panel: Panel): void {
    this.homeDock(panel.id, this.rightDock, this.bottomDock).register(panel);
  }

  addBottomPanel(panel: Panel): void {
    this.homeDock(panel.id, this.bottomDock, this.rightDock).register(panel);
  }

  /** A panel's tab can be dragged to the other dock; the saved layout says
   *  where it went. */
  private homeDock(id: string, usual: Dock, other: Dock): Dock {
    return other.stores(id) && !usual.stores(id) ? other : usual;
  }

  private dockOf(id: string): Dock | undefined {
    return [this.rightDock, this.bottomDock].find((d) => d.has(id));
  }

  // ── Panel visibility (the Window menu) ─────────────────────────────────

  /**
   * Bring a panel on screen: reopen it if it was closed, expand its group,
   * make it the active tab — and, easy to forget, un-collapse the whole right
   * column, without which every one of these does its job invisibly.
   */
  showPanel(id: string): void {
    const dock = this.dockOf(id);
    if (!dock) return;
    if (dock === this.rightDock && !dock.isFloating(id)) this.expandRightDock();
    dock.focus(id);
  }

  togglePanel(id: string): void {
    const dock = this.dockOf(id);
    if (!dock) return;
    if (dock.isOpen(id) && (dock.isFloating(id) || dock.isVisible(id))) dock.close(id);
    else this.showPanel(id);
  }

  floatPanel(id: string): void {
    const dock = this.dockOf(id);
    if (!dock) return;
    if (dock.isFloating(id)) dock.dockPanel(id);
    else dock.float(id);
  }

  isPanelOpen(id: string): boolean {
    const dock = this.dockOf(id);
    return !!dock && dock.isOpen(id) && (dock !== this.rightDock || !this.rightCollapsed || dock.isFloating(id));
  }

  isPanelFloating(id: string): boolean {
    return !!this.dockOf(id)?.isFloating(id);
  }

  private get rightCollapsed(): boolean {
    return this.rightWrap.classList.contains("collapsed");
  }

  private expandRightDock(): void {
    if (!this.rightCollapsed) return;
    this.rightWrap.classList.remove("collapsed");
    this.syncRailToggle();
    this.saveSizes();
  }

  layoutDocks(right: string[][], bottom: string[][]): void {
    this.rightDock.setDefault(right);
    this.bottomDock.setDefault(bottom);
    this.buildRightRail(right.flat());
  }

  /** Icon strip that reopens the right dock when it is hidden. */
  private syncRailToggle(): void {
    const toggle = this.railToggle;
    if (!toggle) return;
    clear(toggle);
    toggle.appendChild(icon(this.rightCollapsed ? "chevLeft" : "chevRight", 13));
  }

  private buildRightRail(panelIds: string[]): void {
    clear(this.rightRail);
    const toggle = h("button", { class: "iconbtn", title: "Show / hide panels" });
    this.railToggle = toggle;
    this.syncRailToggle();
    on(toggle, "click", () => {
      this.rightWrap.classList.toggle("collapsed");
      this.syncRailToggle();
      this.saveSizes();
    });
    this.rightRail.appendChild(toggle);
    this.rightRail.appendChild(h("div", { class: "rule" }));

    for (const id of panelIds) {
      const btn = h("button", { class: "iconbtn", title: id });
      btn.appendChild(icon(iconForPanel(id), 14));
      on(btn, "click", () => this.showPanel(id));
      this.rightRail.appendChild(btn);
    }
  }

  // ── Region splitters ───────────────────────────────────────────────────

  private buildVerticalSplitter(): HTMLElement {
    const sp = h("div", { class: "splitter v" });
    let start = 268;
    drag(sp, {
      cursor: "ew-resize",
      onStart: () => { start = this.rightWrap.offsetWidth; sp.classList.add("dragging"); },
      onMove: (dx) => {
        const w = Math.max(180, Math.min(560, start - dx));
        this.rightWrap.style.width = `${w}px`;
      },
      onEnd: () => { sp.classList.remove("dragging"); this.saveSizes(); },
    });
    return sp;
  }

  /** The AI column's right edge. */
  private buildAiSplitter(): HTMLElement {
    const sp = h("div", { class: "splitter v ai-split" });
    let start = 380;
    drag(sp, {
      cursor: "ew-resize",
      onStart: () => { start = this.aiWrap.offsetWidth; sp.classList.add("dragging"); },
      onMove: (dx) => {
        const w = Math.max(260, Math.min(900, innerWidth - 480, start + dx));
        this.aiWrap.style.width = `${w}px`;
      },
      onEnd: () => { sp.classList.remove("dragging"); this.saveSizes(); },
    });
    return sp;
  }

  get aiOpen(): boolean { return !this.aiWrap.classList.contains("collapsed"); }

  setAiOpen(open: boolean): void {
    this.aiWrap.classList.toggle("collapsed", !open);
    this.el.classList.toggle("ai-open", open);
    this.saveSizes();
    this.syncAiButton();
    this.onAiToggle?.(open);
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

  private saveSizes(): void {
    if (this.aiOpen && this.aiWrap.offsetWidth) this.aiWidth = this.aiWrap.offsetWidth;
    try {
      localStorage.setItem("animo.sizes", JSON.stringify({
        right: this.rightWrap.offsetWidth,
        bottom: this.bottomWrap.offsetHeight,
        rightHidden: this.rightWrap.classList.contains("collapsed"),
        ai: this.aiWidth,
        aiOpen: this.aiOpen,
      }));
    } catch { /* private mode */ }
  }

  private restoreSizes(): void {
    this.bottomWrap.style.height = "200px";
    try {
      const raw = localStorage.getItem("animo.sizes");
      if (!raw) return;
      const s = JSON.parse(raw) as { right?: number; bottom?: number; rightHidden?: boolean; ai?: number; aiOpen?: boolean };
      if (s.ai) { this.aiWidth = s.ai; this.aiWrap.style.width = `${s.ai}px`; }
      if (s.aiOpen) { this.aiWrap.classList.remove("collapsed"); this.el.classList.add("ai-open"); }
      if (s.right) this.rightWrap.style.width = `${s.right}px`;
      if (s.bottom) this.bottomWrap.style.height = `${s.bottom}px`;
      if (s.rightHidden) this.rightWrap.classList.add("collapsed");
    } catch { /* ignore */ }
  }

  resetLayout(): void {
    this.rightDock.resetLayout();
    this.bottomDock.resetLayout();
    try { localStorage.removeItem("animo.sizes"); } catch { /* ignore */ }
    location.reload();
  }
}

function iconForPanel(id: string): IconName {
  switch (id) {
    case "properties": return "properties";
    case "library":    return "folderItem";
    case "outline":    return "outlinePanel";
    case "preview":    return "preview";
    default:           return "properties";
  }
}
