import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The sample exports the BoneBurst format specs' tests read (Unity package, Tests/Editor/Data~). */
export const SAMPLES = resolve(__dirname, "../../../Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples");

export interface SampleFile { name: string; path: string; text: string }

/** Every file under the samples folder ending in `ext`. Fails loudly if the folder is missing. */
export function sampleFiles(ext: string): SampleFile[] {
  if (!existsSync(SAMPLES)) throw new Error(`samples not found at ${SAMPLES}`);
  const out: SampleFile[] = [];
  for (const dir of readdirSync(SAMPLES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(SAMPLES, dir.name))) {
      if (f.endsWith(ext)) out.push({ name: `${dir.name}/${f}`, path: join(SAMPLES, dir.name, f), text: readFileSync(join(SAMPLES, dir.name, f), "utf8") });
    }
  }
  return out;
}
