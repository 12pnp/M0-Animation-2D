import { describe, it, expect } from "vitest";
import { PANEL_COMMANDS } from "@/core/keys/commands";
import {
  type Workspace, LAYOUT_PRESETS, MAX_WORKSPACE_NAME, PRESET_COLUMN_WIDTH, clampRightWidth, findWorkspace,
  parseWorkspaces, presetWorkspace, putWorkspace, removeWorkspace, workspaceNameError,
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

describe("LAYOUT_PRESETS", () => {
  // The AI panel is a dock panel too, though not in the Window menu's list.
  const panels = [...PANEL_COMMANDS.map((p) => p.id), "ai"].sort();
  const placedBy = (w: Workspace) => [w.left!, w.right, ...(w.columns ?? []), w.bottom]
    .flatMap((l) => l.groups.flatMap((g) => g.panelIds));

  for (const p of LAYOUT_PRESETS) {
    describe(p.label, () => {
      it("places every panel exactly once", () => {
        expect(placedBy(presetWorkspace(p)).sort()).toEqual(panels);
      });

      it("has the columns and rows its label says", () => {
        const [cols, rows] = p.id.split("x").map(Number);
        expect(p.right.length).toBe(cols);
        for (const col of p.right) expect(col.length).toBe(rows);
      });

      it("becomes a workspace with one layout per column", () => {
        const w = presetWorkspace(p);
        expect([w.right, ...(w.columns ?? [])].map((l) => l.groups.map((g) => g.panelIds))).toEqual(p.right);
        expect(w.left!.groups.map((g) => g.panelIds)).toEqual(p.left);
        expect(w.sizes).toEqual({
          right: PRESET_COLUMN_WIDTH * p.right.length, rightHidden: false, rightColumns: p.right.length,
        });
        // A preset leaves the timeline height and the AI column alone.
        expect(w.sizes.bottom).toBeUndefined();
        expect(w.sizes.aiOpen).toBeUndefined();
      });
    });
  }

  it("ids are unique", () => {
    expect(new Set(LAYOUT_PRESETS.map((p) => p.id)).size).toBe(LAYOUT_PRESETS.length);
  });
});

describe("parseWorkspaces with columns", () => {
  it("keeps extra right columns", () => {
    const list = putWorkspace([], "Grid", presetWorkspace(LAYOUT_PRESETS.find((p) => p.id === "2x3")!));
    expect(parseWorkspaces(JSON.stringify(list))).toEqual(list);
  });

  it("keeps the left panel, and drops an entry whose left is malformed", () => {
    const list = putWorkspace([], "L", presetWorkspace(LAYOUT_PRESETS[0]!));
    expect(parseWorkspaces(JSON.stringify(list))[0]!.workspace.left).toEqual(list[0]!.workspace.left);
    const bad = { ...ws(["props"]), left: { groups: 3 } };
    expect(parseWorkspaces(JSON.stringify([{ name: "Bad", workspace: bad }]))).toEqual([]);
  });

  it("drops an entry whose columns are malformed", () => {
    const w = { ...ws(["props"]), columns: [{ groups: "no" }] };
    expect(parseWorkspaces(JSON.stringify([{ name: "Bad", workspace: w }]))).toEqual([]);
  });
});

describe("clampRightWidth", () => {
  const cases: Array<[number, number, number, number]> = [
    // width, columns, viewport → width
    [268, 1, 1600, 268],
    [100, 1, 1600, 180],
    [900, 1, 1600, 560],
    [536, 2, 1600, 536],
    [900, 2, 1600, 600],
    [536, 2, 1024, 512],
    [100, 2, 1024, 300],
    // A window too narrow for even the minimum keeps the minimum.
    [536, 3, 600, 420],
  ];
  for (const [w, cols, vw, want] of cases) {
    it(`${w}px, ${cols} column(s), ${vw}px window`, () => expect(clampRightWidth(w, cols, vw)).toBe(want));
  }
});
