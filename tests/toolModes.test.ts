import { describe, it, expect } from "vitest";
import { availableTools, toolForMode } from "@/app/toolModes";
import { Store, type ToolId } from "@/app/Store";
import { createProject } from "@/core/doc/defaults";

describe("availableTools", () => {
  const cases: Array<["setup" | "animate", boolean, ToolId[]]> = [
    ["setup", false, ["select", "freeTransform", "pivot", "bone", "ik", "rotate", "translate", "scale", "shear", "hand", "zoom"]],
    ["animate", false, ["select", "freeTransform", "rotate", "translate", "scale", "shear", "hand", "zoom"]],
    // Play mode shows the runtime: only the view moves, whichever mode is under it.
    ["setup", true, ["hand", "zoom"]],
    ["animate", true, ["hand", "zoom"]],
  ];
  for (const [mode, play, want] of cases) {
    it(`${mode}${play ? " + play" : ""}`, () => expect(availableTools(mode, play)).toEqual(want));
  }
});

describe("toolForMode", () => {
  const cases: Array<[ToolId, "setup" | "animate", boolean, ToolId]> = [
    ["bone", "setup", false, "bone"],
    ["bone", "animate", false, "select"],
    ["ik", "animate", false, "select"],
    ["pivot", "animate", false, "select"],
    ["freeTransform", "animate", false, "freeTransform"],
    ["rotate", "animate", false, "rotate"],
    ["shear", "animate", true, "hand"],
    ["zoom", "animate", true, "zoom"],
    ["select", "animate", true, "hand"],
    ["bone", "setup", true, "hand"],
  ];
  for (const [tool, mode, play, want] of cases) {
    it(`${tool} in ${mode}${play ? " + play" : ""} → ${want}`, () => expect(toolForMode(tool, mode, play)).toBe(want));
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

  it("Play mode leaves Hand or Zoom", () => {
    const store = fresh();
    store.setTool("freeTransform");
    store.setUi({ playMode: true }, "playback");
    expect(store.ui.tool).toBe("hand");
  });
});
