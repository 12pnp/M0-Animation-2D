import { describe, expect, it } from "vitest";
import { DEFAULTS, Preferences, PREFERENCES_KEY, readPreferences, type Store, writePreferences } from "@/ui/preferences";

/** A storage stand-in; `blocked` makes every call throw, as a private window's storage can. */
function store(initial: string | null = null, blocked = false): Store & { saved: string | null } {
  const s = {
    saved: initial,
    getItem: (k: string) => { if (blocked) throw new Error("blocked"); return k === PREFERENCES_KEY ? s.saved : null; },
    setItem: (k: string, v: string) => { if (blocked) throw new Error("blocked"); if (k === PREFERENCES_KEY) s.saved = v; },
  };
  return s;
}

describe("preferences", () => {
  it("start from the defaults, and read back what was written", () => {
    expect(readPreferences(null)).toEqual(DEFAULTS);
    const p = { theme: "dark" as const, rulers: false, uiScale: 80, fontSize: "large" as const, toolbarLabels: "hide" as const, toolbarPosition: "right" as const, rowHeight: 30, fewerTicks: true, defaultFps: 24, treeColours: false, treeIndent: 20, stagePanels: false, boneColour: "#334455", boneSize: 2.5, selectedBoneColour: "#ff00aa", bones: false, constraints: false, undoSteps: 1200, referenceOpacity: 0.3, ai: true, autosave: false, autosaveSeconds: 90, onion: true, onionBefore: 3, onionAfter: 0, onionKeyedOnly: true, onionColour: false, grid: true, checker: false, axes: false, checkerColour: "#112233", gridColour: "#445566", gridThickness: 2.5, axisXColour: "#aa0000", axisYColour: "#00aa00", axisThickness: 3, tabBarColour: "#101820", tabActiveColour: "auto", tabTextColour: "#ddeeff", tabDimTextColour: "#778899", gridSize: 12.5, snap: false, snapGrid: false, snapGuides: false, snapBones: false, snapPixels: true };
    expect(readPreferences(writePreferences(p))).toEqual(p);
  });
  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 2, theme: "dark" })],
    ["no version", JSON.stringify({ theme: "dark" })],
    ["not an object", "3"],
  ])("ignore %s whole", (_w, text) => {
    expect(readPreferences(text)).toEqual(DEFAULTS);
  });
  it("take the default for each value that does not read or is out of range, and ignore unknown keys", () => {
    const text = JSON.stringify({ version: 1, theme: "purple", rulers: "yes", bones: false, undoSteps: 10, referenceOpacity: 2, autosaveSeconds: 1, later: true });
    expect(readPreferences(text)).toEqual({ ...DEFAULTS, bones: false });
  });
  it("keep changes in the storage, tell listeners, bring numbers into range; Reset gives the defaults", () => {
    const st = store(), prefs = new Preferences(st), heard: string[] = [];
    prefs.onChange((p) => heard.push(p.theme));
    prefs.set({ theme: "light", undoSteps: 99999, referenceOpacity: -1, autosaveSeconds: 2, onionBefore: 40, onionAfter: -3 });
    expect(prefs.values).toMatchObject({ theme: "light", undoSteps: 5000, referenceOpacity: 0, autosaveSeconds: 5, onionBefore: 10, onionAfter: 0 });
    expect(new Preferences(st).values).toEqual(prefs.values);
    prefs.set({ theme: "light" });
    expect(heard).toEqual(["light"]);
    prefs.reset();
    expect(prefs.values).toEqual(DEFAULTS);
    expect(readPreferences(st.saved)).toEqual(DEFAULTS);
  });
  it("run on the defaults when the storage is blocked, and still change for this visit", () => {
    const prefs = new Preferences(store("x", true));
    expect(prefs.values).toEqual(DEFAULTS);
    prefs.set({ rulers: false });
    expect(prefs.values.rulers).toBe(false);
    expect(new Preferences(null).values).toEqual(DEFAULTS);
  });
});

describe("stage background preferences", () => {
  it("take the default for a colour that is not #rrggbb or auto, and a thickness out of range", () => {
    const text = JSON.stringify({ version: 1, checkerColour: "red", axisXColour: "auto", gridThickness: 40, axisThickness: 0 });
    expect(readPreferences(text)).toMatchObject({ checkerColour: DEFAULTS.checkerColour, axisXColour: "auto", gridThickness: DEFAULTS.gridThickness, axisThickness: DEFAULTS.axisThickness });
  });
  it("bring a thickness into range", () => {
    const prefs = new Preferences(null);
    prefs.set({ gridThickness: 99, axisThickness: 0.1 });
    expect(prefs.values).toMatchObject({ gridThickness: 8, axisThickness: 0.5 });
  });
});

describe("bone size", () => {
  it("reads in range, and is brought into range", () => {
    expect(readPreferences(JSON.stringify({ version: 1, boneSize: 3 })).boneSize).toBe(3);
    expect(readPreferences(JSON.stringify({ version: 1, boneSize: 50 })).boneSize).toBe(DEFAULTS.boneSize);
    const prefs = new Preferences(null);
    prefs.set({ boneSize: 99 });
    expect(prefs.values.boneSize).toBe(10);
    prefs.set({ boneSize: 0 });
    expect(prefs.values.boneSize).toBe(0.2);
  });
});

describe("the user interface preferences", () => {
  it("fall back to the default for a choice that is not one, and read a value in range", () => {
    const text = JSON.stringify({ version: 1, fontSize: "huge", toolbarLabels: "hide", toolbarPosition: "middle", rowHeight: 30, fewerTicks: true, defaultFps: 24, treeColours: false, treeIndent: 20 });
    expect(readPreferences(text)).toMatchObject({ fontSize: DEFAULTS.fontSize, toolbarLabels: "hide", toolbarPosition: DEFAULTS.toolbarPosition, rowHeight: 30, fewerTicks: true, defaultFps: 24, treeColours: false, treeIndent: 20 });
  });
  it("bring a row height, a frame rate and an indent into range", () => {
    const prefs = new Preferences(null);
    prefs.set({ rowHeight: 999, defaultFps: 0, treeIndent: -4 });
    expect(prefs.values).toMatchObject({ rowHeight: 40, defaultFps: 1, treeIndent: 6 });
    prefs.set({ rowHeight: 3, defaultFps: 1000, treeIndent: 99 });
    expect(prefs.values).toMatchObject({ rowHeight: 16, defaultFps: 240, treeIndent: 40 });
  });
});
