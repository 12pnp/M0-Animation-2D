/**
 * Every keyboard shortcut, in one table (E7-PLAN step 2): what the keys are, what they do, and
 * how a key event matches them. The app's key handler dispatches from it, the menus and titles
 * show its keys, and Help ▸ Keyboard Shortcuts lists it. Order matters: the handler takes the
 * first row that matches and applies (a row can decline, and the walk goes on).
 */

/** How a key event matches: ⌘ (or Ctrl), ⌥ and ⇧ required (true), refused (false) or either (undefined). */
export interface Chord {
  readonly mod: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  /** `e.key`, lowercased: any of these. */
  readonly keys?: readonly string[];
  /** `e.code`: where ⌥ or the layout changes `e.key`. */
  readonly code?: string;
}

export type ShortcutGroup = "File" | "Edit" | "View" | "Tools" | "Playback" | "Timeline" | "Stage" | "Help";

export interface Shortcut {
  readonly id: string;
  /** The keys as shown. */
  readonly keys: string;
  readonly group: ShortcutGroup;
  /** What it does, as the sheet says it. */
  readonly what: string;
  readonly chord: Chord;
  /** It works in a text field too. */
  readonly whileTyping?: boolean;
  /** The browser's own action still happens (Escape: a dialog closes on it). */
  readonly keepDefault?: boolean;
}

/** ⌘ with a key; ⌥ and ⇧ either, unless said. */
const cmd = (keys: string | readonly string[], extra: Partial<Chord> = {}): Chord => ({ mod: true, keys: typeof keys === "string" ? [keys] : keys, ...extra });
/** A key alone: no ⌘, no ⌥; ⇧ either. */
const plain = (keys: string | readonly string[], extra: Partial<Chord> = {}): Chord => ({ mod: false, alt: false, keys: typeof keys === "string" ? [keys] : keys, ...extra });

export const SHORTCUTS = [
  { id: "open", keys: "⌘O", group: "File", what: "Open a project, a skeleton with its atlas and images, or a PSD", chord: cmd("o"), whileTyping: true },
  { id: "save", keys: "⌘S", group: "File", what: "Save the project", chord: cmd("s"), whileTyping: true },
  { id: "preferences", keys: "⌘,", group: "Edit", what: "Preferences", chord: { mod: true, keys: [","], code: "Comma" }, whileTyping: true },
  { id: "undo", keys: "⌘Z", group: "Edit", what: "Undo", chord: cmd("z", { shift: false }) },
  { id: "redo", keys: "⇧⌘Z", group: "Edit", what: "Redo", chord: cmd("z", { shift: true }) },
  // ⌥ changes e.key, so copy and paste match e.code.
  { id: "copyKeys", keys: "⌘C", group: "Edit", what: "Copy the selected keys", chord: { mod: true, alt: false, code: "KeyC" } },
  { id: "copyPose", keys: "⌥⌘C", group: "Edit", what: "Copy the pose at the playhead", chord: { mod: true, alt: true, code: "KeyC" } },
  { id: "pasteKeys", keys: "⌘V", group: "Edit", what: "Paste keys at the playhead", chord: { mod: true, alt: false, code: "KeyV" } },
  { id: "pastePose", keys: "⌥⌘V", group: "Edit", what: "Paste the copied pose", chord: { mod: true, alt: true, code: "KeyV" } },
  { id: "selectAll", keys: "⌘A", group: "Timeline", what: "Select every key of the animation", chord: cmd("a") },
  { id: "snapping", keys: "⇧⌘;", group: "View", what: "Snapping on or off", chord: { mod: true, shift: true, code: "Semicolon" } },
  { id: "fullScreen", keys: "⇧⌘F", group: "View", what: "Full screen on or off (the browser hides its address bar; Esc leaves it)", chord: { mod: true, shift: true, code: "KeyF" } },
  { id: "redoAlt", keys: "⌘Y", group: "Edit", what: "Redo (also)", chord: cmd("y") },
  { id: "escape", keys: "Esc", group: "Stage", what: "Cancel a drag, stop playback, or select nothing", chord: plain("escape"), keepDefault: true },
  { id: "fit", keys: "F", group: "View", what: "Centre the view on the selected bone, or fit the whole skeleton when none is selected", chord: plain("f") },
  { id: "lockSelection", keys: "L", group: "Stage", what: "Lock the selected bone (Animate mode): it cannot be let go or swapped for another until unlocked", chord: plain("l") },
  { id: "cycleSpace", keys: "Z", group: "Stage", what: "Cycle the transform space: Local, Parent, World", chord: plain("z") },
  { id: "brushSmaller", keys: "[", group: "Stage", what: "Weight brush smaller (while painting weights)", chord: plain("[") },
  { id: "brushLarger", keys: "]", group: "Stage", what: "Weight brush larger (while painting weights)", chord: plain("]") },
  { id: "play", keys: "Space", group: "Playback", what: "Play or pause", chord: { mod: false, alt: false, code: "Space" } },
  { id: "prevFrame", keys: "Q", group: "Playback", what: "Previous frame (also ,); in the Motion Path panel, the previous node", chord: plain(["q", ","]) },
  { id: "nextFrame", keys: "W", group: "Playback", what: "Next frame (also .); in the Motion Path panel, the next node", chord: plain(["w", "."]) },
  { id: "firstFrame", keys: "Home", group: "Playback", what: "First frame", chord: plain("home") },
  { id: "lastFrame", keys: "End", group: "Playback", what: "Last frame", chord: plain("end") },
  { id: "key", keys: "K", group: "Timeline", what: "Key the selection at the playhead, or fire the selected event", chord: plain("k") },
  { id: "delete", keys: "Delete", group: "Edit", what: "Delete the selected keys, vertex, or rig item", chord: plain(["delete", "backspace"]) },
  { id: "toolMove", keys: "T", group: "Tools", what: "Move", chord: plain("t") },
  { id: "toolRotate", keys: "R", group: "Tools", what: "Rotate", chord: plain("r") },
  { id: "toolScale", keys: "S", group: "Tools", what: "Scale", chord: plain("s") },
  { id: "toolShear", keys: "H", group: "Tools", what: "Shear", chord: plain("h") },
  { id: "nudgeLeft", keys: "←", group: "Stage", what: "Nudge the selected bone's value for the chosen tool down (⇧ many times as much; the steps are in Preferences ▸ Grid)", chord: plain("arrowleft") },
  { id: "nudgeRight", keys: "→", group: "Stage", what: "Nudge the selected bone's value for the chosen tool up (Rotate: +; Move, Scale, Shear: x)", chord: plain("arrowright") },
  { id: "nudgeDown", keys: "↓", group: "Stage", what: "Nudge the selected bone's second value (y) down; Rotate: down", chord: plain("arrowdown") },
  { id: "nudgeUp", keys: "↑", group: "Stage", what: "Nudge the selected bone's second value (y) up; Rotate: up", chord: plain("arrowup") },
  { id: "shortcuts", keys: "?", group: "Help", what: "This list of shortcuts", chord: plain("?") },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

const BY_ID = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

/** The keys of a shortcut, as shown. */
export function keysOf(id: ShortcutId): string {
  return BY_ID.get(id)!.keys;
}

/** The fields of a key event a chord reads. */
export type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export function matches(c: Chord, e: KeyEventLike): boolean {
  if ((e.metaKey || e.ctrlKey) !== c.mod) return false;
  if (c.alt !== undefined && e.altKey !== c.alt) return false;
  if (c.shift !== undefined && e.shiftKey !== c.shift) return false;
  return !!c.keys?.includes(e.key.toLowerCase()) || (c.code !== undefined && e.code === c.code);
}

/** The rows a key event matches, in table order; in a text field, only those that work there. */
export function matching(e: KeyEventLike, typing: boolean): Shortcut[] {
  return SHORTCUTS.filter((s: Shortcut) => (!typing || s.whileTyping) && matches(s.chord, e));
}
