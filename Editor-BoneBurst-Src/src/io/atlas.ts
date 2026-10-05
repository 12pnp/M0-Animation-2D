import type { Atlas, AtlasField, AtlasPage, AtlasRegion } from "@/model/atlas";

/**
 * Read `.atlas` text with Spine's line model (Format-Json-Atlas.md §15.1–15.2): a blank line ends
 * a page; the first name line after it is a page, the next ones its regions; entry lines (with a
 * `:`) are the fields of what came last. Values are kept as written (all of them, not the
 * reader's first four), so writing back loses nothing.
 */
export function readAtlas(text: string): Atlas {
  const lines = text.split(/\r?\n/);
  const header: AtlasField[] = [];
  const pages: { name: string; fields: AtlasField[]; regions: { name: string; fields: AtlasField[] }[] }[] = [];
  let i = 0;
  const blank = (l: string) => l.trim() === "";
  const entry = (l: string): AtlasField | null => {
    const t = l.trim();
    const c = t.indexOf(":");
    if (c < 0) return null;
    return { key: t.slice(0, c).trim(), values: t.slice(c + 1).split(",").map((v) => v.trim()) };
  };
  while (i < lines.length && blank(lines[i]!)) i++;
  for (let e; i < lines.length && !blank(lines[i]!) && (e = entry(lines[i]!)); i++) header.push(e);

  let page: (typeof pages)[number] | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) { page = null; i++; continue; }
    const fields: AtlasField[] = [];
    let j = i + 1;
    for (let e; j < lines.length && !blank(lines[j]!) && (e = entry(lines[j]!)); j++) fields.push(e);
    if (!page) {
      page = { name: line.trim(), fields, regions: [] };
      pages.push(page);
    } else {
      page.regions.push({ name: line, fields });
    }
    i = j;
  }
  return { header, pages };
}

/** `.atlas` text: the header, then each page and its regions, pages separated by a blank line. */
export function writeAtlas(a: Atlas): string {
  const field = (f: AtlasField) => `${f.key}: ${f.values.join(", ")}`;
  const parts: string[] = [];
  if (a.header.length) parts.push(a.header.map(field).join("\n"));
  for (const p of a.pages) {
    parts.push([p.name, ...p.fields.map(field), ...p.regions.flatMap((r: AtlasRegion) => [r.name, ...r.fields.map(field)])].join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

export type { Atlas, AtlasPage };
