import { withStore } from "@/io/project/idb";

/**
 * File › Export to Unity (docs/BONEBURST-PIPELINE-PLAN.md R4): the export
 * written into a folder of the Unity project, remembered per document, where
 * the import package's `BoneBurstRebakeOnChange` rebakes it once it has been
 * baked the first time. Unity reads the atlas only as `.atlas.txt`.
 */

/**
 * The order the files are written in: everything else, then the atlas, then
 * the skeleton last, so the import that sees the new skeleton finds its atlas
 * and pages already there (a rebake started between two files would bake a
 * half-written export).
 */
export function unityWriteOrder(names: readonly string[]): string[] {
  const rank = (n: string) => (n.endsWith(".json") ? 2 : n.endsWith(".atlas.txt") || n.endsWith(".atlas") ? 1 : 0);
  return [...names].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The folder this document last exported to Unity, by its name. */
export async function rememberedUnityFolder(documentName: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await withStore<FileSystemDirectoryHandle | undefined>("unityExport", "readonly", (s) => s.get(documentName))) ?? null;
  } catch {
    return null;
  }
}

export async function rememberUnityFolder(documentName: string, dir: FileSystemDirectoryHandle): Promise<void> {
  try { await withStore("unityExport", "readwrite", (s) => s.put(dir, documentName)); } catch { /* not remembered: asked again next time */ }
}

type Permissioned = FileSystemDirectoryHandle & {
  queryPermission?(d: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "readwrite" }): Promise<PermissionState>;
};

/**
 * Whether the remembered folder may be written. A grant does not outlive the
 * visit; asking again needs a user gesture (`ask`: a menu click), so the AI's
 * tool only uses a folder granted already.
 */
export async function mayWrite(dir: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  const d = dir as Permissioned;
  const state = (await d.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state === "granted") return true;
  if (!ask) return false;
  return ((await d.requestPermission?.({ mode: "readwrite" })) ?? "denied") === "granted";
}
