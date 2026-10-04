import { describe, it, expect } from "vitest";
import { availableTools, toolForMode } from "@/app/toolModes";
import { Store, type ToolId } from "@/app/Store";
import { createProject } from "@/core/doc/defaults";

describe("availableTools", () => {
  const cases: Array<["setup" | "animate", ToolId[]]> = [
    ["setup", ["select", "freeTransform", "pivot", "bone", "ik", "rotate", "translate", "scale", "shear", "hand", "zoom"]],
    ["animate", ["select", "freeTransform", "rotate", "translate", "scale", "shear", "hand", "zoom"]],
  ];
  for (const [mode, want] of cases) {
    it(mode, () => expect(availableTools(mode)).toEqual(want));
  }
});

describe("toolForMode", () => {
  const cases: Array<[ToolId, "setup" | "animate", ToolId]> = [
    ["bone", "setup", "bone"],
    ["bone", "animate", "select"],
    ["ik", "animate", "select"],
    ["pivot", "animate", "select"],
    ["freeTransform", "animate", "freeTransform"],
    ["rotate", "animate", "rotate"],
    ["zoom", "animate", "zoom"],
  ];
  for (const [tool, mode, want] of cases) {
    it(`${tool} in ${mode} → ${want}`, () => expect(toolForMode(tool, mode)).toBe(want));
  }
});

describe("Store follows the mode", () => {
  const fresh = () => {
    const store = new Store(createProject("T"));
    store.setMode("setup");
    return store;
  };

  it("leaving Setup drops a tool Animate hides", () => {
    const store = fresh();
    store.setTool("bone");
    store.setMode("animate");
    expect(store.ui.tool).toBe("select");
  });

  it("refuses a hidden tool, as its shortcut would ask", () => {
    const store = fresh();
    store.setMode("animate");
    store.setTool("ik");
    expect(store.ui.tool).toBe("select");
  });
});
