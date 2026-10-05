import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextureAtlas } from "@esotericsoftware/spine-core";
import type { AssetId } from "@/core/doc/ids";
import type { AtlasImage } from "@/core/boneburst/importBoneBurst";

/**
 * spine-unity's sample skeletons, from the M0-Animation-2D Unity project around
 * this one (`SPINE_SAMPLES` overrides the folder). Tests that use them are
 * skipped, not passed, when the folder is missing.
 */
export const SAMPLES = process.env.SPINE_SAMPLES
  ?? resolve(__dirname, "../../../Packages/com.esotericsoftware.spine.spine-unity/Samples~/Spine Examples/Spine Skeletons");

export interface SampleRig { name: string; json: string; atlas: string }

export function sampleRigs(): SampleRig[] {
  if (!existsSync(SAMPLES)) return [];
  const out: SampleRig[] = [];
  for (const dir of readdirSync(SAMPLES).filter((d) => !d.includes("."))) {
    const files = readdirSync(`${SAMPLES}/${dir}`);
    const json = files.find((f) => f.endsWith(".json"));
    const atlas = files.find((f) => f.endsWith(".atlas.txt"));
    if (json && atlas) {
      out.push({ name: dir, json: readFileSync(`${SAMPLES}/${dir}/${json}`, "utf8"), atlas: readFileSync(`${SAMPLES}/${dir}/${atlas}`, "utf8") });
    }
  }
  return out;
}

/** Each atlas region as an untrimmed library image; no pixels. */
export function imagesOf(atlasText: string): Map<string, AtlasImage> {
  const out = new Map<string, AtlasImage>();
  new TextureAtlas(atlasText).regions.forEach((r, i) => {
    if (!out.has(r.name)) out.set(r.name, { name: r.name, width: r.originalWidth, height: r.originalHeight, assetId: `s${i}` as AssetId });
  });
  return out;
}
