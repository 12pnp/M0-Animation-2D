import { type AttachmentRef, findAttachment } from "@/edit/attachments";
import { EditRefused, type Edit } from "@/edit/history";
import { addPathPoint, deletePathPoint, localOf, movePathPoint, movePathVertex, pathFrame, pathPositions, pointCount, runsAtConstantSpeed, setPathFlags, worldOf } from "@/edit/path";
import { attachmentType, type Skeleton } from "@/model/skeleton";
import type { Session } from "../session";
import { createPath } from "./pathCreate";

type Space = "local" | "world";

/**
 * The path window over the stage (docs/PATH-PLAN.md): for the selected path attachment, one vertex
 * at a time (◀ ▶ step through them, or click one on the stage), its X and Y to type, in the slot
 * bone's space (Local) or the skeleton's (World); add or delete a point; closed and constant speed.
 * Shown only while a path is selected, and editable on the setup pose.
 */
export class PathPanel {
  readonly element: HTMLElement;
  private space: Space = "local";
  private readonly title = document.createElement("span");
  private readonly which = document.createElement("span");
  private readonly x = document.createElement("input");
  private readonly y = document.createElement("input");
  private readonly spaceBtns: Record<Space, HTMLButtonElement>;
  private readonly prev = button("◀", "The previous vertex");
  private readonly next = button("▶", "The next vertex");
  private readonly add = button("+ Point", "Add a point after the last");
  private readonly del = button("Delete Point", "Delete the selected point, with its handles");
  private readonly closed = document.createElement("input");
  private readonly constant = document.createElement("input");
  private readonly note = document.createElement("p");
  private readonly create = button("+ New Path", "Add a path attachment on the selected slot (or on a new slot of the selected bone)");
  private readonly editing: HTMLElement[] = [];

  constructor(private readonly session: Session, private readonly status: (message: string) => void) {
    this.element = document.createElement("div");
    this.element.className = "group path-panel";
    this.spaceBtns = { local: button("Local", "Values in the slot bone's space"), world: button("World", "Values in the skeleton's space") };
    const head = row("head", this.title, this.spaceBtns.local, this.spaceBtns.world);
    const pick = row("pick", this.prev, this.which, this.next);
    for (const [input, name] of [[this.x, "X"], [this.y, "Y"]] as const) {
      input.inputMode = "decimal";
      input.spellcheck = false;
      input.setAttribute("aria-label", `Path vertex ${name}`);
      input.className = "cell";
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { this.update(); input.blur(); }
      });
      input.addEventListener("change", () => this.set());
    }
    const xy = row("xy", label("X", this.x), label("Y", this.y));
    const buttons = row("buttons", this.add, this.del);
    this.closed.type = this.constant.type = "checkbox";
    const flags = row("flags", flag("Closed", this.closed), flag("Constant speed", this.constant));
    this.note.className = "note";
    this.editing.push(this.spaceBtns.local, this.spaceBtns.world, pick, xy, buttons, flags);
    const make = row("make", this.create);
    this.element.append(head, pick, xy, buttons, flags, make, this.note);
    this.create.addEventListener("click", () => { const t = this.target(); if (t) this.status(createPath(this.session, t)); });
    for (const s of ["local", "world"] as const) this.spaceBtns[s].addEventListener("click", () => { this.space = s; this.update(); });
    this.prev.addEventListener("click", () => this.step(-1));
    this.next.addEventListener("click", () => this.step(1));
    this.add.addEventListener("click", () => this.addPoint());
    this.del.addEventListener("click", () => this.deletePoint());
    this.closed.addEventListener("change", () => this.flags({ closed: this.closed.checked }));
    this.constant.addEventListener("change", () => this.flags({ constantSpeed: this.constant.checked }));
    session.onChange(() => this.update());
    this.update();
  }

  /** The selected path, or null. */
  private ref(): AttachmentRef | null {
    const s = this.session, sel = s.selected, doc = s.doc;
    if (sel?.kind !== "attachment" || !doc) return null;
    const a = findAttachment(doc, sel);
    return a && attachmentType(a) === "path" && a.vertices && a.vertexCount !== undefined ? { skin: sel.skin, slot: sel.slot, key: sel.key } : null;
  }

  /** Where a new path would go: the selected slot (or the slot of the selected attachment), or the selected bone (a slot is made). */
  private target(): { slot?: string; bone?: string } | null {
    const sel = this.session.selected, doc = this.session.doc;
    if (!sel || !doc) return null;
    if (sel.kind === "slot") return { slot: sel.name };
    if (sel.kind === "attachment") return { slot: sel.slot };
    if (sel.kind === "bone") return { bone: sel.name };
    return null;
  }

  /** The vertex the window shows: the chosen one, else the first point. */
  private vertex(count: number): number {
    const v = this.session.pathVertex;
    return v !== null && v < count ? v : Math.min(1, Math.max(count - 1, 0));
  }

  private frame(doc: Skeleton, ref: AttachmentRef) {
    const a = findAttachment(doc, ref)!;
    try { return { a, f: pathFrame(doc, ref, a, this.session.setupBones() ?? undefined), reason: null as string | null }; } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      return { a, f: null, reason: err.message };
    }
  }

  private update(): void {
    const s = this.session, ref = this.ref(), doc = s.doc, target = this.target();
    this.element.hidden = !doc || (!ref && !target);
    if (!doc || (!ref && !target)) return;
    for (const e of this.editing) e.hidden = !ref;
    this.create.disabled = !target;
    if (!ref) {
      this.title.textContent = "Path";
      this.note.textContent = target!.slot ? `A new path goes on the slot ${target!.slot}.` : `A new path goes on a new slot of ${target!.bone}.`;
      this.note.hidden = false;
      return;
    }
    const { a, f, reason } = this.frame(doc, ref), count = a.vertexCount!, i = this.vertex(count);
    const editable = !s.animation && !reason;
    this.title.textContent = `Path · ${ref.key}`;
    for (const k of ["local", "world"] as const) this.spaceBtns[k].setAttribute("aria-pressed", String(this.space === k));
    const kind = i % 3 === 1 ? `Point ${Math.floor(i / 3) + 1} of ${pointCount(a)}` : `Handle ${i % 3 === 0 ? "in" : "out"} of point ${Math.floor(i / 3) + 1}`;
    this.which.textContent = `${kind}`;
    this.prev.disabled = i <= 0;
    this.next.disabled = i >= count - 1;
    let shown: [number, number] | null = null;
    if (f || !reason) {
      const pos = pathPositions(a, f);
      const lx = pos[i * 2], ly = pos[i * 2 + 1];
      if (lx !== undefined && ly !== undefined) shown = this.space === "world" && f ? worldOf(f, lx, ly) : [lx, ly];
    }
    for (const [input, v] of [[this.x, shown?.[0]], [this.y, shown?.[1]]] as const) {
      input.disabled = !editable || !shown;
      if (this.element.ownerDocument.activeElement !== input) input.value = v === undefined ? "" : String(Math.round(v * 100) / 100);
    }
    this.add.disabled = !editable;
    this.del.disabled = !editable || pointCount(a) <= 2;
    this.closed.checked = !!a.closed;
    this.constant.checked = runsAtConstantSpeed(a);
    this.closed.disabled = this.constant.disabled = !editable;
    this.note.textContent = s.animation ? "Paths are edited on the setup pose: choose Pose." : reason ?? "";
    this.note.hidden = !this.note.textContent;
  }

  private step(by: number): void {
    const ref = this.ref(), doc = this.session.doc;
    if (!ref || !doc) return;
    const count = findAttachment(doc, ref)!.vertexCount!;
    this.session.pathVertex = Math.min(count - 1, Math.max(0, this.vertex(count) + by));
    this.session.changed();
  }

  private apply(label: string, edit: Edit<Skeleton>): boolean {
    const h = this.session.history;
    if (!h) return false;
    try {
      const ok = h.apply(label, edit);
      this.session.changed();
      return ok;
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.status(err.message);
      this.update();
      return false;
    }
  }

  /** The typed X and Y, in the chosen space, for the shown vertex. */
  private set(): void {
    const ref = this.ref(), doc = this.session.doc;
    if (!ref || !doc) return;
    const x = Number(this.x.value), y = Number(this.y.value);
    if (this.x.value.trim() === "" || this.y.value.trim() === "" || !Number.isFinite(x) || !Number.isFinite(y)) { this.update(); return; }
    const { a, f } = this.frame(doc, ref), i = this.vertex(a.vertexCount!), bones = this.session.setupBones() ?? undefined;
    const [lx, ly] = this.space === "world" && f ? localOf(f, x, y) : [x, y];
    this.apply(i % 3 === 1 ? `Move point ${Math.floor(i / 3)} of ${ref.key}` : `Move handle ${i} of ${ref.key}`,
      i % 3 === 1 ? movePathPoint(ref, Math.floor(i / 3), lx, ly, bones) : movePathVertex(ref, i, lx, ly, bones));
    this.session.pathVertex = i;
  }

  private addPoint(): void {
    const ref = this.ref(), doc = this.session.doc;
    if (!ref || !doc) return;
    const { a, f } = this.frame(doc, ref), n = pointCount(a), pos = pathPositions(a, f), last = n ? [pos[(n * 3 - 2) * 2]!, pos[(n * 3 - 2) * 2 + 1]!] : [0, 0];
    if (this.apply(`Add a point to ${ref.key}`, addPathPoint(ref, last[0]! + 60, last[1]!, this.session.setupBones() ?? undefined))) this.session.pathVertex = n * 3 + 1;
    this.session.changed();
  }

  private deletePoint(): void {
    const ref = this.ref(), doc = this.session.doc;
    if (!ref || !doc) return;
    const i = this.vertex(findAttachment(doc, ref)!.vertexCount!);
    if (this.apply(`Delete point ${Math.floor(i / 3)} of ${ref.key}`, deletePathPoint(ref, Math.floor(i / 3), this.session.setupBones() ?? undefined))) this.session.pathVertex = null;
    this.session.changed();
  }

  private flags(f: { closed?: boolean; constantSpeed?: boolean }): void {
    const ref = this.ref();
    if (!ref) return;
    this.apply(`Set ${f.closed !== undefined ? (f.closed ? "closed" : "open") : f.constantSpeed ? "constant speed" : "no constant speed"} on ${ref.key}`, setPathFlags(ref, f, this.session.setupBones() ?? undefined));
  }
}

function button(text: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  return b;
}

function row(className: string, ...children: HTMLElement[]): HTMLDivElement {
  const r = document.createElement("div");
  r.className = `p-row ${className}`;
  r.append(...children);
  return r;
}

function label(text: string, input: HTMLInputElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.append(Object.assign(document.createElement("span"), { textContent: text }), input);
  return l;
}

function flag(text: string, box: HTMLInputElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.className = "flag";
  l.append(box, Object.assign(document.createElement("span"), { textContent: text }));
  return l;
}
