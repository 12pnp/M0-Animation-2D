/// <reference path="../vendor/spine-pixi.d.ts" />
import { type FrameToHost, type HostToFrame, tickFrame } from "./protocol";

/**
 * Runs inside the preview iframe. Drives the OFFICIAL Spine runtime
 * (spine-pixi-v8 4.3.13 on PixiJS 8), fed the exact bytes the editor would
 * write to disk: the skeleton JSON, the `.atlas` text and the page images.
 *
 * That is the whole point of this file: it is not a second renderer, it IS
 * the runtime. If what plays here matches the stage, the export is right.
 */

const errEl = document.getElementById("err")!;

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
let view: spine.Spine | null = null;
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

  // The skeleton is created with autoUpdate off and advanced here, so a
  // pause is exact and a seek is not overwritten by the next tick.
  a.ticker.add((ticker) => {
    // An exception in a Pixi ticker listener ends the loop, and the preview
    // would sit frozen with nothing said: report it and carry on.
    try {
      if (view && playing) view.update(ticker.deltaMS / 1000);
      reportTick();
    } catch (err) {
      fail(err);
    }
  });

  app = a;
  return a;
}

function frameCountOf(name: string): number {
  const anim = view?.skeleton.data.findAnimation(name);
  return anim ? Math.round(anim.duration * frameRate) : 0;
}

function reportTick(): void {
  if (!view || !currentAnimation) return;
  const entry = view.state.getTrack(0);
  // A non-looping animation stops advancing at its end: stop the clock and
  // say so, so the transport's play button comes back.
  if (playing && entry && !loop && entry.trackTime >= entry.animation.duration) playing = false;
  const frame = tickFrame(entry ? entry.getAnimationTime() : 0, frameRate, frameCountOf(currentAnimation));
  if (frame !== lastReportedFrame || playing !== lastReportedPlaying) {
    lastReportedFrame = frame;
    lastReportedPlaying = playing;
    post({ type: "tick", frame, playing });
  }
}

function disposeCurrent(): void {
  if (view) {
    view.destroy({ children: true });
    view = null;
  }
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
  const atlas = new spine.TextureAtlas(msg.atlas);
  const pageTextures: PIXI.Texture[] = [];
  for (const page of atlas.pages) {
    const i = msg.pages.findIndex((p) => p.name === page.name);
    if (i < 0) throw new Error(`The atlas names a page "${page.name}" that was not sent.`);
    // Straight from the decoded bitmap: PIXI.Assets cannot resolve a blob
    // URL (no extension to pick a parser from) and hands back an empty
    // texture without raising.
    const texture = PIXI.Texture.from(bitmaps[i]!);
    pageTextures.push(texture);
    page.setTexture(spine.SpineTexture.from(texture.source));
  }
  const skeletonData = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(msg.skeleton);

  disposeCurrent();
  textures = pageTextures;
  view = new spine.Spine({ skeletonData, autoUpdate: false });
  // The stage's skins, combined as `spinePose.combineSkins` does.
  const skins = (msg.skins ?? []).map((n) => skeletonData.findSkin(n)).filter((s): s is spine.Skin => !!s);
  if (skins.length) {
    const combined = new spine.Skin(msg.skins!.join(" + "));
    for (const s of skins) combined.addSkin(s);
    view.skeleton.setSkin(combined);
  }
  view.debug = msg.debugDraw ? new spine.SpineDebugRenderer() : undefined;

  fitBox = msg.fit ?? null;
  stageBox = msg.stage ?? null;
  frameRate = skeletonData.fps || 24;
  const names = skeletonData.animations.map((x) => x.name);
  currentAnimation = msg.animation && names.includes(msg.animation) ? msg.animation : names[0] ?? "";
  lastReportedFrame = -1;

  // Fitted before it is added, from the editor's box: waiting for a frame
  // to measure it drew it at its origin and full size first.
  fitToFrame();
  drawStage(a);
  a.stage.addChild(view);
  if (currentAnimation) {
    if (msg.play) start(currentAnimation);
    else seekTo(msg.frame ?? 0);
  } else {
    playing = false;
    view.update(0);
  }

  post({ type: "loaded", animations: names, animation: currentAnimation, duration: frameCountOf(currentAnimation) });
}

/** Play the current animation from its start, on the runtime's clock. */
function start(name: string): void {
  if (!view) return;
  view.skeleton.setupPose();
  view.state.setAnimation(0, name, loop);
  view.update(0);
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
  view.skeleton.setupPose();
  const entry = view.state.setAnimation(0, currentAnimation, loop);
  entry.trackTime = frame / frameRate;
  view.update(0);
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
  stageGfx.x = view.x;
  stageGfx.y = view.y;
  stageGfx.scale.set(view.scale.x, view.scale.y);
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

  if (!box) {
    view.scale.set(1, 1);
    view.x = w / 2;
    view.y = h / 2;
    positionStage();
    return;
  }
  const margin = 0.92;
  const scale = Math.min((w * margin) / box.w, (h * margin) / box.h);
  view.scale.set(scale, scale);
  view.x = w / 2 - (box.x + box.w / 2) * scale;
  view.y = h / 2 - (box.y + box.h / 2) * scale;
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
          const entry = view.state.getTrack(0);
          if (entry && (loop || entry.trackTime < entry.animation.duration)) playing = true;
          else start(currentAnimation);
        }
        break;

      case "pause":
        playing = false;
        break;

      case "setLoop": {
        loop = msg.on;
        const entry = view?.state.getTrack(0);
        if (entry) entry.loop = loop;
        break;
      }

      case "seek":
        seekTo(msg.frame);
        break;

      case "setAnimation":
        if (view && view.skeleton.data.findAnimation(msg.name)) {
          currentAnimation = msg.name;
          start(currentAnimation);
        }
        break;

      case "setDebug":
        if (view) view.debug = msg.on ? new spine.SpineDebugRenderer() : undefined;
        break;

      case "setBackground":
        if (app) app.renderer.background.color = colorOf(msg.color);
        break;

      case "showStage":
        showStage = msg.on;
        if (app) { drawStage(app); fitToFrame(); }
        break;

      case "getMatrices": {
        const bones: Record<string, number[]> = {};
        const attachments: Record<string, string | null> = {};
        if (view) {
          for (const b of view.skeleton.bones) {
            const p = b.appliedPose;
            bones[b.data.name] = [p.a, p.b, p.c, p.d, p.worldX, p.worldY];
          }
          for (const s of view.skeleton.slots) attachments[s.data.name] = s.appliedPose.getAttachment()?.name ?? null;
        }
        post({ type: "matrices", bones, attachments });
        break;
      }
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

post({ type: "ready", version: `spine-pixi-v8 4.3.13, PixiJS ${PIXI.VERSION}` });
