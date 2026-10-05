import { describe, expect, it } from "vitest";
import { compare, TOLERANCE } from "./fixtures/oracle";
import { rigFiles } from "./fixtures/rigs";

/** Every sample and the stickman, posed by the engine and by spine-core (`fixtures/oracle.ts`). */
const files = rigFiles();

describe("engine against spine-core", () => {
  it("reads every sample and the stickman", () => {
    expect(files.length).toBeGreaterThanOrEqual(17);
    expect(files.some((f) => f.name.startsWith("stickman/"))).toBe(true);
  });
  it.each(files.map((f) => [f.name, f] as const))("%s poses as spine-core does", (name, f) => {
    const { poses, worst } = compare(name, f.json, f.atlas);
    expect(poses).toBeGreaterThan(0);
    expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
  });
});
