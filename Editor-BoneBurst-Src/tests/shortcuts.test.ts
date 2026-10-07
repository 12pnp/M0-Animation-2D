import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type KeyEventLike, keysOf, matching, type Shortcut, SHORTCUTS, type ShortcutId } from "@/ui/shortcuts";

/** The shortcuts table (E7-PLAN step 2). */

const ev = (key: string, mods: { cmd?: boolean; alt?: boolean; shift?: boolean } = {}, code = ""): KeyEventLike =>
  ({ key, code, metaKey: !!mods.cmd, ctrlKey: false, altKey: !!mods.alt, shiftKey: !!mods.shift });
const first = (e: KeyEventLike, typing = false) => matching(e, typing)[0]?.id;
const rows = SHORTCUTS as readonly Shortcut[];

describe("the shortcuts table", () => {
  it("has unique ids, and keys for every id", () => {
    expect(new Set(rows.map((s) => s.id)).size).toBe(rows.length);
    for (const s of rows) expect(keysOf(s.id as ShortcutId)).toMatch(/\S/);
  });

  it("no two rows match one row's own key event, with ⇧ either way where ⇧ is free", () => {
    for (const s of rows) {
      const c = s.chord;
      for (const shift of c.shift === undefined ? [false, true] : [c.shift]) {
        const e: KeyEventLike = { key: c.keys?.[0] ?? "", code: c.code ?? "", metaKey: c.mod, ctrlKey: false, altKey: c.alt ?? false, shiftKey: shift };
        expect(matching(e, false).map((m) => m.id), `${s.id} ⇧${shift}`).toEqual([s.id]);
      }
    }
  });

  // What the key handler did before the table (app.ts's if chain at E7's start), event by event.
  it("matches each key as the key handler did before it", () => {
    const table: [KeyEventLike, string | undefined][] = [
      [ev("o", { cmd: true }), "open"], [ev("s", { cmd: true }), "save"], [ev("s", { cmd: true, shift: true }), "saveAs"], [ev(",", { cmd: true }), "preferences"],
      [ev("<", { cmd: true, shift: true }, "Comma"), "preferences"],
      [ev("z", { cmd: true }), "undo"], [ev("Z", { cmd: true, shift: true }), "redo"], [ev("z", { cmd: true, alt: true }), "undo"],
      [ev("y", { cmd: true }), "redoAlt"],
      [ev("c", { cmd: true }, "KeyC"), "copyKeys"], [ev("C", { cmd: true, shift: true }, "KeyC"), "copyKeys"],
      [ev("ç", { cmd: true, alt: true }, "KeyC"), "copyPose"], [ev("v", { cmd: true }, "KeyV"), "pasteKeys"],
      [ev("√", { cmd: true, alt: true }, "KeyV"), "pastePose"], [ev("a", { cmd: true }, "KeyA"), "selectAll"],
      [ev(":", { cmd: true, shift: true }, "Semicolon"), "snapping"], [ev("F", { cmd: true, shift: true }, "KeyF"), "fullScreen"], [ev("f", { cmd: true }, "KeyF"), undefined], [ev(";", { cmd: true }, "Semicolon"), undefined],
      [ev("Escape"), "escape"], [ev("f"), "fit"], [ev("F", { shift: true }), "fit"], [ev("f", { alt: true }), undefined],
      [ev("["), "brushSmaller"], [ev("]"), "brushLarger"], [ev(" ", {}, "Space"), "play"],
      [ev(","), "prevFrame"], [ev("."), "nextFrame"], [ev("q"), "prevFrame"], [ev("Q", { shift: true }), "prevFrame"], [ev("w"), "nextFrame"], [ev("Home"), "firstFrame"], [ev("End"), "lastFrame"],
      [ev("k"), "key"], [ev("Delete"), "delete"], [ev("Backspace"), "delete"],
      [ev("t"), "toolMove"], [ev("T", { shift: true }), "toolMove"], [ev("r"), "toolRotate"], [ev("s"), "toolScale"], [ev("h"), "toolShear"],
      [ev("z"), "cycleSpace"],
      [ev("t", { cmd: true }), undefined], [ev("t", { alt: true }), undefined], [ev("j"), undefined], [ev("x"), "motionRemove"], [ev("a"), "motionAdd"],
      [ev("?", { shift: true }, "Slash"), "shortcuts"],
    ];
    for (const [e, id] of table) expect(first(e), JSON.stringify(e)).toBe(id);
  });

  it("in a text field, only ⌘O, ⌘S and ⌘, work", () => {
    expect(first(ev("o", { cmd: true }), true)).toBe("open");
    expect(first(ev("s", { cmd: true }), true)).toBe("save");
    expect(first(ev(",", { cmd: true }), true)).toBe("preferences");
    for (const e of [ev("z", { cmd: true }), ev("c", { cmd: true }, "KeyC"), ev("a", { cmd: true }), ev("t"), ev(" ", {}, "Space"), ev("Backspace"), ev("?", { shift: true })]) {
      expect(matching(e, true), JSON.stringify(e)).toEqual([]);
    }
  });

  it("the interface writes no key text of its own: it reads the table", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk(join(__dirname, "..", "src", "ui"));
    // A string literal holding ⌘, ⌥ or ⇧, or a key in brackets such as (K) or (Space).
    const keyText = /(["'`])(?:(?!\1).)*?(⌘|⌥|⇧|\((?:[A-Z]|Space|Esc|Home|End|Delete)\))(?:(?!\1).)*?\1/;
    const found = files.filter((f) => !f.endsWith(join("ui", "shortcuts.ts"))).flatMap((f) => readFileSync(f, "utf8").split("\n")
      .map((line, i) => ({ line, at: `${f.split("src/")[1]}:${i + 1}` }))
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && keyText.test(line.replace(/\/\/.*$/, ""))));
    expect(found.map((f) => `${f.at}: ${f.line.trim()}`)).toEqual([]);
  });
});
