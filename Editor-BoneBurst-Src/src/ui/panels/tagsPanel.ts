import { findAttachment } from "@/edit/attachments";
import { type Tagged, tagCounts, taggedOfKey } from "@/edit/tags";
import type { Skeleton } from "@/model/skeleton";
import { icon, iconButton } from "../icons";
import type { Selection, Session } from "../session";
import { empty, heading } from "./outline";

/** The icon each kind of element has in the rig tree. */
const KIND_ICONS = { bone: "bone", slot: "slot", attachment: "region", skin: "skin", constraint: "ik", event: "event" } as const;

/** Whether the element a tag key names is still in the document (a deleted one leaves its tags behind, unseen). */
function exists(doc: Skeleton, t: Tagged): boolean {
  switch (t.kind) {
    case "bone": return !!doc.bones?.some((b) => b.name === t.name);
    case "slot": return !!doc.slots?.some((x) => x.name === t.name);
    case "skin": return t.name === "default" || !!doc.skins?.some((k) => k.name === t.name);
    case "event": return !!doc.events?.some((e) => e.name === t.name);
    case "constraint": return !!doc.constraints?.some((c) => c.type === t.type && c.name === t.name);
    case "attachment": return !!findAttachment(doc, { skin: t.skin, slot: t.slot, key: t.key });
  }
}

/**
 * The Tags panel (docs/TAGS-PLAN.md): every tag in use with the number of elements that have it. A click opens the list of those
 * elements, and a click on one selects it; ✎ renames the tag on every element (a name already in use merges the two), the bin
 * takes it off every element. Both are one undo step.
 */
export class TagsPanel {
  readonly element: HTMLDivElement;
  onStatus: (message: string) => void = () => {};
  private readonly open = new Set<string>();
  private renaming: string | null = null;
  private shown = "";

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel outline tags-panel";
    session.onChange(() => this.update());
    this.update();
  }

  /** The elements that have `tag` (any case), as selections, in the order they were tagged. */
  private elementsOf(tag: string, doc: Skeleton): { sel: Tagged; key: string }[] {
    const t = tag.toLowerCase();
    return this.session.sidecar.tags.filter((e) => e.tags.some((q) => q.toLowerCase() === t)).flatMap((e) => {
      const sel = taggedOfKey(e.key);
      return sel && exists(doc, sel) ? [{ sel, key: e.key }] : [];
    });
  }

  private update(): void {
    const s = this.session, doc = s.doc;
    const key = JSON.stringify([!!doc, s.sidecar.tags, [...this.open], this.renaming, doc ? s.history?.revision : 0, s.name]);
    if (key === this.shown) return;
    // A name being typed is not taken from under the person.
    if (this.renaming !== null && this.element.contains(this.element.ownerDocument.activeElement) && this.element.ownerDocument.activeElement instanceof HTMLInputElement && this.shown) return;
    this.shown = key;
    if (!doc) { this.element.replaceChildren(heading("Tags"), empty("Open a skeleton: its tags are listed here.")); return; }
    const counts = tagCounts({ ...s.sidecar, tags: s.sidecar.tags.filter((e) => { const t = taggedOfKey(e.key); return !!t && exists(doc, t); }) });
    if (!counts.length) {
      this.element.replaceChildren(heading("Tags"), empty("No tags yet: select an element and press the tags key, or use + in Properties."));
      return;
    }
    const list = document.createElement("div");
    list.className = "rows tag-list";
    for (const c of counts) list.append(...this.rows(c.tag, c.count, doc));
    this.element.replaceChildren(heading("Tags"), list);
  }

  private rows(tag: string, count: number, doc: Skeleton): HTMLElement[] {
    const id = tag.toLowerCase(), opened = this.open.has(id);
    const row = document.createElement("div");
    row.className = "row tag-row";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-expanded", String(opened));
    const twisty = document.createElement("span");
    twisty.className = "twisty-gap";
    twisty.textContent = opened ? "▾" : "▸";
    row.append(twisty, icon("tags"));
    if (this.renaming === id) {
      const input = document.createElement("input");
      input.value = tag;
      input.setAttribute("aria-label", `New name for the tag ${tag}`);
      input.spellcheck = false;
      const done = (commit: boolean): void => {
        const to = input.value;
        this.renaming = null;
        this.shown = "";
        if (commit && to.trim() && to.trim() !== tag) this.session.renameTagEverywhere(tag, to);
        else this.update();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } });
      input.addEventListener("blur", () => { if (this.renaming === id) done(true); });
      row.append(input);
      setTimeout(() => { input.focus(); input.select(); });
    } else {
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = tag;
      row.append(name);
    }
    const n = document.createElement("span");
    n.className = "note";
    n.textContent = String(count);
    n.title = `${count} element${count === 1 ? "" : "s"}`;
    const rename = this.small("✎", `Rename the tag ${tag} on every element`, () => { this.renaming = id; this.shown = ""; this.update(); });
    rename.classList.add("tag-tool");
    const del = iconButton(this.small("Delete", `Take the tag ${tag} off every element`, () => this.session.deleteTagEverywhere(tag)), "delete", false);
    del.classList.add("tag-tool");
    row.append(n, rename, del);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, input")) return;
      if (this.open.has(id)) this.open.delete(id); else this.open.add(id);
      this.shown = "";
      this.update();
    });
    const out: HTMLElement[] = [row];
    if (opened) {
      for (const { sel, key } of this.elementsOf(tag, doc)) {
        const el = document.createElement("div");
        el.className = `row ${sel.kind} tag-element`;
        el.setAttribute("role", "treeitem");
        el.style.paddingLeft = "26px";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = sel.kind === "attachment" ? sel.key : sel.name;
        const kind = document.createElement("span");
        kind.className = "note";
        kind.textContent = sel.kind === "attachment" ? `${sel.slot}` : sel.kind;
        el.append(icon(KIND_ICONS[sel.kind]), name, kind);
        el.dataset.key = key;
        el.addEventListener("click", () => {
          if (sel.kind === "skin") { this.session.skin = sel.name === "default" ? null : sel.name; }
          this.session.select(sel as Selection);
        });
        out.push(el);
      }
    }
    return out;
  }

  private small(text: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
    return b;
  }
}
