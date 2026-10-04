import { describe, it, expect } from "vitest";
import {
  type Workspace, MAX_WORKSPACE_NAME, findWorkspace, parseWorkspaces, putWorkspace,
  removeWorkspace, workspaceNameError,
} from "@/view/widgets/workspaces";

const ws = (rightIds: string[], bottom = 200): Workspace => ({
  right: { groups: [{ panelIds: rightIds, activeId: rightIds[0]!, collapsed: false, weight: 1 }], floats: {}, closed: [] },
  bottom: { groups: [{ panelIds: ["timeline"], activeId: "timeline", collapsed: false, weight: 1 }], floats: {}, closed: [] },
  sizes: { bottom },
});

describe("workspaceNameError", () => {
  const cases: Array<[string, string | null]> = [
    ["Animate", null],
    ["  spaced  ", null],
    ["", "Enter a name."],
    ["   ", "Enter a name."],
    ["x".repeat(MAX_WORKSPACE_NAME), null],
    ["x".repeat(MAX_WORKSPACE_NAME + 1), `Use at most ${MAX_WORKSPACE_NAME} characters.`],
  ];
  for (const [name, want] of cases) {
    it(JSON.stringify(name), () => expect(workspaceNameError(name)).toBe(want));
  }
});

describe("putWorkspace / removeWorkspace", () => {
  it("adds a new name at the end", () => {
    const list = putWorkspace(putWorkspace([], "A", ws(["props"])), "B", ws(["library"]));
    expect(list.map((e) => e.name)).toEqual(["A", "B"]);
  });

  it("replaces a name in place, whatever its case, keeping the new spelling", () => {
    const list = putWorkspace(putWorkspace([], "Rig", ws(["props"])), "Anim", ws(["library"]));
    const next = putWorkspace(list, " rig ", ws(["history"]));
    expect(next.map((e) => e.name)).toEqual(["rig", "Anim"]);
    expect(next[0]!.workspace.right.groups[0]!.panelIds).toEqual(["history"]);
  });

  it("stores a copy, not the live layout", () => {
    const live = ws(["props"]);
    const list = putWorkspace([], "A", live);
    live.right.groups[0]!.panelIds.push("history");
    expect(list[0]!.workspace.right.groups[0]!.panelIds).toEqual(["props"]);
  });

  it("removes by name without case; an unknown name changes nothing", () => {
    const list = putWorkspace(putWorkspace([], "A", ws(["props"])), "B", ws(["library"]));
    expect(removeWorkspace(list, "a").map((e) => e.name)).toEqual(["B"]);
    expect(removeWorkspace(list, "zzz")).toBe(list);
  });

  it("findWorkspace ignores case and surrounding spaces", () => {
    const list = putWorkspace([], "Rigging", ws(["props"]));
    expect(findWorkspace(list, "  RIGGING ")?.name).toBe("Rigging");
  });
});

describe("parseWorkspaces", () => {
  it("round-trips what putWorkspace wrote", () => {
    const list = putWorkspace([], "A", ws(["props", "history"], 260));
    expect(parseWorkspaces(JSON.stringify(list))).toEqual(list);
  });

  it("survives nothing, garbage and the wrong shape", () => {
    expect(parseWorkspaces(null)).toEqual([]);
    expect(parseWorkspaces("{not json")).toEqual([]);
    expect(parseWorkspaces("{\"a\":1}")).toEqual([]);
  });

  it("drops malformed entries and later duplicates, fills missing lists", () => {
    const good = ws(["props"]);
    const raw = JSON.stringify([
      { name: "Good", workspace: { ...good, right: { groups: good.right.groups } } },
      { name: "", workspace: good },
      { name: "NoBottom", workspace: { right: good.right } },
      { name: "BadGroups", workspace: { ...good, right: { groups: [{}] } } },
      { name: "good", workspace: ws(["library"]) },
    ]);
    const list = parseWorkspaces(raw);
    expect(list.map((e) => e.name)).toEqual(["Good"]);
    expect(list[0]!.workspace.right.floats).toEqual({});
    expect(list[0]!.workspace.right.closed).toEqual([]);
  });
});
