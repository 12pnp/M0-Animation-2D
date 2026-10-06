import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex } from "@/ui/colour";

describe("colour conversion", () => {
  it.each(["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#303030", "#e64d4d", "#4dcc66", "#123456"])("round-trips %s", (hex) => {
    expect(hsvToHex(hexToHsv(hex)!)).toBe(hex);
  });
  it("reads hue, saturation and value", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#00ff00")).toEqual({ h: 120, s: 1, v: 1 });
    expect(hexToHsv("#808080")!.s).toBe(0);
  });
  it("is null for what is not #rrggbb", () => {
    expect(hexToHsv("red")).toBeNull();
    expect(hexToHsv("#fff")).toBeNull();
  });
});
