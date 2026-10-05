import { type RigLayer, rigFromLayers } from "@/edit/layerRig";
import { writeAtlas } from "@/io/atlas";
import { pack, type Page } from "@/io/pack";
import { PsdRefused, readPsdLayers } from "@/io/psd";
import type { Atlas } from "@/model/atlas";
import type { Issue } from "@/model/issue";
import type { Skeleton } from "@/model/skeleton";
import { unique } from "./panels/outline";

/**
 * A Photoshop file turned into a new rig (E4-PLAN step 7): its layers read (`io/psd`), packed into
 * atlas pages (`io/pack`), and a skeleton with a slot and region per layer (`edit/layerRig`). No
 * DOM: the browser only encodes the pages as PNG files. The skeleton's origin is the canvas's
 * bottom centre; one Photoshop pixel is one unit.
 */

export interface PsdImport {
  readonly name: string;
  readonly skeleton: Skeleton;
  readonly atlas: Atlas;
  readonly atlasText: string;
  readonly pages: readonly Page[];
  readonly issues: readonly Issue[];
}

/** Photoshop blend → Spine slot blend; others draw normal and are reported. */
const BLENDS: Record<string, string> = { "normal": "normal", "pass through": "normal", "multiply": "multiply", "screen": "screen", "linear dodge": "additive" };

/** A layer name as a slot, region and atlas name: no colon or line break (the atlas reader would misread them). */
export function safeName(name: string): string {
  return name.replace(/[:\r\n]/g, "_").trim() || "layer";
}

export function importPsd(buffer: ArrayBuffer | Uint8Array, fileName: string, hash: string): PsdImport {
  const name = fileName.replace(/^.*[\\/]/, "").replace(/\.psd$/i, "");
  const read = readPsdLayers(buffer, fileName);
  if (!read.layers.length) throw new PsdRefused(`${fileName} has no visible layer with pixels.`);
  const issues: Issue[] = [...read.issues], taken: string[] = [];
  const layers = read.layers.map((l) => {
    const n = unique(safeName(l.name), taken);
    taken.push(n);
    const blend = BLENDS[l.blend];
    if (!blend) issues.push({ where: `${fileName}: ${[...l.groups, l.name].join(" / ")}`, message: `blend "${l.blend}" has no Spine equivalent: drawn normal` });
    return { l, n, blend: blend ?? "normal" };
  });
  const packed = pack(layers.map(({ l, n }) => ({ name: n, width: l.width, height: l.height, pixels: l.pixels })), name);
  const rig: RigLayer[] = layers.map(({ l, n, blend }) => ({
    name: n, width: l.width, height: l.height, opacity: l.opacity, blend,
    x: l.left + l.width / 2 - read.width / 2,
    y: read.height - (l.top + l.height / 2),
  }));
  return { name, skeleton: rigFromLayers(hash, rig), atlas: packed.atlas, atlasText: writeAtlas(packed.atlas), pages: packed.pages, issues };
}
