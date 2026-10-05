import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SAMPLES } from "./samples";

/** The stickman the v2 plan names for E2: the old editor's Spine export of it. */
export const STICKMAN = resolve(__dirname, "stickman");

export interface RigFiles { name: string; json: string; atlas: string }

/** Every skeleton with the atlas text beside it (all of a folder's atlases, one after another). */
export function rigFiles(): RigFiles[] {
  const out: RigFiles[] = [];
  const dirs = [...readdirSync(SAMPLES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(SAMPLES, d.name)), STICKMAN];
  for (const dir of dirs) {
    const files = readdirSync(dir);
    const atlas = files.filter((f) => f.endsWith(".atlas.txt") || f.endsWith(".atlas")).sort()
      .map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      out.push({ name: `${dir.split("/").at(-1)}/${f}`, json: readFileSync(join(dir, f), "utf8"), atlas });
    }
  }
  return out;
}
