import { strFromU8, strToU8 } from "fflate";
import { unzipFiles, zipFiles } from "@/io/zip";
import type { Project } from "@/core/doc/types";
import { isImage, isSymbol } from "@/core/doc/types";
import { referenceAssets } from "@/core/doc/reference";
import type { AssetId } from "@/core/doc/ids";
import type { SoundStore } from "@/app/SoundStore";
import type { AssetStore } from "@/app/AssetStore";
import { type Diagnostic, validateProject } from "@/core/doc/schema";
import { migrate } from "@/core/doc/migrations";

export const PROJECT_EXTENSION = "boneburst";
/** What the document was saved as before: still opened, saved as the new one. */
export const OLD_PROJECT_EXTENSIONS: readonly string[] = ["animo"];

const OLD_SUFFIX = new RegExp(`\\.(${OLD_PROJECT_EXTENSIONS.join("|")})$`, "i");

/** Was the file saved under an old extension? Saving it again has to make a
 *  new file: a browser file handle cannot rename the one it points to. */
export function isOldProjectName(name: string): boolean {
  return OLD_SUFFIX.test(name);
}

/** The name a document is saved under: an old extension becomes the new one. */
export function projectFileName(name: string): string {
  return name.replace(OLD_SUFFIX, `.${PROJECT_EXTENSION}`);
}

interface Manifest {
  /** assetId -> file name inside the archive. */
  assets: Record<string, string>;
  /** Event sound path (`EventDef.audio`) -> file name inside the archive. */
  sounds?: Record<string, string>;
}

/** The sound paths the document's events name. */
export function soundsUsed(project: Project): string[] {
  const out = new Set<string>();
  for (const item of Object.values(project.items)) {
    if (isSymbol(item)) for (const d of item.events ?? []) if (d.audio) out.add(d.audio);
  }
  return [...out].sort();
}

export interface LoadedProject {
  project: Project;
  diagnostics: Diagnostic[];
}

/**
 * A `.boneburst` (before, `.animo`) is a zip:
 *
 *   project.json      the document
 *   manifest.json     assetId -> archive path
 *   assets/<id>.png   the binaries
 *   sounds/<n>.<ext>  event sounds, by the path events name them with
 *
 * Images live as real files rather than base64 inside the JSON: the document
 * stays readable and diffable, and a project with a few megabytes of art does
 * not become a JSON blob that no tool wants to open.
 */
export async function serializeProject(project: Project, assets: AssetStore, sounds?: SoundStore): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const manifest: Manifest = { assets: {} };

  // Only assets the document actually references — importing and deleting
  // should not leave weight behind in every future save.
  // Taken before the first await: an edit landing while the images are read
  // must not reach a project.json whose image list was already fixed.
  const json = JSON.stringify(project, null, 2);
  const used = new Set<AssetId>();
  for (const item of Object.values(project.items)) {
    if (isImage(item)) used.add(item.assetId);
    // Reference art is kept too: it is part of the document, only not exported.
    if (isSymbol(item)) for (const id of referenceAssets(item.animations)) used.add(id as AssetId);
  }

  for (const id of used) {
    const asset = assets.get(id);
    if (!asset) continue;
    const path = `assets/${id}.png`;
    files[path] = new Uint8Array(await asset.blob.arrayBuffer());
    manifest.assets[id] = path;
  }

  // Event sounds the document names, under numbered names: a path may hold
  // folders and characters an archive entry should not.
  const named = sounds ? soundsUsed(project).filter((p) => sounds.has(p)) : [];
  if (named.length) manifest.sounds = {};
  for (const [i, path] of named.entries()) {
    const ext = /\.([a-z0-9]{1,5})$/i.exec(path)?.[1]?.toLowerCase() ?? "bin";
    const entry = `sounds/${i}.${ext}`;
    files[entry] = new Uint8Array(await sounds!.get(path)!.arrayBuffer());
    manifest.sounds![path] = entry;
  }

  files["project.json"] = strToU8(json);
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  const zipped = await zipFiles(files);
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

export async function deserializeProject(
  data: ArrayBuffer, assets: AssetStore,
  /** 0..1 as the images are decoded, which is most of the time a load takes. */
  onProgress: (fraction: number) => void = () => {},
  sounds?: SoundStore,
): Promise<LoadedProject> {
  const entries = await unzipFiles(new Uint8Array(data));

  const projectRaw = entries["project.json"];
  if (!projectRaw) {
    throw new Error("This does not look like a project file: project.json is missing.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(projectRaw));
  } catch (err) {
    throw new Error(`project.json is not valid JSON: ${(err as Error).message}`);
  }

  const { project, diagnostics } = validateProject(migrate(parsed));

  // Restore assets under their original ids, so node references still resolve.
  const manifestRaw = entries["manifest.json"];
  const manifest: Manifest = manifestRaw
    ? (JSON.parse(strFromU8(manifestRaw)) as Manifest)
    : { assets: {} };

  assets.clear();
  const listed = Object.entries(manifest.assets);
  let decoded = 0;
  for (const [id, path] of listed) {
    onProgress(decoded++ / listed.length);
    const bytes = entries[path];
    if (!bytes) {
      diagnostics.push({
        path: `assets.${id}`,
        message: `"${path}" is missing from the archive; images using it will not draw`,
        severity: "warning",
      });
      continue;
    }
    const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
    const name = Object.values(project.items).find(
      (i) => isImage(i) && i.assetId === id,
    )?.name ?? id;
    try {
      await assets.addWithId(id as AssetId, blob, name);
    } catch {
      diagnostics.push({
        path: `assets.${id}`,
        message: `"${name}" could not be decoded and was skipped`,
        severity: "warning",
      });
    }
  }

  if (sounds) {
    sounds.clear();
    for (const [path, entry] of Object.entries(manifest.sounds ?? {})) {
      const bytes = entries[entry];
      if (bytes) sounds.add(new Blob([bytes as unknown as BlobPart]), path);
      else diagnostics.push({ path: `sounds.${path}`, message: `"${entry}" is missing from the archive; the event's sound will not play`, severity: "warning" });
    }
  }

  return { project, diagnostics };
}
