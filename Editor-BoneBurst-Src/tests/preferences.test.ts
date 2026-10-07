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
    const p = { theme: "dark" as const, rulers: false, boneSelect: false, imageSelect: false, otherSelect: false, boneNames: true, pickGlow: false, compensate: true, nudgeStep: 0.5, nudgeScaleStep: 0.05, nudgeBigFactor: 4, uiScale: 80, fontSize: "large" as const, toolbarLabels: "hide" as const, toolbarPosition: "right" as const, fewerTicks: true, defaultFps: 24, treeColours: false, treeIndent: 20, treeGuideColour: "#336699", stagePanels: false, fullScreenOnStart: false, boneColour: "#334455", boneSize: 2.5, selectedBoneColour: "#ff00aa", bones: false, constraints: false, hideIkBones: true, rulerColour: "#112233", rulerOpacity: 0.4, rulerTextColour: "#ffee00", undoSteps: 1200, referenceOpacity: 0.3, ai: true, autosave: false, autosaveSeconds: 90, saveTo: "file" as const, onion: true, onionBefore: 3, onionAfter: 0, onionKeyedOnly: true, onionColour: false, grid: true, checker: false, axes: false, checkerColour: "#112233", gridColour: "#445566", gridThickness: 2.5, axisXColour: "#aa0000", axisYColour: "#00aa00", axisThickness: 3, tabBarColour: "#101820", tabActiveColour: "auto", tabTextColour: "#ddeeff", tabDimTextColour: "#778899", gridSize: 12.5, snap: false, snapGrid: false, snapGuides: false, snapBones: false, snapPixels: true };
    expect(readPreferences(writePreferences(p))).toEqual(p);
  });
  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 3, theme: "dark" })],
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
    // Reset keeps the theme in use.
    expect(prefs.values).toEqual({ ...DEFAULTS, theme: "light" });
    expect(readPreferences(st.saved)).toEqual({ ...DEFAULTS, theme: "light" });
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
    const text = JSON.stringify({ version: 1, fontSize: "huge", toolbarLabels: "hide", toolbarPosition: "middle", fewerTicks: true, defaultFps: 24, treeColours: false, treeIndent: 20 });
    expect(readPreferences(text)).toMatchObject({ fontSize: DEFAULTS.fontSize, toolbarLabels: "hide", toolbarPosition: DEFAULTS.toolbarPosition, fewerTicks: true, defaultFps: 24, treeColours: false, treeIndent: 20 });
  });
  it("bring a row height, a frame rate and an indent into range", () => {
    const prefs = new Preferences(null);
    prefs.set({ defaultFps: 0, treeIndent: -4 });
    expect(prefs.values).toMatchObject({ defaultFps: 1, treeIndent: 6 });
    prefs.set({ defaultFps: 1000, treeIndent: 99 });
    expect(prefs.values).toMatchObject({ defaultFps: 240, treeIndent: 40 });
  });
});

describe("themes", () => {
  const mem = (): Store & { saved: string | null } => { const st = { saved: null as string | null, getItem: () => st.saved, setItem: (_k: string, v: string) => { st.saved = v; } }; return st; };

  it("start with Light and Dark, following the system", () => {
    const prefs = new Preferences(null, () => true);
    expect(prefs.themes.map((t) => t.id)).toEqual(["light", "dark"]);
    expect(prefs.values.theme).toBe("system");
    expect(prefs.active.id).toBe("dark");
    expect(prefs.scheme).toBeNull();
  });

  it("keep each theme's appearance apart, and the behaviour preferences the same in all", () => {
    const prefs = new Preferences(null, () => false);
    prefs.set({ theme: "dark", boneColour: "#112233", undoSteps: 777 });
    prefs.set({ theme: "light", boneColour: "#aabbcc" });
    expect(prefs.values).toMatchObject({ boneColour: "#aabbcc", undoSteps: 777 });
    prefs.set({ theme: "dark" });
    expect(prefs.values).toMatchObject({ boneColour: "#112233", undoSteps: 777 });
  });

  it("make a theme as a copy of the one in use, set it apart, rename, change its base and delete it", () => {
    const st = mem(), prefs = new Preferences(st, () => false);
    prefs.set({ theme: "dark", boneColour: "#112233" });
    const made = prefs.addTheme("Dark 2");
    expect(made).toMatchObject({ name: "Dark 2", base: "dark" });
    expect(prefs.values).toMatchObject({ theme: made.id, boneColour: "#112233" });
    prefs.set({ boneColour: "#ff0000" });
    prefs.set({ theme: "dark" });
    expect(prefs.values.boneColour).toBe("#112233");
    prefs.renameTheme(made.id, "Night");
    prefs.setThemeBase(made.id, "light");
    expect(new Preferences(st).themes.find((t) => t.id === made.id)).toMatchObject({ name: "Night", base: "light", values: { boneColour: "#ff0000" } });
    prefs.set({ theme: made.id });
    expect(prefs.scheme).toBe("light");
    prefs.deleteTheme(made.id);
    expect(prefs.themes.map((t) => t.id)).toEqual(["light", "dark"]);
    expect(prefs.values.theme).toBe("light");
  });

  it("leave Light and Dark in place: no rename, no delete, no new base", () => {
    const prefs = new Preferences(null, () => false);
    prefs.renameTheme("dark", "Black");
    prefs.setThemeBase("dark", "light");
    prefs.deleteTheme("dark");
    expect(prefs.themes).toMatchObject([{ id: "light", name: "Light", base: "light" }, { id: "dark", name: "Dark", base: "dark" }]);
  });

  it("swap the built-in theme in force when the system's scheme changes", () => {
    let dark = false;
    const prefs = new Preferences(null, () => dark), heard: string[] = [];
    prefs.set({ theme: "light", boneColour: "#010203" });
    prefs.set({ theme: "system" });
    prefs.onChange((p) => heard.push(p.boneColour));
    dark = true;
    prefs.resync();
    expect(prefs.active.id).toBe("dark");
    expect(heard).toEqual(["auto"]);
    prefs.resync();
    expect(heard).toHaveLength(1);
  });

  it("read a version 1 file: its appearance goes to the theme it named", () => {
    const p = readPreferences(JSON.stringify({ version: 1, theme: "dark", boneColour: "#334455", undoSteps: 70 }));
    expect(p).toMatchObject({ theme: "dark", boneColour: "#334455", undoSteps: 70 });
    const prefs = new Preferences({ getItem: () => JSON.stringify({ version: 1, theme: "dark", boneColour: "#334455" }), setItem: () => {} }, () => false);
    expect(prefs.themes.find((t) => t.id === "light")!.values.boneColour).toBe("auto");
  });

  it("drop a stored theme that does not read, and fall back to the system when the one in use is gone", () => {
    const text = JSON.stringify({ version: 2, theme: "ghost", themes: [{ id: "x", name: "", base: "dark", values: {} }, { id: "y", name: "Why", base: "purple", values: {} }, { id: "z", name: "Zed", base: "light", values: { boneColour: "#0a0b0c", boneSize: 99 } }] });
    const prefs = new Preferences({ getItem: () => text, setItem: () => {} }, () => false);
    expect(prefs.themes.map((t) => t.id)).toEqual(["light", "dark", "z"]);
    expect(prefs.themes[2]!.values).toMatchObject({ boneColour: "#0a0b0c", boneSize: DEFAULTS.boneSize });
    expect(prefs.values.theme).toBe("system");
  });
});
