import { writeAtlas } from "@/io/atlas";
import { encodePng } from "@/io/png";
import { sidecarName, writeSidecar } from "@/io/sidecar";
import { writeSkeleton } from "@/io/skeletonWrite";
import { hasContent } from "@/edit/sidecar";
import { idbAll, idbSet } from "./idb";
import type { Preferences } from "./preferences";
import type { Session, Source } from "./session";

/**
 * Autosave and recovery (E6-PLAN step 4a): one recovery copy of unsaved work, in the browser,
 * written every few seconds while the document is unsaved and changed, cleared when nothing is
 * unsaved; offered back when the editor opens. It is not the file: Save writes that.
 */

export interface RecoveryRecord {
  readonly version: 1;
  /** The document it is the copy of (each open file has one copy). A copy from before there were several has none: it is filed as "current". */
  readonly id?: string;
  readonly name: string;
  /** When it was written (ms since the epoch). */
  readonly savedAt: number;
  readonly skeleton: string;
  readonly atlas: string | null;
  readonly pages: readonly { readonly name: string; readonly png: Uint8Array }[];
  readonly sidecar: string | null;
  /** The atlas was made by the editor (a PSD import not saved yet): Save writes it. */
  readonly generated: boolean;
  /** Written by Save (Preferences ▸ Files: keep in this browser): kept while nothing is unsaved, until a file is saved or it is discarded. */
  readonly pinned?: boolean;
  /** Changes made after the last Save are in it (a record without this is an autosave of unsaved work). */
  readonly unsaved?: boolean;
}

/** What a copy from before each open file had its own is filed under. */
const LEGACY = "current";

/** The record as the files it would be opened from: the skeleton, its atlas and pages, its sidecar. */
export function sourcesOf(r: RecoveryRecord): Source[] {
  const text = (name: string, t: string): Source => ({ name, text: async () => t, blob: async () => new Blob([t]) });
  const bytes = (name: string, b: Uint8Array): Source => ({ name, text: async () => new TextDecoder().decode(b), blob: async () => new Blob([b as BlobPart], { type: "image/png" }) });
  return [
    text(`${r.name}.json`, r.skeleton),
    ...(r.atlas !== null ? [text(`${r.name}.atlas.txt`, r.atlas)] : []),
    ...r.pages.map((p) => bytes(p.name, p.png)),
    ...(r.sidecar !== null ? [text(sidecarName(`${r.name}.json`), r.sidecar)] : []),
  ];
}

/**
 * The open document as a record, the moment it is asked for: everything it needs is taken now (the pages' pixels are asked for
 * now too), so the file can be set aside, or another opened, while the pictures are still being encoded. Null when nothing is open.
 */
export function recordOf(session: Session, pinned = false, unsaved = true): Promise<RecoveryRecord | null> {
  const doc = session.doc;
  if (!doc) return Promise.resolve(null);
  const atlas = session.atlas, sidecar = session.sidecar, id = session.recoveryId, name = session.name, generated = session.generated !== null;
  const skeleton = writeSkeleton(doc), atlasText = atlas ? writeAtlas(atlas) : null, sidecarText = hasContent(sidecar) ? writeSidecar(sidecar) : null;
  const reads = (atlas?.pages ?? []).map(async (p) => {
    const px = await session.pagePixels(p.name);
    return px ? { name: p.name, png: await encodePng(px) } : null;
  });
  return Promise.all(reads).then((pages) => ({
    version: 1, id, name, savedAt: Date.now(), skeleton, atlas: atlasText, pages: pages.filter((q): q is { name: string; png: Uint8Array } => q !== null),
    sidecar: sidecarText, generated, pinned, unsaved,
  }));
}

/** Every kept copy, the oldest first (one for each file that was open, and a copy of the older kind if there is one). */
export async function readRecoveries(): Promise<RecoveryRecord[]> {
  const all = await idbAll<RecoveryRecord>("recovery");
  return all.filter((r) => r.value?.version === 1).map((r) => ({ ...r.value, id: r.value.id ?? r.key })).sort((a, b) => a.savedAt - b.savedAt);
}

/** The kept copy of the file filed under `id`. */
export const clearRecovery = (id: string): Promise<boolean> => idbSet("recovery", id, undefined);

/**
 * Writes the kept copies as the preferences say: the shown file's copy every few seconds while it has unsaved changes, and any
 * file's when it is set aside (a file not shown does not change, so that copy is the last word). Paused while older copies wait to
 * be restored or discarded.
 */
export class Autosaver {
  /** Older copies are being offered (or not yet looked for): nothing writes over them, or clears them. */
  paused = true;
  private timer = 0;
  /** What was last written for each file: the document and sidecar then, so an unchanged file is not written again. */
  private readonly written = new Map<string, { doc: unknown; sidecar: string }>();
  private busy = false;

  constructor(private readonly session: Session, private readonly prefs: Preferences, private readonly write: (r: RecoveryRecord) => Promise<boolean> = (r) => idbSet("recovery", r.id ?? LEGACY, r)) {}

  start(): void {
    const arm = () => {
      clearInterval(this.timer);
      this.timer = window.setInterval(() => void this.tick(), this.prefs.values.autosaveSeconds * 1000);
    };
    arm();
    this.prefs.onChange(arm);
    // Hidden or closing: write now, the last chance.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void this.tick(); });
    window.addEventListener("pagehide", () => void this.tick());
  }

  /** Save: write the shown file's copy now, as saved (nothing unsaved in it), and keep it. False when the browser would not store it. */
  async saveNow(): Promise<boolean> {
    const s = this.session, r = await recordOf(s, true, false);
    if (!r || !(await this.write(r))) return false;
    s.browserSaved = true;
    this.written.set(r.id!, { doc: s.doc, sidecar: writeSidecar(s.sidecar) });
    return true;
  }

  /** The shown file is about to be set aside: write its copy now, whatever the timer says. */
  flush(): Promise<void> {
    return this.tick(true);
  }

  /** Write the shown file's copy when something unsaved changed; clear it when nothing is unsaved (and it was not saved to this browser). */
  async tick(force = false): Promise<void> {
    if (this.paused || (!force && this.busy) || !this.prefs.values.autosave && !this.session.browserSaved || !this.session.history) return;
    const s = this.session, id = s.recoveryId;
    this.busy = true;
    try {
      if (!s.dirty) {
        if (s.browserSaved) return;
        if (this.written.delete(id)) await clearRecovery(id);
        return;
      }
      if (!this.prefs.values.autosave) return;
      const sidecar = writeSidecar(s.sidecar), was = this.written.get(id);
      if (was && s.doc === was.doc && sidecar === was.sidecar) return;
      const doc = s.doc, r = await recordOf(s, s.browserSaved, true);
      if (r && await this.write(r)) this.written.set(id, { doc, sidecar });
    } finally {
      this.busy = false;
    }
  }

  /** A kept copy of an older visit was restored into the shown file: it is cleared once nothing is unsaved, like one written here. */
  adopt(id: string): void { this.written.set(id, { doc: null, sidecar: "" }); }

  /** The file filed under `id` is closed: forget what was written for it. */
  forget(id: string): void { this.written.delete(id); }
}
