import { writeAtlas } from "@/io/atlas";
import { encodePng } from "@/io/png";
import { writeSkeleton } from "@/io/skeletonWrite";
import { idbGet, idbSet } from "./idb";
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

/** The files an export writes, in order: the atlas and its pages, then the skeleton (`closed` off: the project's own copy, the document as it is). */
export async function exportFiles(session: Session, closed = true): Promise<ExportFile[]> {
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
  files.push({ name: `${session.name}.json`, data: writeSkeleton(doc) });
  return files;
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
export async function exportToUnity(session: Session, gesture: boolean, choose = false): Promise<{ folder: string; files: string[] }> {
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
  return { folder: folder.name, files: await writeFiles(folder, await exportFiles(session)) };
}
