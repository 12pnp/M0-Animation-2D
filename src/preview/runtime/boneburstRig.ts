/// <reference path="../../vendor/spine-pixi.d.ts" />
import { readAtlas } from "@/core/spine/runtime/atlasRead";
import { readRig } from "@/core/spine/runtime/rigData";
import { Rig } from "@/core/spine/runtime/rig";
import type { ClippingData } from "@/core/spine/runtime/rigData";
import { Track } from "@/core/spine/runtime/track";
import { type DrawnSlot, drawList, drawnVertices } from "@/core/spine/runtime/draw";
import type { PreviewRig, RigSource } from "./previewRig";
import { type TwoColor, twoColorShader } from "./twoColor";

/**
 * The BoneBurst runtime in the Preview (docs/PREVIEW-RUNTIME-PLAN.md): our
 * own reader and pose (`core/spine/runtime/`), drawn as one Pixi mesh per
 * slot. The Preview's runtime since P4.
 *
 * The track (`core/spine/runtime/track.ts`) plays, queues and crossfades as
 * spine-core's `AnimationState`; what a file holds that it does not play yet
 * is in `unsupported`.
 */
export function boneburstRig(src: RigSource): PreviewRig {
  const atlas = readAtlas(src.atlas);
  const textures = new Map<string, PIXI.Texture>();
  for (const page of atlas.pages) {
    const texture = src.textures.get(page.name);
    if (!texture) throw new Error(`The atlas names a page "${page.name}" that was not sent.`);
    if (page.pma) texture.source.alphaMode = "premultiplied-alpha";
    textures.set(page.name, texture);
  }
  const rig = new Rig(readRig(src.skeleton, atlas));
  // Posed y down, as spine-pixi's `Skeleton.yDown`: the screen's numbers.
  rig.scaleY = -1;
  rig.setSkins(src.skins);
  const unsupported = [...rig.data.unsupported];

  const display = new PIXI.Container();
  const slotLayer = new PIXI.Container();
  const debugLayer = new PIXI.Graphics();
  display.addChild(slotLayer);
  display.addChild(debugLayer);
  let debug = src.debug;

  // One Pixi mesh per slot, rebuilt when the shape it draws changes: a
  // region's quad, or a mesh attachment's own triangles. What is drawn, in
  // what order and under which clip, is `drawList`'s (core/spine/runtime/draw.ts).
  interface Drawn { mesh: PIXI.Mesh; geometry: PIXI.MeshGeometry; positions: Float32Array; uvs: Float32Array; shape: unknown; twoColor: TwoColor | null }
  const meshes: Array<Drawn | null> = rig.data.slots.map(() => null);
  let drawnOrder = "";

  const track = new Track();

  /** Pose the track after `dt` seconds of the skeleton's clock: physics
   *  steps on it, as spine-pixi's `update` does (a seek is a 0 s update). */
  function pose(dt = 0): void {
    // Events as the runtime fires them, while playing only: a seek poses a
    // frame and must not fire (or sound) what it lands on.
    const fired = track.apply(rig);
    if (src.playing()) {
      const name = track.state()?.name ?? "";
      for (const e of fired) src.onEvent({ animation: name, ...e });
    }
    rig.update(dt);
    rig.updateWorld("update");
    draw();
  }

  /** The slot's Pixi mesh for `shape` (a region's `QUAD` or a mesh
   *  attachment's triangles), made anew when the shape changes. */
  function drawnFor(slot: number, shape: Uint32Array, vertexCount: number, texture: PIXI.Texture): Drawn {
    const old = meshes[slot];
    if (old && old.shape === shape) return old;
    old?.mesh.destroy();
    const positions = new Float32Array(vertexCount * 2), uvs = new Float32Array(vertexCount * 2);
    const geometry = new PIXI.MeshGeometry({ positions, uvs, indices: shape });
    // A slot with a dark colour draws through the two-colour shader.
    const twoColor = rig.data.slots[slot]!.dark ? twoColorShader(texture) : null;
    const mesh = twoColor ? new PIXI.Mesh({ geometry, texture, shader: twoColor.shader }) : new PIXI.Mesh({ geometry, texture });
    const made: Drawn = { mesh, geometry, positions, uvs, shape, twoColor };
    meshes[slot] = made;
    drawnOrder = "";
    return made;
  }

  // A clipping slot's group: the meshes it clips, in a container masked by
  // its polygon (a stencil, the same coverage as Spine cutting triangles).
  interface Clip { group: PIXI.Container; mask: PIXI.Graphics; points: Float64Array; inverse: boolean | null }
  const clips: Array<Clip | null> = rig.data.slots.map(() => null);

  function clipFor(slot: number, att: ClippingData): Clip {
    let c = clips[slot];
    if (!c) {
      const group = new PIXI.Container(), mask = new PIXI.Graphics();
      group.addChild(mask);
      c = clips[slot] = { group, mask, points: new Float64Array(0), inverse: null };
    }
    if (c.inverse !== att.inverse) {
      c.inverse = att.inverse;
      c.group.setMask({ mask: c.mask, inverse: att.inverse });
    }
    if (c.points.length !== att.vertexCount * 2) c.points = new Float64Array(att.vertexCount * 2);
    rig.vertexWorld(slot, att, 0, att.vertexCount * 2, c.points, 0);
    c.mask.clear().poly(Array.from(c.points)).fill({ color: 0xffffff });
    return c;
  }

  function draw(): void {
    const list = drawList(rig);
    const drawn = new Set<number>();
    for (const d of list.slots) { drawSlot(d); drawn.add(d.slot); }
    meshes.forEach((m, slot) => { if (m && !drawn.has(slot)) m.mesh.visible = false; });
    for (const [slot, att] of list.clips) clipFor(slot, att);
    // Restack only when what is drawn, or how it is grouped, changed.
    const key = list.slots.map((e) => `${e.slot}:${e.clip}`).join(",");
    if (key !== drawnOrder) {
      drawnOrder = key;
      slotLayer.removeChildren();
      for (const c of clips) c?.group.removeChildren();
      let group = -1;
      for (const { slot, clip } of list.slots) {
        const mesh = meshes[slot]!.mesh;
        if (clip < 0) { slotLayer.addChild(mesh); group = -1; continue; }
        const c = clips[clip]!;
        if (group !== clip) { c.group.addChild(c.mask); slotLayer.addChild(c.group); group = clip; }
        c.group.addChild(mesh);
      }
    }
    drawDebug();
  }

  /** Pose one drawn slot's Pixi mesh. */
  function drawSlot(d: DrawnSlot): void {
    const texture = textures.get(d.frame.region.page.name)!;
    const m = drawnFor(d.slot, d.triangles, d.vertexCount, texture);
    m.mesh.visible = true;
    m.mesh.texture = texture;
    drawnVertices(rig, d, m.positions);
    m.uvs.set(d.frame.uvs);
    m.geometry.getBuffer("aPosition").update();
    m.geometry.getBuffer("aUV").update();
    const [r, g, b, alpha] = d.color;
    if (m.twoColor) m.twoColor.set(texture, d.color, d.dark ?? [0, 0, 0]);
    else {
      m.mesh.tint = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
      m.mesh.alpha = alpha;
    }
    m.mesh.blendMode = d.blend === "additive" ? "add" : d.blend;
  }

  /** Bones as lines from their origin along their x axis, roots as dots;
   *  bounding boxes, clipping polygons, paths (their control polygon) and
   *  points as outlines, as spine-pixi's debug view shows them. */
  function drawDebug(): void {
    debugLayer.clear();
    if (!debug) return;
    for (const slot of rig.drawOrder) {
      const att = rig.attachmentOf(slot);
      if (!att) continue;
      if (att.kind === "box" || att.kind === "clipping" || att.kind === "path") {
        const pts = new Float64Array(att.vertexCount * 2);
        rig.vertexWorld(slot, att, 0, pts.length, pts, 0);
        const color = att.kind === "box" ? 0x00ff00 : att.kind === "clipping" ? 0xcc0000 : 0xff7f00;
        debugLayer.poly(Array.from(pts), att.kind !== "path" || att.closed).stroke({ color, alpha: 0.9, width: 1 });
      } else if (att.kind === "point") {
        const p = rig.pointWorld(slot, att);
        const r = (p.rotation * Math.PI) / 180;
        debugLayer.circle(p.x, p.y, 3).stroke({ color: 0x00a0ff, width: 1 });
        debugLayer.moveTo(p.x, p.y).lineTo(p.x + Math.cos(r) * 12, p.y + Math.sin(r) * 12).stroke({ color: 0x00a0ff, width: 1 });
      }
    }
    const W = rig.world;
    for (const b of rig.data.bones) {
      if (!rig.active[b.index]) continue;
      const w = b.index * 6;
      const x = W[w + 4]!, y = W[w + 5]!;
      const len = b.length || 0;
      debugLayer.circle(x, y, 3).fill({ color: 0xff3f00, alpha: 0.9 });
      if (len > 0) {
        debugLayer.moveTo(x, y).lineTo(x + W[w]! * len, y + W[w + 2]! * len).stroke({ color: 0xffbd00, alpha: 0.9, width: 2 });
      }
    }
  }

  const find = (name: string) => rig.animation(name);

  return {
    display,
    animations: rig.data.animations.map((a) => a.name),
    fps: rig.data.fps,
    unsupported,
    durationOf: (name) => find(name)?.duration ?? 0,
    start(name, loop) {
      const anim = find(name);
      if (anim) track.start(anim, loop);
      pose();
    },
    seek(name, time, loop) {
      const anim = find(name);
      if (anim) track.seek(anim, time, loop);
      pose();
    },
    queue(steps) {
      const resolved = steps.map((step) => ({ anim: find(step.name)!, loop: step.loop, mix: step.mix })).filter((s) => s.anim);
      if (!resolved.length) return;
      track.queue(resolved);
      pose();
    },
    advance(dt) {
      track.advance(dt);
      pose(dt);
    },
    track: () => track.state(),
    setLoop: (on) => track.setLoop(on),
    setDebug(on) { debug = on; drawDebug(); },
    matrices() {
      const bones: Record<string, number[]> = {};
      const attachments: Record<string, string | null> = {};
      for (const b of rig.data.bones) bones[b.name] = rig.matrix(b.index);
      for (const s of rig.data.slots) attachments[s.name] = rig.attachmentOf(s.index)?.name ?? null;
      return { bones, attachments };
    },
    destroy() {
      for (const m of meshes) m?.mesh.destroy();
      for (const c of clips) c?.group.destroy({ children: true });
      display.destroy({ children: true });
    },
  };
}
