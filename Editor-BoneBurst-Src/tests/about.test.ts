import { describe, expect, it } from "vitest";
import { EDITOR_NAME, titleFor } from "../src/about";

describe("titleFor", () => {
  it.each([
    [null, false, EDITOR_NAME],
    ["hero.json", false, `hero.json — ${EDITOR_NAME}`],
    ["hero.json", true, `• hero.json — ${EDITOR_NAME}`],
  ])("%s, dirty %s", (file, dirty, want) => expect(titleFor(file, dirty)).toBe(want));
});
