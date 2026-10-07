import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The two systems stay apart (docs/TWO-SYSTEMS-PLAN.md): the path motion (`src/motion/`) takes numbers and returns numbers, and the key
 * animation's layers never read it. `scripts/check.sh` guards the same rule on every landing; this makes `npm test` fail first.
 */

const root = join(__dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const importsOf = (file: string): string[] => [...readFileSync(join(root, file), "utf8").matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]!);

export const allowedInMotion = (spec: string): boolean => spec.startsWith("./") || spec === "@/model/sidecar" || spec === "@/model/refused";

describe("the path motion folder", () => {
  it("is not empty (a guard over nothing is no guard)", () => {
    expect(files("motion").length).toBeGreaterThanOrEqual(4);
  });

  it("imports only itself, the path's data types and the error class: no rig, no document, no edit layer, no interface", () => {
    for (const f of files("motion")) for (const spec of importsOf(f)) expect(allowedInMotion(spec), `${f} imports ${spec}`).toBe(true);
  });

  it("touches no DOM and no session", () => {
    for (const f of files("motion")) expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/\b(document|window|navigator)\.[a-zA-Z]|\bHTML[A-Za-z]*Element\b|requestAnimationFrame/);
  });

  it("is not imported by the key animation's layers: engine, edit and model", () => {
    for (const f of [...files("engine"), ...files("edit"), ...files("model")]) for (const spec of importsOf(f)) expect(spec.startsWith("@/motion"), `${f} imports ${spec}`).toBe(false);
  });

  it("the check refuses what it should: a rig import is not allowed in motion", () => {
    for (const bad of ["@/engine/rig", "@/edit/keys", "@/ui/session", "@/model/skeleton", "@/model/timelines"]) expect(allowedInMotion(bad), bad).toBe(false);
  });
});
