import { type Tagged, tagCounts } from "@/edit/tags";
import type { Session } from "./session";

/**
 * The tags of one element (docs/TAGS-PLAN.md), in a small popup beside a point: its tags as chips with ×, and a field to add more
 * (commas between several; the tags already used elsewhere are suggested). Enter adds, Escape or a click away closes. Only one is open.
 */
let open: { close: () => void } | null = null;

/** A short name for the element, for the popup's title. */
export function taggedName(t: Tagged): string {
  return t.kind === "attachment" ? t.key : t.name;
}

export function openTags(session: Session, target: Tagged, at: { x: number; y: number }, host: HTMLElement = document.body): void {
  open?.close();
  const doc = host.ownerDocument, pop = doc.createElement("div");
  pop.className = "tags-popup";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Tags");
  const title = doc.createElement("div");
  title.className = "title";
  title.textContent = `Tags · ${taggedName(target)}`;
  const chips = doc.createElement("div");
  chips.className = "tag-chips";
  const input = doc.createElement("input");
  input.type = "text";
  input.placeholder = "Add a tag (commas for several)";
  input.setAttribute("aria-label", "Add a tag");
  input.spellcheck = false;
  const list = doc.createElement("datalist");
  list.id = `tag-suggest-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("list", list.id);
  pop.append(title, chips, input, list);

  const draw = (): void => {
    chips.replaceChildren(...session.tagsOn(target).map((tag) => tagChip(doc, tag, () => session.removeTag(target, tag))));
    if (!chips.childElementCount) { const none = doc.createElement("span"); none.className = "none"; none.textContent = "No tags yet."; chips.append(none); }
    const mine = new Set(session.tagsOn(target).map((x) => x.toLowerCase()));
    list.replaceChildren(...tagCounts(session.sidecar).filter((c) => !mine.has(c.tag.toLowerCase())).map((c) => Object.assign(doc.createElement("option"), { value: c.tag })));
  };
  const off = session.onChange(draw);
  draw();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (input.value.trim()) session.addTags(target, input.value); input.value = ""; }
    else if (e.key === "Backspace" && !input.value) { const mine = session.tagsOn(target); if (mine.length) session.removeTag(target, mine[mine.length - 1]!); }
  });
  const key = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const outside = (e: Event): void => { if (!pop.contains(e.target as Node)) close(); };
  const close = (): void => {
    off();
    pop.remove();
    doc.removeEventListener("keydown", key, true);
    doc.removeEventListener("pointerdown", outside, true);
    if (open?.close === close) open = null;
  };
  host.append(pop);
  const win = doc.defaultView ?? window;
  pop.style.left = `${Math.max(4, Math.min(at.x, win.innerWidth - pop.offsetWidth - 4))}px`;
  pop.style.top = `${Math.max(4, Math.min(at.y, win.innerHeight - pop.offsetHeight - 4))}px`;
  setTimeout(() => doc.addEventListener("pointerdown", outside, true));
  doc.addEventListener("keydown", key, true);
  open = { close };
  input.focus();
}

/** A tag as a small chip; with `onRemove`, a × that takes it off. */
export function tagChip(doc: Document, tag: string, onRemove?: () => void): HTMLElement {
  const chip = doc.createElement("span");
  chip.className = "tag-chip";
  chip.textContent = tag;
  if (onRemove) {
    const x = doc.createElement("button");
    x.type = "button";
    x.className = "tag-x";
    x.textContent = "×";
    x.title = `Remove the tag ${tag}`;
    x.setAttribute("aria-label", `Remove the tag ${tag}`);
    x.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    chip.append(x);
  }
  return chip;
}
