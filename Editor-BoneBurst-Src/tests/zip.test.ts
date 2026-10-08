import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, readZip, zipStore } from "@/io/zip";

describe("zipStore", () => {
  it("the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("reads back the files, names (UTF-8) and bytes, in order", () => {
    const png = new Uint8Array([137, 80, 78, 71, 0, 255, 128]);
    const files = readZip(zipStore([{ name: "a.json", data: '{"é":1}' }, { name: "page.png", data: png }, { name: "empty.txt", data: "" }]));
    expect(files.map((f) => f.name)).toEqual(["a.json", "page.png", "empty.txt"]);
    expect(new TextDecoder().decode(files[0]!.data)).toBe('{"é":1}');
    expect([...files[1]!.data]).toEqual([...png]);
    expect(files[2]!.data.length).toBe(0);
  });
  it("is a real zip: the system's unzip tests it", () => {
    const dir = mkdtempSync(join(tmpdir(), "bbzip-")), path = join(dir, "x.zip");
    writeFileSync(path, zipStore([{ name: "Stickman_IK.json", data: "{}" }, { name: "Stickman_IK_tex.png", data: new Uint8Array(5000).fill(7) }]));
    let out = "";
    try { out = execFileSync("unzip", ["-t", path], { encoding: "utf8" }); } catch (err) { if ((err as { code?: string }).code === "ENOENT") return; throw err; }
    expect(out).toContain("No errors detected");
  });
});
