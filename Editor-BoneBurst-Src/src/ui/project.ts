import { type BbFile, packBbdata } from "@/io/bbdata";
import type { View } from "@/edit/sidecar";
import { sidecarName } from "@/io/sidecar";
import { referenceFile } from "./stage/references";
import type { ProjectFile, Session } from "./session";
import { exportFiles } from "./unityExport";

/**
 * Save Project (docs/BBDATA-PLAN.md): the open rig as one `.bbdata` file, ⌘S. What Spine and Unity
 * read is written by Export, not by this: the project also keeps the view, guides and references.
 */

/** The files a project holds: what a folder import reads, so opening one is that open. */
export async function projectFiles(session: Session, view: View): Promise<BbFile[]> {
  const encoder = new TextEncoder();
  const files: BbFile[] = (await exportFiles(session)).map((f) => ({ name: f.name, data: typeof f.data === "string" ? encoder.encode(f.data) : f.data }));
  files.push({ name: sidecarName(`${session.name}.json`), data: encoder.encode(session.projectSidecar(view)) });
  const taken = new Set(files.map((f) => f.name.toLowerCase()));
  for (const [path, blob] of session.referenceBlobs) {
    const name = referenceFile(path);
    // Two references with one file name, or one named like a page: the first is kept.
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return files;
}

type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<ProjectFile>;

/** A browser that can write a chosen file again (File System Access); an automated one is given downloads. */
function picker(): SavePicker | null {
  const pick = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return pick && !navigator.webdriver ? pick.bind(window) : null;
}

export function download(name: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Write the project: to the file it has (opened from, or saved to before), else one the person
 * picks; a download where the browser cannot write files. `again` picks a new file (Save As).
 * Returns the file's name, or null when the person cancelled the picker (nothing is marked saved).
 */
export async function saveProject(session: Session, view: View, again = false): Promise<string | null> {
  if (!session.doc) throw new Error("Nothing is open to save.");
  const bytes = packBbdata(await projectFiles(session, view));
  const fileName = `${session.name}.bbdata`;
  const pick = picker();
  if (pick) {
    let file = again ? null : session.projectFile;
    if (!file) {
      try {
        file = await pick({ suggestedName: fileName, types: [{ description: "BoneBurst project", accept: { "application/x-boneburst-project": [".bbdata"] } }] });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return null;
        throw err;
      }
    }
    const w = await file.createWritable();
    await w.write(bytes);
    await w.close();
    session.projectFile = file;
    session.markSaved();
    session.generated = null;
    return file.name;
  }
  download(fileName, new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  session.markSaved();
  session.generated = null;
  return fileName;
}
