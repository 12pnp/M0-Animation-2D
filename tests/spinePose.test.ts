import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, ClippingAttachment, MeshAttachment, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson,
  TextureAtlas,
} from "@esotericsoftware/spine-core";
import { reseed } from "@/core/doc/ids";
import type { SymbolItem } from "@/core/doc/types";
import { importSpine } from "@/core/spine/importSpine";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { posedSymbol, spinePoseError, stageSkinOf } from "@/core/spine/spinePose";
import { imagesOf, sampleRigs } from "./fixtures/spineSamples";

/**
 * The stage draws an opened Spine file through the runtime (`spinePose.ts`):
 * the document's pose in, the runtime's worlds, attachments, colours, draw
 * order and vertices out. That must be what the EXPORT plays, frame by
 * frame, or the stage would show one thing and the file another. The
 * export is played the way the preview seeks (time f / fps, exactly).
 */

beforeEach(() => reseed());

const found = sampleRigs();

describe.skipIf(found.length === 0)("the stage poses an opened Spine file as its export plays", () => {
  for (const rig of found) {
    it(rig.name, () => {
      const { project } = importSpine(JSON.parse(rig.json), rig.name, imagesOf(rig.atlas));
      const sym = project.items[project.rootSymbolId] as SymbolItem;
      expect(spinePoseError(project, sym)).toBeNull();
      const exported = exportSpine(project);
      const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(rig.atlas)))
        .readSkeletonData(JSON.parse(spineJson(exported.skeleton))));
      // A rig without a default skin shows one the stage picks; so must the file.
      const skin = stageSkinOf(sym);
      if (skin) sk.setSkin(skin);
      const fps = project.frameRate;
      let worst = 0, checks = 0;
      const fail = (where: string, what: string) => { throw new Error(`${rig.name} ${where}: ${what}`); };

      for (const anim of sym.animations) {
        const runtimeAnim = sk.data.findAnimation(anim.name)!;
        for (let f = 0; f < anim.duration; f++) {
          const where = `"${anim.name}" frame ${f}`;
          sk.setupPose();
          runtimeAnim.apply(sk, 0, f / fps, false, null, 1, MixFrom.setup, false, false, false);
          sk.updateWorldTransform(Physics.reset);
          const pose = posedSymbol(project, sym, anim, f, "animate");

          for (const [nodeId, name] of exported.names) {
            const e = pose.byNode.get(nodeId)!;
            const w = sk.findBone(name)!.appliedPose;
            const d = Math.max(Math.abs(e.world.a - w.a), Math.abs(e.world.b + w.c), Math.abs(e.world.c + w.b), Math.abs(e.world.d - w.d));
            const p = Math.max(Math.abs(e.world.tx - w.worldX), Math.abs(e.world.ty + w.worldY));
            worst = Math.max(worst, p);
            if (d > 1e-4 || p > 1e-3) fail(where, `bone "${name}" off by ${d} / ${p}`);
          }
          const drawn = pose.entries.filter((e) => exported.slots.has(e.nodeId)).map((e) => exported.slots.get(e.nodeId));
          const order = sk.drawOrder.appliedPose.map((s) => s.data.name);
          if (drawn.join("|") !== order.join("|")) fail(where, "draw order differs");

          for (const [nodeId, name] of exported.slots) {
            const e = pose.byNode.get(nodeId as never)!;
            const slot = sk.findSlot(name)!;
            const att = slot.appliedPose.getAttachment();
            const drawsImage = att instanceof RegionAttachment || att instanceof MeshAttachment;
            if (!!e.spine !== drawsImage) fail(where, `slot "${name}": the stage ${e.spine ? "draws" : "draws nothing"}, the runtime shows ${att?.name ?? "nothing"}`);
            if ((att instanceof ClippingAttachment) !== !!e.clip) fail(where, `slot "${name}": clipping differs`);
            const l = slot.appliedPose.color;
            const c = e.color;
            const tint = drawsImage ? (att as RegionAttachment).color : null;
            const dr = slot.appliedPose.darkColor?.r ?? 0;
            // The file holds 8-bit colours: a key the import added inside a
            // tween is rounded to one.
            if (Math.abs((c.rM / 100 + c.rO / 255) - l.r * (tint?.r ?? 1)) > 1 / 255 || Math.abs(c.rO / 255 - dr) > 1 / 255
              || Math.abs(c.aM / 100 - l.a * (tint?.a ?? 1)) > 1 / 255) fail(where, `slot "${name}" colour differs`);
            if (!e.spine) continue;
            const v = new Array<number>(e.spine.vertices.length);
            if (att instanceof RegionAttachment) att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), v, 0, 2);
            else (att as MeshAttachment).computeWorldVertices(sk, slot, 0, v.length, v, 0, 2);
            for (let i = 0; i < v.length; i++) {
              const diff = Math.abs(e.spine.vertices[i]! - (i % 2 ? -v[i]! : v[i]!));
              worst = Math.max(worst, diff);
              if (diff > 2e-3) fail(where, `slot "${name}" vertex ${i >> 1} off by ${diff}`);
            }
            checks++;
          }
        }
      }
      console.log(rig.name, "worst", worst, "attachments checked", checks);
      expect(checks).toBeGreaterThan(0);
    });
  }
});
