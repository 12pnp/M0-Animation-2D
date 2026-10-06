import { type RigLayer, rigFromLayers } from "@/edit/layerRig";
import { writeAtlas } from "@/io/atlas";
import { pack, type Page } from "@/io/pack";
import { type PsdLayer, PsdRefused, readPsdLayers } from "@/io/psd";
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

/**
 * Each layer's slot, region and atlas name, bottom first: its name made safe, then unique with a
 * number. A re-import names layers the same way to find them again (E4 step 14).
 */
export function layerNames(layers: readonly PsdLayer[]): string[] {
  const taken: string[] = [];
  for (const l of layers) taken.push(unique(safeName(l.name), taken));
  return taken;
}

/** The layer's Spine blend; an unsupported one is drawn normal and reported in `issues`. */
export function layerBlend(l: PsdLayer, fileName: string, issues: Issue[]): string {
  const blend = BLENDS[l.blend];
  if (!blend) issues.push({ where: `${fileName}: ${[...l.groups, l.name].join(" / ")}`, message: `blend "${l.blend}" has no Spine equivalent: drawn normal` });
  return blend ?? "normal";
}

/** Where a layer's trimmed image's centre is with the canvas's bottom centre at the origin (y up). */
export function layerCentre(l: PsdLayer, canvas: { width: number; height: number }): [number, number] {
  return [l.left + l.width / 2 - canvas.width / 2, canvas.height - (l.top + l.height / 2)];
}

export function importPsd(buffer: ArrayBuffer | Uint8Array, fileName: string, hash: string): PsdImport {
  const name = fileName.replace(/^.*[\\/]/, "").replace(/\.psd$/i, "");
  const read = readPsdLayers(buffer, fileName);
  if (!read.layers.length) throw new PsdRefused(`${fileName} has no visible layer with pixels.`);
  const issues: Issue[] = [...read.issues];
  const names = layerNames(read.layers);
  const layers = read.layers.map((l, i) => ({ l, n: names[i]!, blend: layerBlend(l, fileName, issues) }));
  const packed = pack(layers.map(({ l, n }) => ({ name: n, width: l.width, height: l.height, pixels: l.pixels })), name);
  const rig: RigLayer[] = layers.map(({ l, n, blend }) => ({
    name: n, width: l.width, height: l.height, opacity: l.opacity, blend,
    x: layerCentre(l, read)[0],
    y: layerCentre(l, read)[1],
  }));
  return { name, skeleton: rigFromLayers(hash, rig), atlas: packed.atlas, atlasText: writeAtlas(packed.atlas), pages: packed.pages, issues };
}
