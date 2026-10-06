import { describe, expect, it } from "vitest";
import { BbdataRefused, packBbdata, unpackBbdata } from "@/io/bbdata";

const text = (s: string) => new TextEncoder().encode(s);

describe("bbdata", () => {
  const files = [
    { name: "hero.json", data: text("{\"bones\":[]}") },
    { name: "hero.png", data: new Uint8Array([137, 80, 78, 71, 0, 255]) },
    { name: "empty.txt", data: new Uint8Array(0) },
  ];

  it("round trips names and bytes, in order", () => {
    const back = unpackBbdata(packBbdata(files));
    expect(back.map((f) => f.name)).toEqual(["hero.json", "hero.png", "empty.txt"]);
    expect([...back[1]!.data]).toEqual([137, 80, 78, 71, 0, 255]);
    expect(back[2]!.data.length).toBe(0);
  });

  it("reads from a view that does not start at the buffer's start", () => {
    const packed = packBbdata(files);
    const padded = new Uint8Array(packed.length + 5);
    padded.set(packed, 5);
    expect(unpackBbdata(padded.subarray(5)).length).toBe(3);
  });

  it.each([
    ["wrong magic", () => text("not a project at all")],
    ["cut inside a file", () => packBbdata(files).slice(0, -3)],
    ["cut inside the header", () => packBbdata(files).slice(0, 14)],
    ["unknown version", () => text(new TextDecoder().decode(packBbdata(files)).replace("\"version\":1", "\"version\":9"))],
  ])("refuses %s", (_name, make) => {
    expect(() => unpackBbdata(make())).toThrow(BbdataRefused);
  });

  it("refuses a file name with a path", () => {
    expect(() => unpackBbdata(packBbdata([{ name: "../x.json", data: text("{}") }]))).toThrow(BbdataRefused);
  });
});
