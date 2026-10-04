import { describe, it, expect } from "vitest";
import { PANEL_COMMANDS } from "@/core/keys/commands";
import {
  type Workspace, LAYOUT_PRESETS, MAX_WORKSPACE_NAME, COLUMN_MIN, PRESET_COLUMN_WIDTH, clampColumnWidth, columnSizes, findWorkspace, fitColumns, storedColumns,
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
        // One column of PRESET_COLUMN_WIDTH each; R2 shows for two columns.
        expect(w.sizes).toEqual({
          right: PRESET_COLUMN_WIDTH, rightHidden: false,
          right2: PRESET_COLUMN_WIDTH, right2Open: p.right.length > 1,
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

describe("clampColumnWidth", () => {
  const cases: Array<[number, number, number]> = [
    // width, viewport → width
    [268, 1600, 268],
    [100, 1600, 180],
    [900, 1600, 700],
    [600, 1024, 461],
    // A window too narrow for even the minimum keeps the minimum.
    [268, 300, 180],
  ];
  for (const [w, vw, want] of cases) {
    it(`${w}px in a ${vw}px window`, () => expect(clampColumnWidth(w, vw)).toBe(want));
  }
});

describe("columnSizes", () => {
  it("defaults: the right panel open, everything else shut", () => {
    expect(columnSizes({})).toEqual({
      l1: { width: 380, open: false }, l2: { width: 300, open: false },
      r1: { width: 268, open: true }, r2: { width: 268, open: false },
    });
  });

  it("reads the old format: one right width shared by two columns, one toggle", () => {
    const c = columnSizes({ right: 536, rightColumns: 2, ai: 400, aiOpen: true });
    expect(c.r1).toEqual({ width: 268, open: true });
    expect(c.r2).toEqual({ width: 268, open: true });
    expect(c.l1).toEqual({ width: 400, open: true });
    const hidden = columnSizes({ right: 536, rightColumns: 2, rightHidden: true });
    expect([hidden.r1.open, hidden.r2.open]).toEqual([false, false]);
  });

  it("round-trips the new format", () => {
    const c = {
      l1: { width: 390, open: true }, l2: { width: 250, open: true },
      r1: { width: 300, open: false }, r2: { width: 220, open: true },
    };
    expect(columnSizes(storedColumns(c))).toEqual(c);
  });
});

describe("fitColumns", () => {
  const cols = (l1: number, l2: number, r1: number, r2: number, open = [true, true, true, false]) => ({
    l1: { width: l1, open: open[0]! }, l2: { width: l2, open: open[1]! },
    r1: { width: r1, open: open[2]! }, r2: { width: r2, open: open[3]! },
  });

  it("draws every column at its own width while they fit", () => {
    expect(fitColumns(cols(380, 300, 268, 268), 1200)).toEqual({ l1: 380, l2: 300, r1: 268, r2: 268 });
  });

  it("shrinks the open ones in proportion when they do not, never under the minimum", () => {
    const out = fitColumns(cols(460, 300, 268, 268), 724);
    expect(out.l1 + out.l2 + out.r1).toBeLessThanOrEqual(724);
    expect(Math.min(out.l1, out.l2, out.r1)).toBeGreaterThanOrEqual(COLUMN_MIN);
    // Wider ones give up more.
    expect(out.l1 - COLUMN_MIN).toBeGreaterThan(out.l2 - COLUMN_MIN);
    // A closed column keeps its width for when it opens.
    expect(out.r2).toBe(268);
  });

  it("with no room even for the minimums, each is drawn at the minimum", () => {
    const out = fitColumns(cols(400, 400, 400, 400, [true, true, true, true]), 500);
    expect(Object.values(out)).toEqual([COLUMN_MIN, COLUMN_MIN, COLUMN_MIN, COLUMN_MIN]);
  });
});
