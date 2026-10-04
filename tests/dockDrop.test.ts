import { describe, it, expect } from "vitest";
import { type DockLayout, type DockRects, dropTargetAt, moveTab, placesPanel } from "@/view/widgets/dockDrop";

const r = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

/** Right column at x 600–800: group 0 is y 0–200 with two 60px tabs, group 1 y 200–400 with one. */
const right: DockRects = {
  rect: r(600, 0, 800, 600),
  groups: [
    { rect: r(600, 0, 800, 200), strip: r(600, 0, 800, 22), tabs: [r(600, 0, 660, 22), r(660, 0, 720, 22)] },
    { rect: r(600, 200, 800, 400), strip: r(600, 200, 800, 222), tabs: [r(600, 200, 660, 222)] },
  ],
};
/** Bottom area at y 450–600, left of the column, with no groups left in it. */
const emptyBottom: DockRects = { rect: r(0, 450, 590, 600), groups: [] };

describe("dropTargetAt", () => {
  const cases: Array<[string, number, number, ReturnType<typeof dropTargetAt>]> = [
    ["left half of the first tab", 610, 10, { dock: 0, group: 0, edge: "into", tab: 0 }],
    ["right half of the first tab", 650, 10, { dock: 0, group: 0, edge: "into", tab: 1 }],
    ["strip past the last tab", 780, 10, { dock: 0, group: 0, edge: "into", tab: 2 }],
    ["middle of a group's body", 700, 100, { dock: 0, group: 0, edge: "into", tab: 2 }],
    ["top band under the strip", 700, 26, { dock: 0, group: 0, edge: "before" }],
    ["bottom band of a group", 700, 190, { dock: 0, group: 0, edge: "after" }],
    ["second group's strip", 700, 210, { dock: 0, group: 1, edge: "into", tab: 1 }],
    ["column below the last group", 700, 500, { dock: 0, group: 1, edge: "after" }],
    ["an empty dock", 100, 500, { dock: 1, edge: "empty" }],
    ["off every dock", 300, 100, null],
  ];
  for (const [name, x, y, want] of cases) {
    it(name, () => expect(dropTargetAt([right, emptyBottom], x, y)).toEqual(want));
  }
});

const layout = (...groups: string[][]): DockLayout => ({
  groups: groups.map((ids) => ({ panelIds: ids, activeId: ids[0]!, collapsed: false, weight: 1 })),
  floats: {},
  closed: [],
});
const ids = (l: DockLayout) => l.groups.map((g) => g.panelIds);

describe("moveTab", () => {
  const two = [layout(["props", "history"], ["library"]), layout(["timeline"])];

  it("reorders inside a strip", () => {
    const next = moveTab(two, 0, "props", { dock: 0, group: 0, edge: "into", tab: 2 })!;
    expect(ids(next[0]!)).toEqual([["history", "props"], ["library"]]);
    expect(next[0]!.groups[0]!.activeId).toBe("props");
  });

  it("dropping a tab where it already is changes nothing", () => {
    expect(moveTab(two, 0, "props", { dock: 0, group: 0, edge: "into", tab: 0 })).toBeNull();
    expect(moveTab(two, 0, "props", { dock: 0, group: 0, edge: "into", tab: 1 })).toBeNull();
  });

  it("dropping an inactive tab where it is activates it", () => {
    const next = moveTab(two, 0, "history", { dock: 0, group: 0, edge: "into", tab: 1 })!;
    expect(ids(next[0]!)).toEqual(ids(two[0]!));
    expect(next[0]!.groups[0]!.activeId).toBe("history");
  });

  it("joins another group at the tab position", () => {
    const next = moveTab(two, 0, "library", { dock: 0, group: 0, edge: "into", tab: 1 })!;
    expect(ids(next[0]!)).toEqual([["props", "library", "history"]]);
  });

  it("crosses into another dock", () => {
    const next = moveTab(two, 0, "history", { dock: 1, group: 0, edge: "into", tab: 1 })!;
    expect(ids(next[0]!)).toEqual([["props"], ["library"]]);
    expect(ids(next[1]!)).toEqual([["timeline", "history"]]);
    expect(next[0]!.groups[0]!.activeId).toBe("props");
  });

  it("splits into a new group below another", () => {
    const next = moveTab(two, 0, "history", { dock: 0, group: 1, edge: "after" })!;
    expect(ids(next[0]!)).toEqual([["props"], ["library"], ["history"]]);
  });

  it("places by the target group even when the source group empties ahead of it", () => {
    const l = [layout(["a"], ["b"], ["c"])];
    const next = moveTab(l, 0, "a", { dock: 0, group: 2, edge: "before" })!;
    expect(ids(next[0]!)).toEqual([["b"], ["a"], ["c"]]);
  });

  it("splits a tab out of its own group, just below it (the group menu's Split Below)", () => {
    const next = moveTab(two, 0, "history", { dock: 0, group: 0, edge: "after" })!;
    expect(ids(next[0]!)).toEqual([["props"], ["history"], ["library"]]);
    expect(next[0]!.groups[1]!.activeId).toBe("history");
  });

  it("a lone tab dropped on its own group's edge stays", () => {
    expect(moveTab(two, 0, "library", { dock: 0, group: 1, edge: "before" })).toBeNull();
  });

  it("fills an empty dock", () => {
    const next = moveTab([layout(["timeline"]), layout()], 0, "timeline", { dock: 1, edge: "empty" })!;
    expect(ids(next[0]!)).toEqual([]);
    expect(ids(next[1]!)).toEqual([["timeline"]]);
  });

  it("leaves its inputs alone", () => {
    const before = structuredClone(two);
    moveTab(two, 0, "history", { dock: 1, group: 0, edge: "into", tab: 0 });
    expect(two).toEqual(before);
  });
});

describe("placesPanel", () => {
  it("docked, floating or closed all count", () => {
    const l: DockLayout = { ...layout(["a"]), floats: { b: { x: 0, y: 0, w: 1, h: 1 } }, closed: ["c"] };
    expect(["a", "b", "c", "d"].map((id) => placesPanel(l, id))).toEqual([true, true, true, false]);
    expect(placesPanel(null, "a")).toBe(false);
  });
});
