import { describe, it, expect } from "vitest";
import { isOldProjectName, PROJECT_EXTENSION, projectFileName } from "@/io/project/ProjectFile";

describe("the project file's name", () => {
  it("is a .boneburst", () => expect(PROJECT_EXTENSION).toBe("boneburst"));

  const cases: Array<[string, string, boolean]> = [
    ["frog.animo", "frog.boneburst", true],
    ["Frog.ANIMO", "Frog.boneburst", true],
    ["frog.boneburst", "frog.boneburst", false],
    ["my.animo.backup", "my.animo.backup", false],
    ["notes.animo2", "notes.animo2", false],
  ];
  for (const [name, saved, old] of cases) {
    it(`${name} saves as ${saved}`, () => {
      expect(projectFileName(name)).toBe(saved);
      expect(isOldProjectName(name)).toBe(old);
    });
  }
});
