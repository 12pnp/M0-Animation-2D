/**
 * The history (SPEC §4): it keeps the documents themselves. An edit is a pure function from
 * document to document; undo returns the previous document object, so an undo cannot disagree
 * with the edit it undoes. A gesture (a drag, a scrubbed field) is one undo step however many
 * steps it took.
 */

/** An edit that would leave the document breaking a rule: nothing changes, and the reason is said. */
export class EditRefused extends Error {}

export type Edit<D> = (doc: D) => D;

interface Entry<D> { readonly label: string; readonly before: D; readonly after: D }

export class History<D> {
  private current: D;
  private readonly past: Entry<D>[] = [];
  private future: Entry<D>[] = [];
  private gesture: { label: string; start: D } | null = null;
  /** Steps dropped from the start for the limit: the oldest kept step is not the first one made. */
  private droppedSteps = 0;
  /** Bumped on every change, so a view can tell whether it is stale. */
  revision = 0;

  constructor(doc: D, private readonly limit = 500) {
    this.current = settle(doc);
  }

  get doc(): D { return this.current; }
  get canUndo(): boolean { return this.past.length > 0 && !this.gesture; }
  get canRedo(): boolean { return this.future.length > 0 && !this.gesture; }
  get undoLabel(): string | undefined { return this.past.at(-1)?.label; }
  get redoLabel(): string | undefined { return this.future.at(-1)?.label; }

  /**
   * Every step, oldest first: the done steps, then the undone ones a redo would bring back.
   * `done` is how many are done (0: back at the start); `dropped`, how many older steps the limit
   * let go of.
   */
  get entries(): { readonly labels: readonly string[]; readonly done: number; readonly dropped: number } {
    return { labels: [...this.past.map((e) => e.label), ...this.future.map((e) => e.label).reverse()], done: this.past.length, dropped: this.droppedSteps };
  }

  /**
   * Undo or redo until `done` steps are done: one step at a time, as the buttons do, calling
   * `step` after each (what follows the document, such as a re-import's atlas, sees every step).
   * Returns false when nothing moved (out of range, or inside a gesture).
   */
  goTo(done: number, step: () => void = () => {}): boolean {
    if (this.gesture || done < 0 || done > this.past.length + this.future.length || done === this.past.length) return false;
    while (this.past.length > done && this.undo()) step();
    while (this.past.length < done && this.redo()) step();
    return true;
  }

  /**
   * Apply one edit as one undo step. Returns false, and records nothing, when the edit changed
   * nothing (returned the same document). Inside a gesture, the step belongs to the gesture.
   * An `EditRefused` passes through with the document untouched.
   */
  apply(label: string, edit: Edit<D>): boolean {
    const next = settle(edit(this.current));
    if (next === this.current) return false;
    if (!this.gesture) this.record(label, this.current, next);
    this.set(next);
    return true;
  }

  /** Start a gesture: what `apply` does until `end` is one step labelled `label`. */
  begin(label: string): void {
    if (this.gesture) this.end();
    this.gesture = { label, start: this.current };
  }

  /** End the gesture: one step, or none if it ends on the very document it started from (identity,
   *  not equality: a drag out and back to the same values is still a step). */
  end(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (this.current !== g.start) this.record(g.label, g.start, this.current);
  }

  /** Abandon the gesture: back to the document it started from, nothing recorded. */
  cancel(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.set(g.start);
  }

  undo(): boolean {
    const e = this.canUndo ? this.past.pop() : undefined;
    if (!e) return false;
    this.future.push(e);
    this.set(e.before);
    return true;
  }

  redo(): boolean {
    const e = this.canRedo ? this.future.pop() : undefined;
    if (!e) return false;
    this.past.push(e);
    this.set(e.after);
    return true;
  }

  private record(label: string, before: D, after: D): void {
    this.past.push({ label, before, after });
    if (this.past.length > this.limit) { this.past.shift(); this.droppedSteps++; }
    this.future = [];
  }

  private set(doc: D): void {
    this.current = doc;
    this.revision++;
  }
}

/** Under the test runner every document is deep-frozen, so an edit that mutates fails loudly. */
function settle<D>(doc: D): D {
  return underTest() ? deepFreeze(doc) : doc;
}

function underTest(): boolean {
  return !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST;
}

export function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return v;
  Object.freeze(v);
  if (v instanceof Map) for (const [, e] of v) deepFreeze(e);
  else for (const e of Object.values(v)) deepFreeze(e);
  return v;
}
