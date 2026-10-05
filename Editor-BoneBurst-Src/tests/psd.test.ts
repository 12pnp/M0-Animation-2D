import { type Layer, writePsdUint8Array } from "ag-psd";
import { describe, expect, it } from "vitest";
import { readAtlas } from "@/io/atlas";
import { pack, PackRefused, place } from "@/io/pack";
import { PsdRefused, readPsdLayers, trim } from "@/io/psd";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { regionBounds } from "@/model/atlas";
import { profileIssues } from "@/model/profile";
import { importPsd, safeName } from "@/ui/psdImport";
import { readFileSync } from "node:fs";
import { compare, TOLERANCE } from "./fixtures/oracle";
import { FIGURE_PSD, figurePsd } from "./fixtures/psd";

/** A w × h image of one colour, with a transparent margin of `m` pixels when given. */
function image(w: number, h: number, rgba: readonly number[], m = 0) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) data.set(rgba, (y * w + x) * 4);
  return { width: w, height: h, data };
}

const layer = (name: string, left: number, top: number, w: number, h: number, rgba: readonly number[], more: Partial<Layer> = {}, m = 0): Layer =>
  ({ name, left, top, right: left + w, bottom: top + h, imageData: image(w, h, rgba, m), ...more });

/** A PSD as Photoshop would save it, written by ag-psd. */
function psdFile(width: number, height: number, children: Layer[]): Uint8Array {
  return writePsdUint8Array({ width, height, imageData: image(width, height, [0, 0, 0, 0]), children }, { generateThumbnail: false });
}

/** Bottom layer first, as Photoshop lists them bottom-up. */
function sample(): Uint8Array {
  return psdFile(200, 100, [
    layer("body", 80, 30, 40, 70, [200, 50, 50, 255], {}, 5),
    layer("shadow", 60, 90, 80, 10, [0, 0, 0, 255], { blendMode: "multiply", opacity: 0.5 }),
    { name: "arms", opacity: 0.5, children: [
      layer("arm", 40, 40, 30, 10, [50, 200, 50, 255]),
      layer("arm", 130, 40, 30, 10, [50, 50, 200, 255], { blendMode: "linear dodge" }),
      layer("glow: left", 30, 30, 10, 10, [255, 255, 0, 255], { blendMode: "overlay" }),
    ] },
    layer("hidden", 0, 0, 10, 10, [9, 9, 9, 255], { hidden: true }),
    { name: "off", hidden: true, children: [layer("inside off", 0, 0, 10, 10, [9, 9, 9, 255])] },
    layer("empty", 0, 0, 10, 10, [0, 0, 0, 0]),
    layer("head", 85, 0, 30, 30, [240, 200, 160, 255]),
  ]);
}

describe("packing", () => {
  it("places every image inside its page, none overlapping, padded, deterministic", () => {
    let seed = 5;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const ims = Array.from({ length: 60 }, (_, i) => ({ name: `i${i}`, width: 1 + Math.floor(rand() * 40), height: 1 + Math.floor(rand() * 40) }));
    const a = place(ims, 128, 2), b = place(ims, 128, 2);
    expect(a).toEqual(b);
    expect(a.sizes.length).toBeGreaterThan(1);
    for (const p of a.placed) {
      const size = a.sizes[p.page]!;
      expect(p.x).toBeGreaterThanOrEqual(2);
      expect(p.y).toBeGreaterThanOrEqual(2);
      expect(p.x + p.width + 2).toBeLessThanOrEqual(size.width);
      expect(p.y + p.height + 2).toBeLessThanOrEqual(size.height);
      for (const q of a.placed) {
        if (q === p || q.page !== p.page) continue;
        const apart = p.x + p.width + 2 <= q.x || q.x + q.width + 2 <= p.x || p.y + p.height + 2 <= q.y || q.y + q.height + 2 <= p.y;
        expect(apart, `${p.name} and ${q.name}`).toBe(true);
      }
    }
    expect(() => place([{ name: "wide", width: 125, height: 3 }], 128, 2)).toThrow(PackRefused);
  });
  it("draws each image where its region says, on pages named after the skeleton", () => {
    const ims = [10, 20, 30].map((w, i) => ({ name: `r${i}`, width: w, height: 12, pixels: image(w, 12, [i * 80, 1, 2, 255]).data }));
    const { pages, atlas } = pack(ims, "kit", 34);
    expect(pages.map((p) => p.name)).toEqual(["kit.png", "kit_2.png"]);
    for (const p of atlas.pages) for (const r of p.regions) {
      const b = regionBounds(r)!, pg = pages.find((x) => x.name === p.name)!, i = Number(r.name.slice(1));
      expect([b.w, b.h]).toEqual([ims[i]!.width, 12]);
      expect([...pg.pixels.slice((b.y * pg.width + b.x) * 4, (b.y * pg.width + b.x) * 4 + 4)]).toEqual([i * 80, 1, 2, 255]);
    }
  });
});

describe("reading a PSD", () => {
  it("trims to the pixels with alpha", () => {
    const t = trim(image(10, 8, [1, 2, 3, 255], 2).data, 10, 8)!;
    expect([t.x, t.y, t.width, t.height]).toEqual([2, 2, 6, 4]);
    expect(trim(image(4, 4, [0, 0, 0, 0]).data, 4, 4)).toBeNull();
  });
  it("takes visible layers bottom first, groups' opacity applied; leaves out hidden and empty ones, saying so", () => {
    const r = readPsdLayers(sample(), "kit.psd");
    expect(r.layers.map((l) => l.name)).toEqual(["body", "shadow", "arm", "arm", "glow: left", "head"]);
    expect(r.layers[2]!.groups).toEqual(["arms"]);
    expect(r.layers[2]!.opacity).toBeCloseTo(0.5, 2);
    expect(r.layers[1]!.opacity).toBeCloseTo(0.5, 2);
    const body = r.layers[0]!;
    expect([body.left, body.top, body.width, body.height]).toEqual([85, 35, 30, 60]);
    expect(r.issues.map((i) => `${i.where}: ${i.message}`)).toEqual([
      "kit.psd: hidden: hidden: left out",
      "kit.psd: off / inside off: hidden: left out",
      "kit.psd: empty: fully transparent: left out",
    ]);
  });
  it("refuses what is not a PSD", () => {
    expect(() => readPsdLayers(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "x.psd")).toThrow(PsdRefused);
  });
});

describe("importing a PSD", () => {
  it("makes a rig: a slot and region per layer where the layer is, Photoshop's order, opacity and blends", () => {
    const im = importPsd(sample(), "kit.psd", "hash");
    const s = im.skeleton;
    expect(im.name).toBe("kit");
    expect(s.slots!.map((x) => x.name)).toEqual(["body", "shadow", "arm", "arm2", "glow_ left", "head"]);
    const region = (slot: string) => s.skins![0]!.attachments!.find((ss) => ss.slot === slot)!.entries[0]!;
    // body: trimmed 30 × 60 at (85, 35) on a 200 × 100 canvas: centre (100, 65) → (0, 35).
    expect(region("body")).toMatchObject({ key: "body", attachment: { width: 30, height: 60, y: 35 } });
    expect(region("body").attachment.x).toBeUndefined();
    expect(region("head").attachment).toMatchObject({ y: 85, width: 30, height: 30 });
    const slot = (n: string) => s.slots!.find((x) => x.name === n)!;
    expect(slot("shadow")).toMatchObject({ blend: "multiply", color: "ffffff80", attachment: "shadow" });
    expect(slot("arm2")).toMatchObject({ blend: "additive", color: "ffffff80" });
    expect(slot("glow_ left").blend).toBeUndefined();
    expect(slot("head").color).toBeUndefined();
    expect(im.issues.map((i) => i.message)).toContain('blend "overlay" has no Spine equivalent: drawn normal');
    // The atlas reads back and each region's pixels are the layer's.
    const atlas = readAtlas(im.atlasText);
    expect(atlas.pages.map((p) => p.name)).toEqual(["kit.png"]);
    const page = im.pages[0]!;
    const r = atlas.pages[0]!.regions.find((x) => x.name === "head")!, b = regionBounds(r)!;
    expect([b.w, b.h]).toEqual([30, 30]);
    expect([...page.pixels.slice(((b.y + 3) * page.width + b.x + 3) * 4, ((b.y + 3) * page.width + b.x + 3) * 4 + 4)]).toEqual([240, 200, 160, 255]);
    // A file both runtimes read and pose alike.
    expect(profileIssues(s, { written: true })).toEqual([]);
    const text = writeSkeleton(s);
    expect(writeSkeleton(readSkeleton(text).skeleton)).toBe(text);
    const { poses, worst } = compare("psd", text, im.atlasText, [0]);
    expect(poses).toBeGreaterThan(0);
    expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
  });
  it("refuses a file with nothing to show, and a layer larger than a page", () => {
    expect(() => importPsd(psdFile(20, 20, [layer("ghost", 0, 0, 5, 5, [1, 1, 1, 255], { hidden: true })]), "g.psd", "h")).toThrow(/no visible layer/);
    expect(() => importPsd(psdFile(2100, 10, [layer("banner", 0, 0, 2100, 4, [1, 1, 1, 255])]), "b.psd", "h")).toThrow(/"banner" is 2100 × 4/);
  });
  it("imports the figure fixture (the file is what its code writes): every layer but the hidden sketch", () => {
    const file = new Uint8Array(readFileSync(FIGURE_PSD));
    expect(file).toEqual(figurePsd());
    const im = importPsd(file, "figure.psd", "h");
    expect(im.skeleton.slots!.map((x) => x.name)).toEqual(["shadow", "leg L", "leg R", "body", "arm L", "arm R", "head"]);
    expect(im.issues.map((i) => i.where)).toEqual(["figure.psd: sketch"]);
    const { worst } = compare("figure", writeSkeleton(im.skeleton), im.atlasText, [0]);
    expect(worst.value).toBeLessThanOrEqual(TOLERANCE);
  });
  it("keeps names the atlas can read", () => {
    expect(safeName("a: b\nc")).toBe("a_ b_c");
    expect(safeName("  ")).toBe("layer");
  });
});
