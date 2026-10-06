import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSTRAINT_ICONS, ICON_FILES } from "@/ui/icons";
import { CONSTRAINT_TYPES } from "@/model/skeleton";

/** The vendored icons (E4-PLAN step 13a): where they came from, how they look, what uses them. */
const ROOT = join(__dirname, "..", "public", "vendor", "icons");
const GODOT_COMMIT = "ed1daf0bf001b61586d9930840f2f1394092c079";
const LUCIDE_COMMIT = "500620a2e8123f8d1db191538886dc0c223f69a9";
const svgs = (set: string) => readdirSync(join(ROOT, set)).filter((f) => f.endsWith(".svg")).sort();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
/** The files a manifest's table lists, in its first column. */
const listed = (set: string) => [...read(set, "MANIFEST.md").matchAll(/^\| `([^`]+\.svg)` \|/gm)].map((m) => m[1]!).sort();

describe("vendored icons", () => {
  it("every icon the interface names has its file, and every file is named", () => {
    const named = Object.values(ICON_FILES);
    for (const f of named) expect(existsSync(join(ROOT, `${f}.svg`)), f).toBe(true);
    const files = ["godot", "lucide"].flatMap((set) => svgs(set).map((f) => `${set}/${f.slice(0, -4)}`));
    expect(files.sort()).toEqual([...new Set(named)].sort());
    for (const t of CONSTRAINT_TYPES) expect(ICON_FILES[CONSTRAINT_ICONS[t]]).toMatch(/^godot\//);
  });
  it("each manifest lists exactly its files, and names the pinned commit", () => {
    for (const set of ["godot", "lucide"]) expect(listed(set), set).toEqual(svgs(set));
    const godot = read("godot", "MANIFEST.md");
    expect(godot).toContain("4.7.2-stable");
    // Every Godot row names its original and the one commit.
    for (const row of godot.split("\n").filter((l) => /^\| `.+\.svg` \|/.test(l))) {
      expect(row).toMatch(/\| `editor\/icons\/[A-Za-z0-9]+\.svg` \|/);
      expect(row).toContain(GODOT_COMMIT);
    }
    expect(read("lucide", "MANIFEST.md")).toContain(LUCIDE_COMMIT);
  });
  it("Godot's icons are restyled: 24×24, one path, a 2px currentColor stroke, no colour of their own", () => {
    for (const f of svgs("godot")) {
      const s = read("godot", f);
      expect(s, f).toMatch(/viewBox="0 0 24 24"/);
      expect(s.match(/<path\b/g)?.length, f).toBe(1);
      expect(s.match(/<(?!svg|path|\/svg)[a-z]/g), f).toBeNull();
      expect(s, f).toMatch(/fill="none"/);
      expect(s, f).toMatch(/stroke="currentColor"/);
      expect(s, f).toMatch(/stroke-width="2"/);
      expect(s, f).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|style=|opacity/i);
    }
  });
  it("Lucide's icons are as Lucide draws them: 24×24, currentColor, no colour of their own", () => {
    for (const f of svgs("lucide")) {
      const s = read("lucide", f);
      expect(s, f).toMatch(/viewBox="0 0 24 24"/);
      expect(s, f).toMatch(/stroke="currentColor"/);
      expect(s, f).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|<script|href/i);
    }
  });
  it("both licences ship beside the icons and the notices list both sets", () => {
    const godot = read("godot", "LICENSE-godot-icons.txt"), lucide = read("lucide", "LICENSE-lucide.txt");
    expect(godot).toContain("Godot Engine contributors");
    expect(godot).toContain("Permission is hereby granted");
    expect(lucide).toContain("ISC License");
    expect(lucide).toContain("Cole Bemis");
    const notices = readFileSync(join(__dirname, "..", "THIRD-PARTY-NOTICES.md"), "utf8");
    expect(notices).toMatch(/Godot editor icons\]\([^)]*\) \(subset, restyled\).*MIT/);
    expect(notices).toMatch(/Lucide.*ISC/);
  });
});
