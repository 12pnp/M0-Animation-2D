import { deleteConstraintKeys } from "@/core/doc/constraintKeys";
import type { SoundStore } from "@/app/SoundStore";
import { Waveforms } from "./waveforms";
import { offsetPlan } from "@/core/doc/offset";
import { clear, cls, drag, h, on } from "@/view/widgets/dom";
import { deleteChannelKeys, type TimelineProp } from "@/core/doc/propertyKeys";
import { SPEED_SLIDER_MAX, sliderFromSpeed, speedFromSlider, speedLabel } from "./playSpeed";
import { PLAY_RATES } from "./playStep";
import { uniqueAnimationName } from "@/core/doc/animationList";
import { promptText } from "@/view/widgets/dialogs";
import { onAccelChange, withAccel } from "@/view/widgets/accel";
import { icon } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import { type MenuEntry, showMenu } from "@/view/widgets/Dock";
import { attachOptionsMenu } from "./onionButton";
import type { Store } from "@/app/Store";
import type { NodeId } from "@/core/doc/ids";
import { deformKeysOf } from "@/core/mesh/deform";
import { deformRow } from "@/core/mesh/meshPlan";
import { doSetSequenceKeys } from "@/app/AttachmentOps";
import { deleteEventKeys } from "@/core/doc/events";
import type { DeformKey, Keyframe } from "@/core/doc/types";
import { FrameGrid, ROW_HEIGHT } from "./FrameGrid";
import { transportButtons } from "./transport";
import { LayerList } from "./LayerList";
import { Playback } from "./Playback";
import {
  doClearKeyframes,
  doConvertToKeyframes, doInsertFrames, doMoveKeyframes,
  doSetTrack,
  doSetDrawOrder,
  doSetIkKeys,
  doSetEventKeys,
  doSetTcKeys,
  doSetDeformKeys, doRemoveFrames,
  doSetEndFrame, doSetTween,
  doCloseLoop, doKeyProps, doOffsetKeys, doSetConstraintKeys, doSetInheritKeys,
  doToggleCycle,
  easeTargets
} from "@/app/TimelineOps";
import { isCycle, seamFrame } from "@/core/doc/cycle";
import { easeLabel, type TweenSpec } from "@/core/math/easing";
import { openEaseDialog } from "./EaseDialog";
import { FrameClipboard, type PasteMode } from "@/app/FrameClipboard";
import type { Clipboard } from "@/app/Clipboard";
import { MAX_FRAMES, spanKeyAt } from "@/core/doc/timeline";
import { promptNumber } from "@/view/widgets/promptNumber";
import { AddAnimation, RemoveAnimation, RenameAnimation, SetAnimationDuration } from "@/core/history/timelineCommands";
import { AddNode, RemoveNodes } from "@/core/history/commands";
import { SetParent } from "@/core/history/hierarchyCommands";
import { createLayer, createNode } from "@/core/doc/defaults";
import { groupPlan, layerRows } from "@/core/doc/layerTree";
import { evaluateSymbol } from "@/core/doc/pose";
import { mayReparent } from "@/view/widgets/ikReparentGuard";
import { uiPx } from "@/core/prefs/fonts";
import { deleteKeys } from "@/core/doc/keyList";
import { frameCell, frameCellBounds } from "@/core/doc/frameCells";
import { keyMenu, layerMenu, rulerMenu, eventsMenu, drawOrderMenu, frameMenu } from "./timelineMenus";

/** The timeline: layer column, frame grid, transport. */
export class TimelinePanel implements Panel {
  readonly id = "timeline";
  readonly title = "Timeline";
  readonly icon = "outlinePanel" as const;
  readonly el: HTMLElement;

  readonly grid: FrameGrid;
  readonly layers: LayerList;
  readonly playback: Playback;
  readonly frames = new FrameClipboard();

  private animSelect: HTMLSelectElement;
  private offsetStep = 2;
  private offsetStagger = true;
  private frameLabel: HTMLElement;
  private elapsedLabel: HTMLElement;
  private tweenLabel: HTMLElement;
  private hScroll: HTMLElement;
  private hScrollInner: HTMLElement;
  /** The last `scrollX` the two ends agreed on; see `syncHScroll`. */
  private pushedScrollX = 0;
  private fpsLabel: HTMLElement;

  constructor(
    readonly store: Store,
    /** Shared with the stage: copying layers and copying objects are the same
     *  clipboard object, in two separate slots. */
    readonly clipboard: Clipboard,
    /** The onion skin's options, for press-and-hold on its buttons. */
    readonly onionMenu: () => Array<MenuEntry | "-"> = () => [],
    /** Event sounds, for their waveforms on the Events row. */
    sounds?: SoundStore,
  ) {
    const waveforms = sounds ? new Waveforms(sounds, () => this.grid.invalidate()) : null;
    this.grid = new FrameGrid(store, {
      waveform: waveforms ? (path) => waveforms.get(path) : undefined,
      onScrub: (frame) => { this.playback.pause(); store.setFrame(frame); },
      onSelectCell: (row, frame, additive) => this.selectCell(row, frame, additive),
      onSelectRange: (rowFrom, rowTo, from, to) => this.selectRange(rowFrom, rowTo, from, to),
      onMoveKeyframes: (nodeId, from, to, delta, base) => doMoveKeyframes(store, nodeId, from, to, delta, base),
      onEditTrack: (nodeId, track, label, kind) => doSetTrack(store, nodeId, track, label, kind),
      onEditDrawOrder: (keys, label, kind) => doSetDrawOrder(store, keys, label, kind),
      onDrawOrderMenu: (frame, x, y) => drawOrderMenu(this, frame, x, y),
      onEditIk: (ik, keys, label, kind) => doSetIkKeys(store, ik, keys, label, kind),
      onEditTc: (tc, keys, label, kind) => doSetTcKeys(store, tc, keys, label, kind),
      onEditDeform: (node, keys, label, kind) => doSetDeformKeys(store, node, keys, label, kind),
      onEditSequence: (node, keys, label, kind) => doSetSequenceKeys(store, node, keys, label, kind),
      onEditInherit: (node, keys, label, kind) => doSetInheritKeys(store, node, keys, label, kind),
      onEditConstraintKeys: (keys, label, kind) => doSetConstraintKeys(store, keys, label, kind),
      onEditEvents: (keys, label, kind) => doSetEventKeys(store, keys, label, kind),
      onEventsMenu: (frame, x, y) => eventsMenu(this, frame, x, y),
      onDragSpanEnd: (nodeId, endFrame) => doSetEndFrame(store, nodeId, endFrame),
      onDragFrames: (row, frame, copy) => this.dragFrames(row, frame, copy),
      onBeginInteraction: (kind) => store.history.beginInteraction(kind),
      onEndInteraction: () => store.history.endInteraction(),
      onContextMenu: (row, frame, x, y) => frameMenu(this, row, frame, x, y),
      onRulerContextMenu: (frame, x, y) => rulerMenu(this, frame, x, y),
      onWheelY: (dy) => this.layers.scrollByY(dy),
      onGeometry: () => this.syncHScroll(),
    });

    this.layers = new LayerList(store, {
      // A getter, not a number: the rows follow Interface ▸ Text, and
      // `LayerList.render` reads it again on every pass. It has to give the
      // same answer as `FrameGrid.rowHeight` or the names stop lining up
      // with their frames.
      get rowHeight() { return uiPx(ROW_HEIGHT, store.prefs.value.interface.fontSize); },
      onScrollY: (y) => this.grid.setScrollY(y),
      onContextMenu: (_nodeId, x, y) => layerMenu(this, x, y),
      onOnionOptions: (anchor) => showMenu(anchor, this.onionMenu()),
    });

    this.playback = new Playback(store, (frame) => this.grid.revealFrame(frame));

    this.fpsLabel = h("span", { class: "fps" });
    this.animSelect = h("select", { class: "tl-anim", title: "Animation" });
    this.frameLabel = h("span", { class: "cur", title: "Current frame. Click to jump to a frame." }, "1");
    on(this.frameLabel, "click", () => this.goToFrame());
    this.elapsedLabel = h("span", { class: "elapsed" }, "0.0 s");
    this.tweenLabel = h("button", { class: "tween", title: "Easing of the tween at the current frame. Click to edit it." }, "");
    on(this.tweenLabel, "pointerup", () => this.openEase());

    this.hScrollInner = h("div");
    this.hScroll = h("div", { class: "hscroll" }, this.hScrollInner);
    this.grid.el.appendChild(this.hScroll);
    on(this.hScroll, "scroll", () => {
      this.grid.scrollX = this.hScroll.scrollLeft;
      this.pushedScrollX = this.grid.scrollX;
      this.grid.invalidate();
    });

    const splitter = h("div", { class: "splitter v" });
    let startW = 186;
    drag(splitter, {
      cursor: "ew-resize",
      onStart: () => { startW = this.layers.el.offsetWidth; splitter.classList.add("dragging"); },
      onMove: (dx) => {
        const w = Math.max(110, Math.min(400, startW + dx));
        main.style.setProperty("--tl-layers", `${w}px`);
        this.grid.invalidate();
      },
      onEnd: () => splitter.classList.remove("dragging"),
    });

    const main = h("div", { class: "tl-main" }, this.layers.el, splitter, this.grid.el);
    // The toolbar sits on top, over the layers and the ruler, as in Spine.
    this.el = h("div", { class: "tl" }, this.buildFooter(), main);

    // A selection made in here (a row, a frame) leaves the focus as it was.
    let pressedHere = false;
    on(this.el, "pointerdown", () => { pressedHere = true; }, { capture: true });
    on(window, "pointerup", () => { setTimeout(() => { pressedHere = false; }); });
    store.subscribe((topic) => {
      if (topic === "selection" && !pressedHere && !this.el.contains(document.activeElement)) {
        store.ui.timelineFocus = [...store.selection.nodes];
        this.grid.propSel = null;
      }
      if (topic === "doc" || topic === "timeline" || topic === "selection") {
        this.layers.render();
        this.grid.invalidate();
        this.syncAnimations();
      }
      if (topic === "frame" || topic === "playback" || topic === "stage" || topic === "doc") {
        this.grid.invalidate();
        this.syncReadout();
      }
    });

    // The text scale moves the row height on both sides of the splitter.
    store.prefs.subscribe(() => { this.layers.render(); this.grid.invalidate(); });

    this.syncAnimations();
    this.syncReadout();
  }

  onShow(): void { this.grid.invalidate(); this.layers.render(); }

  // ── Footer transport ───────────────────────────────────────────────────

  private buildFooter(): HTMLElement {
    const iconBtn = (name: Parameters<typeof icon>[0], title: string, run: () => void) => {
      const b = h("button", { class: "iconbtn", title });
      b.appendChild(icon(name, 13));
      on(b, "click", run);
      return b;
    };

    const newLayer = iconBtn("newLayer", "New layer, above the selected one", () => this.addEmptyLayer());
    const newGroup = iconBtn("newFolder", "", () => this.addGroup());
    const groupTitle = () => { newGroup.title = `${withAccel("New group", "modify.group")}, containing the selected layers`; };
    groupTitle();
    onAccelChange(groupTitle);
    const del = iconBtn("trash", "Delete layer", () => this.deleteSelectedLayers());

    const transport = transportButtons(this.store, this.playback);

    const onionBtn = iconBtn("onion", "Onion skin (hold or right-click for options)", () => {
      this.store.setUi({ onionSkin: !this.store.ui.onionSkin }, "stage");
    });
    attachOptionsMenu(onionBtn, () => showMenu(onionBtn, this.onionMenu()));
    // Spine's dopesheet: a bone selected on the stage or in the Tree shows
    // only its own rows here.
    const focusBtn = iconBtn("subtree", "Show only the selected bones' rows (select a bone on the stage or in the Tree)", () => {
      this.store.prefs.set("timeline", { focusSelected: !this.store.prefs.value.timeline.focusSelected });
    });
    const syncFocus = () => cls(focusBtn, "on", this.store.prefs.value.timeline.focusSelected);
    this.store.prefs.subscribe(syncFocus);
    syncFocus();
    // Spine's key buttons: what changed, or (its menu) everything or one group.
    const keyBtn = iconBtn("key", "", () => this.keySelected("changed"));
    attachOptionsMenu(keyBtn, () => showMenu(keyBtn, keyMenu(this)));
    const keyTitle = () => {
      keyBtn.title = `${withAccel("Key what changed", "timeline.keyChanged")} on the selected layers: each property that is not at the setup pose (hold or right-click: key everything, or one group)`;
    };
    keyTitle();
    onAccelChange(keyTitle);
    const syncKey = () => { (keyBtn as HTMLButtonElement).disabled = this.store.ui.mode !== "animate" || !this.store.currentAnimation; };
    this.store.subscribe((t) => { if (t === "ui" || t === "doc" || t === "stage") syncKey(); });
    syncKey();
    const multiBtn = iconBtn("multiFrames", "Edit multiple frames: a change applies to every frame between the onion markers", () => {
      this.store.setUi({ editMultipleFrames: !this.store.ui.editMultipleFrames }, "stage");
    });
    // Both follow the STATE: the View menu and the layer-list button change
    // it too.
    const syncOnion = () => {
      cls(onionBtn, "on", this.store.ui.onionSkin);
      cls(multiBtn, "on", this.store.ui.editMultipleFrames);
    };
    this.store.subscribe((t) => { if (t === "stage" || t === "ui") syncOnion(); });
    syncOnion();

    on(this.animSelect, "change", () => {
      const anim = this.store.currentSymbol.animations.find((a) => a.id === this.animSelect.value);
      if (anim) {
        this.store.setUi({ animId: anim.id, frame: 0 }, "doc");
        this.store.emit("timeline");
      }
    });

    const animMenu = iconBtn("hamburger", "Animation options", () => {
      const sym = this.store.currentSymbol;
      const anim = this.store.currentAnimation;
      showMenu(animMenu, [
        { label: "New Animation", run: () => this.addAnimation() },
        { label: "Rename Animation…", enabled: !!anim, run: () => this.renameAnimation() },
        {
          label: "Delete Animation", enabled: !!anim && sym.animations.length > 1,
          run: () => {
            if (!anim) return;
            this.store.apply(new RemoveAnimation(this.store.currentSymbolId, anim.id));
            this.store.setUi({ animId: this.store.currentSymbol.animations[0]?.id ?? null }, "doc");
            this.store.emit("timeline");
          },
        },
        "-",
        { label: "Set Duration…", enabled: !!anim, run: () => this.setDuration() },
        "-",
        this.cycleItem(),
        this.closeLoopItem(),
        "-",
        this.offsetItem(),
      ]);
    });

    const fit = iconBtn("fit", "Fit the animation to the timeline's width", () => {
      this.grid.fitToView(this.store.currentAnimation?.duration ?? 1);
    });

    this.fpsLabel = h("span", { class: "fps" }, `${this.store.project.frameRate} fps`);

    const speedOf = () => this.store.prefs.value.timeline.playSpeed;
    const speed = h("input", {
      type: "range", min: "0", max: String(SPEED_SLIDER_MAX), value: String(sliderFromSpeed(speedOf())),
    }) as HTMLInputElement;
    const speedText = h("span", { class: "mark speed-value" }, speedLabel(speedOf()));
    const setSpeed = (v: number) => this.store.prefs.set("timeline", { playSpeed: v });
    on(speed, "input", () => setSpeed(speedFromSlider(Number(speed.value))));
    // The slider has the focus after a double-click, so the sync below skips it.
    const reset = () => { setSpeed(1); speed.value = String(sliderFromSpeed(1)); };
    on(speed, "dblclick", reset);
    on(speedText, "dblclick", reset);
    const one = h("button", { class: "tl-chip", title: "Playback speed back to 1×" }, "1×");
    on(one, "click", reset);
    // Redraws a second while playing: the stage poses between frames.
    const rateOf = () => this.store.prefs.value.timeline.playRate;
    const rateBtn = h("button", {
      class: "tl-chip tl-rate", title: "Smooth playback: how many times a second the timeline and the Preview redraw",
    }) as HTMLButtonElement;
    on(rateBtn, "click", () => showMenu(rateBtn, PLAY_RATES.map((rate) => ({
      label: `${rate} fps`, checked: rateOf() === rate,
      run: () => this.store.prefs.set("timeline", { playRate: rate }),
    }))));
    const syncSpeed = () => {
      speedText.textContent = speedLabel(speedOf());
      if (document.activeElement !== speed) speed.value = String(sliderFromSpeed(speedOf()));
      cls(one, "on", speedOf() === 1);
      rateBtn.textContent = `${rateOf()} fps ▾`;
    };
    this.store.prefs.subscribe(syncSpeed);
    syncSpeed();
    const speedBox = h("div", { class: "tl-zoom tl-speed" },
      rateBtn,
      h("span", { title: "Playback speed (double-click: 1×). The timeline and the Preview play at it.", style: "display:flex;align-items:center;gap:5px" },
        icon("play", 11), speed, speedText),
      one);

    return h("div", { class: "tl-foot" },
      newLayer, newGroup, del,
      h("div", { class: "sep-v" }),
      ...transport.buttons, onionBtn, multiBtn, focusBtn, keyBtn,
      h("div", { class: "sep-v" }),
      this.animSelect, animMenu,
      h("div", { class: "readout" },
        this.frameLabel, this.fpsLabel, this.elapsedLabel, this.tweenLabel),
      h("div", { class: "spacer" }),
      speedBox,
      fit,
    );
  }

  private syncReadout(): void {
    const frame = this.store.ui.frame;
    this.frameLabel.textContent = String(frame + 1);
    this.elapsedLabel.textContent = `${(frame / this.store.project.frameRate).toFixed(1)} s`;
    // The frame rate is a document setting and can change under us.
    const fps = `${this.store.project.frameRate} fps`;
    if (this.fpsLabel.textContent !== fps) this.fpsLabel.textContent = fps;

    this.tweenLabel.textContent = this.tweenAtPlayhead();

    this.syncHScroll();
  }

  /**
   * The horizontal scrollbar is a sibling of the canvas, not the canvas's own
   * overflow, so nothing updates it implicitly. Its inner width has to follow
   * `contentWidth` — which a zoom changes without emitting any store
   * event, so the bar simply never appeared when the frames were widened —
   * and its thumb has to follow a `scrollX` the grid moved itself, as
   * `revealFrame` does while playing.
   */
  private syncHScroll(): void {
    const width = `${this.grid.contentWidth}px`;
    if (this.hScrollInner.style.width !== width) this.hScrollInner.style.width = width;

    // Push the thumb only when the GRID moved, never merely because the two
    // disagree. A `scroll` event is delivered asynchronously, so a draw
    // queued by something else — playback runs one every frame — can land
    // between the bar being dragged and the event arriving, and a plain
    // comparison there would shove the thumb back under the pointer.
    if (this.grid.scrollX !== this.pushedScrollX) {
      this.pushedScrollX = this.grid.scrollX;
      this.hScroll.scrollLeft = this.grid.scrollX;
    }
  }

  /**
   * The easing governing the span under the playhead on the selected layer —
   * the same thing the "in"/"out" tag on the frame grid says, spelled out.
   * Blank when the selection does not settle on one span.
   */
  private tweenAtPlayhead(): string {
    const ids = this.store.selection.nodes;
    if (ids.length !== 1) return "";
    const track = this.store.currentAnimation?.tracks[ids[0]!];
    if (!track) return "";
    const key = spanKeyAt(track, this.store.ui.frame);
    if (!key) return "";
    const overrides = key.tween.kind !== "none" && key.eases ? " *" : "";
    return easeLabel(key.tween) + overrides + rotationName(key);
  }

  private syncAnimations(): void {
    const sym = this.store.currentSymbol;
    const current = this.store.currentAnimation;
    clear(this.animSelect);
    for (const a of sym.animations) {
      this.animSelect.appendChild(h("option", { value: a.id }, isCycle(a) ? `${a.name} ↻` : a.name));
    }
    if (current) this.animSelect.value = current.id;
    this.syncReadout();
  }

  // ── Actions ────────────────────────────────────────────────────────────

  private selectCell(row: number, frame: number, additive: boolean): void {
    const layer = this.grid.visibleRows()[row]?.layer;
    if (!layer) return;
    this.playback.pause();
    this.store.selectNodes([layer.nodeId], additive);
    this.store.selection = {
      ...this.store.selection,
      frames: [frameCell(layer.nodeId, frame)],
    };
    this.store.setFrame(frame);
    this.store.emit("selection");
  }

  /**
   * A frame selection dropped somewhere else — Flash's "drag timeline frames
   * to a new location on the same layer or to a different layer". It is a move
   * unless ⌥ was held, and one undo step either way.
   */
  private dragFrames(row: number, frame: number, copy: boolean): void {
    const sel = FrameClipboard.selectionOf(this.store);
    const target = this.grid.visibleRows()[row]?.layer.nodeId;
    if (!sel || !target) return;
    this.playback.pause();
    this.frames.dragTo(this.store, sel, target, frame, copy);
  }

  /** A rectangle of cells: every frame in `from..to` on every row in range. */
  private selectRange(rowFrom: number, rowTo: number, from: number, to: number): void {
    const rows = this.grid.visibleRows();
    const frames: string[] = [];
    const nodes: NodeId[] = [];
    for (let r = rowFrom; r <= rowTo; r++) {
      const layer = rows[r]?.layer;
      if (!layer) continue;
      nodes.push(layer.nodeId);
      for (let f = from; f <= to; f++) frames.push(frameCell(layer.nodeId, f));
    }
    if (!frames.length) return;
    this.store.selection = { ...this.store.selection, nodes, frames };
    this.store.emit("selection");
  }

  /**
   * The current frame selection as a rectangle. Cells are stored one by one,
   * but every producer writes a rectangle, so reading it back as bounds is
   * enough for the range operations.
   */
  frameSelection(): { ids: NodeId[]; from: number; to: number } | null {
    const cells = this.store.selection.frames;
    return cells.length < 2 ? null : frameCellBounds(cells);
  }

  /**
   * Every layer of the current symbol, for the "all layers" operations —
   * including the ones folded away inside a collapsed group. Taking only the
   * visible rows shifted every other layer's keys and left those behind.
   */
  allLayerIds(): NodeId[] {
    return layerRows(this.store.currentSymbol, true).map((r) => r.layer.nodeId);
  }

  /**
   * The layers an INSERTING F-key acts on: the selection, or every layer when
   * there is none. Flash always has exactly one current layer, so the case
   * does not arise there and the keys simply did nothing here — pressing F5
   * on a fresh scene to make room was a dead key. Only inserting takes this
   * fallback; ⇧F5 and ⇧F6 destroy content and keep needing a selection.
   */
  insertTargets(): NodeId[] {
    const sel = this.store.selection.nodes;
    return sel.length ? [...sel] : this.allLayerIds();
  }

  /**
   * Create an empty layer.
   *
   * A layer IS an object here, so an empty one needs something to hold it
   * open: an "empty" node, which carries no library item and exports as
   * nothing at all — not even a bone. Dropping a library item on it converts
   * that same node in place (`SetNodeItem`), so the layer keeps its id, its
   * name, its z-order and its mask links instead of being replaced by a
   * freshly created one somewhere else in the stack.
   */
  addEmptyLayer(): void {
    const sym = this.store.currentSymbol;
    const selected = [...this.store.selection.nodes].filter((id) => sym.nodes[id]);

    // Above the topmost selected layer, or at the very top with no selection —
    // Flash's rule, and the reason a new layer never lands out of sight.
    const at = selected.length
      ? Math.max(0, Math.min(...selected
          .map((id) => sym.layers.findIndex((l) => l.nodeId === id))
          .filter((i) => i >= 0)))
      : 0;

    const node = createNode("empty", uniqueLayerName(this.store));
    const layer = createLayer(node.id, node.name, sym.layers.length);
    this.store.apply(new AddNode("New Layer", this.store.currentSymbolId, node, layer, at));
    this.store.selectNodes([node.id]);
    this.store.emit("doc");
  }

  /**
   * Create a group.
   *
   * A group is a transform-only parent that moves its children together — as
   * distinct from an empty layer, which holds a slot in the stack open and
   * has no children. It adopts the current selection when there is one.
   */
  addGroup(): void {
    const sym = this.store.currentSymbol;
    const setup = evaluateSymbol(sym, null, 0, "setup");
    const plan = groupPlan(sym, this.store.selection.nodes, (id) => {
      const w = setup.byNode.get(id)?.world;
      return { x: w?.tx ?? 0, y: w?.ty ?? 0 };
    });
    if (!mayReparent(this.store, plan.members)) return;

    // Put the group where the selection is, so its origin is a sensible pivot,
    // above the topmost selected layer so it reads as their parent.
    const node = createNode("group", uniqueGroupName(this.store), {
      x: plan.origin.x, y: plan.origin.y, parentId: plan.parent,
    });
    const layer = createLayer(node.id, node.name, sym.layers.length);

    this.store.transaction("Group", () => {
      this.store.apply(new AddNode("Group", this.store.currentSymbolId, node, layer, plan.index));
      if (plan.members.length) {
        this.store.apply(new SetParent(this.store.currentSymbolId, plan.members, node.id));
      }
    });
    this.store.selectNodes([node.id]);
    this.store.emit("doc");
  }

  deleteSelectedLayers(): void {
    const ids = [...this.store.selection.nodes];
    if (!ids.length) return;
    this.store.apply(new RemoveNodes(this.store.currentSymbolId, ids));
    this.store.clearSelection();
    this.store.emit("doc");
  }

  private addAnimation(): void {
    const sym = this.store.currentSymbol;
    const name = uniqueAnimationName(sym.animations.map((a) => a.name));
    const cmd = new AddAnimation(this.store.currentSymbolId, name);
    this.store.apply(cmd);
    this.store.setUi({ animId: cmd.animation.id, frame: 0 }, "doc");
    this.store.emit("timeline");
  }

  private async renameAnimation(): Promise<void> {
    const anim = this.store.currentAnimation;
    if (!anim) return;
    const symbolId = this.store.currentSymbolId;
    const name = await promptText({ title: "Rename Animation", label: "Name", value: anim.name, ok: "Rename" });
    if (!name || name === anim.name) return;
    if (!this.store.project.items[symbolId] || this.store.currentAnimation?.id !== anim.id) return;
    this.store.apply(new RenameAnimation(symbolId, anim.id, name));
    this.store.emit("timeline");
  }

  setDuration(): void {
    const anim = this.store.currentAnimation;
    if (!anim) return;
    const symbolId = this.store.currentSymbolId;
    promptNumber({
      title: "Animation Duration", label: "Frames", value: anim.duration, min: 1, max: 100000,
      onOk: (n) => {
        if (this.store.currentAnimation?.id !== anim.id || !Number.isFinite(n) || n < 1) return;
        this.store.apply(new SetAnimationDuration(symbolId, anim.id, Math.round(n)));
        this.store.emit("timeline");
      },
    });
  }

  cycleItem() {
    const anim = this.store.currentAnimation;
    return { label: "Cycle", command: "timeline.cycle", enabled: !!anim, checked: !!anim && isCycle(anim),
      run: () => doToggleCycle(this.store) };
  }

  /** On the selected layers, or every layer when none is selected. */
  closeLoopItem() {
    const anim = this.store.currentAnimation;
    return { label: "Close Loop", command: "timeline.closeLoop", enabled: !!anim && seamFrame(anim) !== null,
      run: () => doCloseLoop(this.store, this.insertTargets()) };
  }

  /** Key the selected layers at the playhead: what changed from the setup
   *  pose, or `props` (`doKeyProps`). */
  keySelected(props: readonly TimelineProp[] | "changed", label = "Key Changed"): void {
    if (this.store.ui.mode !== "animate") return;
    doKeyProps(this.store, this.store.selection.nodes, props, label);
  }

  offsetItem() {
    return { label: "Offset Keys…", command: "timeline.offsetKeys", enabled: this.store.ui.mode === "animate" && !!this.store.currentAnimation,
      run: () => this.offsetKeys() };
  }

  /**
   * Offset Keys (Spine's Offset): the selected layers' keys, or every
   * layer's, moved in time; with Stagger each row by one more step than the
   * row above it (`offsetPlan`, `offsetTrack`).
   */
  offsetKeys(): void {
    const anim = this.store.currentAnimation;
    if (!anim) return;
    const targets = new Set(this.insertTargets());
    // Top to bottom as the rows show, so a chain staggers from its root.
    const rows = [...new Set(this.grid.visibleRows().filter((r) => !r.prop && r.layer && targets.has(r.layer.nodeId)).map((r) => r.layer!.nodeId))];
    for (const id of targets) if (!rows.includes(id)) rows.push(id);
    promptNumber({
      title: "Offset Keys", label: "Frames", value: this.offsetStep, min: -10000, max: 10000,
      toggle: { label: "Stagger: each row one step more", checked: this.offsetStagger, title: "The first row moves by 0, the next by the step, the next by twice the step…" },
      onOk: (n, stagger) => {
        if (this.store.currentAnimation?.id !== anim.id || !Number.isFinite(n)) return;
        this.offsetStep = Math.round(n);
        this.offsetStagger = stagger;
        doOffsetKeys(this.store, offsetPlan(rows, this.offsetStep, stagger));
      },
    });
  }

  /** A 0×0 fixed anchor at a screen point, for `showMenu`. */
  menuAnchor(x: number, y: number): HTMLElement {
    const anchor = h("div");
    anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:0;height:0`;
    document.body.appendChild(anchor);
    setTimeout(() => anchor.remove(), 0);
    return anchor;
  }

  /**
   * Every frame of every selected layer.
   *
   * A long animation makes the last frame a scroll away, and a range select
   * that has to reach it is a drag into the edge of the panel. The selection
   * itself needs no new state: it is the same rectangle a drag produces.
   */
  selectAllFrames(): void {
    const rows = this.grid.visibleRows();
    const selected = new Set(this.store.selection.nodes);
    const indices = rows
      .map((r, i) => (selected.has(r.layer.nodeId) ? i : -1))
      .filter((i) => i >= 0);
    if (!indices.length) return;
    const duration = this.store.currentAnimation?.duration ?? 1;
    this.selectRange(Math.min(...indices), Math.max(...indices), 0, duration - 1);
  }

  copyLayers(): number {
    const n = this.clipboard.copyLayers(this.store);
    this.store.emit("selection");
    return n;
  }

  pasteLayers(): number { return this.clipboard.pasteLayers(this.store); }
  duplicateLayers(): number { return this.clipboard.duplicateLayers(this.store); }

  /**
   * Park the playhead on a frame by number, past the end of the animation
   * included — the empty frames out there are where F5 and F6 lengthen a
   * timeline, and reaching frame 400 by dragging the scrollbar is not a
   * gesture anyone should have to perform.
   */
  goToFrame(): void {
    this.playback.pause();
    promptNumber({
      title: "Go to Frame",
      label: "Frame",
      value: this.store.ui.frame + 1,
      min: 1,
      max: MAX_FRAMES,
      onOk: (v) => {
        this.store.setFrame(Math.round(v) - 1);
        this.grid.revealFrame(this.store.ui.frame);
      },
    });
  }

  /** The picked property keys gone (`deleteChannelKeys`); false with none
   *  picked, so Delete goes on to what else is selected. */
  deletePropKeys(): boolean {
    const sel = this.grid.propSel;
    const track = sel && this.store.currentAnimation?.tracks[sel.nodeId];
    const node = sel && this.store.currentSymbol.nodes[sel.nodeId];
    if (!sel || !track || !node || !sel.frames.length) return false;
    doSetTrack(this.store, sel.nodeId, deleteChannelKeys(track, node, sel.prop, sel.frames), "Delete Keys");
    this.grid.propSel = null;
    return true;
  }

  /** The picked frames' event keys gone; false with none picked. */
  deleteEventKeys(): boolean {
    const frames = this.store.ui.eventFrames;
    const keys = this.store.currentAnimation?.events;
    if (!frames.length || !keys?.some((k) => frames.includes(k.frame))) return false;
    const n = keys.filter((k) => frames.includes(k.frame)).length;
    doSetEventKeys(this.store, deleteEventKeys(keys, frames), n > 1 ? "Delete Event Keys" : "Delete Event Key");
    this.store.ui.eventFrames = [];
    return true;
  }

  /** The deform keys of the mesh `node`'s Deform row shows (`deformRow`). */
  private deformKeysOf(node: NodeId): DeformKey[] | undefined {
    const sym = this.store.currentSymbol, n = sym.nodes[node];
    const row = n ? deformRow(sym, n) : null;
    return row ? deformKeysOf(this.store.currentAnimation, row.target) : undefined;
  }

  /** The picked deform keys gone; false with none picked. */
  deleteDeformKeys(): boolean {
    const sel = this.grid.deformSel;
    if (!sel?.frames.length) return false;
    const label = (what: string) => (sel.frames.length > 1 ? `Delete ${what} Keys` : `Delete ${what} Key`);
    const anim = this.store.currentAnimation;
    if (sel.cn) {
      if (!anim) return false;
      doSetConstraintKeys(this.store, deleteConstraintKeys(anim.constraintKeys, sel.cn, sel.frames), label("Constraint"));
    } else if (sel.inherit) {
      const keys = anim?.inherits?.[sel.node];
      if (!keys) return false;
      doSetInheritKeys(this.store, sel.node, deleteKeys(keys, sel.frames), label("Inherit"));
    } else if (sel.sequence) {
      const keys = anim?.sequences?.[sel.node];
      if (!keys) return false;
      doSetSequenceKeys(this.store, sel.node, deleteKeys(keys, sel.frames), label("Sequence"));
    } else {
      const keys = this.deformKeysOf(sel.node);
      if (!keys) return false;
      doSetDeformKeys(this.store, sel.node, deleteKeys(keys, sel.frames), label("Deform"));
    }
    this.grid.deformSel = null;
    return true;
  }

  /** The picked transform keys gone; false with none picked. */
  deleteTcKeys(): boolean {
    const sel = this.grid.tcSel;
    const keys = sel && this.store.currentAnimation?.transforms?.[sel.tc];
    if (!sel?.frames.length || !keys) return false;
    doSetTcKeys(this.store, sel.tc, deleteKeys(keys, sel.frames), sel.frames.length > 1 ? "Delete Transform Keys" : "Delete Transform Key");
    this.grid.tcSel = null;
    return true;
  }

  /** The picked IK keys gone; false with none picked. */
  deleteIkKeys(): boolean {
    const sel = this.grid.ikSel;
    const keys = sel && this.store.currentAnimation?.ik?.[sel.ik];
    if (!sel?.frames.length || !keys) return false;
    doSetIkKeys(this.store, sel.ik, deleteKeys(keys, sel.frames), sel.frames.length > 1 ? "Delete IK Keys" : "Delete IK Key");
    this.grid.ikSel = null;
    return true;
  }

  /** The picked draw order keys gone; false with none picked. */
  deleteDrawOrderKeys(): boolean {
    const sel = this.grid.orderSel;
    const keys = this.store.currentAnimation?.drawOrder;
    if (!sel?.length || !keys) return false;
    doSetDrawOrder(this.store, deleteKeys(keys, sel), sel.length > 1 ? "Delete Draw Order Keys" : "Delete Draw Order Key");
    this.grid.orderSel = null;
    return true;
  }

  /**
   * F5 / ⇧F5 / F6 / ⇧F6 with a frame selection: the keys act on the whole
   * rectangle. Returns false when there is nothing selected, so the caller
   * falls back to the single-frame behaviour.
   */
  applyRangeOp(op: "insert" | "remove" | "keyframes" | "clear"): boolean {
    const range = this.frameSelection();
    if (!range) return false;
    const count = range.to - range.from + 1;
    if (op === "insert") doInsertFrames(this.store, range.ids, range.from, count);
    else if (op === "remove") doRemoveFrames(this.store, range.ids, range.from, count);
    else if (op === "keyframes") doConvertToKeyframes(this.store, range.ids, range.from, range.to);
    else doClearKeyframes(this.store, range.ids, range.from, range.to);
    return true;
  }

  /** Insert or remove one frame on every layer, at the playhead. */
  allLayersFrameOp(op: "insert" | "remove"): void {
    const range = this.frameSelection();
    const from = range?.from ?? this.store.ui.frame;
    const count = range ? range.to - range.from + 1 : 1;
    const ids = this.allLayerIds();
    if (op === "insert") doInsertFrames(this.store, ids, from, count);
    else doRemoveFrames(this.store, ids, from, count);
  }

  applyTween(nodeId: NodeId, frame: number, spec: TweenSpec): void {
    doSetTween(this.store, nodeId, frame, spec);
  }

  /** The Ease panel, on the spans under the frame selection or the playhead. */
  openEase(): void {
    const targets = easeTargets(this.store);
    if (!targets.length) return;
    this.playback.pause();
    openEaseDialog(this.store, targets);
  }

  /** True when the timeline owns the current selection, so ⌘C should copy
   *  frames rather than stage objects. */
  get hasFrameSelection(): boolean {
    return FrameClipboard.selectionOf(this.store) !== null;
  }

  copyFrames(): number { return this.frames.copy(this.store); }
  cutFrames(): number { return this.frames.cut(this.store); }
  pasteFrames(mode: PasteMode = "insert"): number {
    return this.frames.paste(this.store, undefined, undefined, mode);
  }

  dispose(): void { this.playback.dispose(); }
}

function uniqueLayerName(store: Store): string {
  const taken = new Set(store.currentSymbol.layers.map((l) => l.name));
  for (let i = 1; ; i++) {
    const name = `Layer ${i}`;
    if (!taken.has(name)) return name;
  }
}

function uniqueGroupName(store: Store): string {
  const taken = new Set(store.currentSymbol.layers.map((l) => l.name));
  for (let i = 1; ; i++) {
    const name = `Group ${i}`;
    if (!taken.has(name)) return name;
  }
}

function rotationName(key: Keyframe): string {
  const turns = Math.abs(key.rotateTurns ?? 0);
  if (!key.rotateDir) return turns ? ` · ${key.rotateTurns! > 0 ? "CW" : "CCW"} +${turns}` : "";
  return ` · ${key.rotateDir === "cw" ? "CW" : "CCW"}${turns ? ` +${turns}` : ""}`;
}

