import { idbGet, idbSet } from "./idb";
import type { ProjectFile } from "./session";

const KEY = "recent-projects";
const MAX = 8;

/**
 * File ▸ Recent: the project files this browser opened or saved through the File System Access
 * pickers, newest first, their handles kept in IndexedDB. A browser without those pickers never
 * has any (a download leaves no handle to open again). Reopening asks the browser for access again.
 */

/** A file handle as the browser gives it: the parts the list uses. */
export interface RecentHandle extends ProjectFile {
  getFile(): Promise<File>;
  isSameEntry?(other: unknown): Promise<boolean>;
  queryPermission?(d: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "readwrite" }): Promise<PermissionState>;
}

export interface Recent { readonly name: string; readonly handle: RecentHandle; readonly at: number }

let list: Recent[] = [];

export const recent = {
  /** The list as last read or changed: what the menu shows. */
  get list(): readonly Recent[] { return list; },

  /** Read the kept list (once, at start). */
  async load(): Promise<void> {
    const kept = await idbGet<Recent[]>("handles", KEY);
    if (Array.isArray(kept)) list = kept.filter((r) => r && typeof r.name === "string" && r.handle);
  },

  /** Put a project file first, once. */
  async add(handle: RecentHandle): Promise<void> {
    const rest: Recent[] = [];
    for (const r of list) {
      let same = r.name === handle.name && r.handle === handle;
      if (!same && r.name === handle.name && handle.isSameEntry) same = await handle.isSameEntry(r.handle).catch(() => false);
      if (!same) rest.push(r);
    }
    list = [{ name: handle.name, handle, at: Date.now() }, ...rest].slice(0, MAX);
    await idbSet("handles", KEY, list);
  },

  async remove(r: Recent): Promise<void> {
    list = list.filter((x) => x !== r);
    await idbSet("handles", KEY, list);
  },

  async clear(): Promise<void> {
    list = [];
    await idbSet("handles", KEY, undefined);
  },
};

/** The file of a recent project, after asking the browser for access again when it needs it. */
export async function readRecent(r: Recent): Promise<File> {
  let state = (await r.handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state !== "granted") state = (await r.handle.requestPermission?.({ mode: "readwrite" })) ?? "denied";
  if (state !== "granted") throw new Error(`The browser did not allow ${r.name} to be opened again.`);
  return r.handle.getFile();
}

/** A folder the person added to the Open dialog, with whether it is starred (kept at the top). */
export interface ProjectFolder { readonly name: string; readonly handle: FolderHandle; readonly star: boolean }

/** A directory handle as the browser gives it: the parts the dialog uses. */
export interface FolderHandle {
  readonly name: string;
  values(): AsyncIterable<{ kind: string; name: string; getFile?(): Promise<File> }>;
  isSameEntry?(other: unknown): Promise<boolean>;
  queryPermission?(d: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" }): Promise<PermissionState>;
}

const FOLDERS = "project-folders";
let kept: ProjectFolder[] = [];

/** The folders of the Open dialog: starred first, then in the order added. */
export const folders = {
  get list(): readonly ProjectFolder[] { return [...kept.filter((f) => f.star), ...kept.filter((f) => !f.star)]; },

  async load(): Promise<void> {
    const read = await idbGet<ProjectFolder[]>("handles", FOLDERS);
    if (Array.isArray(read)) kept = read.filter((f) => f && typeof f.name === "string" && f.handle);
  },

  async add(handle: FolderHandle): Promise<void> {
    for (const f of kept) {
      if (f.handle === handle || (f.name === handle.name && handle.isSameEntry && await handle.isSameEntry(f.handle).catch(() => false))) return;
    }
    kept = [...kept, { name: handle.name, handle, star: false }];
    await idbSet("handles", FOLDERS, kept);
  },

  async toggleStar(f: ProjectFolder): Promise<void> {
    kept = kept.map((x) => (x === f ? { ...x, star: !x.star } : x));
    await idbSet("handles", FOLDERS, kept);
  },

  async remove(f: ProjectFolder): Promise<void> {
    kept = kept.filter((x) => x !== f);
    await idbSet("handles", FOLDERS, kept);
  },
};

/** A project's file in a folder: `.bbdata` files, by name. */
export async function projectsIn(folder: FolderHandle): Promise<{ name: string; getFile(): Promise<File> }[]> {
  let state = (await folder.queryPermission?.({ mode: "read" })) ?? "granted";
  if (state !== "granted") state = (await folder.requestPermission?.({ mode: "read" })) ?? "denied";
  if (state !== "granted") throw new Error(`The browser did not allow ${folder.name} to be read.`);
  const out: { name: string; getFile(): Promise<File> }[] = [];
  for await (const e of folder.values()) {
    if (e.kind === "file" && e.getFile && /\.bbdata$/i.test(e.name)) out.push({ name: e.name, getFile: e.getFile.bind(e) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
