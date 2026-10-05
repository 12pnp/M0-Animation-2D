import { describe, expect, it } from "vitest";
import { readSidecar, sidecarName, writeSidecar } from "@/io/sidecar";
import { EMPTY_SIDECAR, type Sidecar } from "@/model/sidecar";

const FULL: Sidecar = {
  view: new Map([["zoom", 2]]),
  guides: [{ axis: "x", at: 12.5 }],
  references: [{ path: "ref/run.png", x: 10, y: -4, scale: 0.5, opacity: 0.4 }],
  notes: [{ text: "hips lead", author: "AI", about: "hip" }, { text: "plain" }],
  extra: new Map([["later", true]]),
};

describe("sidecar", () => {
  it("writes and reads back everything, newer top-level keys included", () => {
    const { sidecar, issues } = readSidecar(writeSidecar(FULL));
    expect(issues).toEqual([]);
    expect(sidecar).toEqual(FULL);
  });
  it.each([
    ["not JSON", "{", /not JSON/],
    ["another format", '{"format": "x", "version": 1}', /not a boneburst-sidecar/],
    ["a newer version", '{"format": "boneburst-sidecar", "version": 2}', /version 2/],
  ])("refuses %s rather than guess", (_w, text, want) => {
    const { sidecar, issues } = readSidecar(text);
    expect(sidecar).toBe(EMPTY_SIDECAR);
    expect(issues[0]!.message).toMatch(want);
  });
  it("drops an entry that does not read, and says so", () => {
    const { sidecar, issues } = readSidecar('{"format": "boneburst-sidecar", "version": 1, "guides": [{"axis": "z", "at": 1}, {"axis": "y", "at": 2}]}');
    expect(sidecar.guides).toEqual([{ axis: "y", at: 2 }]);
    expect(issues).toEqual([{ where: "guides[0]", message: "does not read; dropped" }]);
  });
  it.each([["hero.json", "hero.bb.json"], ["a.b.JSON", "a.b.bb.json"], ["noext", "noext.bb.json"]])("names %s → %s", (a, b) => {
    expect(sidecarName(a)).toBe(b);
  });
});
