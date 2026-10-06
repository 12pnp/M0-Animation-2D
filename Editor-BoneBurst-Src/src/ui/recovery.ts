import { writeAtlas } from "@/io/atlas";
import { encodePng } from "@/io/png";
import { sidecarName, writeSidecar } from "@/io/sidecar";
import { writeSkeleton } from "@/io/skeletonWrite";
import { hasContent } from "@/edit/sidecar";
import { idbGet, idbSet } from "./idb";
import type { Preferences } from "./preferences";
import type { Session, Source } from "./session";

/**
 * Autosave and recovery (E6-PLAN step 4a): one recovery copy of unsaved work, in the browser,
 * written every few seconds while the document is unsaved and changed, cleared when nothing is
 * unsaved; offered back when the editor opens. It is not the file: Save writes that.
 */

export interface RecoveryRecord {
  readonly version: 1;
  readonly name: string;
  /** When it was written (ms since the epoch). */
  readonly savedAt: number;
  readonly skeleton: string;
  readonly atlas: string | null;
  readonly pages: readonly { readonly name: string; readonly png: Uint8Array }[];
  readonly sidecar: string | null;
  /** The atlas was made by the editor (a PSD import not saved yet): Save writes it. */
  readonly generated: boolean;
}

const KEY = "current";

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

/** The open document as a record; null when nothing is open. */
export async function recordOf(session: Session): Promise<RecoveryRecord | null> {
  const doc = session.doc;
  if (!doc) return null;
  const pages: { name: string; png: Uint8Array }[] = [];
  for (const p of session.atlas?.pages ?? []) {
    const px = await session.pagePixels(p.name);
    if (px) pages.push({ name: p.name, png: await encodePng(px) });
  }
  return {
    version: 1, name: session.name, savedAt: Date.now(), skeleton: writeSkeleton(doc),
    atlas: session.atlas ? writeAtlas(session.atlas) : null, pages,
    sidecar: hasContent(session.sidecar) ? writeSidecar(session.sidecar) : null,
    generated: session.generated !== null,
  };
}

export const readRecovery = (): Promise<RecoveryRecord | null> => idbGet<RecoveryRecord>("recovery", KEY).then((r) => (r?.version === 1 ? r : null));
export const clearRecovery = (): Promise<boolean> => idbSet("recovery", KEY, undefined);

/** Writes the recovery copy as the preferences say; paused while an older copy waits to be restored or discarded. */
export class Autosaver {
  /** An older copy is being offered (or not yet looked for): nothing writes over it, or clears it. */
  paused = true;
  private timer = 0;
  private lastDoc: unknown = null;
  private lastSidecar = "";
  /** A copy may be stored (one from before this page counts): cleared once nothing is unsaved. */
  private kept = true;
  private busy = false;

  constructor(private readonly session: Session, private readonly prefs: Preferences, private readonly write: (r: RecoveryRecord) => Promise<boolean> = (r) => idbSet("recovery", KEY, r)) {}

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

  /** Write the copy when something unsaved changed; clear it when nothing is unsaved. */
  async tick(): Promise<void> {
    if (this.paused || this.busy || !this.prefs.values.autosave || !this.session.history) return;
    this.busy = true;
    try {
      if (!this.session.dirty) {
        if (this.kept) { await clearRecovery(); this.kept = false; this.lastDoc = null; }
        return;
      }
      const sidecar = writeSidecar(this.session.sidecar);
      if (this.session.doc === this.lastDoc && sidecar === this.lastSidecar) return;
      const r = await recordOf(this.session);
      if (r && await this.write(r)) { this.kept = true; this.lastDoc = this.session.doc; this.lastSidecar = sidecar; }
    } finally {
      this.busy = false;
    }
  }
}
