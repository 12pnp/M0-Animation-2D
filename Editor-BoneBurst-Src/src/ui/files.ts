/**
 * Which of the files a person picked or dropped are the skeleton, its atlas and the atlas's page
 * images. The choice is pure (`pickFiles`, tested); reading them is the browser's.
 */

export interface Picked<F> {
  skeleton: F | null;
  atlas: F | null;
  /** Images by file name, for the atlas's pages to find. */
  images: Map<string, F>;
  /** Files that were none of these, or a second skeleton or atlas. */
  ignored: F[];
}

const IMAGE = /\.(png|jpe?g|webp)$/i;

export function pickFiles<F extends { name: string }>(files: readonly F[]): Picked<F> {
  const out: Picked<F> = { skeleton: null, atlas: null, images: new Map(), ignored: [] };
  const lower = (f: F) => f.name.toLowerCase();
  for (const f of files) {
    const n = lower(f);
    if (n.endsWith(".bb.json")) out.ignored.push(f); // the sidecar (E4)
    else if (n.endsWith(".json") && !out.skeleton) out.skeleton = f;
    else if ((n.endsWith(".atlas") || n.endsWith(".atlas.txt")) && !out.atlas) out.atlas = f;
    else if (IMAGE.test(n)) out.images.set(f.name, f);
    else out.ignored.push(f);
  }
  return out;
}

/** The skeleton's name for the title and for saving: its file name without `.json`. */
export function baseName(file: string): string {
  return file.replace(/^.*[\\/]/, "").replace(/\.json$/i, "");
}
