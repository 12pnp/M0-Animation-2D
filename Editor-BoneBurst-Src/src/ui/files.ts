import { sidecarName } from "@/io/sidecar";

/**
 * Which of the files a person picked or dropped are the skeleton, its atlas and the atlas's page
 * images. The choice is pure (`pickFiles`, tested); reading them is the browser's.
 */

export interface Picked<F> {
  skeleton: F | null;
  atlas: F | null;
  /** The skeleton's sidecar: the `.bb.json` named after it (`hero.bb.json` for `hero.json`). */
  sidecar: F | null;
  /** A Photoshop file to import (E4 step 7); it takes the place of a skeleton and atlas. */
  psd: F | null;
  /** Images by file name, for the atlas's pages to find. */
  images: Map<string, F>;
  /** Files that were none of these, or a second skeleton or atlas. */
  ignored: F[];
}

const IMAGE = /\.(png|jpe?g|webp)$/i;

/**
 * What a folder is missing to be a Spine export the editor can open: the skeleton .json, the
 * .atlas and at least one page image, by file name. Empty when it has all three.
 */
export function spineFolderProblems(names: readonly string[]): string[] {
  const picked = pickFiles(names.map((name) => ({ name })));
  const missing: string[] = [];
  if (!picked.skeleton) missing.push("the skeleton (.json)");
  if (!picked.atlas) missing.push("the atlas (.atlas)");
  if (!picked.images.size) missing.push("a page image (.png)");
  return missing;
}

export function pickFiles<F extends { name: string }>(files: readonly F[]): Picked<F> {
  const out: Picked<F> = { skeleton: null, atlas: null, sidecar: null, psd: null, images: new Map(), ignored: [] };
  const sidecars: F[] = [];
  const lower = (f: F) => f.name.toLowerCase();
  for (const f of files) {
    const n = lower(f);
    if (n.endsWith(".bb.json")) sidecars.push(f);
    else if (n.endsWith(".json") && !out.skeleton) out.skeleton = f;
    else if ((n.endsWith(".atlas") || n.endsWith(".atlas.txt")) && !out.atlas) out.atlas = f;
    else if (n.endsWith(".psd") && !out.psd) out.psd = f;
    else if (IMAGE.test(n)) out.images.set(f.name, f);
    else out.ignored.push(f);
  }
  // Only the skeleton's own sidecar; any other is ignored.
  const own = out.skeleton ? sidecarName(out.skeleton.name.replace(/^.*[\\/]/, "")).toLowerCase() : null;
  for (const f of sidecars) {
    if (!out.sidecar && own !== null && f.name.replace(/^.*[\\/]/, "").toLowerCase() === own) out.sidecar = f;
    else out.ignored.push(f);
  }
  return out;
}

/** The skeleton's name for the title and for saving: its file name without `.json`. */
export function baseName(file: string): string {
  return file.replace(/^.*[\\/]/, "").replace(/\.json$/i, "");
}
