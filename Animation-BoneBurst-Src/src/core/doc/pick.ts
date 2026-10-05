import type { AssetId, NodeId } from "./ids";
import { boneburstPixelAt, entryBox, type FrameContext, type Pose } from "./pose";
import { isImage, type Project } from "./types";
import { nearPolyline } from "./boxes";
import { pathPolyline } from "./constraints";
import { applyInverse } from "@/core/math/Matrix2D";
import { inFlatPolygon, rectContains } from "@/core/math/geom";

/** A pixel's alpha, 0–255, by asset and image pixel. */
export type AlphaAt = (asset: AssetId, x: number, y: number) => number;

/**
 * The topmost node under a world point, or null. Walks each pose front to
 * back (the reverse of paint order) and probes alpha, so transparent pixels
 * do not swallow clicks meant for the artwork behind them. Bones are never
 * picked here; a runtime-posed slot picks the bone it rides, as picking an
 * attachment in Spine picks its bone. `tolerance` is how near a path counts,
 * in world units.
 */
export function pickNode(
  project: Project, poses: Iterable<{ pose: Pose; when: FrameContext }>, wx: number, wy: number,
  alphaAt: AlphaAt, tolerance: number, exclude?: ReadonlySet<string>,
): NodeId | null {
  for (const { pose, when } of poses) {
    for (let i = pose.entries.length - 1; i >= 0; i--) {
      const e = pose.entries[i]!;
      if (!e.visible || e.node.kind === "bone") continue;
      if (exclude?.has(e.nodeId)) continue;
      if (e.spine) {
        // Posed by the runtime: its triangles, and the pixel under them.
        const px = boneburstPixelAt(e, wx, wy);
        const item = project.items[e.spine.itemId];
        if (!px || !isImage(item) || alphaAt(item.assetId, px.x, px.y) < 8) continue;
        return e.node.slotBone ?? e.nodeId;
      }
      const outline = e.node.kind === "box" || e.node.kind === "point" || e.node.kind === "path";
      // Points that follow bones are tested where they are in the world.
      if (e.outline && (e.node.box || e.node.path)) {
        const hit = e.node.box ? inFlatPolygon(e.outline, wx, wy) : nearPolyline(pathPolyline({ ...e.node.path!, points: e.outline }), wx, wy, tolerance);
        if (hit) return e.nodeId;
        continue;
      }
      const box = entryBox(project, e, when);
      if (!box || (!e.display && !outline)) continue;

      const local = { x: 0, y: 0 };
      if (!applyInverse(local, e.world, wx, wy)) continue;
      if (!rectContains(box, local.x, local.y)) continue;
      // A bounding box is picked inside its polygon, a point near it.
      if (outline) {
        if (e.node.kind === "box" && !inFlatPolygon(e.node.box!.points, local.x, local.y)) continue;
        if (e.node.kind === "path" && !nearPolyline(pathPolyline(e.node.path!), local.x, local.y, tolerance)) continue;
        return e.nodeId;
      }

      const display = e.display!;
      const item = project.items[display.itemId];
      if (isImage(item) && alphaAt(item.assetId, local.x + display.pivot.x, local.y + display.pivot.y) < 8) continue;
      return e.nodeId;
    }
  }
  return null;
}
