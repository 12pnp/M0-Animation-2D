import { writeAtlas } from "@/io/atlas";
import { encodePng } from "@/io/png";
import { writeSkeleton } from "@/io/skeletonWrite";
import { DEFAULT_MAX_STRAY, exportTwin, twinSummary, writeTwinSpline } from "@/edit/exportTwin";
import { idbGet, idbSet } from "./idb";
import { bakeSummary, exportDoc } from "./exportPaths";
import { pathFromKeysOf, pathKeysOver } from "./motion";
import type { Session } from "./session";

const KEY = "unity-folder";

/**
 * Export to Unity (E5-PLAN step 8): the skeleton, its atlas and pages written into a folder the
 * person picked once (the browser's folder picker; its handle kept in IndexedDB), the skeleton
 * last, so Unity's BoneBurst import rebakes the folder it baked before. Not Save: the document
 * is not marked saved.
 */

/** Said back to the person, or to the AI as a refusal. */
export class ExportRefused extends Error {}

/** This browser has no folder picker: a person pressing the button is given the files to save instead (the way Open falls back to a plain folder input); the AI is told. */
export class NoFolderPicker extends ExportRefused {}

/** The parts of a folder handle the export uses (File System Access; a stub in tests). */
export interface Folder {
  readonly name: string;
  getFileHandle(name: string, options: { create: boolean }): Promise<{ createWritable(): Promise<{ write(data: Blob | string | Uint8Array): Promise<void>; close(): Promise<void> }> }>;
  queryPermission?(d: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "readwrite" }): Promise<PermissionState>;
}

export interface ExportFile { readonly name: string; readonly data: string | Uint8Array }

/**
 * What an export makes of the motion (docs/UNITY-EXPORT-PLAN.md): `keys` writes the skeleton, a bone that uses its path with translate keys made from it; `twinspline` writes every bone with
 * translate motion as a path in `name.twinspline.json`, the skeleton without those bones' translate timelines.
 */
export type ExportMode = "keys" | "twinspline";

export interface ExportBundle { readonly files: ExportFile[]; /** What the mode did, for the status line and the AI; absent when nothing was baked or moved. */ readonly note?: string }

/** The files an export writes, in order: the atlas and its pages, the TwinSpline file (`twinspline` mode), then the skeleton. */
export async function exportBundle(session: Session, closed = true, mode: ExportMode = "keys"): Promise<ExportBundle> {
  const doc = closed ? session.closedDoc() : session.doc;
  if (!doc) throw new ExportRefused("Nothing is open to export.");
  const files: ExportFile[] = [];
  if (session.atlas) {
    files.push({ name: `${session.name}.atlas.txt`, data: writeAtlas(session.atlas) });
    for (const p of session.atlas.pages) {
      const px = await session.pagePixels(p.name);
      if (!px) throw new ExportRefused(`The page "${p.name}" was not opened with the rig (or is not a PNG), so it cannot be written. Open the rig with all its pages, then export.`);
      files.push({ name: p.name, data: await encodePng(px) });
    }
  }
  if (mode === "twinspline") {
    const out = exportTwin(doc, session.sidecar.motion, (animation, bone) => pathFromKeysOf(session, animation, bone, doc.bones?.find((b) => b.name === bone)?.parent ?? null, doc, DEFAULT_MAX_STRAY / 2));
    files.push({ name: `${session.name}.twinspline.json`, data: writeTwinSpline(out.file) });
    files.push({ name: `${session.name}.json`, data: writeSkeleton(out.skeleton) });
    return { files, note: twinSummary(out.report) };
  }
  // The project's own copy (`closed` off) keeps the document as it is; an export bakes the paths in use into keys.
  if (!closed) {
    files.push({ name: `${session.name}.json`, data: writeSkeleton(doc) });
    return { files };
  }
  const poser = session.poserFor();
  const baked = exportDoc(doc, session.sidecar.motion, (m, length) => {
    if (!poser) throw new ExportRefused("Nothing is open to export.");
    return pathKeysOver(poser, doc, session.skin, m, length, session.fps);
  });
  files.push({ name: `${session.name}.json`, data: writeSkeleton(baked.doc) });
  const note = bakeSummary(baked.report);
  return { files, ...(note ? { note } : {}) };
}

/** The files an export writes (`exportBundle` without the note). */
export async function exportFiles(session: Session, closed = true, mode: ExportMode = "keys"): Promise<ExportFile[]> {
  return (await exportBundle(session, closed, mode)).files;
}

/** Write the files into the folder, one after another; their names. */
export async function writeFiles(folder: Folder, files: readonly ExportFile[]): Promise<string[]> {
  for (const f of files) {
    const w = await (await folder.getFileHandle(f.name, { create: true })).createWritable();
    await w.write(f.data);
    await w.close();
  }
  return files.map((f) => f.name);
}

/** The folder chosen in this page; IndexedDB is read only when there is none yet (after a reload). */
let chosen: Folder | null = null;

/** The Unity folder chosen in this browser, kept between visits. */
export const unityFolder = {
  async get(): Promise<Folder | null> {
    if (chosen) return chosen;
    chosen = await idbGet<Folder>("handles", KEY);
    return chosen;
  },
  async set(f: Folder): Promise<void> {
    chosen = f;
    // Not kept (a private window): chosen again after a reload.
    await idbSet("handles", KEY, f);
  },
};

type Picker = (o: { id: string; mode: "readwrite" }) => Promise<Folder>;

/**
 * Export the open rig to the Unity folder. `gesture`: the person pressed the button, so a folder
 * may be picked (`choose`, or none chosen yet) and access asked for; without it (the AI's call)
 * either missing is a refusal saying what to press.
 */
export async function exportToUnity(session: Session, gesture: boolean, choose = false, mode: ExportMode = "keys"): Promise<{ folder: string; files: string[]; note?: string }> {
  if (!session.doc) throw new ExportRefused("Nothing is open to export.");
  let folder = choose ? null : await unityFolder.get();
  if (!folder) {
    if (!gesture) throw new ExportRefused("No Unity folder has been chosen in this browser: press Export to Unity… (the button after Save in the editor's toolbar) once to choose it.");
    const pick = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
    if (!pick) throw new NoFolderPicker("This browser cannot write to a folder (it has no folder picker): use Chrome or Edge, or Save and copy the files into Unity.");
    try {
      folder = await pick({ id: "boneburst-unity", mode: "readwrite" });
    } catch {
      throw new ExportRefused("No folder was chosen; nothing was exported.");
    }
    await unityFolder.set(folder);
  }
  let state = (await folder.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state !== "granted" && gesture) state = (await folder.requestPermission?.({ mode: "readwrite" })) ?? "denied";
  if (state !== "granted") throw new ExportRefused(`The editor may not write to "${folder.name}" now (the browser asks again after a reload): press Export to Unity… (the button after Save in the toolbar) once to allow it.`);
  const bundle = await exportBundle(session, true, mode);
  const files = await writeFiles(folder, bundle.files);
  return { folder: folder.name, files, ...(bundle.note ? { note: bundle.note } : {}) };
}
