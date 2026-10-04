import { describe, it, expect } from "vitest";
import { chooseSkeleton } from "@/io/import/spineFiles";

/** File ▸ Open Spine Folder: which skeleton a folder's files mean. */
describe("chooseSkeleton", () => {
  const cases: Array<[string, string[], ReturnType<typeof chooseSkeleton>]> = [
    ["one export", ["hero.json", "hero.atlas", "hero.png"], { json: "hero.json", atlas: "hero.atlas" }],
    ["Unity's .atlas.txt", ["hero.json", "hero.atlas.txt", "hero.png"], { json: "hero.json", atlas: "hero.atlas.txt" }],
    ["a lone atlas named otherwise", ["hero.json", "skeleton.atlas", "skeleton.png"], { json: "hero.json", atlas: "skeleton.atlas" }],
    ["an unrelated JSON beside the export", ["hero.json", "hero.atlas", "package.json", "hero.png"], { json: "hero.json", atlas: "hero.atlas" }],
    ["two exports", ["hero.json", "hero.atlas", "goblin.json", "goblin.atlas"], { candidates: ["hero.json", "goblin.json"] }],
    ["two skeletons sharing one atlas", ["walk.json", "run.json", "pack.atlas"], { candidates: ["walk.json", "run.json"] }],
    ["no JSON", ["hero.atlas", "hero.png"], { error: "No skeleton .json among the files. Pick the .json, the .atlas and the page images together." }],
    ["a binary skeleton", ["hero.skel", "hero.atlas"], { error: "Binary skeletons (.skel) cannot be opened. In Spine, export the skeleton as JSON instead." }],
    ["no atlas", ["hero.json", "hero.png"], { error: "No .atlas among the files. Pick it with the .json and the page images." }],
  ];
  for (const [name, files, want] of cases) {
    it(name, () => expect(chooseSkeleton(files)).toEqual(want));
  }

  it("the user's pick gets its own atlas", () => {
    const files = ["hero.json", "hero.atlas", "goblin.json", "goblin.atlas"];
    expect(chooseSkeleton(files, "goblin.json")).toEqual({ json: "goblin.json", atlas: "goblin.atlas" });
  });
});
