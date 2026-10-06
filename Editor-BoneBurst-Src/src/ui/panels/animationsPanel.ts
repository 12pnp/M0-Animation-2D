import { addAnimation, deleteAnimation, duplicateAnimation, renameAnimation } from "@/edit/animations";
import { animationDuration } from "@/model/timelines";
import type { Session } from "../session";
import { ListPanel, type ListRow } from "./listPanel";
import { unique } from "./outline";

/**
 * The Animations panel: a window of its own for the animations. The setup pose and each animation
 * with its length, the one shown on the stage and keyed marked; a click shows it from its start.
 */
export class AnimationsPanel extends ListPanel {
  constructor(session: Session) {
    super(session, "Animations", "Open a skeleton to see its animations.", {
      add: () => this.add(),
      duplicate: (n) => this.duplicate(n),
      rename: (n) => this.rename(n),
      remove: (n) => this.remove(n),
    });
    this.update();
  }

  protected rows(): ListRow[] | null {
    const doc = this.session.doc;
    if (!doc) return null;
    const shown = this.session.animation?.name ?? null;
    const setup: ListRow = { label: "Setup pose", note: "", current: shown === null, editable: false, choose: () => this.session.showAnimation(null) };
    return [setup, ...(doc.animations ?? []).map((a): ListRow => ({
      label: a.name, note: `${animationDuration(a).toFixed(2)} s`, current: shown === a.name, editable: true, choose: () => this.session.showAnimation(a.name),
    }))];
  }

  private names(): string[] { return (this.session.doc?.animations ?? []).map((a) => a.name); }

  private add(): void {
    const name = prompt("Name of the new animation:", unique("animation", this.names()))?.trim();
    if (name && this.apply(`Add animation ${name}`, addAnimation(name))) this.session.showAnimation(name);
  }

  private duplicate(from: string): void {
    const name = prompt(`Name of the copy of "${from}":`, unique(`${from} copy`, this.names()))?.trim();
    if (name && this.apply(`Duplicate animation ${from} as ${name}`, duplicateAnimation(from, name))) this.session.showAnimation(name);
  }

  private rename(from: string): void {
    const name = prompt(`Rename "${from}" to:`, from)?.trim();
    if (!name || name === from) return;
    if (this.apply(`Rename animation ${from} to ${name}`, renameAnimation(from, name))) this.session.showAnimation(name);
  }

  private remove(name: string): void {
    if (!confirm(`Delete the animation "${name}"? Undo brings it back.`)) return;
    if (this.apply(`Delete animation ${name}`, deleteAnimation(name))) this.session.showAnimation(null);
  }
}
