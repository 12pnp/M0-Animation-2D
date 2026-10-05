import { addRegion, deleteAttachment } from "@/edit/attachments";
import { addBone, deleteBone } from "@/edit/bones";
import { type Edit, EditRefused } from "@/edit/history";
import { addSkin, deleteSkin, duplicateSkin } from "@/edit/skins";
import { addSlot, deleteSlot, moveSlot, updateSlot } from "@/edit/slots";
import type { Skeleton } from "@/model/skeleton";
import { type Selection, sameSelection, type Session } from "../session";

type View = "tree" | "order" | "skins";

/** One row of the rig tree. */
interface Item { readonly sel: Selection; readonly label: string; readonly depth: number; readonly kind: "bone" | "slot" | "attachment" | "skin"; readonly toggle?: string; readonly open?: boolean; readonly note?: string }

/**
 * The rig: bones as a tree, each with its slots, each slot with its attachments (the shown skin's
 * and the default skin's). Add a bone, a slot or a region from the atlas; delete what is
 * selected. The draw order view lists the slots front to back and moves them.
 */
export class Outline {
  readonly element: HTMLDivElement;
  onStatus: (message: string) => void = () => {};
  private view: View = "tree";
  /** Bones folded shut, and slots opened to show their attachments. */
  private readonly closed = new Set<string>();
  private readonly opened = new Set<string>();
  private rendered = "";
  private readonly rows = new Map<string, HTMLElement>();
  private readonly list: HTMLDivElement;
  private readonly regionPick: HTMLSelectElement;
  private readonly buttons: Record<"bone" | "slot" | "region" | "del" | "up" | "down" | "tree" | "order" | "skins" | "skin" | "dup", HTMLButtonElement>;

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel outline";
    const bar = document.createElement("div");
    bar.className = "outline-bar";
    this.regionPick = document.createElement("select");
    this.regionPick.title = "The atlas region + Region adds";
    this.buttons = {
      tree: button("Tree", "Bones, slots and attachments", () => this.setView("tree")),
      order: button("Draw order", "Slots front to back", () => this.setView("order")),
      skins: button("Skins", "The skins; choosing one shows it", () => this.setView("skins")),
      skin: button("+ Skin", "Add an empty skin", () => this.addSkin()),
      dup: button("Duplicate", "Copy the selected skin", () => this.duplicateSkin()),
      bone: button("+ Bone", "Add a bone under the selected one", () => this.addBone()),
      slot: button("+ Slot", "Add a slot on the selected bone", () => this.addSlot()),
      region: button("+ Region", "Add the chosen atlas region to the selected slot (or a new slot on the selected bone)", () => { if (this.regionPick.value) this.addRegion(this.regionPick.value); }),
      del: button("Delete", "Delete what is selected (Undo brings it back)", () => this.deleteSelected()),
      up: button("↑", "Bring the selected slot forward", () => this.moveSelected(1)),
      down: button("↓", "Send the selected slot back", () => this.moveSelected(-1)),
    };
    bar.append(this.buttons.tree, this.buttons.order, this.buttons.skins, sep(), this.buttons.bone, this.buttons.slot, this.buttons.region, this.regionPick,
      this.buttons.skin, this.buttons.dup, this.buttons.del, this.buttons.up, this.buttons.down);
    this.list = document.createElement("div");
    this.list.className = "rows";
    this.list.setAttribute("role", "tree");
    this.element.append(bar, this.list);
    session.onChange(() => this.update());
    this.update();
  }

  /** Delete what is selected: the rig panel's Delete. */
  deleteSelected(): void {
    const sel = this.session.selected;
    if (!sel) return;
    const edit = sel.kind === "bone" ? deleteBone(sel.name) : sel.kind === "slot" ? deleteSlot(sel.name) : sel.kind === "skin" ? deleteSkin(sel.name) : deleteAttachment(sel);
    const label = sel.kind === "attachment" ? `Delete attachment ${sel.key}` : `Delete ${sel.kind} ${sel.name}`;
    if (this.apply(label, edit)) {
      if (sel.kind === "skin" && this.session.skin === sel.name) this.session.skin = null;
      this.session.select(null);
    }
  }

  private setView(v: View): void { this.view = v; this.rendered = ""; this.update(); }

  private apply(label: string, edit: Edit<Skeleton>): boolean {
    const h = this.session.history;
    if (!h) return false;
    try {
      const ok = h.apply(label, edit);
      this.session.changed();
      return ok;
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return false;
    }
  }

  /** The bone the selection is on: the bone, a slot's bone, an attachment's slot's bone. */
  private selectedBoneOrOwner(): string | null {
    const sel = this.session.selected, doc = this.session.doc;
    if (!sel || !doc || sel.kind === "skin") return null;
    if (sel.kind === "bone") return sel.name;
    const slot = sel.kind === "slot" ? sel.name : sel.slot;
    return doc.slots?.find((x) => x.name === slot)?.bone ?? null;
  }

  private addBone(): void {
    const doc = this.session.doc;
    if (!doc) return;
    const parent = doc.bones?.length ? this.selectedBoneOrOwner() ?? doc.bones[0]!.name : null;
    const name = prompt(parent ? `Name of the new bone under "${parent}":` : "Name of the root bone:", unique("bone", (doc.bones ?? []).map((b) => b.name)))?.trim();
    if (!name) return;
    if (this.apply(`Add bone ${name}`, addBone(name, parent))) this.session.select({ kind: "bone", name });
  }

  private addSkin(): void {
    const doc = this.session.doc;
    if (!doc) return;
    const name = prompt("Name of the new skin:", unique("skin", (doc.skins ?? []).map((k) => k.name)))?.trim();
    if (!name) return;
    if (this.apply(`Add skin ${name}`, addSkin(name))) this.showSkin(name);
  }

  private duplicateSkin(): void {
    const doc = this.session.doc, sel = this.session.selected;
    if (!doc || sel?.kind !== "skin") { this.onStatus("Select the skin to copy."); return; }
    const name = prompt(`Name of the copy of "${sel.name}":`, unique(`${sel.name} copy`, (doc.skins ?? []).map((k) => k.name)))?.trim();
    if (!name) return;
    if (this.apply(`Duplicate skin ${sel.name} as ${name}`, duplicateSkin(sel.name, name))) this.showSkin(name);
  }

  /** Select a skin and show it on the stage (the default skin: no other skin shown). */
  private showSkin(name: string): void {
    this.session.skin = name === "default" ? null : name;
    this.session.select({ kind: "skin", name });
  }

  private addSlot(): void {
    const doc = this.session.doc, bone = this.selectedBoneOrOwner();
    if (!doc) return;
    if (!bone) { this.onStatus("Select the bone the slot goes on."); return; }
    const name = prompt(`Name of the new slot on "${bone}":`, unique(bone, (doc.slots ?? []).map((x) => x.name)))?.trim();
    if (!name) return;
    if (this.apply(`Add slot ${name}`, addSlot(name, bone))) this.session.select({ kind: "slot", name });
  }

  /** Add the atlas region `region` to the selected slot, or to a new slot on the selected bone. */
  private addRegion(region: string): void {
    const s = this.session, doc = s.doc, sel = s.selected;
    const img = s.images.regions.find((r) => r.name === region);
    if (!doc || !img) return;
    let slot = sel?.kind === "slot" ? sel.name : sel?.kind === "attachment" ? sel.slot : null;
    const bone = this.selectedBoneOrOwner();
    if (!slot && !bone) { this.onStatus("Select a slot, or the bone a new slot should go on."); return; }
    const edits: Edit<Skeleton>[] = [];
    if (!slot) {
      slot = unique(region, (doc.slots ?? []).map((x) => x.name));
      edits.push(addSlot(slot, bone!));
    }
    // New regions go in the shown skin (the default one when none is shown).
    const skin = s.skin ?? "default", taken = (doc.skins ?? []).flatMap((k) => k.attachments ?? []).filter((ss) => ss.slot === slot).flatMap((ss) => ss.entries.map((e) => e.key));
    const key = unique(region, taken);
    // The region's original size; its key names the image unless it had to be made unique.
    edits.push(addRegion({ skin, slot, key }, { width: img.originalWidth, height: img.originalHeight, ...(key !== region ? { path: region } : {}) }));
    const s0 = doc.slots?.find((x) => x.name === slot);
    // A slot that showed nothing shows the new region.
    if (!s0?.attachment) edits.push(updateSlot(slot, { attachment: key }));
    const target = slot;
    if (this.apply(`Add region ${region} to ${slot}`, (d) => edits.reduce((acc, e) => e(acc), d))) s.select({ kind: "attachment", skin, slot: target, key });
  }

  private moveSelected(by: number): void {
    const sel = this.session.selected, doc = this.session.doc;
    const slot = sel?.kind === "slot" ? sel.name : sel?.kind === "attachment" ? sel.slot : null;
    if (!slot || !doc) { this.onStatus("Select a slot to move it in the draw order."); return; }
    const i = (doc.slots ?? []).findIndex((x) => x.name === slot);
    this.apply(`${by > 0 ? "Bring" : "Send"} ${slot} ${by > 0 ? "forward" : "back"}`, moveSlot(slot, i + by));
  }

  private items(doc: Skeleton): Item[] {
    const s = this.session, out: Item[] = [];
    const slots = doc.slots ?? [];
    if (this.view === "skins") {
      return (doc.skins ?? []).map((k): Item => ({
        sel: { kind: "skin", name: k.name }, label: k.name, depth: 0, kind: "skin",
        note: [(s.skin ?? "default") === k.name ? "shown" : "", k.bones?.length ? `${k.bones.length} bones` : ""].filter(Boolean).join(" · "),
      }));
    }
    if (this.view === "order") {
      return [...slots].reverse().map((x): Item => ({ sel: { kind: "slot", name: x.name }, label: x.name, depth: 0, kind: "slot", note: x.bone }));
    }
    const skins = [s.skin, "default"].filter((k, i, a): k is string => k !== null && a.indexOf(k) === i);
    const children = new Map<string, string[]>();
    for (const b of doc.bones ?? []) if (b.parent !== undefined) children.set(b.parent, [...(children.get(b.parent) ?? []), b.name]);
    const walk = (bone: string, depth: number) => {
      const mine = slots.filter((x) => x.bone === bone);
      const kids = children.get(bone) ?? [];
      const id = `bone/${bone}`, open = !this.closed.has(id);
      out.push({ sel: { kind: "bone", name: bone }, label: bone, depth, kind: "bone", ...(mine.length || kids.length ? { toggle: id, open } : {}) });
      if (!open) return;
      for (const slot of mine) {
        const entries = skins.flatMap((skin) => (doc.skins?.find((k) => k.name === skin)?.attachments?.find((ss) => ss.slot === slot.name)?.entries ?? []).map((e) => ({ skin, key: e.key })));
        const sid = `slot/${slot.name}`, sopen = this.opened.has(sid) || (s.selected?.kind === "attachment" && s.selected.slot === slot.name);
        out.push({ sel: { kind: "slot", name: slot.name }, label: slot.name, depth: depth + 1, kind: "slot", ...(entries.length ? { toggle: sid, open: sopen } : {}) });
        if (sopen) {
          for (const e of entries) {
            out.push({
              sel: { kind: "attachment", skin: e.skin, slot: slot.name, key: e.key }, label: e.key, depth: depth + 2, kind: "attachment",
              note: [e.key === slot.attachment ? "shown" : "", e.skin !== "default" ? e.skin : ""].filter(Boolean).join(" · "),
            });
          }
        }
      }
      for (const k of kids) walk(k, depth + 1);
    };
    for (const b of doc.bones ?? []) if (b.parent === undefined) walk(b.name, 0);
    return out;
  }

  private update(): void {
    const s = this.session, doc = s.doc;
    const sig = JSON.stringify([this.view, s.skin, [...this.closed], [...this.opened], s.selected?.kind === "attachment" ? s.selected.slot : null]);
    const key = doc ? `${s.history!.revision}|${sig}` : "none";
    if (key !== this.rendered) {
      this.rendered = key;
      this.rows.clear();
      if (!doc) this.list.replaceChildren(empty("Open a skeleton to see its rig."));
      else {
        const items = this.items(doc);
        this.list.replaceChildren(...items.map((it) => this.row(it)));
        if (!items.length) this.list.append(empty(this.view === "order" ? "No slots yet." : "No bones yet: + Bone adds the root."));
      }
      const regions = [...new Set(s.images.regions.map((r) => r.name))], chosen = this.regionPick.value;
      this.regionPick.replaceChildren(...(regions.length ? regions.map((n) => new Option(n, n)) : [new Option("no atlas", "")]));
      if (regions.includes(chosen)) this.regionPick.value = chosen;
    }
    for (const [id, row] of this.rows) {
      const on = s.selected !== null && id === JSON.stringify(s.selected);
      if (row.classList.contains("selected") !== on) {
        row.classList.toggle("selected", on);
        row.setAttribute("aria-selected", String(on));
        if (on) row.scrollIntoView({ block: "nearest" });
      }
    }
    const sel = s.selected, slotSel = sel?.kind === "slot" || sel?.kind === "attachment";
    const v = this.view;
    for (const k of ["bone", "slot", "region"] as const) this.buttons[k].hidden = v === "skins";
    this.regionPick.hidden = v === "skins";
    this.buttons.skin.hidden = this.buttons.dup.hidden = v !== "skins";
    this.buttons.skin.disabled = !doc;
    this.buttons.dup.disabled = sel?.kind !== "skin";
    this.buttons.skins.setAttribute("aria-pressed", String(v === "skins"));
    this.buttons.bone.disabled = !doc;
    this.buttons.slot.disabled = !doc || !this.selectedBoneOrOwner();
    this.regionPick.disabled = !doc || !s.images.regions.length;
    this.buttons.region.disabled = !doc || !s.images.regions.length || !sel;
    this.buttons.del.disabled = !sel;
    this.buttons.up.hidden = this.buttons.down.hidden = this.view !== "order";
    this.buttons.up.disabled = this.buttons.down.disabled = !slotSel;
    this.buttons.tree.setAttribute("aria-pressed", String(this.view === "tree"));
    this.buttons.order.setAttribute("aria-pressed", String(this.view === "order"));
  }

  private row(it: Item): HTMLElement {
    const row = document.createElement("div");
    row.className = `row ${it.kind}`;
    row.setAttribute("role", "treeitem");
    row.style.paddingLeft = `${6 + it.depth * 14}px`;
    if (it.toggle) {
      row.setAttribute("aria-expanded", String(!!it.open));
      const t = button(it.open ? "▾" : "▸", it.open ? "Fold" : "Unfold", () => {
        const id = it.toggle!;
        if (it.kind === "bone") { if (this.closed.has(id)) this.closed.delete(id); else this.closed.add(id); }
        else if (this.opened.has(id)) this.opened.delete(id); else this.opened.add(id);
        this.update();
      });
      t.className = "twisty";
      row.append(t);
    } else {
      const pad = document.createElement("span");
      pad.className = "twisty-gap";
      row.append(pad);
    }
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.label;
    row.append(name);
    if (it.note) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = it.note;
      row.append(note);
    }
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("twisty")) return;
      if (it.sel.kind === "skin") { this.showSkin(it.sel.name); return; }
      if (!sameSelection(this.session.selected, it.sel)) this.session.select(it.sel);
    });
    this.rows.set(JSON.stringify(it.sel), row);
    return row;
  }
}

/** `base`, or `base2`, `base3`… whichever is not taken. */
export function unique(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}${i}`)) return `${base}${i}`;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function sep(): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "sep";
  return s;
}

export function heading(text: string): HTMLHeadingElement {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}

export function empty(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}
