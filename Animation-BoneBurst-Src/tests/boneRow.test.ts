import { describe, expect, it } from "vitest";
import { boneRow, type RowFlags } from "@/core/doc/boneRow";

const row = (pick: boolean, show: boolean, name: boolean): RowFlags => ({ pick, show, name });

describe("boneRow", () => {
  it.each([
    { name: "a plain bone follows Bones", primary: false, bones: row(true, true, false), prim: row(false, false, false), want: row(true, true, false) },
    { name: "a primary bone follows Primary", primary: true, bones: row(false, false, false), prim: row(true, true, true), want: row(true, true, true) },
    { name: "bones hidden, primary still shown", primary: true, bones: row(true, false, true), prim: row(true, true, false), want: row(true, true, false) },
    { name: "a hidden row neither picks nor names", primary: false, bones: row(true, false, true), prim: row(true, true, true), want: row(false, false, false) },
    { name: "primary shown but not pickable", primary: true, bones: row(true, true, true), prim: row(false, true, false), want: row(false, true, false) },
  ])("$name", ({ primary, bones, prim, want }) => {
    expect(boneRow(primary, bones, prim)).toEqual(want);
  });
});
