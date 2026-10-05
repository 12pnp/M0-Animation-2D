import { EDITOR_NAME, SPINE_VERSION, titleFor } from "@/about";
import { Inspector } from "./panels/inspector";
import type { Page } from "@/io/pack";
import { sidecarName } from "@/io/sidecar";
import { Outline } from "./panels/outline";
import { fileSource, Session, type Source } from "./session";
import type { Tool } from "./stage/gizmo";
import { isTyping, Stage } from "./stage/stage";
import { Timeline } from "./timeline/timeline";
import { animationDuration, timeFrame } from "@/model/timelines";
import { isPanelId, PANEL_TITLES, type PanelId } from "./workspace/panelIds";
import { type PanelContent, Workspace } from "./workspace/workspace";

/** The stickman the plan names for E2, served by the dev server from the test fixtures. */
const STICKMAN = ["Stickman_IK.json", "Stickman_IK.atlas.txt", "Stickman_IK_tex.png"];

const TOOLS: ReadonlyArray<{ tool: Tool; label: string; key: string }> = [
  { tool: "move", label: "Move", key: "W" },
  { tool: "rotate", label: "Rotate", key: "E" },
  { tool: "scale", label: "Scale", key: "R" },
];

/**
 * One window (SPEC §7): the toolbar and status line around a Dockview dock (D6) holding the stage,
 * timeline, rig tree and properties panels. With no animation chosen the stage edits the setup
 * pose; with one, it keys at the playhead.
 */
export function mountApp(root: HTMLElement): void {
  const session = new Session();
  const stage = new Stage(session);
  const outline = new Outline(session);
  const inspector = new Inspector(session);

  const bar = el("header", "toolbar");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ".json,.atlas,.txt,.png,.jpg,.jpeg,.webp,.psd";
  fileInput.hidden = true;
  const openBtn = button("Open…", "Open a skeleton with its atlas and images, or a Photoshop file to start a rig from (⌘O)", () => fileInput.click());
  const saveBtn = button("Save", "Save the skeleton JSON, with the atlas and pages of an imported PSD (⌘S)", () => void save());
  const undoBtn = button("Undo", "", () => { session.history?.undo(); session.changed(); });
  const redoBtn = button("Redo", "", () => { session.history?.redo(); session.changed(); });
  const toolBtns = TOOLS.map((t) => {
    const b = button(t.label, `${t.label} (${t.key})`, () => setTool(t.tool));
    b.dataset.tool = t.tool;
    return b;
  });
  const fitBtn = button("Fit", "Show the whole skeleton (F)", () => stage.fitView());
  const skinLabel = el("label", "skin");
  const skinSelect = document.createElement("select");
  skinSelect.addEventListener("change", () => { session.skin = skinSelect.value || null; session.changed(); });
  skinLabel.append("Skin ", skinSelect);
  const title = el("span", "title");
  const panelsMenu = document.createElement("select");
  panelsMenu.title = "Show a panel, or put the panels back where they started";
  bar.append(openBtn, saveBtn, sep(), undoBtn, redoBtn, sep(), ...toolBtns, sep(), fitBtn, skinLabel, sep(), panelsMenu, title, fileInput);

  // The stage panel: the canvas, with the hint over it while nothing is open.
  const stagePanel = el("section", "stage-panel");
  const hint = el("div", "hint");
  stagePanel.append(stage.element, hint);
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
  root.replaceChildren(bar, main, status, issuesList);

  // The docking shell (D6): every panel is a Dockview panel.
  const workspace = new Workspace(main, new Map<PanelId, PanelContent>([
    ["stage", { element: stagePanel, layout: (w, h) => stage.resize(w, h) }],
    ["timeline", { element: timeline.element, layout: () => timeline.redraw() }],
    ["rigTree", { element: outline.element }],
    ["properties", { element: inspector.element }],
  ]), (w) => w.addEventListener("keydown", onKey));
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

  const say = (m: string) => { message.textContent = m; };
  stage.onStatus = say;
  timeline.onStatus = say;
  stage.onPointer = (t) => { pointer.textContent = t; };
  inspector.onStatus = say;
  outline.onStatus = say;

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

  async function open(files: readonly Source[]): Promise<void> {
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

  /** An atlas page as a PNG file. */
  async function png(p: Page): Promise<Blob> {
    const c = document.createElement("canvas");
    c.width = p.width;
    c.height = p.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height), 0, 0);
    return new Promise((done, fail) => c.toBlob((b) => (b ? done(b) : fail(new Error("The page could not be encoded."))), "image/png"));
  }

  function refresh(): void {
    const h = session.history, doc = session.doc;
    document.title = titleFor(doc ? `${session.name}.json` : null, session.dirty);
    title.textContent = doc ? `${session.dirty ? "• " : ""}${session.name}.json` : "";
    saveBtn.disabled = !doc;
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
    if (files.length) void open(files.map(fileSource));
  });
  window.addEventListener("beforeunload", (e) => { if (session.dirty) e.preventDefault(); });

  window.addEventListener("keydown", onKey);
  function onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
    if (mod && key === "o") { e.preventDefault(); fileInput.click(); return; }
    if (mod && key === "s") { e.preventDefault(); void save(); return; }
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
