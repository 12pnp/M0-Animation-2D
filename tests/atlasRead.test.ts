import { describe, expect, it } from "vitest";
import { TextureAtlas } from "@esotericsoftware/spine-core";
import { readAtlas } from "@/core/boneburst/runtime/atlasRead";
import { atlasText } from "@/core/boneburst/atlas";
import { sampleRigs } from "./fixtures/spineSamples";

/**
 * Our atlas reader against spine-core's `TextureAtlas`, the oracle: every
 * page and region field the preview and File ▸ Open Spine use, on what our
 * exporter writes, on hand-written old-format text, and on every spine-unity
 * sample atlas (skipped without the samples folder).
 */

function both(text: string) {
  const theirs = new TextureAtlas(text);
  const ours = readAtlas(text);
  return {
    theirs: {
      pages: theirs.pages.map((p) => ({ name: p.name, width: p.width, height: p.height, pma: p.pma })),
      regions: theirs.regions.map((r) => ({
        name: r.name, page: r.page.name, x: r.x, y: r.y, width: r.width, height: r.height,
        offsetX: r.offsetX, offsetY: r.offsetY, originalWidth: r.originalWidth, originalHeight: r.originalHeight,
        degrees: r.degrees, index: r.index,
      })),
    },
    ours: {
      pages: ours.pages.map((p) => ({ name: p.name, width: p.width, height: p.height, pma: p.pma })),
      regions: ours.regions.map((r) => ({
        name: r.name, page: r.page.name, x: r.x, y: r.y, width: r.width, height: r.height,
        offsetX: r.offsetX, offsetY: r.offsetY, originalWidth: r.originalWidth, originalHeight: r.originalHeight,
        degrees: r.degrees, index: r.index,
      })),
    },
  };
}

describe("readAtlas", () => {
  const cases: Array<[string, string]> = [
    ["what the exporter writes", atlasText([{
      name: "p", imagePath: "rig.png", width: 64, height: 32, scale: 1,
      regions: [
        { name: "a", x: 0, y: 0, width: 10, height: 12, offsetX: 0, offsetY: 0, originalWidth: 10, originalHeight: 12, rotated: false },
        { name: "b", x: 10, y: 0, width: 6, height: 4, offsetX: 2, offsetY: 3, originalWidth: 12, originalHeight: 9, rotated: false },
      ],
    }, {
      name: "q", imagePath: "rig_2.png", width: 16, height: 16, scale: 1,
      regions: [{ name: "c", x: 1, y: 2, width: 3, height: 4, offsetX: 0, offsetY: 0, originalWidth: 3, originalHeight: 4, rotated: false }],
    }])],
    ["the old format, rotated and indexed", [
      "", "old.png", "size: 128,64", "format: RGBA8888", "filter: Linear,Linear", "repeat: none",
      "head", "  rotate: true", "  xy: 2, 4", "  size: 20, 30", "  orig: 22, 34", "  offset: 1, 2", "  index: -1",
      "walk", "  rotate: false", "  xy: 40, 4", "  size: 8, 9", "  orig: 8, 9", "  offset: 0, 0", "  index: 3",
      "",
    ].join("\n")],
    ["pma, degrees and CRLF", "pma.png\r\nsize:32,32\r\npma:true\r\nx\r\nbounds:0,0,4,6\r\nrotate:270\r\n"],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      const { theirs, ours } = both(text);
      expect(ours).toEqual(theirs);
    });
  }

  for (const rig of sampleRigs()) {
    it(`sample ${rig.name}`, () => {
      const { theirs, ours } = both(rig.atlas);
      expect(ours).toEqual(theirs);
    });
  }
});
