/**
 * A Spine `.atlas` text (Format-Json-Atlas.md §15) as the editor holds it: pages and regions with
 * their fields in file order, values as written, so a field this editor does not know survives.
 * Meanings are read through the queries below.
 */
export interface Atlas {
  /** Entry lines before the first page: ignored by Spine's reader, kept here. */
  readonly header: readonly AtlasField[];
  readonly pages: readonly AtlasPage[];
}

export interface AtlasPage {
  /** The texture file name (trimmed, as the reader trims it). */
  readonly name: string;
  readonly fields: readonly AtlasField[];
  readonly regions: readonly AtlasRegion[];
}

export interface AtlasRegion {
  /** Not trimmed: Spine's reader keeps a region name's surrounding whitespace. */
  readonly name: string;
  readonly fields: readonly AtlasField[];
}

export interface AtlasField {
  readonly key: string;
  /** Each value trimmed, every comma-separated value kept. */
  readonly values: readonly string[];
}

/** A field's values, or undefined. */
export function atlasField(o: { readonly fields: readonly AtlasField[] }, key: string): readonly string[] | undefined {
  return o.fields.find((f) => f.key === key)?.values;
}

/** Integer values of a field, or undefined if absent or not all integers. */
export function atlasInts(o: { readonly fields: readonly AtlasField[] }, key: string): number[] | undefined {
  const v = atlasField(o, key);
  if (!v || !v.every((s) => /^-?\d+$/.test(s))) return undefined;
  return v.map(Number);
}

/** The region's packed rectangle on its page (`bounds`, or the older `xy` and `size`). */
export function regionBounds(r: AtlasRegion): { x: number; y: number; w: number; h: number } | undefined {
  const b = atlasInts(r, "bounds");
  if (b?.length === 4) return { x: b[0]!, y: b[1]!, w: b[2]!, h: b[3]! };
  const xy = atlasInts(r, "xy"), size = atlasInts(r, "size");
  return xy?.length === 2 && size?.length === 2 ? { x: xy[0]!, y: xy[1]!, w: size[0]!, h: size[1]! } : undefined;
}

/** The region's rotation in degrees: `rotate: true` is 90 (§15.4). */
export function regionDegrees(r: AtlasRegion): number {
  const v = atlasField(r, "rotate")?.[0];
  if (v === undefined || v === "false") return 0;
  if (v === "true") return 90;
  return /^-?\d+$/.test(v) ? Number(v) : 0;
}
