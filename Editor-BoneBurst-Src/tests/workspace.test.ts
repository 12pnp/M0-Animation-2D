import { describe, expect, it } from "vitest";
import { arrivalPlacement, DEFAULT_ORDER, defaultPlacement, restoreWorkspace, saveWorkspace } from "@/ui/workspace/layout";
import { PANEL_IDS, type PanelId } from "@/ui/workspace/panelIds";

const BUILT = new Set<PanelId>(["stage", "timeline", "rigTree", "properties"]);
const leaf = (id: string, views: string[], activeView = views[0]) => ({ type: "leaf" as const, size: 100, data: { id, views, ...(activeView ? { activeView } : {}) } });
const panel = (id: string) => [id, { id, contentComponent: id, title: id }] as const;

/** A layout saved by a build with the AI and reference panels: AI tabbed with properties,
 *  reference alone in a split, preview floating. */
function saved(extra: Record<string, unknown> = {}) {
  return JSON.stringify(saveWorkspace({
    grid: {
      root: {
        type: "branch", size: 800, data: [
          leaf("g1", ["rigTree"]),
          { type: "branch", size: 600, data: [leaf("g2", ["stage"]), leaf("g3", ["timeline"])] },
          leaf("g4", ["ai", "properties"], "ai"),
          leaf("g5", ["reference"]),
        ],
      },
      width: 1200, height: 800, orientation: "HORIZONTAL" as never,
    },
    panels: Object.fromEntries(["rigTree", "stage", "timeline", "properties", "ai", "reference", "preview", "mystery"].map(panel)),
    activeGroup: "g5",
    floatingGroups: [{ data: { id: "g6", views: ["preview"], activeView: "preview" }, position: { left: 10, top: 10, width: 200, height: 200 } }],
    ...extra,
  } as never, {}));
}

describe("default placement", () => {
  it("adds every panel in a fixed order, each beside one already there", () => {
    expect([...DEFAULT_ORDER].sort()).toEqual([...PANEL_IDS].sort());
    const present = new Set<string>();
    for (const id of DEFAULT_ORDER) {
      const p = defaultPlacement(id, present);
      if ("referencePanel" in p) expect(present.has(p.referencePanel)).toBe(true);
      present.add(id);
    }
  });
  it("falls back to an edge when its neighbour is not there", () => {
    expect(defaultPlacement("properties", new Set())).toEqual({ direction: "right" });
    expect(defaultPlacement("ai", new Set(["properties"]))).toEqual({ referencePanel: "properties", direction: "within" });
  });
});

describe("restoring a saved workspace", () => {
  it("takes out panels this build lacks, keeping where they were for later", () => {
    const r = restoreWorkspace(saved(), BUILT)!;
    expect(Object.keys(r.dockview.panels).sort()).toEqual(["properties", "rigTree", "stage", "timeline"]);
    expect(r.deferred).toEqual({ ai: { tabWith: "properties" }, reference: {}, preview: {} });
    const json = JSON.stringify(r.dockview);
    expect(json).not.toContain('"ai"');
    expect(json).not.toContain("g5");
    expect(json).not.toContain("mystery");
    expect(r.dockview.floatingGroups).toBeUndefined();
    // The active group went with the reference panel.
    expect(r.dockview.activeGroup).toBeUndefined();
    // properties is the active tab of its group now.
    expect(json).toContain('"views":["properties"],"activeView":"properties"');
  });
  it("puts a deferred panel back with the panel it was tabbed with when it arrives", () => {
    const r = restoreWorkspace(saved(), BUILT)!;
    expect(arrivalPlacement("ai", r.deferred, BUILT)).toEqual({ referencePanel: "properties", direction: "within" });
    expect(arrivalPlacement("preview", r.deferred, BUILT)).toEqual({ referencePanel: "stage", direction: "right" });
  });
  it("keeps deferring a panel across saves until it is built, then forgets the deferral", () => {
    const again = JSON.stringify({ ...JSON.parse(saved()), deferred: { ai: { tabWith: "properties" } } });
    expect(restoreWorkspace(again, BUILT)!.deferred.ai).toEqual({ tabWith: "properties" });
    expect(restoreWorkspace(again, new Set([...BUILT, "ai" as const]))!.deferred.ai).toBeUndefined();
  });
  it.each([
    ["nothing saved", null],
    ["not JSON", "{oops"],
    ["another format", JSON.stringify({ format: "other", version: 1 })],
    ["a newer version", JSON.stringify({ ...JSON.parse(saved()), version: 2 })],
    ["only panels this build lacks", JSON.stringify(saveWorkspace({ grid: { root: { type: "branch", data: [leaf("g", ["ai"])] }, width: 1, height: 1, orientation: "HORIZONTAL" as never }, panels: Object.fromEntries([panel("ai")]) } as never, {}))],
  ])("gives way to the default, quietly: %s", (_, text) => {
    expect(restoreWorkspace(text, BUILT)).toBeNull();
  });
});
