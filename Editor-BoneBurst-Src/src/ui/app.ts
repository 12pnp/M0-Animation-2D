import { EDITOR_NAME, SPINE_VERSION, titleFor } from "@/about";
import { Inspector } from "./panels/inspector";
import type { Page } from "@/io/pack";
import { sidecarName } from "@/io/sidecar";
import { pickFiles } from "./files";
import { Outline } from "./panels/outline";
import { type PreferenceValues, Preferences } from "./preferences";
import { PreferencesDialog } from "./preferencesDialog";
import { References } from "./panels/references";
import { fileSource, Session, type Source } from "./session";
import type { Tool } from "./stage/gizmo";
import { isTyping, Stage } from "./stage/stage";
import { Timeline } from "./timeline/timeline";
import { animationDuration, timeFrame } from "@/model/timelines";
import { encodePng } from "@/io/png";
import { AiBridge, DEFAULT_BRIDGE } from "./agent/bridge";
import { ChatClient } from "./agent/chat";
import { sessionContext } from "./agent/context";
import { AskAi } from "./panels/askAi";
import { DIVIDER, MenuBar } from "./menubar";
import { type IconName, iconButton } from "./icons";
import { ExportRefused, exportToUnity } from "./unityExport";
import { Autosaver, clearRecovery, readRecovery, sourcesOf } from "./recovery";
import { isPanelId, PANEL_TITLES, type PanelId } from "./workspace/panelIds";
import { type PanelContent, Workspace } from "./workspace/workspace";

/** The stickman the plan names for E2, served by the dev server from the test fixtures. */
const STICKMAN = ["Stickman_IK.json", "Stickman_IK.atlas.txt", "Stickman_IK_tex.png"];

const TOOLS: ReadonlyArray<{ tool: Tool; label: string; key: string }> = [
  { tool: "move", label: "Move", key: "W" },
  { tool: "rotate", label: "Rotate", key: "E" },
  { tool: "scale", label: "Scale", key: "R" },
  { tool: "shear", label: "Shear", key: "T" },
];

/**
 * One window (SPEC §7): the toolbar and status line around a Dockview dock (D6) holding the stage,
 * timeline, rig tree and properties panels. With no animation chosen the stage edits the setup
 * pose; with one, it keys at the playhead.
 */
export function mountApp(root: HTMLElement): void {
  const session = new Session();
  const stage = new Stage(session);
  // Preferences (E4 step 10): the browser's storage when it can be used.
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { /* blocked: the defaults */ }
  const prefs = new Preferences(storage);
  const prefsDialog = new PreferencesDialog(prefs);
  // The theme before the dock is built, so it starts in it.
  if (prefs.values.theme !== "system") document.documentElement.dataset.theme = prefs.values.theme;
  const outline = new Outline(session);
  const inspector = new Inspector(session);

  const bar = el("header", "toolbar");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ".json,.atlas,.txt,.png,.jpg,.jpeg,.webp,.psd";
  fileInput.hidden = true;
  const openBtn = iconButton(button("Open…", "Open a skeleton with its atlas and images, or a Photoshop file to start a rig from (⌘O). Drop a PSD on an open rig to bring its changes in", () => fileInput.click()), "open");
  const saveBtn = iconButton(button("Save", "Save the skeleton JSON, with the atlas and pages of an imported PSD (⌘S)", () => void save()), "save");
  // Export to Unity (E5 step 8): into the folder chosen once; Shift-click chooses another.
  const unityBtn = button("Export to Unity…", "Export to Unity…: write the skeleton, atlas and pages into your Unity folder, where the BoneBurst import rebakes them (Shift-click: choose another folder)", () => {});
  unityBtn.setAttribute("aria-label", "Export to Unity…");
  iconButton(unityBtn, "exportUnity", false);
  unityBtn.addEventListener("click", (e) => void toUnity(e.shiftKey));
  const undoBtn = iconButton(button("Undo", "", () => { session.history?.undo(); session.changed(); }), "undo");
  const redoBtn = iconButton(button("Redo", "", () => { session.history?.redo(); session.changed(); }), "redo");
  const toolBtns = TOOLS.map((t) => {
    const b = iconButton(button(t.label, `${t.label} (${t.key})`, () => setTool(t.tool)), t.tool);
    b.dataset.tool = t.tool;
    return b;
  });
  const fitBtn = iconButton(button("Fit", "Show the whole skeleton (F)", () => stage.fitView()), "fit", false);
  const skinLabel = el("label", "skin");
  const skinSelect = document.createElement("select");
  skinSelect.addEventListener("change", () => { session.skin = skinSelect.value || null; session.changed(); });
  skinLabel.append("Skin ", skinSelect);
  const title = el("span", "title");
  const panelsMenu = document.createElement("select");
  panelsMenu.title = "Show a panel, or put the panels back where they started";
  const prefsBtn = iconButton(button("⚙", "Preferences: theme, rulers, bones, undo steps (⌘,)", () => prefsDialog.open()), "settings", false);
  prefsBtn.setAttribute("aria-label", "Preferences");
  // The AI bridge (E5 step 2): an MCP client or Ask AI works on the open rig through it.
  // `?bridge=<port>` talks to a bridge on another local port (tests, or two bridges at once).
  const port = new URLSearchParams(location.search).get("bridge");
  const ai = new AiBridge(sessionContext(session), port && /^\d{2,5}$/.test(port) ? `http://127.0.0.1:${port}` : DEFAULT_BRIDGE);
  const aiBtn = iconButton(button("AI", "Connect to the AI bridge, so an MCP client (Claude Code, Claude Desktop) or Ask AI can work on the open rig", () => prefs.set({ ai: !prefs.values.ai })), "ai");
  aiBtn.classList.add("ai-button");
  aiBtn.dataset.state = "off";
  ai.onState((state, detail) => { aiBtn.dataset.state = state; aiBtn.title = detail; message.textContent = detail; });
  bar.append(openBtn, saveBtn, unityBtn, sep(), undoBtn, redoBtn, sep(), skinLabel, sep(), panelsMenu, aiBtn, prefsBtn, title, fileInput, prefsDialog.element);

  // The stage panel: the canvas, with the hint over it while nothing is open.
  const stagePanel = el("section", "stage-panel");
  const hint = el("div", "hint");
  // The stage's tools, floating over its foot: the bone tools and fit, then what the stage draws.
  const showBtn = (label: string, tip: string, key: "bones" | "constraints" | "rulers") => {
    const b = button(label, tip, () => prefs.set({ [key]: !prefs.values[key] }));
    b.dataset.show = key;
    return b;
  };
  const showBtns = [
    showBtn("Bones", "Draw the bones", "bones"),
    showBtn("Constraints", "Draw the constraints", "constraints"),
    showBtn("Rulers", "Show the rulers and their guides", "rulers"),
  ];
  const stageTools = el("div", "stage-tools");
  const group = (...children: HTMLElement[]) => { const g = el("div", "group"); g.append(...children); return g; };
  const autoKeyBtn = iconButton(button("Auto Key", "Auto Key: with an animation chosen, a drag on the stage keys it. Off, a drag poses the bone without keying until you press Key", () => {
    stage.autoKey = !stage.autoKey;
    autoKeyBtn.setAttribute("aria-pressed", String(stage.autoKey));
    say(stage.autoKey ? "Auto Key on: dragging keys the animation." : "Auto Key off: dragging poses the bone unkeyed; press Key (K) to key it.");
  }), "autoKey");
  autoKeyBtn.setAttribute("aria-pressed", "true");
  stageTools.append(group(...toolBtns), group(autoKeyBtn), group(...showBtns));
  // Fit stays in the panel's top right corner, whatever its size.
  const fitCorner = el("div", "stage-fit");
  fitCorner.append(fitBtn);
  stagePanel.append(fitCorner);
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
  const references = new References(session);
  // Ask AI (E5 step 9): the bridge's model with the editor's tools; sending connects the AI button.
  const askAi = new AskAi(new ChatClient(ai.url), ai, () => { if (!prefs.values.ai) prefs.set({ ai: true }); });
  // The activity bar: one button per built panel, pressed while the panel is open.
  const activity = el("nav", "activity");
  activity.setAttribute("aria-label", "Panels");
  const menubar = new MenuBar([
    { label: "File", items: () => [
      { label: "Open…", keys: "⌘O", run: () => fileInput.click() },
      { label: "Save", keys: "⌘S", disabled: !session.doc, run: () => void save() },
      { label: "Export to Unity…", disabled: !session.doc, run: () => void toUnity(false) },
      { label: "Export to Unity, another folder…", disabled: !session.doc, run: () => void toUnity(true) },
    ] },
    { label: "Edit", items: () => [
      { label: "Undo", keys: "⌘Z", disabled: !session.history?.canUndo, run: () => undoBtn.click() },
      { label: "Redo", keys: "⇧⌘Z", disabled: !session.history?.canRedo, run: () => redoBtn.click() },
      DIVIDER,
      { label: "Preferences…", keys: "⌘,", run: () => prefsDialog.open() },
    ] },
    { label: "View", items: () => [
      ...TOOLS.map((t) => ({ label: t.label, keys: t.key, checked: stage.tool === t.tool, run: () => setTool(t.tool) })),
      DIVIDER,
      { label: "Fit to skeleton", keys: "F", run: () => stage.fitView() },
    ] },
    { label: "Window", items: () => [
      ...workspace.built.map((id) => ({ label: PANEL_TITLES[id], checked: workspace.isOpen(id), run: () => workspace.toggle(id) })),
      DIVIDER,
      { label: "Reset layout", run: () => workspace.reset() },
    ] },
    { label: "Help", items: () => [
      { label: `About ${EDITOR_NAME}`, run: () => say(`${EDITOR_NAME} — Spine ${SPINE_VERSION}, MIT.`) },
    ] },
  ]);
  const body = el("div", "body");
  body.append(activity, main);
  root.replaceChildren(menubar.element, bar, body, status, issuesList);

  // The docking shell (D6): every panel is a Dockview panel.
  const workspace = new Workspace(main, new Map<PanelId, PanelContent>([
    ["stage", { element: stagePanel, layout: (w, h) => stage.resize(w, h) }],
    ["timeline", { element: timeline.element, layout: () => timeline.redraw() }],
    ["rigTree", { element: outline.element }],
    ["properties", { element: inspector.element }],
    ["reference", { element: references.element }],
    ["ai", { element: askAi.element }],
  ]), (w) => w.addEventListener("keydown", onKey));
  const PANEL_ICONS: Readonly<Record<PanelId, IconName>> = {
    stage: "panelStage", rigTree: "panelRig", properties: "panelProperties", timeline: "panelTimeline",
    reference: "addImage", ai: "ai", preview: "play",
  };
  const activityBtns = workspace.built.map((id) => {
    const b = iconButton(button(PANEL_TITLES[id], `${PANEL_TITLES[id]}: show or hide the panel`, () => workspace.toggle(id)), PANEL_ICONS[id], false);
    b.dataset.panel = id;
    return b;
  });
  const syncActivity = () => { for (const b of activityBtns) b.setAttribute("aria-pressed", String(workspace.isOpen(b.dataset.panel as PanelId))); };
  workspace.api.onDidLayoutChange(syncActivity);
  syncActivity();
  activity.append(...activityBtns);
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
    stage.redraw();
    session.undoSteps = p.undoSteps;
    session.referenceOpacity = p.referenceOpacity;
    aiBtn.setAttribute("aria-pressed", String(p.ai));
    for (const b of showBtns) b.setAttribute("aria-pressed", String(p[b.dataset.show as "bones" | "constraints" | "rulers"]));
    if (p.ai) ai.start(); else if (ai.state !== "off") ai.stop();
  };
  applyPrefs(prefs.values);
  prefs.onChange(applyPrefs);

  const say = (m: string) => { message.textContent = m; };
  stage.onStatus = say;
  timeline.onStatus = say;
  stage.onPointer = (t) => { pointer.textContent = t; };
  inspector.onStatus = say;
  outline.onStatus = say;
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

  async function open(files: readonly Source[], dropped = false): Promise<void> {
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
    if (session.dirty && !confirm(`${session.name}.json has unsaved changes. Open another file and lose them?`)) return;
    try {
      await session.open(files);
      stage.opened();
      say(`Opened ${session.name}.`);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
  }

  function download(name: string, blob: Blob): void {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** The skeleton; with it, once, an atlas and pages the editor made (a PSD import). */
  async function save(): Promise<void> {
    if (!session.history) return;
    const made = session.generated;
    download(`${session.name}.json`, new Blob([session.save()], { type: "application/json" }));
    // The sidecar beside it, when it holds something and changed (E4 step 8).
    const side = session.sidecarToSave({ camera: stage.camera, ...(session.skin ? { skin: session.skin } : {}), ...(session.animation ? { animation: session.animation.name } : {}) });
    if (side !== null) download(sidecarName(`${session.name}.json`), new Blob([side], { type: "application/json" }));
    const also = side !== null ? `, ${sidecarName(`${session.name}.json`)}` : "";
    if (!made) { say(`Saved ${session.name}.json${also}.`); return; }
    download(`${session.name}.atlas.txt`, new Blob([made.atlasText], { type: "text/plain" }));
    for (const p of made.pages) download(p.name, await png(p));
    session.generated = null;
    say(`Saved ${session.name}.json${also}, ${session.name}.atlas.txt and ${made.pages.map((p) => p.name).join(", ")}.`);
  }

  async function toUnity(choose: boolean): Promise<void> {
    try {
      const out = await exportToUnity(session, true, choose);
      say(`Exported to ${out.folder}: ${out.files.join(", ")}. Unity rebakes the folder on its next refresh.`);
    } catch (err) {
      say(err instanceof ExportRefused ? err.message : `Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** An atlas page as a PNG file, written exactly (io/png: no canvas rounding semi-transparent colours). */
  async function png(p: Page): Promise<Blob> {
    return new Blob([await encodePng(p) as BlobPart], { type: "image/png" });
  }

  function refresh(): void {
    const h = session.history, doc = session.doc;
    document.title = titleFor(doc ? `${session.name}.json` : null, session.dirty);
    title.textContent = doc ? `${session.dirty ? "• " : ""}${session.name}.json` : "";
    saveBtn.disabled = !doc;
    unityBtn.disabled = !doc;
    undoBtn.disabled = !h?.canUndo;
    redoBtn.disabled = !h?.canRedo;
    undoBtn.title = h?.undoLabel ? `Undo ${h.undoLabel} (⌘Z)` : "Undo (⌘Z)";
    redoBtn.title = h?.redoLabel ? `Redo ${h.redoLabel} (⇧⌘Z)` : "Redo (⇧⌘Z)";
    const skins = (doc?.skins ?? []).map((s) => s.name).filter((n) => n !== "default");
    // A shown skin an edit or an undo took away: back to the default skin.
    if (session.skin !== null && !skins.includes(session.skin)) session.skin = null;
    if (skinSelect.options.length !== skins.length + 1 || [...skinSelect.options].some((o, i) => i > 0 && o.value !== skins[i - 1])) {
      skinSelect.replaceChildren(new Option("default", ""), ...skins.map((n) => new Option(n, n)));
    }
    skinSelect.value = session.skin ?? "";
    skinLabel.hidden = skins.length === 0;
    const unsupported = session.pose()?.rig.data.unsupported ?? [];
    const notes = [
      ...session.issues.map((i) => `${i.where}: ${i.message}`),
      ...unsupported.map((u) => `not drawn yet: ${u}`),
    ];
    issuesBtn.hidden = notes.length === 0;
    issuesBtn.textContent = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
    issuesList.replaceChildren(...notes.map((n) => Object.assign(document.createElement("li"), { textContent: n })));
    hint.hidden = !!doc;
  }
  session.onChange(refresh);

  hint.append(
    Object.assign(document.createElement("p"), { textContent: `${EDITOR_NAME} — Spine ${SPINE_VERSION}` }),
    Object.assign(document.createElement("p"), { textContent: "Drop a skeleton .json with its .atlas and page images here, or use Open… An atlas with its images alone starts a new skeleton." }),
  );
  if (import.meta.env.DEV) {
    // For inspecting the live editor from the browser console; not in a build.
    (window as unknown as { boneburst: unknown }).boneburst = { session, stage, get workspace() { return workspace; } };
    const dev = button("Open the stickman fixture", "Dev only: tests/fixtures/stickman", () => void openStickman());
    const devNew = button("New skeleton on the stickman's atlas", "Dev only: tests/fixtures/stickman, atlas and image", () => void openStickman(false));
    hint.append(dev, devNew);
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
    bar.after(offer);
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

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) void open([...fileInput.files].map(fileSource));
    fileInput.value = "";
  });
  window.addEventListener("dragover", (e) => { e.preventDefault(); main.classList.add("dropping"); });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) main.classList.remove("dropping"); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    main.classList.remove("dropping");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void open(files.map(fileSource), true);
  });
  window.addEventListener("beforeunload", (e) => { if (session.dirty) e.preventDefault(); });

  window.addEventListener("keydown", onKey);
  function onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
    if (mod && key === "o") { e.preventDefault(); fileInput.click(); return; }
    if (mod && key === "s") { e.preventDefault(); void save(); return; }
    if (mod && (key === "," || e.code === "Comma")) { e.preventDefault(); prefsDialog.open(); return; }
    if (isTyping(e)) return;
    if (mod && key === "z") { e.preventDefault(); (e.shiftKey ? redoBtn : undoBtn).click(); return; }
    if (mod && key === "y") { e.preventDefault(); redoBtn.click(); return; }
    if (mod || e.altKey) return;
    if (key === "escape") {
      if (!stage.cancel() && session.playing) session.pause();
      else session.select(null);
      return;
    }
    if (key === "f") { stage.fitView(); return; }
    if (e.code === "Space") { e.preventDefault(); timeline.togglePlay(); return; }
    if (key === "," || key === ".") { e.preventDefault(); session.seek(session.frame + (key === "," ? -1 : 1)); return; }
    if (key === "home") { e.preventDefault(); session.seek(0); return; }
    if (key === "end") {
      e.preventDefault();
      const a = session.animation;
      if (a) session.seek(timeFrame(animationDuration(a), session.fps));
      return;
    }
    if (key === "k") { timeline.keySelectedBone(); return; }
    if ((key === "delete" || key === "backspace") && timeline.hasSelection) { e.preventDefault(); timeline.deleteSelected(); return; }
    // On the stage in mesh mode, Delete deletes the selected vertex.
    if ((key === "delete" || key === "backspace") && stage.element.contains(e.target as Node) && stage.deleteVertex()) { e.preventDefault(); return; }
    // In the rig panel, Delete deletes what is selected there (Undo brings it back).
    if ((key === "delete" || key === "backspace") && outline.element.contains(e.target as Node)) { e.preventDefault(); outline.deleteSelected(); return; }
    const t = TOOLS.find((x) => x.key.toLowerCase() === key);
    if (t) setTool(t.tool);
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

function sep(): HTMLSpanElement {
  const s = el("span", "sep");
  s.setAttribute("aria-hidden", "true");
  return s;
}
