import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readAtlas } from "@/io/atlas";
import { decodePng, encodePng, PngRefused } from "@/io/png";
import { atlasInts } from "@/model/atlas";

/** A PNG written here with Node's zlib, independent of the editor's encoder. `rows` hold each row's filter byte first. */
function png(width: number, height: number, depth: number, type: number, rows: number[][], extra: [string, number[]][] = [], interlace = 0): Uint8Array {
  const chunk = (name: string, body: Uint8Array) => {
    const c = Buffer.alloc(12 + body.length);
    c.writeUInt32BE(body.length, 0);
    c.write(name, 4, "latin1");
    Buffer.from(body).copy(c, 8);
    c.writeUInt32BE(crc32(c.subarray(4, 8 + body.length)), 8 + body.length);
    return c;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr.set([depth, type, 0, 0, interlace], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    ...extra.map(([n, b]) => chunk(n, new Uint8Array(b))),
    chunk("IDAT", deflateSync(Buffer.from(rows.flat()))), chunk("IEND", new Uint8Array(0)),
  ]));
}

const rgba = (px: Uint8ClampedArray, i: number) => [...px.subarray(i * 4, i * 4 + 4)];

describe("PNG files (E4 step 14)", () => {
  it("reads every 8-bit colour type, with transparency", async () => {
    // Grey, 2×1: 10, 200; tRNS makes 200 transparent.
    let im = await decodePng(png(2, 1, 8, 0, [[0, 10, 200]], [["tRNS", [0, 200]]]));
    expect([rgba(im.pixels, 0), rgba(im.pixels, 1)]).toEqual([[10, 10, 10, 255], [200, 200, 200, 0]]);
    // RGB with a transparent colour.
    im = await decodePng(png(2, 1, 8, 2, [[0, 1, 2, 3, 4, 5, 6]], [["tRNS", [0, 4, 0, 5, 0, 6]]]));
    expect([rgba(im.pixels, 0), rgba(im.pixels, 1)]).toEqual([[1, 2, 3, 255], [4, 5, 6, 0]]);
    // Palette, with alpha for its first entry only.
    im = await decodePng(png(3, 1, 8, 3, [[0, 0, 1, 1]], [["PLTE", [9, 8, 7, 1, 2, 3]], ["tRNS", [128]]]));
    expect([0, 1, 2].map((i) => rgba(im.pixels, i))).toEqual([[9, 8, 7, 128], [1, 2, 3, 255], [1, 2, 3, 255]]);
    // Grey and alpha.
    im = await decodePng(png(1, 1, 8, 4, [[0, 50, 60]]));
    expect(rgba(im.pixels, 0)).toEqual([50, 50, 50, 60]);
  });
  it("undoes each row filter", async () => {
    // RGBA 2×2, rows filtered Sub, then Up, then the same pixels as Average and Paeth.
    const a = [10, 20, 30, 40], b = [15, 25, 35, 45], c = [100, 110, 120, 130], d = [1, 2, 3, 4];
    const sub = (row: number[][]) => row.flatMap((p, i) => p.map((v, k) => (v - (i ? row[i - 1]![k]! : 0)) & 255));
    const upf = (row: number[][], prev: number[][]) => row.flatMap((p, i) => p.map((v, k) => (v - prev[i]![k]!) & 255));
    const avg = (row: number[][], prev: number[][]) => row.flatMap((p, i) => p.map((v, k) => (v - (((i ? row[i - 1]![k]! : 0) + prev[i]![k]!) >> 1)) & 255));
    const paeth = (row: number[][], prev: number[][]) => row.flatMap((p, i) => p.map((v, k) => {
      const l = i ? row[i - 1]![k]! : 0, u = prev[i]![k]!, ul = i ? prev[i - 1]![k]! : 0, q = l + u - ul;
      const pl = Math.abs(q - l), pu = Math.abs(q - u), pul = Math.abs(q - ul);
      return (v - (pl <= pu && pl <= pul ? l : pu <= pul ? u : ul)) & 255;
    }));
    const r0 = [a, b], r1 = [c, d];
    const want = [...a, ...b, ...c, ...d];
    for (const second of [[2, ...upf(r1, r0)], [3, ...avg(r1, r0)], [4, ...paeth(r1, r0)]]) {
      const im = await decodePng(png(2, 2, 8, 6, [[1, ...sub(r0)], second]));
      expect([...im.pixels]).toEqual(want);
    }
    // Paeth's tie: left 0, up 12, upper-left 4 predict up (12), not upper-left.
    const t0 = [[4, 4, 4, 4], [12, 12, 12, 12]], t1 = [[0, 0, 0, 0], [50, 60, 70, 80]];
    const tied = await decodePng(png(2, 2, 8, 6, [[0, ...t0.flat()], [4, ...paeth(t1, t0)]]));
    expect([...tied.pixels]).toEqual([...t0.flat(), ...t1.flat()]);
  });
  it("writes what it reads, bit for bit, semi-transparent colours included", async () => {
    const w = 37, h = 23, px = new Uint8ClampedArray(w * h * 4);
    let seed = 7;
    for (let i = 0; i < px.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; px[i] = seed >> 16; }
    // Some fully transparent pixels with colour, which a canvas would lose.
    for (let i = 0; i < 40; i++) px[i * 4 + 3] = 0;
    const back = await decodePng(await encodePng({ width: w, height: h, pixels: px }));
    expect(back.width).toBe(w);
    expect(back.height).toBe(h);
    expect(Buffer.from(back.pixels).equals(Buffer.from(px))).toBe(true);
  });
  it("reads the stickman's page at the size its atlas gives", async () => {
    const dir = join(__dirname, "fixtures", "stickman");
    const page = readAtlas(readFileSync(join(dir, "Stickman_IK.atlas.txt"), "utf8")).pages[0]!;
    const im = await decodePng(new Uint8Array(readFileSync(join(dir, page.name))));
    expect([im.width, im.height]).toEqual(atlasInts(page, "size"));
    const again = await decodePng(await encodePng(im));
    expect(Buffer.from(again.pixels).equals(Buffer.from(im.pixels))).toBe(true);
  });
  it("refuses what it cannot read, saying why", async () => {
    const refused = async (bytes: Uint8Array) => { try { await decodePng(bytes, "x.png"); return ""; } catch (e) { expect(e).toBeInstanceOf(PngRefused); return (e as Error).message; } };
    expect(await refused(new Uint8Array([1, 2, 3]))).toMatch(/not a PNG/);
    expect(await refused(png(1, 1, 16, 6, [[0, 0, 0, 0, 0, 0, 0, 0, 0]]))).toMatch(/16 bits/);
    expect(await refused(png(1, 1, 8, 6, [[0, 1, 2, 3, 4]], [], 1))).toMatch(/interlaced/);
    const bad = png(1, 1, 8, 6, [[0, 1, 2, 3, 4]]);
    bad[20] = bad[20]! ^ 1;
    expect(await refused(bad)).toMatch(/damaged/);
    expect(await refused(png(1, 1, 8, 6, [[7, 1, 2, 3, 4]]))).toMatch(/row filter/);
  });
});
