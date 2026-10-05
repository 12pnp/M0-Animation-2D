/**
 * The project's sound files, by the path an event names them with
 * (`EventDef.audio`, ARCHITECTURE ▸ Events). Like images (`AssetStore`) they
 * live outside the undoable document: the document holds the path, a save
 * writes the file under `sounds/` in the `.boneburst`, and the export writes it
 * into the skeleton's `audio/` folder at that path. A game finds it there by
 * the same path.
 */
export class SoundStore {
  private sounds = new Map<string, Blob>();
  private listeners = new Set<() => void>();

  get(path: string): Blob | undefined { return this.sounds.get(path); }
  has(path: string): boolean { return this.sounds.has(path); }
  /** Every path, sorted. */
  paths(): string[] { return [...this.sounds.keys()].sort(); }

  /** Add a file under its own name, or `name` when given; a file already
   *  there under that path is replaced. The path it is stored under. */
  add(blob: Blob, name: string): string {
    const path = soundPath(name);
    this.sounds.set(path, blob);
    this.changed();
    return path;
  }

  clear(): void {
    this.sounds.clear();
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void { for (const fn of this.listeners) fn(); }
}

/** A sound file's path as an event names it: forward slashes, no leading
 *  slash or dot segments, so it stays inside the `audio/` folder. */
export function soundPath(name: string): string {
  return name.replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..").join("/") || "sound";
}
