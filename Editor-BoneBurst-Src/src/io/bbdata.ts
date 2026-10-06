/**
 * The project file (`.bbdata`): named files in one container, so a project is one file to keep.
 * No DOM: tested in vitest. Layout: `MAGIC`, a little-endian u32 header length, the JSON header
 * `{format, version, files:[{name, size}]}`, then the files' bytes in header order.
 */

export const BBDATA_MAGIC = "BBDATA1\n";
export const BBDATA_FORMAT = "boneburst-project";
export const BBDATA_VERSION = 1;

export interface BbFile { readonly name: string; readonly data: Uint8Array }

/** A file that is not a project this editor reads; the message says why. */
export class BbdataRefused extends Error {}

export function packBbdata(files: readonly BbFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const header = encoder.encode(JSON.stringify({
    format: BBDATA_FORMAT, version: BBDATA_VERSION, files: files.map((f) => ({ name: f.name, size: f.data.length })),
  }));
  const magic = encoder.encode(BBDATA_MAGIC);
  const total = magic.length + 4 + header.length + files.reduce((n, f) => n + f.data.length, 0);
  const out = new Uint8Array(total);
  out.set(magic, 0);
  new DataView(out.buffer).setUint32(magic.length, header.length, true);
  let at = magic.length + 4;
  out.set(header, at);
  at += header.length;
  for (const f of files) { out.set(f.data, at); at += f.data.length; }
  return out;
}

export function unpackBbdata(bytes: Uint8Array): BbFile[] {
  const magic = new TextEncoder().encode(BBDATA_MAGIC);
  if (bytes.length < magic.length + 4 || magic.some((b, i) => bytes[i] !== b)) throw new BbdataRefused("Not a BoneBurst project (.bbdata) file.");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.length, true);
  const start = magic.length + 4;
  if (start + headerLength > bytes.length) throw new BbdataRefused("The project file is cut short (its header is incomplete).");
  let header: unknown;
  try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + headerLength))); } catch { throw new BbdataRefused("The project file's header is not readable."); }
  const h = header as { format?: unknown; version?: unknown; files?: unknown };
  if (h.format !== BBDATA_FORMAT) throw new BbdataRefused("Not a BoneBurst project (.bbdata) file.");
  if (h.version !== BBDATA_VERSION) throw new BbdataRefused(`The project file is version ${String(h.version)}; this editor reads version ${BBDATA_VERSION}.`);
  if (!Array.isArray(h.files)) throw new BbdataRefused("The project file lists no files.");
  const out: BbFile[] = [];
  let at = start + headerLength;
  for (const entry of h.files as unknown[]) {
    const e = entry as { name?: unknown; size?: unknown };
    if (typeof e?.name !== "string" || !e.name || /[\\/]/.test(e.name) || typeof e.size !== "number" || !Number.isInteger(e.size) || e.size < 0) throw new BbdataRefused("The project file lists a file it cannot read.");
    if (at + e.size > bytes.length) throw new BbdataRefused(`The project file is cut short (inside "${e.name}").`);
    out.push({ name: e.name, data: bytes.slice(at, at + e.size) });
    at += e.size;
  }
  return out;
}
