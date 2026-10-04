import { clear, cls, h, on } from "@/view/widgets/dom";
import { icon, type IconName } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import type { AnimId } from "@/core/doc/ids";
import { AddAnimation, RemoveAnimation, RenameAnimation } from "@/core/history/timelineCommands";
import { animationAfterRemoval, uniqueAnimationName } from "@/core/doc/animationList";
import { isCycle } from "@/core/doc/cycle";
import { confirmDialog } from "@/view/widgets/dialogs";

/**
 * Animations: every animation of the symbol being edited, to switch between,
 * add, rename and delete. The timeline's animation menu does the same, and
 * both follow the Store. Skins have a panel of their own (SkinsPanel).
 */
export class AnimationsPanel implements Panel {
  readonly id = "animations";
  readonly title = "Animations";
  readonly icon = "film" as const;
  readonly el: HTMLElement;

  private animList: HTMLElement;
  private renaming: AnimId | null = null;

  constructor(private readonly store: Store) {
    const tool = (name: IconName, title: string, run: () => void) => {
      const b = h("button", { class: "iconbtn", title });
      b.appendChild(icon(name, 13));
      on(b, "click", run);
      return b;
    };
    this.animList = h("div", { class: "anims-list", tabIndex: 0 });
    on(this.animList, "keydown", (ev) => this.onKey(ev as unknown as KeyboardEvent));

    this.el = h("div", { class: "anims" },
      h("div", { class: "anims-head" },
        h("span", { class: "anims-title" }, "Animations"),
        h("div", { class: "spacer" }),
        tool("newLayer", "New animation", () => this.add()),
        tool("tag", "Rename the current animation (or double-click it)", () => {
          const id = this.store.ui.animId;
          if (id) this.rename(id);
        }),
        tool("trash", "Delete the current animation", () => void this.remove())),
      this.animList);

    store.subscribe((t) => {
      if (t === "doc" || t === "timeline" || t === "ui" || t === "stage") this.render();
    });
    this.render();
  }

  private render(): void {
    if (this.renaming) return;
    this.renderAnimations();
  }

  // ── Animations ─────────────────────────────────────────────────────────

  private renderAnimations(): void {
    clear(this.animList);
    const sym = this.store.currentSymbol;
    const fps = this.store.project.frameRate || 24;
    if (sym.animations.length === 0) {
      this.animList.appendChild(h("div", { class: "hint" }, "No animation yet. Press + to make one."));
      return;
    }
    for (const a of sym.animations) {
      const name = h("span", { class: "anims-name" }, a.name);
      const row = h("div", { class: "anims-row", title: `Show “${a.name}” on the stage and in the timeline` },
        h("span", { class: "anims-mark" }, isCycle(a) ? "↻" : ""),
        name,
        h("span", { class: "anims-len" }, `${a.duration}f · ${(a.duration / fps).toFixed(2)}s`));
      cls(row, "on", a.id === this.store.ui.animId);
      // pointerup, and only the class changes: the row stays the same element
      // between the two clicks of a double-click (the DOM trap).
      on(row, "pointerup", () => this.select(a.id));
      on(name, "dblclick", () => this.rename(a.id));
      this.animList.appendChild(row);
    }
  }

  private select(id: AnimId): void {
    if (this.store.ui.animId === id) return;
    this.store.setUi({ animId: id, frame: 0 }, "doc");
    this.store.emit("timeline");
  }

  private add(): void {
    const sym = this.store.currentSymbol;
    const cmd = new AddAnimation(this.store.currentSymbolId, uniqueAnimationName(sym.animations.map((a) => a.name)));
    this.store.apply(cmd);
    this.store.setUi({ animId: cmd.animation.id, frame: 0 }, "doc");
    this.store.emit("timeline");
    this.rename(cmd.animation.id);
  }

  private async remove(): Promise<void> {
    const sym = this.store.currentSymbol;
    const anim = this.store.currentAnimation;
    if (!anim) return;
    if (sym.animations.length <= 1) {
      this.store.emit("timeline");
      return;
    }
    const symbolId = this.store.currentSymbolId;
    const ok = await confirmDialog({
      title: "Delete Animation",
      message: `Delete “${anim.name}” and all its keys? You can undo it.`,
      ok: "Delete", danger: true,
    });
    // Re-check after the await: the document can change under a dialog.
    if (!ok || this.store.currentSymbolId !== symbolId) return;
    const ids = this.store.currentSymbol.animations.map((a) => a.id);
    if (!ids.includes(anim.id)) return;
    const next = animationAfterRemoval(ids, anim.id, this.store.ui.animId);
    this.store.apply(new RemoveAnimation(symbolId, anim.id));
    this.store.setUi({ animId: next, frame: 0 }, "doc");
    this.store.emit("timeline");
  }

  private rename(id: AnimId): void {
    this.select(id);
    this.renderAnimations();
    const anim = this.store.currentSymbol.animations.find((a) => a.id === id);
    const nameEl = [...this.animList.querySelectorAll(".anims-row")]
      .find((r) => r.classList.contains("on"))?.querySelector(".anims-name");
    if (!anim || !nameEl) return;
    this.renaming = id;
    const symbolId = this.store.currentSymbolId;
    const input = h("input", { type: "text", class: "anims-rename", value: anim.name, spellcheck: false }) as HTMLInputElement;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.renaming = null;
      const next = input.value.trim();
      const taken = this.store.currentSymbol.animations.some((a) => a.id !== id && a.name === next);
      if (commit && next && next !== anim.name && !taken && this.store.currentSymbolId === symbolId) {
        this.store.apply(new RenameAnimation(symbolId, id, next));
        this.store.emit("timeline");
      } else {
        if (commit && taken) this.store.emit("timeline");
        this.render();
      }
      this.animList.focus({ preventScroll: true });
    };
    on(input, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    on(input, "blur", () => finish(true));
    on(input, "pointerup", (e) => e.stopPropagation());
  }

  /** ↑ ↓ switch animation, F2 / Enter rename; these stop at the list. */
  private onKey(e: KeyboardEvent): void {
    if (this.renaming) return;
    const anims = this.store.currentSymbol.animations;
    const at = anims.findIndex((a) => a.id === this.store.ui.animId);
    let handled = true;
    if (e.key === "ArrowDown" && at < anims.length - 1) this.select(anims[at + 1]!.id);
    else if (e.key === "ArrowUp" && at > 0) this.select(anims[at - 1]!.id);
    else if ((e.key === "F2" || e.key === "Enter") && at >= 0) this.rename(anims[at]!.id);
    else handled = e.key === "ArrowDown" || e.key === "ArrowUp";
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
}
