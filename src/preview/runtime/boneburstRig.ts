/// <reference path="../../vendor/spine-pixi.d.ts" />
import { readAtlas } from "@/core/spine/runtime/atlasRead";
import { readRig } from "@/core/spine/runtime/rigData";
import { Rig } from "@/core/spine/runtime/rig";
import type { AnimationData } from "@/core/spine/runtime/rigData";
import type { QueueStep } from "../queue";
import type { PreviewRig, RigSource } from "./previewRig";

/**
 * The BoneBurst runtime in the Preview (docs/PREVIEW-RUNTIME-PLAN.md, P0):
 * our own reader and pose (`core/spine/runtime/`), drawn as one Pixi mesh per
 * slot. Not the default yet; `animo.previewRuntime` = "boneburst" turns it on.
 *
 * It cuts between queued animations instead of crossfading, and fires no
 * events yet; what else a file holds that it does not play is in `unsupported`.
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
  rig.setSkins(src.skins);
  const unsupported = [...rig.data.unsupported];
  const flag = (what: string) => { if (!unsupported.includes(what)) unsupported.push(what); };

  const display = new PIXI.Container();
  const slotLayer = new PIXI.Container();
  const debugLayer = new PIXI.Graphics();
  display.addChild(slotLayer);
  display.addChild(debugLayer);
  let debug = src.debug;

  // One Pixi mesh per slot, rebuilt when the shape it draws changes: a
  // region's quad, or a mesh attachment's own triangles.
  interface Drawn { mesh: PIXI.Mesh; geometry: PIXI.MeshGeometry; positions: Float32Array; uvs: Float32Array; shape: unknown }
  const meshes: Array<Drawn | null> = rig.data.slots.map(() => null);
  const QUAD = new Uint32Array([0, 1, 2, 2, 3, 0]);
  let drawnOrder = "";

  // The track: what plays now, and what the queue holds after it.
  let entry: { anim: AnimationData; loop: boolean; trackTime: number } | null = null;
  let rest: Array<{ step: QueueStep; anim: AnimationData }> = [];

  const animTime = (e: NonNullable<typeof entry>) => {
    const d = e.anim.duration;
    if (e.loop) return d > 0 ? e.trackTime % d : 0;
    return Math.min(e.trackTime, d);
  };

  function pose(): void {
    rig.setupPose();
    if (entry) rig.apply(entry.anim, animTime(entry), false);
    rig.updateWorld();
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
    const made: Drawn = { mesh: new PIXI.Mesh({ geometry, texture }), geometry, positions, uvs, shape };
    meshes[slot] = made;
    drawnOrder = "";
    return made;
  }

  function draw(): void {
    rig.drawOrder.forEach((slot) => {
      const att = rig.attachmentOf(slot);
      const frame = att && rig.frameOf(slot, att);
      if (!att || !frame?.region) { const m = meshes[slot]; if (m) m.mesh.visible = false; return; }
      const texture = textures.get(frame.region.page.name)!;
      const m = att.kind === "mesh"
        ? drawnFor(slot, att.triangles, att.vertexCount, texture)
        : drawnFor(slot, QUAD, 4, texture);
      m.mesh.visible = true;
      m.mesh.texture = texture;
      if (att.kind === "mesh") rig.meshWorld(slot, att, m.positions);
      else rig.regionWorld(slot, att, m.positions);
      // The format is y up, the screen y down.
      for (let i = 1; i < m.positions.length; i += 2) m.positions[i] = -m.positions[i]!;
      m.uvs.set(frame.uvs);
      m.geometry.getBuffer("aPosition").update();
      m.geometry.getBuffer("aUV").update();
      const c = rig.color, k = slot * 4, a = att.color;
      const r = c[k]! * a[0], g = c[k + 1]! * a[1], b = c[k + 2]! * a[2];
      m.mesh.tint = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
      m.mesh.alpha = c[k + 3]! * a[3];
      const blend = rig.data.slots[slot]!.blend;
      m.mesh.blendMode = blend === "additive" ? "add" : blend;
    });
    // Restack only when the order or the set of meshes changed.
    const order = rig.drawOrder.join(",");
    if (order !== drawnOrder) {
      drawnOrder = order;
      slotLayer.removeChildren();
      for (const slot of rig.drawOrder) { const m = meshes[slot]; if (m) slotLayer.addChild(m.mesh); }
    }
    drawDebug();
  }

  /** Bones as lines from their origin along their x axis, roots as dots. */
  function drawDebug(): void {
    debugLayer.clear();
    if (!debug) return;
    const W = rig.world;
    for (const b of rig.data.bones) {
      const w = b.index * 6;
      const x = W[w + 4]!, y = -W[w + 5]!;
      const len = b.length || 0;
      debugLayer.circle(x, y, 3).fill({ color: 0xff3f00, alpha: 0.9 });
      if (len > 0) {
        debugLayer.moveTo(x, y).lineTo(x + W[w]! * len, y - W[w + 2]! * len).stroke({ color: 0xffbd00, alpha: 0.9, width: 2 });
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
      entry = anim ? { anim, loop, trackTime: 0 } : null;
      rest = [];
      pose();
    },
    seek(name, time, loop) {
      const anim = find(name);
      entry = anim ? { anim, loop, trackTime: time } : null;
      rest = [];
      pose();
    },
    queue(steps) {
      const resolved = steps.map((step) => ({ step, anim: find(step.name)! })).filter((s) => s.anim);
      if (!resolved.length) return;
      if (resolved.some((s) => s.step.mix > 0)) flag("crossfades (queued animations cut instead)");
      entry = { anim: resolved[0]!.anim, loop: resolved[0]!.step.loop, trackTime: 0 };
      rest = resolved.slice(1);
      pose();
    },
    advance(dt) {
      if (!entry) return;
      entry.trackTime += dt;
      // The next queued animation starts where the crossfade into it would:
      // its mix before the current one ends.
      while (rest.length && entry.trackTime >= Math.max(0, entry.anim.duration - rest[0]!.step.mix)) {
        const over: number = entry.trackTime - Math.max(0, entry.anim.duration - rest[0]!.step.mix);
        const next = rest.shift()!;
        entry = { anim: next.anim, loop: next.step.loop, trackTime: over };
      }
      pose();
    },
    track() {
      return entry && { name: entry.anim.name, time: animTime(entry), trackTime: entry.trackTime, duration: entry.anim.duration, loop: entry.loop };
    },
    setLoop(on) { if (entry) entry.loop = on; },
    setDebug(on) { debug = on; drawDebug(); },
    matrices() {
      const bones: Record<string, number[]> = {};
      const attachments: Record<string, string | null> = {};
      for (const b of rig.data.bones) bones[b.name] = rig.yDown(b.index);
      for (const s of rig.data.slots) attachments[s.name] = rig.attachmentOf(s.index)?.name ?? null;
      return { bones, attachments };
    },
    destroy() {
      for (const m of meshes) m?.mesh.destroy();
      display.destroy({ children: true });
    },
  };
}
