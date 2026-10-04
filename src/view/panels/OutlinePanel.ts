import { clear, cls, h, on } from "@/view/widgets/dom";
import { icon, type IconName } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import type { NodeId } from "@/core/doc/ids";
import { RenameNode, SetLayerFlag, SetParent } from "@/core/history/commands";
import { mayReparent } from "@/view/widgets/ikReparentGuard";
import { isSymbol, type Layer } from "@/core/doc/types";
import { ikRoles } from "@/core/doc/ikGraph";
import { lineColorIndex } from "@/core/doc/treeLines";
import {
  type OutlineRow, type OutlineShow, ancestorsOf, canDropOn, outlineRows, rowRange,
} from "@/core/doc/outlineTree";

/**
 * The node hierarchy, as Spine's Tree: search, filters by kind, open and
 * close branches, lines joining a row to its parent, show / lock per row, IK
 * badges, rename in place, keyboard walking, and drag to re-parent (onto the
 * symbol's own row to move a node to the top level).
 *
 * Which rows show is decided in `core/doc/outlineTree.ts`. A selection change
 * only restyles the rows: rebuilding them between the two clicks of a
 * double-click would swallow it (the DOM trap in ARCHITECTURE.md).
 *
 * Two panels are built from it: the Tree (id `outline`, kept from when it was
 * called Outline, so stored layouts still find it) and the Sub Tree, which
 * shows only the node last selected elsewhere — in the Tree, on the stage —
 * and what hangs under it. A selection made in the Sub Tree itself does not
 * re-root it, or every click would replace the list under the pointer.
 */
export class OutlinePanel implements Panel {
  readonly id: string;
  readonly title: string;
  readonly icon: "outlinePanel" | "subtree";
  readonly el: HTMLElement;

  /** The Sub Tree's node; null in the Tree. */
  private subRoot: NodeId | null = null;
  /** True while a selection made here is being applied. */
  private own = false;

  private list: HTMLElement;
  private search: HTMLInputElement;
  private filterButtons: Record<keyof OutlineShow, HTMLElement>;
  private query = "";
  private show: OutlineShow = { bones: true, images: true };
  /** Closed branches, per symbol, for the session. */
  private collapsed = new Map<string, Set<NodeId>>();
  private rows: OutlineRow[] = [];
  private rowEls = new Map<NodeId, HTMLElement>();
  /** Where a Shift-click range starts. */
  private anchor: NodeId | null = null;
  private dragId: NodeId | null = null;
  private renaming: NodeId | null = null;

  constructor(private readonly store: Store, private readonly mode: "tree" | "subtree" = "tree") {
    this.id = mode === "tree" ? "outline" : "subtree";
    this.title = mode === "tree" ? "Tree" : "Sub Tree";
    this.icon = mode === "tree" ? "outlinePanel" : "subtree";
    this.search = h("input", { type: "search", class: "otree-search", placeholder: "Search", spellcheck: false }) as HTMLInputElement;
    on(this.search, "input", () => { this.query = this.search.value; this.render(); });
    on(this.search, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      if (e.key === "Escape" && this.search.value) { this.search.value = ""; this.query = ""; this.render(); e.stopPropagation(); }
    });

    const tool = (name: IconName, title: string, run: () => void) => {
      const b = h("button", { class: "otree-btn", title });
      b.appendChild(icon(name, 13));
      on(b, "click", run);
      return b;
    };
    this.filterButtons = {
      bones: tool("bone", "Show bones", () => this.toggleShow("bones")),
      images: tool("imageItem", "Show images and symbols", () => this.toggleShow("images")),
    };
    const bar = h("div", { class: "otree-bar" },
      this.search,
      h("div", { class: "otree-group" }, this.filterButtons.bones, this.filterButtons.images),
      h("div", { class: "otree-group" },
        tool("fit", "Show the selection: open its branches and scroll to it", () => this.reveal(true)),
        tool("expandAll", "Expand all", () => this.setAll(true)),
        tool("collapseAll", "Collapse all", () => this.setAll(false))),
    );

    this.list = h("div", { class: "otree-list", tabIndex: 0 });
    on(this.list, "keydown", (ev) => this.onKey(ev as unknown as KeyboardEvent));
    this.el = h("div", { class: "outline otree" }, bar, this.list);

    store.subscribe((t) => {
      if (t === "doc" || t === "timeline") this.render();
      else if (t === "selection") {
        const sel = this.store.selection.nodes;
        if (this.mode === "subtree" && !this.own && sel.length) {
          this.subRoot = sel[sel.length - 1]!;
          this.render();
        } else this.syncSelection();
      }
    });
    this.render();
  }

  // ── Rows ───────────────────────────────────────────────────────────────

  private get closed(): Set<NodeId> {
    const key = this.store.currentSymbolId;
    let s = this.collapsed.get(key);
    if (!s) { s = new Set(); this.collapsed.set(key, s); }
    return s;
  }

  private render(): void {
    if (this.renaming) return;
    cls(this.filterButtons.bones, "on", this.show.bones);
    cls(this.filterButtons.images, "on", this.show.images);
    clear(this.list);
    this.rowEls.clear();
    const sym = this.store.currentSymbol;
    if (sym.layers.length === 0) {
      this.rows = [];
      this.list.appendChild(h("div", { class: "empty" }, "No objects on stage"));
      return;
    }
    const sub = this.mode === "subtree";
    if (sub && (!this.subRoot || !sym.nodes[this.subRoot])) {
      this.rows = [];
      this.list.appendChild(h("div", { class: "empty" }, "Select a node in the Tree to see it and its children here."));
      return;
    }
    this.rows = outlineRows(sym, { collapsed: this.closed, query: this.query, show: this.show, root: sub ? this.subRoot : null });
    const layerOf = new Map<NodeId, Layer>(sym.layers.map((l) => [l.nodeId, l]));
    const { targets, driven } = ikRoles(sym);
    const ikName = new Map<NodeId, string>(sym.ik.map((k) => [k.targetId, k.name]));

    if (!sub) this.list.appendChild(this.rootRow());
    for (const r of this.rows) {
      const el = this.rowFor(r, layerOf.get(r.id), targets.has(r.id), driven.has(r.id), ikName.get(r.id));
      this.rowEls.set(r.id, el);
      this.list.appendChild(el);
    }
    if (this.query && this.rows.length === 0) {
      this.list.appendChild(h("div", { class: "empty" }, `Nothing named “${this.query.trim()}”`));
    }
    this.syncSelection();
  }

  /** The symbol itself: drop a row here to move it to the top level. */
  private rootRow(): HTMLElement {
    const sym = this.store.currentSymbol;
    const row = h("div", { class: "otree-row otree-root", title: "Drop a row here to move it to the top level" },
      h("span", { class: "otree-cell" }), h("span", { class: "otree-cell" }),
      h("span", { class: "ico" }, icon("scene", 12)),
      h("span", { class: "otree-name" }, sym.name));
    on(row, "click", () => this.store.clearSelection());
    this.dropTarget(row, null);
    return row;
  }

  private rowFor(
    r: OutlineRow, layer: Layer | undefined, isTarget: boolean, isDriven: boolean, ikName?: string,
  ): HTMLElement {
    const sym = this.store.currentSymbol;
    const node = sym.nodes[r.id]!;
    const item = node.itemId ? this.store.project.items[node.itemId] : undefined;
    const kindIcon: IconName = node.kind === "bone"
      ? (isTarget ? "ikTarget" : "bone")
      : isSymbol(item) ? "symbolItem" : "imageItem";

    const guides = h("span", { class: "tguides" },
      ...r.guides.map((on, j) => h("span", { class: `tguide d${lineColorIndex(j)}${on ? " on" : ""}` })),
      // The Sub Tree's top row has nothing above it to join.
      ...(this.mode === "subtree" && r.depth === 0 ? []
        : [h("span", { class: `telbow d${lineColorIndex(r.depth)}${r.last ? " last" : ""}` })]));

    const tri = h("span", { class: `otree-tri${r.hasChildren ? (r.open ? " open" : "") : " leaf"}` });
    on(tri, "click", (ev) => {
      ev.stopPropagation();
      if (!r.hasChildren || this.query) return;
      // Alt opens or closes the whole branch, as in most trees.
      const ids = (ev as unknown as MouseEvent).altKey ? [r.id, ...this.descendants(r.id)] : [r.id];
      const close = r.open;
      for (const id of ids) { if (close) this.closed.add(id); else this.closed.delete(id); }
      this.render();
    });

    const name = h("span", { class: "otree-name" }, ...highlight(node.name, r.match ? this.query.trim() : ""));
    const badges = h("span", { class: "otree-badges" });
    if (isTarget) badges.appendChild(badge("ik", `IK target of “${ikName ?? ""}”`));
    if (isDriven) badges.appendChild(badge("link", "Solved by IK"));

    const row = h("div", {
      class: `otree-row kind-${node.kind}${isDriven ? " driven" : ""}${isTarget ? " target" : ""}`,
      draggable: true,
    },
      this.flagCell(layer, "visible"),
      this.flagCell(layer, "locked"),
      guides, tri,
      h("span", { class: "ico" }, icon(kindIcon, 12)),
      name, badges,
    );
    if (layer && !layer.visible) row.classList.add("hidden-layer");

    on(row, "click", (ev) => this.click(r.id, ev as unknown as MouseEvent));
    on(name, "dblclick", (ev) => { ev.stopPropagation(); this.rename(r.id, name); });
    on(row, "dragstart", () => { this.dragId = r.id; });
    on(row, "dragend", () => { this.dragId = null; });
    this.dropTarget(row, r.id);
    return row;
  }

  private flagCell(layer: Layer | undefined, flag: "visible" | "locked"): HTMLElement {
    const exceptional = !!layer && (flag === "visible" ? !layer.visible : layer.locked);
    const cell = h("span", {
      class: `otree-cell${exceptional ? " on" : ""}`,
      title: flag === "visible" ? (exceptional ? "Hidden. Click to show." : "Hide") : (exceptional ? "Locked. Click to unlock." : "Lock"),
    });
    cell.appendChild(icon(flag === "visible" ? (exceptional ? "eyeOff" : "eye") : "lock", 11));
    on(cell, "click", (ev) => {
      ev.stopPropagation();
      if (!layer) return;
      const next = flag === "visible" ? !layer.visible : !layer.locked;
      this.store.apply(new SetLayerFlag(this.store.currentSymbolId, layer.id, flag, next));
      this.store.emit("timeline");
      this.store.emit("stage");
    });
    return cell;
  }

  private dropTarget(row: HTMLElement, target: NodeId | null): void {
    on(row, "dragover", (e) => {
      if (!this.dragId || !canDropOn(this.store.currentSymbol, this.dragId, target)) return;
      e.preventDefault();
      row.classList.add("drop");
    });
    on(row, "dragleave", () => row.classList.remove("drop"));
    on(row, "drop", (e) => {
      e.preventDefault();
      row.classList.remove("drop");
      const id = this.dragId;
      this.dragId = null;
      if (!id || !canDropOn(this.store.currentSymbol, id, target) || !mayReparent(this.store, [id])) return;
      if (target) this.closed.delete(target);
      this.store.apply(new SetParent(this.store.currentSymbolId, [id], target));
      this.store.emit("doc");
    });
  }

  // ── Selection ──────────────────────────────────────────────────────────

  private click(id: NodeId, e: MouseEvent): void {
    this.list.focus({ preventScroll: true });
    if (e.shiftKey && this.anchor) {
      this.select(rowRange(this.rows, this.anchor, id));
      return;
    }
    if (e.metaKey || e.ctrlKey) this.mine(() => this.store.toggleNode(id));
    else this.select([id]);
    this.anchor = id;
  }

  /** A selection made from this panel: the Sub Tree keeps its root. */
  private mine(run: () => void): void {
    this.own = true;
    try { run(); } finally { this.own = false; }
  }

  private select(ids: NodeId[]): void { this.mine(() => this.store.selectNodes(ids)); }

  private syncSelection(): void {
    const sel = new Set(this.store.selection.nodes);
    for (const [id, el] of this.rowEls) cls(el, "selected", sel.has(id));
    this.reveal(false);
  }

  /** Open the branches above the selection; scroll its first row into view.
   *  `force` also clears a search that hides it (the Show Selection button). */
  private reveal(force: boolean): void {
    const sel = this.store.selection.nodes;
    if (sel.length === 0) return;
    const sym = this.store.currentSymbol;
    if (force && this.query && !sel.some((id) => this.rowEls.has(id))) {
      this.search.value = ""; this.query = "";
    }
    let opened = false;
    for (const id of sel) {
      for (const a of ancestorsOf(sym, id)) if (this.closed.delete(a)) opened = true;
    }
    if (opened || (force && !this.rowEls.has(sel[0]!))) { this.render(); return; }
    this.rowEls.get(sel[sel.length - 1]!)?.scrollIntoView({ block: "nearest" });
  }

  private toggleShow(kind: keyof OutlineShow): void {
    this.show = { ...this.show, [kind]: !this.show[kind] };
    // At least one kind stays: an Outline showing nothing looks broken.
    if (!this.show.bones && !this.show.images) this.show = { ...this.show, [kind === "bones" ? "images" : "bones"]: true };
    this.render();
  }

  private setAll(open: boolean): void {
    const sym = this.store.currentSymbol;
    if (open) this.closed.clear();
    else for (const n of Object.values(sym.nodes)) this.closed.add(n.id);
    this.render();
  }

  private descendants(id: NodeId): NodeId[] {
    const sym = this.store.currentSymbol;
    return Object.values(sym.nodes).filter((n) => ancestorsOf(sym, n.id).includes(id)).map((n) => n.id);
  }

  // ── Rename and keys ────────────────────────────────────────────────────

  private rename(id: NodeId, nameEl: HTMLElement): void {
    const node = this.store.currentSymbol.nodes[id];
    if (!node) return;
    this.renaming = id;
    const input = h("input", { type: "text", class: "otree-rename", value: node.name, spellcheck: false }) as HTMLInputElement;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.renaming = null;
      const next = input.value.trim();
      if (commit && next && next !== node.name) {
        this.store.apply(new RenameNode(this.store.currentSymbolId, id, next));
        this.store.emit("doc");
      } else {
        this.render();
      }
      this.list.focus({ preventScroll: true });
    };
    on(input, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    on(input, "blur", () => finish(true));
    on(input, "click", (e) => e.stopPropagation());
  }

  /** Arrows walk the rows, Left / Right close and open, F2 or Enter renames.
   *  The keys handled here stop here, as in the Library, so the stage never
   *  sees them. */
  private onKey(e: KeyboardEvent): void {
    if (this.renaming || this.rows.length === 0) return;
    const sel = this.store.selection.nodes;
    const at = sel.length ? this.rows.findIndex((r) => r.id === sel[sel.length - 1]) : -1;
    const row = at >= 0 ? this.rows[at]! : null;
    const select = (i: number) => {
      const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, i))]!;
      this.select([r.id]);
      this.anchor = r.id;
    };
    let handled = true;
    switch (e.key) {
      case "ArrowDown": select(at + 1); break;
      case "ArrowUp": select(at < 0 ? 0 : at - 1); break;
      case "ArrowRight":
        if (row?.hasChildren && !row.open) { this.closed.delete(row.id); this.render(); }
        else if (row?.open) select(at + 1);
        break;
      case "ArrowLeft":
        if (row?.open && !this.query) { this.closed.add(row.id); this.render(); }
        else if (row) {
          const parent = this.store.currentSymbol.nodes[row.id]?.parentId;
          if (parent && this.rowEls.has(parent)) { this.select([parent]); this.anchor = parent; }
        }
        break;
      case "F2":
      case "Enter": {
        const nameEl = row ? this.rowEls.get(row.id)?.querySelector(".otree-name") : null;
        if (row && nameEl) this.rename(row.id, nameEl as HTMLElement);
        break;
      }
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
}

function badge(name: IconName, title: string): HTMLElement {
  const b = h("span", { class: "otree-badge", title });
  b.appendChild(icon(name, 11));
  return b;
}

/** The name, with the searched-for part marked. */
function highlight(name: string, query: string): Array<string | HTMLElement> {
  if (!query) return [name];
  const i = name.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return [name];
  return [name.slice(0, i), h("mark", null, name.slice(i, i + query.length)), name.slice(i + query.length)];
}
