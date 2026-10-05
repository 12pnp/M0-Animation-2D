import { expect } from "vitest";
import { AtlasAttachmentLoader, MixFrom, Physics, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { evaluateSymbol } from "@/core/doc/pose";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { atlasText } from "@/core/spine/atlas";
import { posedSymbol } from "@/core/spine/spinePose";
import { isImage, type Project, type SymbolItem } from "@/core/doc/types";

/**
 * The stage (`posedSymbol`) against the full export played by spine-core, every
 * bone's world position at every frame of every animation. Returns how far
 * `bone` ended up from where the editor's own pose (`evaluateSymbol`) puts it,
 * so a test can show the runtime did something.
 */
export function stageAgainstRuntime(project: Project, sym: SymbolItem, bone: string): number {
  const out = exportSpine(project);
  expect(out.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const regions = out.usedImages.map((id, i) => { const it = project.items[id]; if (!isImage(it)) throw new Error("image"); return { name: it.name, x: 0, y: i * 200, width: it.width, height: it.height, offsetX: 0, offsetY: 0, originalWidth: it.width, originalHeight: it.height, rotated: false }; });
  const atlas = new TextureAtlas(atlasText([{ name: "p", imagePath: "p.png", width: 512, height: 4096, scale: 1, regions }]));
  const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.parse(spineJson(out.skeleton))));
  const id = Object.values(sym.nodes).find((n) => n.name === bone)!.id;
  let moved = 0;
  for (const anim of sym.animations) {
    for (let f = 0; f < anim.duration; f++) {
      sk.setupPose();
      sk.data.findAnimation(anim.name)!.apply(sk, 0, f / project.frameRate, false, null, 1, MixFrom.setup, false, false, false);
      sk.updateWorldTransform(Physics.reset);
      const pose = posedSymbol(project, sym, anim, f, "animate");
      for (const [path, name] of out.paths) {
        const b = sk.findBone(name), e = pose.byNode.get(path as never);
        if (!b || !e) continue;
        const w = b.appliedPose;
        expect(Math.abs(w.worldX - e.world.tx) + Math.abs(w.worldY + e.world.ty), `${anim.name} ${f} ${name}`).toBeLessThan(1e-3);
      }
      const own = evaluateSymbol(sym, anim, f, "animate").byNode.get(id)!.world, posed = pose.byNode.get(id)!.world;
      moved = Math.max(moved, Math.hypot(own.tx - posed.tx, own.ty - posed.ty), Math.abs(own.a - posed.a) * 100);
    }
  }
  return moved;
}
