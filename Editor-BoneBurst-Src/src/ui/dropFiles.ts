/**
 * The files of a drop. A dropped folder is one directory entry in `dataTransfer.files`, with no
 * content; its files are reached through `webkitGetAsEntry`, which this walks (the first level of
 * subfolders too, for an export kept in `export/`).
 */

const MAX_DEPTH = 2;

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, depth: number, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await fileOf(entry as FileSystemFileEntry));
    return;
  }
  if (!entry.isDirectory || depth > MAX_DEPTH) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns a batch at a time (100 in Chrome): read until it is empty.
  for (;;) {
    const batch: FileSystemEntry[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await walk(child, depth + 1, out);
  }
}

/** Every file in a drop, folders opened. */
export async function droppedFiles(data: DataTransfer): Promise<File[]> {
  // Entries must be taken before the first await: the drop's data goes stale after the event.
  const entries: FileSystemEntry[] = [];
  for (const item of data.items) {
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (!entries.length) return [...data.files];
  const out: File[] = [];
  for (const entry of entries) await walk(entry, 0, out);
  return out;
}
