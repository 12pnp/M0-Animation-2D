import { EDITOR_NAME, titleFor } from "@/about";
import { Inspector } from "./panels/inspector";
import { pickFiles, spineFolderProblems } from "./files";
import { Outline } from "./panels/outline";
import { FONT_SIZES, type PreferenceValues, Preferences } from "./preferences";
import { setRowHeight, setTickSeries } from "./timeline/layout";
import { PreferencesDialog } from "./preferencesDialog";
import { AnimationsPanel } from "./panels/animationsPanel";
import { HistoryPanel } from "./panels/history";
import { LocalPathPanel } from "./panels/localPath";
import { SkinsPanel } from "./panels/skinsPanel";
import { References } from "./panels/references";
import { droppedFiles } from "./dropFiles";
import { fileSource, type ProjectFile, Session, type Source } from "./session";
import type { Space, Tool } from "./stage/gizmo";
import { keysOf, matching, type ShortcutId } from "./shortcuts";
import { ShortcutsSheet } from "./shortcutsSheet";
import { isTyping, Stage } from "./stage/stage";
import { Timeline } from "./timeline/timeline";
import { animationDuration, timeFrame } from "@/model/timelines";
import { AiBridge, DEFAULT_BRIDGE } from "./agent/bridge";
import { ChatClient } from "./agent/chat";
import { sessionContext } from "./agent/context";
import { AskAi } from "./panels/askAi";
import { showContextMenu } from "./contextMenu";
import { DocumentTabs } from "./documentTabs";
import { stageMenu } from "./stageMenu";
import { PathPanel } from "./stage/pathPanel";
import { TransformStrip } from "./stage/transformStrip";
import { lookOf } from "./stage/look";
import { DIVIDER, MenuBar, type MenuItem } from "./menubar";
import { icon, iconButton } from "./icons";
import type { View } from "@/edit/sidecar";
import { download, saveProject } from "./project";
import { OpenDialog } from "./openDialog";
import { folders, type Recent, recent, type RecentHandle, readRecent } from "./recent";
import { ExportRefused, exportFiles, exportToUnity } from "./unityExport";
import { snapFields } from "./snapFields";
import { Autosaver, clearRecovery, readRecovery, sourcesOf } from "./recovery";
import { floatGroups } from "./stage/floatingGroups";
import { clipboard, copyPose, pastePoseHere } from "./clipboard";
import { brush, resizeBrush } from "./stage/weightBrush";
import { isPanelId, PANEL_ICONS, PANEL_TITLES, type PanelId } from "./workspace/panelIds";
import { type PanelContent, Workspace } from "./workspace/workspace";

/** The stickman the plan names for E2, served by the dev server from the test fixtures. */
const STICKMAN = ["Stickman_IK.json", "Stickman_IK.atlas.txt", "Stickman_IK_tex.png"];

const TOOLS: ReadonlyArray<{ tool: Tool; label: string; shortcut: ShortcutId }> = [
  { tool: "move", label: "Translate", shortcut: "toolMove" },
  { tool: "rotate", label: "Rotate", shortcut: "toolRotate" },
  { tool: "scale", label: "Scale", shortcut: "toolScale" },
  { tool: "shear", label: "Shear", shortcut: "toolShear" },
];

/**
 * One window (SPEC §7): the toolbar and status line around a Dockview dock (D6) holding the stage,
 * timeline, rig tree and properties panels. With no animation chosen the stage edits the setup
 * pose; with one, it keys at the playhead.
 */
/** "#rrggbb" at `alpha` as a CSS colour; transparent when the colour is not a hex one. */
function rulerBackground(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `rgb(${parseInt(m[1]!, 16)} ${parseInt(m[2]!, 16)} ${parseInt(m[3]!, 16)} / ${alpha})` : "transparent";
}

export function mountApp(root: HTMLElement): void {
  const session = new Session();
  const stage = new Stage(session);
  // Preferences (E4 step 10): the browser's storage when it can be used.
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { /* blocked: the defaults */ }
  const prefs = new Preferences(storage);
  const prefsDialog = new PreferencesDialog(prefs);
  const sheet = new ShortcutsSheet();
  // The theme before the dock is built, so it starts in it.
  if (prefs.values.theme !== "system") document.documentElement.dataset.theme = prefs.values.theme;
  const outline = new Outline(session);
  const inspector = new Inspector(session);

  const bar = el("header", "toolbar");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ".bbdata,.json,.atlas,.txt,.png,.jpg,.jpeg,.webp,.psd";
  fileInput.hidden = true;
  // File ▸ Import Spine Folder…: a whole export folder (skeleton .json, .atlas, page images) at once.
  const folderInput = document.createElement("input");
  folderInput.type = "file";
  folderInput.webkitdirectory = true;
  folderInput.hidden = true;
  const openBtn = iconButton(button("Open…", `Open a project (.bbdata), a Spine skeleton with its atlas and images, or a Photoshop file to start a rig from (${keysOf("open")}). Drop a PSD on an open rig to bring its changes in`, () => openDialog.open()), "open");
  const saveBtn = iconButton(button("Save", `Save the project (.bbdata): the rig, its atlas and pages, guides and references (${keysOf("save")}). Spine JSON and Unity go through File ▸ Export`, () => void save()), "save");
  // Export to Unity (E5 step 8): into the folder chosen once; Shift-click chooses another.
  const unityBtn = button("Export to Unity…", "Export to Unity…: write the skeleton, atlas and pages into your Unity folder, where the BoneBurst import rebakes them (Shift-click: choose another folder)", () => {});
  unityBtn.setAttribute("aria-label", "Export to Unity…");
  iconButton(unityBtn, "exportUnity", false);
  unityBtn.addEventListener("click", (e) => void toUnity(e.shiftKey));
  const undoBtn = iconButton(button("Undo", "", () => { session.history?.undo(); session.changed(); }), "undo");
  const redoBtn = iconButton(button("Redo", "", () => { session.history?.redo(); session.changed(); }), "redo");
  const toolBtns = TOOLS.map((t) => {
    const b = iconButton(button(t.label, `${t.label} (${keysOf(t.shortcut)})`, () => setTool(t.tool)), t.tool);
    b.dataset.tool = t.tool;
    return b;
  });
  const fitBtn = iconButton(button("Fit", `Show the whole skeleton (${keysOf("fit")})`, () => stage.fitView()), "fit", false);
  const skinLabel = el("label", "skin");
  const skinSelect = document.createElement("select");
  skinSelect.addEventListener("change", () => { session.skin = skinSelect.value || null; session.changed(); });
  skinLabel.append("Skin ", skinSelect);
  const panelsMenu = document.createElement("select");
  panelsMenu.title = "Show a panel, or put the panels back where they started";
  // The app icon at the menu bar's left: the Preferences button.
  const prefsBtn = button("", `Preferences: theme, rulers, bones, undo steps (${keysOf("preferences")})`, () => prefsDialog.open());
  prefsBtn.className = "app-icon";
  prefsBtn.setAttribute("aria-label", "Preferences");
  const appMark = document.createElement("span");
  appMark.className = "icon";
  appMark.style.setProperty("--icon", `url("${import.meta.env.BASE_URL}vendor/app-icon.svg")`);
  prefsBtn.append(appMark);
  // The AI bridge (E5 step 2): an MCP client or Ask AI works on the open rig through it.
  // `?bridge=<port>` talks to a bridge on another local port (tests, or two bridges at once).
  const port = new URLSearchParams(location.search).get("bridge");
  const ai = new AiBridge(sessionContext(session), port && /^\d{2,5}$/.test(port) ? `http://127.0.0.1:${port}` : DEFAULT_BRIDGE);
  const aiBtn = iconButton(button("AI", "Connect to the AI bridge, so an MCP client (Claude Code, Claude Desktop) or Ask AI can work on the open rig", () => prefs.set({ ai: !prefs.values.ai })), "ai");
  aiBtn.classList.add("ai-button");
  aiBtn.dataset.state = "off";
  ai.onState((state, detail) => { aiBtn.dataset.state = state; aiBtn.title = detail; message.textContent = detail; });
  // There is no toolbar row: Open, Save, Export, Undo, Redo and the skin are in the menus, the AI
  // button sits at the menu bar's right end, and the buttons the code drives stay (unattached).
  bar.append(openBtn, saveBtn, unityBtn, undoBtn, redoBtn, skinLabel);

  // The stage panel: the canvas, with the hint over it while nothing is open.
  const stagePanel = el("section", "stage-panel");
  const hint = el("div", "hint");
  // The stage's tools, floating over its foot: the bone tools and fit, then what the stage draws.
  const showBtn = (label: string, tip: string, key: "bones" | "constraints" | "rulers" | "onion" | "hideIkBones") => {
    const b = button(label, tip, () => prefs.set({ [key]: !prefs.values[key] }));
    b.dataset.show = key;
    return b;
  };
  const showBtns = [
    showBtn("Bones", "Draw the bones", "bones"),
    showBtn("Constraints", "Draw the constraints", "constraints"),
    showBtn("Rulers", "Show the rulers and their guides", "rulers"),
    showBtn("Hide IK", "In animation mode, hide the bones an IK constraint drives: they are not animated, so only the targets and the free bones show", "hideIkBones"),
    showBtn("Onion", "Onion skin: the poses before (red) and after (green) the playhead, behind the skeleton (View ▸ Onion Skin)", "onion"),
  ];
  iconButton(showBtns.find((b) => b.dataset.show === "onion")!, "onion", false);
  const rulersBtn = iconButton(showBtns.find((b) => b.dataset.show === "rulers")!, "ruler", false);
  const stageTools = el("div", "stage-tools");
  let crumb: HTMLElement;
  const group = (...children: HTMLElement[]) => { const g = el("div", "group"); g.append(...children); return g; };
  /** Auto Key on or off, from the stage strip's button or the View menu. */
  const toggleAutoKey = () => {
    stage.autoKey = !stage.autoKey;
    autoKeyBtn.setAttribute("aria-pressed", String(stage.autoKey));
    say(stage.autoKey ? "Auto Key on: dragging keys the animation." : `Auto Key off: dragging poses the bone unkeyed; press Key (${keysOf("key")}) to key it.`);
  };
  const autoKeyBtn = iconButton(button("Auto Key", "Auto Key: with an animation chosen, a drag on the stage keys it. Off, a drag poses the bone without keying until you press Key", toggleAutoKey), "autoKey", false);
  autoKeyBtn.setAttribute("aria-pressed", "true");
  const SPACES: ReadonlyArray<{ space: Space; label: string; tip: string }> = [
    { space: "local", label: "Local", tip: "Move, scale or shear along the bone's own axes" },
    { space: "parent", label: "Parent", tip: "Move, scale and shear freely, as dragged" },
    { space: "world", label: "World", tip: "Move, scale or shear along the world's axes" },
  ];
  const setSpace = (space: Space): void => {
    stage.space = space;
    SPACES.forEach((x, i) => spaceBtns[i]?.setAttribute("aria-pressed", String(x.space === space)));
    stage.redraw();
  };
  const spaceBtns: HTMLButtonElement[] = SPACES.map((x) => {
    const b = button(x.label, x.tip, () => setSpace(x.space));
    b.setAttribute("aria-pressed", String(x.space === stage.space));
    return b;
  });
  // The transform panel after Spine's: a row per property, with its tool, values and key button.
  const transform = new TransformStrip(session, new Map(TOOLS.map((t, i) => [t.tool, toolBtns[i]!] as const)), { autoKey: () => stage.autoKey, status: (m) => say(m) });
  // What is selected, as a path above the panels: bone, then slot, then attachment.
  crumb = el("div", "stage-crumb");
  // Pose / Animate: one button for the mode. Pose edits the setup pose (no animation shown); Animate
  // shows the last animation used, or the first, and what is done there is keyed.
  const modeBtn = button("Pose", "", () => {
    if (session.animation) { session.showAnimation(null); return; }
    if (!session.enterAnimate()) say("No animations yet: New… in the Timeline adds one.");
  });
  // Text only, fixed at the stage's foot, in the middle.
  modeBtn.classList.add("mode", "stage-mode");
  // The path window: the selected path attachment's vertices, by number (docs/PATH-PLAN.md); it sits in the Local Path panel.
  const pathPanel = new PathPanel(session, (m) => say(m));
  const spaceGroup = group(...spaceBtns), showGroup = group(...showBtns.filter((b) => b !== rulersBtn && b.dataset.show !== "onion"));
  stageTools.append(crumb, transform.element, spaceGroup, showGroup);
  // Each panel can be dragged by its grip and folded; the corner button shows or hides all of them.
  const resetPanels = floatGroups(stagePanel, { transform: transform.element, space: spaceGroup, show: showGroup });
  // Fit stays in the panel's top right corner, whatever its size.
  const fitCorner = el("div", "stage-fit");
  const panelsBtn = iconButton(button("Panels", "Show or hide the tool panels over the stage (View ▸ Stage Panels); double-click to put them back where they started", () => prefs.set({ stagePanels: !prefs.values.stagePanels })), "panels", false);
  panelsBtn.addEventListener("dblclick", () => { resetPanels(); say("Stage panels put back."); });
  fitCorner.append(fitBtn);
  // Two small buttons in the stage's bottom-left corner, stacked upward: show or hide the panels, then the rulers.
  const rulerTools = el("div", "stage-ruler-tools");
  rulerTools.append(panelsBtn, rulersBtn);
  stagePanel.append(rulerTools, modeBtn);
  stagePanel.append(fitCorner);
  // "Automatic" text labels: hidden while the stage is narrow.
  new ResizeObserver(() => stageTools.classList.toggle("narrow", stagePanel.clientWidth < 560)).observe(stagePanel);
  stagePanel.append(stage.element, hint, stageTools);
  const main = el("main", "dock");

  const status = el("footer", "status");
  const message = el("span", "message");
  message.setAttribute("aria-live", "polite");
  const pointer = el("span", "pointer");
  const issuesBtn = button("", "Show what reading the file found", () => issuesList.toggleAttribute("hidden"));
  issuesBtn.className = "issues";
  const issuesList = el("ul", "issue-list");
  issuesList.hidden = true;
  status.append(message, pointer, issuesBtn);
  const timeline = new Timeline(session);
  // Auto Key and Onion work on the animation: they sit at the timeline bar's end.
  timeline.addTools(autoKeyBtn, showBtns.find((b) => b.dataset.show === "onion")!);
  const references = new References(session);
  const history = new HistoryPanel(session);
  const localPath = new LocalPathPanel(session);
  // The path window (+ New Path, a path's vertices) is part of the Local Path panel.
  localPath.addTools(pathPanel.element);
  const skinsPanel = new SkinsPanel(session);
  const animationsPanel = new AnimationsPanel(session);
  // Ask AI (E5 step 9): the bridge's model with the editor's tools; sending connects the AI button.
  const askAi = new AskAi(new ChatClient(ai.url), ai, () => { if (!prefs.values.ai) prefs.set({ ai: true }); });
  // The activity bar: one button per built panel, pressed while the panel is open.
  const activity = el("nav", "activity");
  activity.setAttribute("aria-label", "Panels");
  // The panel picker at the bar's top: an icon over the native select, which opens on a click.
  const picker = el("div", "panel-picker");
  picker.append(icon("panels"), panelsMenu);
  const tabs = new DocumentTabs(session, {
    camera: () => stage.camera,
    showCamera: (c) => { session.openedCamera = c; stage.opened(); },
    save: () => save(),
  });
  const menubar = new MenuBar([
    { label: "File", items: () => [
      { label: "Import Spine Folder…", run: () => folderInput.click() },
      { label: "New Project", run: () => newProject() },
      { label: "Open…", keys: keysOf("open"), run: () => openDialog.open() },
      ...(recent.list.length ? [DIVIDER, ...recent.list.map((r): MenuItem => ({ label: `Recent / ${r.name}`, run: () => void openRecent(r) })), { label: "Clear Recent", run: () => void recent.clear() }, DIVIDER] : []),
      { label: "Save Project", keys: keysOf("save"), disabled: !session.doc, run: () => void save() },
      { label: "Save Project As…", disabled: !session.doc, run: () => void save(true) },
      { label: "Close File", disabled: !session.doc, run: () => tabs.closeCurrent() },
      { label: "Export Spine JSON…", disabled: !session.doc, run: () => void exportSpine() },
      { label: "Export to Unity…", disabled: !session.doc, run: () => void toUnity(false) },
      { label: "Export to Unity, another folder…", disabled: !session.doc, run: () => void toUnity(true) },
    ] },
    { label: "Edit", items: () => [
      { label: "Undo", keys: keysOf("undo"), disabled: !session.history?.canUndo, run: () => undoBtn.click() },
      { label: "Redo", keys: keysOf("redo"), disabled: !session.history?.canRedo, run: () => redoBtn.click() },
      DIVIDER,
      { label: "Copy Keys", keys: keysOf("copyKeys"), disabled: !timeline.hasSelection, run: () => say(timeline.copySelected()) },
      { label: "Paste Keys", keys: keysOf("pasteKeys"), disabled: !clipboard.keys || !session.animation, run: () => say(timeline.paste()) },
      { label: "Select All Keys", keys: keysOf("selectAll"), disabled: !session.animation, run: () => timeline.selectAll() },
      { label: "Copy Pose", keys: keysOf("copyPose"), disabled: !session.doc, run: () => say(copyPose(session)) },
      { label: "Paste Pose", keys: keysOf("pastePose"), disabled: !clipboard.pose || !session.doc, run: () => say(pastePoseHere(session)) },
      DIVIDER,
      { label: "Preferences…", keys: keysOf("preferences"), run: () => prefsDialog.open() },
    ] },
    { label: "View", items: () => [
      ...TOOLS.map((t) => ({ label: t.label, keys: keysOf(t.shortcut), checked: stage.tool === t.tool, run: () => setTool(t.tool) })),
      { label: "Auto Key", checked: stage.autoKey, run: toggleAutoKey },
      { label: "Stage Panels", checked: prefs.values.stagePanels, run: () => prefs.set({ stagePanels: !prefs.values.stagePanels }) },
      DIVIDER,
      { label: "Fit to skeleton", keys: keysOf("fit"), run: () => stage.fitView() },
      { label: "Onion Skin", checked: prefs.values.onion, run: () => prefs.set({ onion: !prefs.values.onion }) },
      // The skins the file has, to show one at a time (the old toolbar's Skin choice).
      ...((session.doc?.skins ?? []).map((k) => k.name).filter((n) => n !== "default").length
        ? [DIVIDER, { label: "Skin: default", checked: session.skin === null, run: () => { session.skin = null; session.changed(); } },
          ...(session.doc?.skins ?? []).map((k) => k.name).filter((n) => n !== "default").map((n) => ({ label: `Skin: ${n}`, checked: session.skin === n, run: () => { session.skin = n; session.changed(); } }))]
        : []),
      DIVIDER,
      { label: "Checkerboard", checked: prefs.values.checker, run: () => prefs.set({ checker: !prefs.values.checker }) },
      { label: "Centre Axes", checked: prefs.values.axes, run: () => prefs.set({ axes: !prefs.values.axes }) },
      { label: "Grid", checked: prefs.values.grid, run: () => prefs.set({ grid: !prefs.values.grid }) },
      { label: "Snapping", keys: keysOf("snapping"), checked: prefs.values.snap, run: () => prefs.set({ snap: !prefs.values.snap }) },
      { label: "Snap to Grid", checked: prefs.values.snapGrid, disabled: !prefs.values.snap, run: () => prefs.set({ snapGrid: !prefs.values.snapGrid }) },
      { label: "Snap to Guides", checked: prefs.values.snapGuides, disabled: !prefs.values.snap, run: () => prefs.set({ snapGuides: !prefs.values.snapGuides }) },
      { label: "Snap to Bones", checked: prefs.values.snapBones, disabled: !prefs.values.snap, run: () => prefs.set({ snapBones: !prefs.values.snapBones }) },
      { label: "Snap to Whole Pixels", checked: prefs.values.snapPixels, disabled: !prefs.values.snap, run: () => prefs.set({ snapPixels: !prefs.values.snapPixels }) },
    ] },
    { label: "Window", items: () => [
      ...workspace.built.map((id) => ({ label: PANEL_TITLES[id], checked: workspace.isOpen(id), run: () => workspace.toggle(id) })),
      DIVIDER,
      { label: "Reset layout", run: () => workspace.reset() },
    ] },
    { label: "Help", items: () => [
      { label: "Keyboard Shortcuts", keys: keysOf("shortcuts"), run: () => sheet.open() },
      DIVIDER,
      { label: `About ${EDITOR_NAME}`, run: () => say(`${EDITOR_NAME}, MIT licence.`) },
    ] },
  ]);
  const body = el("div", "body");
  body.append(activity, main);
  menubar.element.prepend(prefsBtn);
  menubar.element.append(tabs.element);
  root.replaceChildren(menubar.element, body, status, issuesList, fileInput, folderInput, prefsDialog.element, sheet.element);
  menubar.element.append(aiBtn);

  // The docking shell (D6): every panel is a Dockview panel.
  const workspace = new Workspace(main, new Map<PanelId, PanelContent>([
    ["stage", { element: stagePanel, layout: (w, h) => stage.resize(w, h) }],
    ["timeline", { element: timeline.element, layout: () => timeline.redraw() }],
    ["rigTree", { element: outline.element }],
    ["properties", { element: inspector.element }],
    ["reference", { element: references.element }],
    ["ai", { element: askAi.element }],
    ["history", { element: history.element }],
    ["localPath", { element: localPath.element, layout: (w, h) => localPath.layout(w, h) }],
    ["skins", { element: skinsPanel.element }],
    ["animations", { element: animationsPanel.element }],
  ]), (w) => w.addEventListener("keydown", onKey));
  const activityBtns = workspace.built.map((id) => {
    const b = iconButton(button(PANEL_TITLES[id], `${PANEL_TITLES[id]}: show or hide the panel`, () => workspace.toggle(id)), PANEL_ICONS[id], false);
    b.dataset.panel = id;
    return b;
  });
  const syncActivity = () => { for (const b of activityBtns) b.setAttribute("aria-pressed", String(workspace.isOpen(b.dataset.panel as PanelId))); };
  workspace.api.onDidLayoutChange(syncActivity);
  syncActivity();
  activity.append(picker, ...activityBtns);
  const refreshPanels = () => {
    panelsMenu.replaceChildren(
      new Option("Panels…", ""),
      ...workspace.built.map((id) => new Option(`${workspace.isOpen(id) ? "✓ " : "  "}${PANEL_TITLES[id]}`, id)),
      new Option("Reset layout", "reset"),
    );
  };
  panelsMenu.addEventListener("focus", refreshPanels);
  panelsMenu.addEventListener("pointerdown", refreshPanels);
  panelsMenu.addEventListener("change", () => {
    const v = panelsMenu.value;
    if (v === "reset") workspace.reset();
    else if (isPanelId(v)) workspace.show(v);
    panelsMenu.value = "";
  });
  refreshPanels();

  /** Each preference where it applies; on start, and whenever one changes. */
  const applyPrefs = (p: PreferenceValues) => {
    if (p.theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = p.theme;
    workspace.refreshTheme();
    stage.show = { rulers: p.rulers, bones: p.bones, constraints: p.constraints };
    stage.hideIkBones = p.hideIkBones;
    localPath.onion = () => ({ before: prefs.values.onionBefore, after: prefs.values.onionAfter, keyedOnly: prefs.values.onionKeyedOnly, colour: prefs.values.onionColour });
    stage.onion = p.onion ? { before: p.onionBefore, after: p.onionAfter, keyedOnly: p.onionKeyedOnly, colour: p.onionColour } : null;
    stage.grid = p.grid ? p.gridSize : null;
    // The interface size: CSS zoom on the page (the pointer maths in `pageScale.ts` follows it).
    document.documentElement.style.zoom = p.uiScale === 100 ? "" : String(p.uiScale / 100);
    // The rest of Preferences ▸ User interface: text size, the stage's tool panels, the timeline, the rig tree, new projects' frame rate.
    document.documentElement.style.setProperty("--ui-font-size", `${FONT_SIZES[p.fontSize]}px`);
    stageTools.dataset.align = p.toolbarPosition;
    stageTools.dataset.labels = p.toolbarLabels;
    setRowHeight(p.rowHeight);
    setTickSeries(p.fewerTicks);
    timeline.redraw();
    outline.setLook(p.treeIndent, p.treeColours);
    session.defaultFps = p.defaultFps;
    stage.look = lookOf(p);
    localPath.background = () => ({ look: lookOf(prefs.values), grid: prefs.values.grid ? prefs.values.gridSize : null });
    localPath.refresh();
    stage.boneColour = p.boneColour === "auto" ? null : p.boneColour;
    if (session.boneSize !== p.boneSize) { session.boneSize = p.boneSize; session.changed(); }
    stageTools.hidden = !p.stagePanels;
    panelsBtn.setAttribute("aria-pressed", String(p.stagePanels));
    stage.selectedBoneColour = p.selectedBoneColour === "auto" ? null : p.selectedBoneColour;
    // The panel tabs' colours: "auto" leaves the theme's.
    const rootStyle = document.documentElement.style;
    for (const [name, value] of [["--tab-bar-bg", p.tabBarColour], ["--tab-active-bg", p.tabActiveColour], ["--tab-text", p.tabTextColour], ["--tab-dim-text", p.tabDimTextColour]] as const) {
      if (value === "auto") rootStyle.removeProperty(name); else rootStyle.setProperty(name, value);
    }
    // The rulers' background: the colour at its opacity ("auto" is the panel colour); the stage and the Fit button read it.
    rootStyle.setProperty("--ruler-bg", rulerBackground(p.rulerColour === "auto" ? getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() : p.rulerColour, p.rulerOpacity));
    if (p.rulerTextColour === "auto") rootStyle.removeProperty("--ruler-text"); else rootStyle.setProperty("--ruler-text", p.rulerTextColour);
    stage.snap = p.snap ? { grid: p.snapGrid, guides: p.snapGuides, bones: p.snapBones, pixels: p.snapPixels, gridSize: p.gridSize } : null;
    stage.redraw();
    session.undoSteps = p.undoSteps;
    session.referenceOpacity = p.referenceOpacity;
    aiBtn.setAttribute("aria-pressed", String(p.ai));
    for (const b of showBtns) b.setAttribute("aria-pressed", String(p[b.dataset.show as "bones" | "constraints" | "rulers" | "onion" | "hideIkBones"]));
    // The IK button names what its next press does: Hide IK, then Show IK.
    const ikBtn = showBtns.find((b) => b.dataset.show === "hideIkBones");
    if (ikBtn) ikBtn.textContent = p.hideIkBones ? "Show IK" : "Hide IK";
    if (p.ai) ai.start(); else if (ai.state !== "off") ai.stop();
  };
  applyPrefs(prefs.values);
  prefs.onChange(applyPrefs);

  const say = (m: string) => { message.textContent = m; };
  stage.onStatus = say;
  // Right-click on the stage (a drag still pans): what acts on the bone there, add a bone, the pose, the view.
  stage.onContextMenu = ([x, y], world, bone) => showContextMenu(x, y, stageMenu({
    session, status: say, keySelected: () => timeline.keySelected(), deleteSelected: () => outline.deleteSelected(),
    copyPose: () => say(copyPose(session)), pastePose: () => say(pastePoseHere(session)), canPastePose: () => !!clipboard.pose,
    fit: () => stage.fitView(),
    toggles: [
      { label: "Grid", checked: prefs.values.grid, run: () => prefs.set({ grid: !prefs.values.grid }) },
      { label: "Snapping", checked: prefs.values.snap, run: () => prefs.set({ snap: !prefs.values.snap }) },
      { label: "Stage Panels", checked: prefs.values.stagePanels, run: () => prefs.set({ stagePanels: !prefs.values.stagePanels }) },
    ],
  }, world, bone));
  timeline.onStatus = say;
  stage.onPointer = (t) => { pointer.textContent = t; };
  inspector.onStatus = say;
  inspector.onBoneSize = (n) => prefs.set({ boneSize: n });
  inspector.snapFields = (owner) => snapFields(prefs, owner);
  outline.onStatus = say;
  skinsPanel.onStatus = say;
  animationsPanel.onStatus = say;
  references.onStatus = say;
  references.centre = () => [stage.camera.x, stage.camera.y];

  // Playback: the playhead moves by real time while playing.
  let last = 0;
  const tick = (now: number) => {
    if (session.playing) session.advance(Math.min(0.1, last ? (now - last) / 1000 : 0));
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  function setTool(t: Tool): void {
    stage.tool = t;
    for (const b of toolBtns) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
    stage.redraw();
  }
  setTool("move");

  async function open(files: readonly Source[], dropped = false, project: ProjectFile | null = null): Promise<void> {
    // Images alone, onto an open document: references (E4 step 9), not a new document.
    const picked = pickFiles(files);
    // A PSD dropped on an open rig brings its changes in (E4 step 14); Open… with one starts a new rig.
    if (dropped && session.doc && picked.psd && !picked.skeleton && !picked.atlas) {
      try {
        say(await session.reimportPsd(picked.psd));
        stage.redraw();
      } catch (err) {
        say(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (session.doc && picked.images.size && !picked.skeleton && !picked.atlas && !picked.psd && !picked.sidecar) {
      say(await session.addReferenceImages([...picked.images.values()], [stage.camera.x, stage.camera.y]));
      return;
    }
    // A new file gets its own tab: the shown one is set aside, and comes back if this one fails.
    const parked = tabs.park();
    try {
      await session.open(files);
      session.projectFile = project;
      stage.opened();
      say(`Opened ${session.name}.`);
    } catch (err) {
      tabs.unpark(parked);
      say(err instanceof Error ? err.message : String(err));
    }
  }

  /** The view a project keeps: the camera, the skin and the animation shown. */
  const viewNow = (): View => ({ camera: stage.camera, ...(session.skin ? { skin: session.skin } : {}), ...(session.animation ? { animation: session.animation.name } : {}) });

  /** ⌘S: the project, to its file (File ▸ Save Project As… picks another). */
  async function save(again = false): Promise<void> {
    if (!session.history) return;
    try {
      const file = await saveProject(session, viewNow(), again);
      say(file === null ? "Save cancelled." : `Saved ${file}.`);
    } catch (err) {
      say(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** File ▸ Export Spine JSON…: the skeleton, atlas and pages as Spine reads them, not marked saved. */
  async function exportSpine(): Promise<void> {
    try {
      const files = await exportFiles(session);
      for (const f of files) download(f.name, new Blob([f.data as BlobPart], { type: typeof f.data === "string" ? "text/plain" : "image/png" }));
      say(`Exported ${files.map((f) => f.name).join(", ")}.`);
    } catch (err) {
      say(err instanceof ExportRefused ? err.message : `Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  void recent.load();
  void folders.load();
  /** Open… shows this helper first: recent projects and folders; Browse goes on to the browser's picker. */
  const openDialog = new OpenDialog({
    browse: () => void openNative(),
    openFile: async (file, handle) => {
      await open([fileSource(file)], false, handle);
      if (handle && session.projectFile === handle) void recent.add(handle as RecentHandle);
    },
  });

  /** File ▸ New Project: a blank skeleton in its own tab (the shown one is set aside, as Open does). */
  function newProject(): void {
    tabs.park();
    session.newProject();
    stage.opened();
    say("New project. Add bones, or drop an atlas with its images to build from; Save Project keeps it.");
  }

  /** Open… with the browser's file picker where it has one, so a project it opens is saved back to the same file. */
  async function openNative(): Promise<void> {
    const pick = (window as unknown as { showOpenFilePicker?: (o: { multiple: boolean }) => Promise<(ProjectFile & { getFile(): Promise<File> })[]> }).showOpenFilePicker;
    if (!pick || navigator.webdriver) { fileInput.click(); return; }
    let handles: Awaited<ReturnType<typeof pick>>;
    try { handles = await pick.call(window, { multiple: true }); } catch { return; }
    const files = await Promise.all(handles.map((h) => h.getFile()));
    const project = handles.length === 1 && /\.bbdata$/i.test(files[0]!.name) ? handles[0]! : null;
    await open(files.map(fileSource), false, project);
    if (project && session.projectFile === project) void recent.add(project as RecentHandle);
  }

  /** File ▸ Recent / name: the project file again, from its kept handle. */
  async function openRecent(r: Recent): Promise<void> {
    try {
      const file = await readRecent(r);
      await open([fileSource(file)], false, r.handle);
      if (session.projectFile === r.handle) void recent.add(r.handle);
    } catch (err) {
      // Moved or deleted: dropped from the list.
      if (err instanceof DOMException && err.name === "NotFoundError") { void recent.remove(r); say(`${r.name} is no longer where it was; removed from Recent.`); return; }
      say(err instanceof Error ? err.message : String(err));
    }
  }

  async function toUnity(choose: boolean): Promise<void> {
    try {
      const out = await exportToUnity(session, true, choose);
      say(`Exported to ${out.folder}: ${out.files.join(", ")}. Unity rebakes the folder on its next refresh.`);
    } catch (err) {
      say(err instanceof ExportRefused ? err.message : `Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function refresh(): void {
    const h = session.history, doc = session.doc;
    document.title = titleFor(doc ? `${session.name}.json` : null, session.dirty);
    saveBtn.disabled = !doc;
    unityBtn.disabled = !doc;
    undoBtn.disabled = !h?.canUndo;
    redoBtn.disabled = !h?.canRedo;
    undoBtn.title = h?.undoLabel ? `Undo ${h.undoLabel} (${keysOf("undo")})` : `Undo (${keysOf("undo")})`;
    redoBtn.title = h?.redoLabel ? `Redo ${h.redoLabel} (${keysOf("redo")})` : `Redo (${keysOf("redo")})`;
    const skins = (doc?.skins ?? []).map((s) => s.name).filter((n) => n !== "default");
    // A shown skin an edit or an undo took away: back to the default skin.
    if (session.skin !== null && !skins.includes(session.skin)) session.skin = null;
    if (skinSelect.options.length !== skins.length + 1 || [...skinSelect.options].some((o, i) => i > 0 && o.value !== skins[i - 1])) {
      skinSelect.replaceChildren(new Option("default", ""), ...skins.map((n) => new Option(n, n)));
    }
    skinSelect.value = session.skin ?? "";
    skinLabel.hidden = skins.length === 0;
    // What reading the files said, then the notes about the document as it is now (E8-PLAN step 1);
    // a note about a thing selects it (an animation's, shows it).
    const notes = [...session.issues.map((i) => ({ text: `${i.where}: ${i.message}`, subject: null })), ...session.notes()];
    issuesBtn.hidden = notes.length === 0;
    issuesBtn.textContent = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
    const shown = notes.map((n) => n.text).join("\n");
    if (issuesList.dataset.shown !== shown) {
      issuesList.dataset.shown = shown;
      issuesList.replaceChildren(...notes.map((n) => {
        const li = document.createElement("li");
        const subject = n.subject;
        if (!subject) { li.textContent = n.text; return li; }
        li.append(button(n.text, "Select it", () => {
          if (subject.kind === "animation") session.showAnimation(subject.name);
          else session.select(subject);
        }));
        return li;
      }));
    }
    hint.hidden = !!doc;
    // The mode button says what is shown now, and what a click switches to.
    const animating = !!session.animation;
    modeBtn.textContent = animating ? "Animate" : "Pose";
    modeBtn.title = animating ? `Animate: editing ${session.animation!.name}. Click for the setup pose (Pose)` : "Pose: editing the setup pose. Click to animate";
    modeBtn.disabled = !doc;
    workspace.setMode(animating ? "animate" : "pose");
    modeBtn.setAttribute("aria-pressed", String(animating));
    // The path of what is selected.
    const sel = session.selected, parts: string[] = [];
    if (doc && sel) {
      const slotBone = (slot: string) => doc.slots?.find((x) => x.name === slot)?.bone;
      if (sel.kind === "bone") parts.push(sel.name);
      else if (sel.kind === "slot") parts.push(slotBone(sel.name) ?? "", sel.name);
      else if (sel.kind === "attachment") parts.push(slotBone(sel.slot) ?? "", sel.slot, sel.key);
      else parts.push(sel.name);
    }
    crumb.hidden = !parts.length;
    crumb.replaceChildren(...parts.filter(Boolean).flatMap((p, i) => [...(i ? [Object.assign(document.createElement("span"), { className: "sep", textContent: "▸" })] : []), Object.assign(document.createElement("span"), { textContent: p, title: p })]));
  }
  session.onChange(refresh);

  hint.append(
    Object.assign(document.createElement("p"), { textContent: EDITOR_NAME }),
  );
  if (import.meta.env.DEV) {
    // For inspecting the live editor from the browser console; not in a build.
    (window as unknown as { boneburst: unknown }).boneburst = { session, stage, get workspace() { return workspace; } };
    const dev = button("Open the stickman fixture", "Dev only: tests/fixtures/stickman", () => void openStickman());
    const devNew = button("New skeleton on the stickman's atlas", "Dev only: tests/fixtures/stickman, atlas and image", () => void openStickman(false));
    // Kept apart and quiet: they are for developing the editor, not for opening a rig.
    const devRow = el("div", "dev");
    devRow.append(dev, devNew);
    hint.append(devRow);
  }
  refresh();

  // Autosave and recovery (E6 step 4a): paused until the browser is asked for an older copy; one
  // found is offered back, and until it is restored or discarded nothing writes over it.
  const autosaver = new Autosaver(session, prefs);
  autosaver.start();
  void readRecovery().then((r) => {
    if (!r) { autosaver.paused = false; return; }
    const offer = el("div", "recovery-bar");
    offer.setAttribute("role", "alert");
    const when = new Date(r.savedAt).toLocaleString();
    const text = el("span", "text");
    text.textContent = `Unsaved work on ${r.name}.json from ${when} was kept in this browser.`;
    const done = (m: string) => { offer.remove(); autosaver.paused = false; say(m); };
    const restore = button("Restore", "Open it, unsaved, as it was", () => {
      if (session.dirty && !confirm(`${session.name}.json has unsaved changes. Restore the kept copy and lose them?`)) return;
      void session.restore(sourcesOf(r), r.generated && r.atlas !== null ? { atlasText: r.atlas } : null)
        .then(() => done(`Restored ${r.name}.json from ${when}: unsaved until you Save it.`), (err) => say(err instanceof Error ? err.message : String(err)));
    });
    const discard = button("Discard", "Delete the kept copy", () => { void clearRecovery().then(() => done("The kept copy was discarded.")); });
    offer.append(text, restore, discard);
    menubar.element.after(offer);
  });

  /** The stickman fixture; without its skeleton, a new skeleton on its atlas. */
  async function openStickman(withSkeleton = true): Promise<void> {
    const sources = STICKMAN.filter((n) => withSkeleton || !n.endsWith(".json")).map((name): Source => {
      const url = `/tests/fixtures/stickman/${name}`;
      const get = async () => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r; };
      return { name, text: async () => (await get()).text(), blob: async () => (await get()).blob() };
    });
    await open(sources);
  }
  const devOpen = import.meta.env.DEV ? new URLSearchParams(location.search).get("open") : null;
  if (devOpen === "stickman") void openStickman();
  else if (devOpen === "stickman-atlas") void openStickman(false);

  folderInput.addEventListener("change", () => {
    const all = [...(folderInput.files ?? [])];
    folderInput.value = "";
    if (!all.length) return;
    const problems = spineFolderProblems(all.map((f) => f.name));
    const folder = all[0]!.webkitRelativePath.split("/")[0] || "That folder";
    if (problems.length) { say(`${folder} is not a Spine export folder: it is missing ${problems.join(" and ")}.`); return; }
    void open(all.map(fileSource));
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) void open([...fileInput.files].map(fileSource));
    fileInput.value = "";
  });
  window.addEventListener("dragover", (e) => { e.preventDefault(); main.classList.add("dropping"); });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) main.classList.remove("dropping"); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    main.classList.remove("dropping");
    if (!e.dataTransfer) return;
    void droppedFiles(e.dataTransfer).then((files) => { if (files.length) void open(files.map(fileSource), true); });
  });
  window.addEventListener("beforeunload", (e) => { if (tabs.anyDirty) e.preventDefault(); });

  // Every shortcut is a row of `SHORTCUTS` (E7 step 2); a handler returns false when it does not
  // apply here, and the next matching row is tried.
  const shortcuts: Record<ShortcutId, () => boolean | void> = {
    open: () => openDialog.open(),
    save: () => void save(),
    preferences: () => prefsDialog.open(),
    undo: () => undoBtn.click(),
    redo: () => redoBtn.click(),
    redoAlt: () => redoBtn.click(),
    copyKeys: () => say(timeline.copySelected()),
    copyPose: () => say(copyPose(session)),
    pasteKeys: () => say(timeline.paste()),
    pastePose: () => say(pastePoseHere(session)),
    selectAll: () => { if (!session.animation) return false; timeline.selectAll(); },
    snapping: () => { prefs.set({ snap: !prefs.values.snap }); say(`Snapping ${prefs.values.snap ? "on" : "off"}.`); },
    escape: () => {
      if (!stage.cancel() && session.playing) session.pause();
      else session.select(null);
    },
    fit: () => stage.focusSelected(),
    nudgeLeft: (e?: KeyboardEvent) => nudge("left", e),
    nudgeRight: (e?: KeyboardEvent) => nudge("right", e),
    nudgeDown: (e?: KeyboardEvent) => nudge("down", e),
    nudgeUp: (e?: KeyboardEvent) => nudge("up", e),
    cycleSpace: () => {
      const next = SPACES[(SPACES.findIndex((x) => x.space === stage.space) + 1) % SPACES.length]!;
      setSpace(next.space);
      stage.flash(next.label);
    },
    // The weight brush's size (E6 step 4f), while it is on.
    brushSmaller: () => { if (!brush.on) return false; say(`Brush ${resizeBrush(-1)} px.`); stage.redraw(); },
    brushLarger: () => { if (!brush.on) return false; say(`Brush ${resizeBrush(1)} px.`); stage.redraw(); },
    play: () => timeline.togglePlay(),
    prevFrame: () => session.seek(session.frame - 1),
    nextFrame: () => session.seek(session.frame + 1),
    firstFrame: () => session.seek(0),
    lastFrame: () => { const a = session.animation; if (a) session.seek(timeFrame(animationDuration(a), session.fps)); },
    key: () => timeline.keySelected(),
    // The timeline's selected keys; on the stage in mesh mode, the selected vertex; in the rig
    // panel, what is selected there (Undo brings it back).
    delete: (e?: KeyboardEvent) => {
      if (timeline.hasSelection) { timeline.deleteSelected(); return; }
      const at = e?.target as Node | null;
      if (at && stage.element.contains(at) && stage.deleteVertex()) return;
      if (at && outline.element.contains(at)) { outline.deleteSelected(); return; }
      return false;
    },
    toolMove: () => setTool("move"),
    toolRotate: () => setTool("rotate"),
    toolScale: () => setTool("scale"),
    toolShear: () => setTool("shear"),
    shortcuts: () => sheet.open(),
  };

  // An arrow key nudges the chosen tool's value, unless a list or menu has it (a select moves its choice on arrows).
  const nudge = (dir: "left" | "right" | "up" | "down", e?: KeyboardEvent): boolean | void => {
    if ((e?.target as HTMLElement | null)?.tagName === "SELECT") return false;
    transform.nudge(stage.tool, dir, !!e?.shiftKey, { step: prefs.values.nudgeStep, scaleStep: prefs.values.nudgeScaleStep, bigFactor: prefs.values.nudgeBigFactor });
  };

  window.addEventListener("keydown", onKey);
  function onKey(e: KeyboardEvent): void {
    for (const s of matching(e, isTyping(e))) {
      if ((shortcuts[s.id as ShortcutId] as (e: KeyboardEvent) => boolean | void)(e) === false) continue;
      if (!s.keepDefault) e.preventDefault();
      return;
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

