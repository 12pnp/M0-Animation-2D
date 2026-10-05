/// <reference path="../vendor/spine-pixi.d.ts" />
import { queueSteps } from "./queue";
import { type FrameToHost, type HostToFrame, tickFrame } from "./protocol";
import type { PreviewRig } from "./runtime/previewRig";
import { spineRig } from "./runtime/spineRig";
import { boneburstRig } from "./runtime/boneburstRig";

/**
 * Runs inside the preview iframe. Drives a Spine runtime on PixiJS 8, fed
 * the exact bytes the editor would write to disk: the skeleton JSON, the
 * `.atlas` text and the page images.
 *
 * That is the whole point of this file: it is not a second renderer, it IS
 * the runtime. If what plays here matches the stage, the export is right.
 * The runtime is the official spine-pixi-v8 4.3.13, or, with
 * `localStorage["animo.previewRuntime"] = "boneburst"`, our own
 * (docs/PREVIEW-RUNTIME-PLAN.md), both behind `PreviewRig`.
 */

const RUNTIME = (() => {
  try { return localStorage.getItem("animo.previewRuntime") === "boneburst" ? "boneburst" : "spine"; } catch { return "spine"; }
})();

const errEl = document.getElementById("err")!;
/** What the BoneBurst runtime does not play in the loaded file, said on screen. */
const warnEl = document.getElementById("warn");

/** The editor, which embeds this page; `opener` when opened by hand. */
function host(): Window | null {
  return (parent !== window ? parent : null) ?? window.opener;
}

function post(msg: FrameToHost): void {
  host()?.postMessage(msg, window.location.origin);
}

function fail(err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  errEl.style.display = "block";
  errEl.textContent = message;
  post({ type: "error", message });
}

window.addEventListener("error", (e) => fail(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));

let app: PIXI.Application | null = null;
let view: PreviewRig | null = null;
let textures: PIXI.Texture[] = [];
let currentAnimation = "";
/** The last `setLoop`: every later play honours it. */
let loop = true;
/** The runtime owns the clock while this is true; paused, nothing advances
 *  and the pose is whatever the last seek or update left. */
let playing = false;
let fitBox: { x: number; y: number; w: number; h: number } | null = null;
let stageBox: { width: number; height: number; background: string } | null = null;
let stageGfx: PIXI.Graphics | null = null;
let showStage = true;
let frameRate = 24;
let speed = 1;
let maxFps = 60;
let lastReportedFrame = -1;
let lastReportedPlaying = false;
/** Bumped by every `load`; a load that a newer one overtook while it was
 *  decoding gives up instead of replacing the newer skeleton. */
let loadSeq = 0;

async function ensureApp(): Promise<PIXI.Application> {
  if (app) return app;
  const a = new PIXI.Application();
  await a.init({
    background: 0x353535,
    resizeTo: document.body,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  document.body.appendChild(a.canvas);
  a.ticker.maxFPS = maxFps;

  // The skeleton is created with autoUpdate off and advanced here, so a
  // pause is exact and a seek is not overwritten by the next tick.
  a.ticker.add((ticker) => {
    // An exception in a Pixi ticker listener ends the loop, and the preview
    // would sit frozen with nothing said: report it and carry on.
    try {
      if (view && playing) view.advance((ticker.deltaMS / 1000) * speed);
      reportTick();
    } catch (err) {
      fail(err);
    }
  });

  app = a;
  return a;
}

function frameCountOf(name: string): number {
  return view ? Math.round(view.durationOf(name) * frameRate) : 0;
}

function reportTick(): void {
  if (!view || !currentAnimation) return;
  const entry = view.track();
  // Mixing: the "from" animation is still playing; the editor's playhead
  // follows "to" only.
  if (entry && entry.name !== currentAnimation) return;
  // A non-looping animation stops advancing at its end: stop the clock and
  // say so, so the transport's play button comes back.
  if (playing && entry && !loop && entry.trackTime >= entry.duration) playing = false;
  const frame = tickFrame(entry ? entry.time : 0, frameRate, frameCountOf(currentAnimation));
  if (frame !== lastReportedFrame || playing !== lastReportedPlaying) {
    lastReportedFrame = frame;
    lastReportedPlaying = playing;
    post({ type: "tick", frame, playing });
  }
}

function disposeCurrent(): void {
  if (view) {
    view.destroy();
    view = null;
  }
  showUnsupported([]);
  for (const t of textures) t.destroy(true);
  textures = [];
  app?.stage.removeChildren();
}

async function load(msg: Extract<HostToFrame, { type: "load" }>): Promise<void> {
  const seq = ++loadSeq;
  const a = await ensureApp();
  // Decode while the old skeleton is still on screen: every await between
  // disposing it and adding the new one is a frame drawn empty.
  const bitmaps = await Promise.all(msg.pages.map((p) => createImageBitmap(p.png)));
  if (seq !== loadSeq) {
    for (const b of bitmaps) b.close();
    return;
  }

  // Nothing below awaits: the old skeleton goes and the new one arrives,
  // posed and fitted, between two frames.
  errEl.style.display = "none";
  // Straight from the decoded bitmap: PIXI.Assets cannot resolve a blob
  // URL (no extension to pick a parser from) and hands back an empty
  // texture without raising.
  const pageTextures = new Map(msg.pages.map((p, i) => [p.name, PIXI.Texture.from(bitmaps[i]!)] as const));
  let next: PreviewRig;
  try {
    next = (RUNTIME === "boneburst" ? boneburstRig : spineRig)({
      skeleton: msg.skeleton, atlas: msg.atlas, textures: pageTextures, skins: msg.skins ?? [], debug: !!msg.debugDraw,
      // Events as the runtime fires them, while playing: a seek poses a
      // frame and must not fire (or sound) what it lands on.
      onEvent: (e) => post({ type: "event", ...e }),
      playing: () => playing,
    });
  } catch (err) {
    for (const t of pageTextures.values()) t.destroy(true);
    throw err;
  }

  disposeCurrent();
  textures = [...pageTextures.values()];
  view = next;
  showUnsupported(view.unsupported);

  fitBox = msg.fit ?? null;
  stageBox = msg.stage ?? null;
  frameRate = view.fps || 24;
  const names = view.animations;
  currentAnimation = msg.animation && names.includes(msg.animation) ? msg.animation : names[0] ?? "";
  lastReportedFrame = -1;

  // Fitted before it is added, from the editor's box: waiting for a frame
  // to measure it drew it at its origin and full size first.
  fitToFrame();
  drawStage(a);
  a.stage.addChild(view.display);
  if (currentAnimation) {
    if (msg.play) start(currentAnimation);
    else seekTo(msg.frame ?? 0);
  } else {
    playing = false;
    view.advance(0);
  }

  post({ type: "loaded", animations: names, animation: currentAnimation, duration: frameCountOf(currentAnimation) });
}

/** Play the current animation from its start, on the runtime's clock. */
function start(name: string): void {
  if (!view) return;
  view.start(name, loop);
  playing = true;
}

/**
 * Pose the current animation on a frame and stop there. Deterministic, unlike
 * playing and waiting, which the parity harness relies on. The setup pose
 * goes first: a bone the animation does not key must show its setup pose,
 * not whatever the previous frame left. The key times `keyTime` writes make
 * `frame / fps` land on the key at that frame, never before it.
 */
function seekTo(frame: number): void {
  if (!view || !currentAnimation) return;
  playing = false;
  view.seek(currentAnimation, frame / frameRate, loop);
}

function showUnsupported(list: readonly string[]): void {
  if (!warnEl) return;
  warnEl.hidden = !list.length;
  warnEl.textContent = list.length ? `BoneBurst runtime: not played yet — ${list.join(", ")}` : "";
}

/** Outline the scene bounds, so a detached preview shows how the rig sits
 *  in the scene rather than floating in grey. */
function drawStage(a: PIXI.Application): void {
  stageGfx?.destroy();
  stageGfx = null;
  if (!stageBox || !showStage) return;
  const g = new PIXI.Graphics();
  g.rect(0, 0, stageBox.width, stageBox.height);
  g.fill({ color: colorOf(stageBox.background), alpha: 1 });
  g.rect(0, 0, stageBox.width, stageBox.height);
  g.stroke({ color: 0x000000, alpha: 0.35, width: 1 });
  a.stage.addChild(g);
  stageGfx = g;
  positionStage();
}

function positionStage(): void {
  if (!stageGfx || !view) return;
  stageGfx.x = view.display.x;
  stageGfx.y = view.display.y;
  stageGfx.scale.set(view.display.scale.x, view.display.scale.y);
}

function colorOf(css: string): number {
  const hex = css.replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex, 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

/**
 * Fit the rig into the frame, from the box the editor measured. The preview
 * sets `Skeleton.yDown`, so the skeleton's space is the editor's: y down,
 * the same numbers.
 */
function fitToFrame(): void {
  if (!app || !view) return;
  const w = app.canvas.clientWidth || app.canvas.width || 320;
  const h = app.canvas.clientHeight || app.canvas.height || 240;
  const box = showStage && stageBox
    ? { x: 0, y: 0, w: stageBox.width, h: stageBox.height }
    : fitBox && fitBox.w > 0 && fitBox.h > 0 ? fitBox : null;

  const d = view.display;
  if (!box) {
    d.scale.set(1, 1);
    d.x = w / 2;
    d.y = h / 2;
    positionStage();
    return;
  }
  const margin = 0.92;
  const scale = Math.min((w * margin) / box.w, (h * margin) / box.h);
  d.scale.set(scale, scale);
  d.x = w / 2 - (box.x + box.w / 2) * scale;
  d.y = h / 2 - (box.y + box.h / 2) * scale;
  positionStage();
}

window.addEventListener("resize", () => fitToFrame());
new ResizeObserver(() => fitToFrame()).observe(document.body);

window.addEventListener("message", (event: MessageEvent) => {
  if (event.origin !== window.location.origin) return;
  const msg = event.data as HostToFrame;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;

  (async () => {
    switch (msg.type) {
      case "load":
        await load(msg);
        break;

      case "clear":
        loadSeq++;
        errEl.style.display = "none";
        disposeCurrent();
        currentAnimation = "";
        playing = false;
        fitBox = null;
        stageBox = null;
        stageGfx?.destroy();
        stageGfx = null;
        lastReportedFrame = -1;
        break;

      case "play":
        if (currentAnimation) start(currentAnimation);
        break;

      case "resume":
        // Carry on from where the pause left the track; restart only when
        // there is nothing to carry on from, or a one-shot has finished.
        if (view && currentAnimation) {
          const entry = view.track();
          if (entry && (loop || entry.trackTime < entry.duration)) playing = true;
          else start(currentAnimation);
        }
        break;

      case "pause":
        playing = false;
        break;

      case "setLoop": {
        loop = msg.on;
        view?.setLoop(loop);
        break;
      }

      case "setSpeed":
        speed = msg.speed;
        break;

      case "setFps":
        maxFps = msg.fps;
        if (app) app.ticker.maxFPS = maxFps;
        break;

      case "seek":
        seekTo(msg.frame);
        break;

      case "playQueue": {
        const steps = view ? queueSteps(msg.entries, view.animations, loop) : [];
        if (!view || !steps.length) break;
        view.queue(steps);
        showUnsupported(view.unsupported);
        currentAnimation = steps[steps.length - 1]!.name;
        playing = true;
        break;
      }

      case "setAnimation":
        if (view && view.animations.includes(msg.name)) {
          currentAnimation = msg.name;
          start(currentAnimation);
        }
        break;

      case "setDebug":
        view?.setDebug(msg.on);
        break;

      case "setBackground":
        if (app) app.renderer.background.color = colorOf(msg.color);
        break;

      case "showStage":
        showStage = msg.on;
        if (app) { drawStage(app); fitToFrame(); }
        break;

      case "getMatrices":
        post({ type: "matrices", ...(view ? view.matrices() : { bones: {}, attachments: {} }) });
        break;
    }
  })().catch(fail);
});

// For debugging and for the parity harness, which reads the runtime's own
// matrices to compare with the editor's.
(window as unknown as Record<string, unknown>).__preview = {
  get app() { return app; },
  get view() { return view; },
  fitToFrame,
};

post({
  type: "ready",
  version: RUNTIME === "boneburst" ? `BoneBurst runtime (P0), PixiJS ${PIXI.VERSION}` : `spine-pixi-v8 4.3.13, PixiJS ${PIXI.VERSION}`,
});
