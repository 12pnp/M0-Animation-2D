import { describe, expect, it } from "vitest";
import { readAtlas, writeAtlas } from "@/io/atlas";
import { atlasInts, regionBounds, regionDegrees } from "@/model/atlas";
import { sampleFiles } from "./fixtures/samples";

const TEXT = `
a.png
size: 64, 32
filter: Linear, Linear
 eye
bounds: 2, 3, 10, 12
rotate: 90
split: 1, 2, 3, 4, 5
mouth
xy: 0, 0
size: 4, 4

b.png
size: 8, 8
tail
bounds: 0, 0, 8, 8
`;

describe("readAtlas", () => {
  const a = readAtlas(TEXT);
  it("reads pages, then their regions, split by blank lines", () => {
    expect(a.pages.map((p) => [p.name, p.regions.map((r) => r.name)])).toEqual([["a.png", [" eye", "mouth"]], ["b.png", ["tail"]]]);
    expect(atlasInts(a.pages[0]!, "size")).toEqual([64, 32]);
  });
  it("answers bounds, the old xy/size form, and rotation", () => {
    const [eye, mouth] = a.pages[0]!.regions;
    expect(regionBounds(eye!)).toEqual({ x: 2, y: 3, w: 10, h: 12 });
    expect(regionBounds(mouth!)).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect([regionDegrees(eye!), regionDegrees(mouth!)]).toEqual([90, 0]);
  });
  it("keeps every value, past the reader's first four", () => {
    expect(a.pages[0]!.regions[0]!.fields.find((f) => f.key === "split")!.values).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("keeps header lines", () => {
    expect(readAtlas("format: RGBA8888\n\np.png\nsize: 1, 1\n").header).toEqual([{ key: "format", values: ["RGBA8888"] }]);
  });
});

describe("every sample atlas reads and writes back unchanged", () => {
  const files = sampleFiles(".atlas.txt");
  it("has samples", () => expect(files.length).toBeGreaterThanOrEqual(10));
  it.each(files.map((f) => [f.name, f.text]))("%s", (_n, text) => {
    const a = readAtlas(text);
    expect(a.pages.length).toBeGreaterThan(0);
    expect(readAtlas(writeAtlas(a))).toEqual(a);
  });
});
