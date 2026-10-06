import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileFor } from "../scripts/start.mjs";

/** `npm start`'s server (E7-PLAN step 3): it serves files under dist/ and nothing else. */
const DIST = join(__dirname, "..", "dist");

describe("npm start's server", () => {
  it("maps the page and its assets into dist/", () => {
    expect(fileFor("/")).toBe(join(DIST, "index.html"));
    expect(fileFor("/assets/index-abc.js?v=1")).toBe(join(DIST, "assets", "index-abc.js"));
    expect(fileFor("/vendor/icons/lucide/save.svg")).toBe(join(DIST, "vendor", "icons", "lucide", "save.svg"));
  });
  it("serves nothing outside dist/, however the path is written", () => {
    for (const p of ["/../package.json", "/assets/../../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/%2e%2e%2f%2e%2e%2fetc/passwd", "/a%00b", "/%E0%A4%A"]) {
      expect(fileFor(p), p).toBeNull();
    }
  });
});
