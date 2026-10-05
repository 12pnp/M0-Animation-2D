import { constraintKeyFrames, withConstraintTween } from "@/core/doc/constraintKeys";
import { INHERIT_LABELS, INHERIT_MODES, inheritAt, withInheritKey } from "@/core/doc/inherit";
import { KEY_GROUPS, type KeyGroup } from "@/core/doc/keyButtons";
import { keyChannelAt, propertyKeys, TIMELINE_PROPS, type TimelineProp } from "@/core/doc/propertyKeys";
import { drawingLayers, orderAt, withDrawOrderKey, type Reorder } from "@/core/doc/drawOrder";
import { promptText } from "@/view/widgets/dialogs";
import { type MenuEntry, showMenu } from "@/view/widgets/Dock";
import type { CnId, IkId, NodeId, TcId } from "@/core/doc/ids";
import { tcMixAt, withTcKey } from "@/core/doc/transformKeys";
import { deformAt, deformKeysOf, withDeformKey } from "@/core/mesh/deform";
import { deformRow } from "@/core/mesh/meshPlan";
import { SEQUENCE_MODE_LABELS, SEQUENCE_MODES, sequenceIndexAt, withSequenceKey } from "@/core/doc/sequence";
import { doSetSequenceKeys } from "@/app/AttachmentOps";
import { uniqueEventName, withEventKey } from "@/core/doc/events";
import { ikPoseAt, withIkKey } from "@/core/doc/ikKeys";
import type { Keyframe, Layer, RotateDir } from "@/core/doc/types";
import {
  doClearKeyframe,
  doClearKeyframes,
  doConvertToKeyframes,
  doInsertBlankKeyframe,
  doInsertFrame,
  doInsertFrames,
  doInsertKeyframe, doSetTrack,
  doSetDrawOrder,
  doSetIkKeys,
  doSetEventKeys,
  doSetTcKeys,
  doSetDeformKeys,
  doSetEvents,
  doReorder,
  ensureTrack,
  doRemoveFrame,
  doRemoveFrames, doSetRotation, doSetConstraintKeys, doSetInheritKeys, easeTargets
} from "@/app/TimelineOps";
import { EASE_PRESETS, sameEase } from "@/core/math/easing";
import { FrameClipboard } from "@/app/FrameClipboard";
import { keyIndexAt } from "@/core/doc/timeline";
import { promptNumber } from "@/view/widgets/promptNumber";
import { SetLayerExcluded } from "@/core/history/layerCommands";
import { keyTweenOf, keyTweenSpec, withKeyTween, type KeyTween } from "@/core/doc/keyList";
import { frameCell } from "@/core/doc/frameCells";
import type { TimelinePanel } from "./TimelinePanel";

/** The property rows' names, as Spine writes them. */
const PROP_NAMES: Record<TimelineProp, string> = {
  rotate: "Rotate", x: "Translate X", y: "Translate Y", scale: "Scale", shear: "Shear",
};

/**
 * The timeline's context menus: per row kind, what a right-click offers.
 * Each entry applies through the panel's operations.
 */

export function keyMenu(api: TimelinePanel) {
  const can = api.store.ui.mode === "animate" && !!api.store.currentAnimation && api.store.selection.nodes.length > 0;
  const group = (g: KeyGroup, label: string) => ({ label: `Key ${label}`, enabled: can, run: () => api.keySelected(KEY_GROUPS[g], `Key ${label}`) });
  return [
    { label: "Key Changed", command: "timeline.keyChanged", enabled: can, run: () => api.keySelected("changed") },
    { label: "Key All", command: "timeline.keyAll", enabled: can, run: () => api.keySelected(TIMELINE_PROPS, "Key All") },
    "-" as const,
    group("rotate", "Rotate"), group("translate", "Translate"), group("scale", "Scale"), group("shear", "Shear"),
  ];
}

/**
 * The menu on a layer row.
 *
 * The layer column had no context menu at all, which left New Layer buried
 * in the footer, Select All Frames unreachable, and every layer-level
 * operation split between the menubar and a drag. This is their home.
 */
export function layerMenu(api: TimelinePanel, x: number, y: number): void {
  const sym = api.store.currentSymbol;
  const selected = api.store.selection.nodes.filter((id) => sym.nodes[id]);
  const layers = selected
    .map((id) => sym.layers.find((l) => l.nodeId === id))
    .filter((l): l is Layer => !!l);
  const n = layers.length;
  const plural = n > 1 ? `${n} Layers` : "Layer";
  // A mixed selection reads as "not excluded", so the toggle turns it on.
  const excluded = n > 0 && layers.every((l) => l.excludeFromExport);

  showMenu(api.menuAnchor(x, y), [
    { label: "New Layer", run: () => api.addEmptyLayer() },
    { label: "New Group", command: "modify.group", run: () => api.addGroup() },
    "-",
    { label: `Copy ${plural}`, enabled: n > 0, run: () => api.copyLayers() },
    { label: "Paste Layers", enabled: api.clipboard.hasLayers, run: () => api.pasteLayers() },
    { label: `Duplicate ${plural}`, enabled: n > 0, run: () => api.duplicateLayers() },
    { label: `Delete ${plural}`, enabled: n > 0, run: () => api.deleteSelectedLayers() },
    "-",
    { label: "Select All Frames", command: "edit.selectAllFrames", enabled: n > 0, run: () => api.selectAllFrames() },
    api.offsetItem(),
    "-",
    {
      // Keyed at the playhead, in Animate (Spine's draw order keys).
      label: "Draw Order", items: drawOrderItems(api.store.ui.mode === "animate" && n > 0, (how) => doReorder(api.store, how)),
    },
    "-",
    {
      label: excluded ? "Include in Export" : "Exclude from Export",
      enabled: n > 0,
      checked: excluded,
      run: () => api.store.apply(new SetLayerExcluded(
        api.store.currentSymbolId, layers.map((l) => l.id), !excluded)),
    },
  ]);
}

/**
 * The menu on the frame ruler. There is no layer under the pointer up
 * there, so everything in it works on EVERY layer, starting at the playhead
 * — which the right-click moves, exactly as a left-click would.
 */
export function rulerMenu(api: TimelinePanel, frame: number, x: number, y: number): void {
  api.playback.pause();
  api.store.setFrame(frame);

  // A selection the click lands inside says how many frames and from
  // where; anywhere else the gesture itself is the answer, so the stale
  // selection goes rather than silently governing the operation.
  let range = api.frameSelection();
  if (range && (frame < range.from || frame > range.to)) {
    api.store.selection = { ...api.store.selection, frames: [] };
    api.store.emit("selection");
    range = null;
  }
  const from = range?.from ?? frame;
  const count = range ? range.to - range.from + 1 : 1;
  const ids = api.allLayerIds();
  const label = count > 1 ? `${count} Frames` : "Frame";

  showMenu(api.menuAnchor(x, y), [
    { label: `Insert ${label} (All Layers)`, command: "timeline.insertFrameAll",
      enabled: ids.length > 0,
      run: () => doInsertFrames(api.store, ids, from, count) },
    { label: `Remove ${label} (All Layers)`, command: "timeline.removeFrameAll",
      enabled: ids.length > 0,
      run: () => doRemoveFrames(api.store, ids, from, count) },
    "-",
    { label: "Convert to Keyframes (All Layers)",
      enabled: ids.length > 0,
      run: () => doConvertToKeyframes(api.store, ids, from, from + count - 1) },
    "-",
    { label: "Set Duration…", enabled: !!api.store.currentAnimation,
      run: () => api.setDuration() },
    { label: "Go to Frame…", command: "timeline.goToFrame", run: () => api.goToFrame() },
    "-",
    api.cycleItem(),
    api.closeLoopItem(),
    "-",
    // The markers live on the ruler, so their options are here too.
    { label: "Onion Skin", items: api.onionMenu() },
  ]);
}

/**
 * The Events row's menu: fire an event here (each of the symbol's, or a new
 * one, named first), or delete the picked frames' keys.
 */
export function eventsMenu(api: TimelinePanel, frame: number, x: number, y: number): void {
  const anim = api.store.currentAnimation;
  if (!anim) return;
  api.store.setFrame(frame);
  const sym = api.store.currentSymbol;
  const defs = sym.events ?? [];
  const keys = anim.events ?? [];
  const picked = keys.filter((k) => api.store.ui.eventFrames.includes(k.frame)).length;
  const add = (name: string) => {
    doSetEventKeys(api.store, withEventKey(keys, frame, name), `Add Event "${name}"`);
    api.store.ui.eventFrames = [frame];
  };
  showMenu(api.menuAnchor(x, y), [
    {
      label: "Add Event Here",
      items: [
        ...defs.map((d) => ({ label: d.name, run: () => add(d.name) })),
        ...(defs.length ? ["-" as const] : []),
        {
          label: "New Event…",
          run: async () => {
            const name = await promptText({ title: "New Event", label: "Name", value: uniqueEventName(defs, "event") });
            const now = api.store.currentSymbol;
            const a = api.store.currentAnimation;
            if (!name?.trim() || !a || now.id !== sym.id) return;
            const fresh = uniqueEventName(now.events ?? [], name);
            doSetEvents(api.store, [...(now.events ?? []), { name: fresh }],
              new Map([[a.id, withEventKey(a.events ?? [], frame, fresh)]]), `New Event "${fresh}"`);
            api.store.ui.eventFrames = [frame];
          },
        },
      ],
    },
    "-",
    {
      label: picked > 1 ? `Delete ${picked} Event Keys` : "Delete Event Key",
      enabled: picked > 0, run: () => { api.deleteEventKeys(); },
    },
  ]);
}

/** A physics, slider or path row's menu: the picked keys' ease, or delete
 *  them. Keys are made in Properties, a value at a time. */
export function constraintKeyMenu(api: TimelinePanel, node: NodeId, cn: CnId, frame: number, x: number, y: number): void {
  const anim = api.store.currentAnimation;
  if (!anim) return;
  const frames = constraintKeyFrames(anim, cn);
  const at = frames.includes(frame);
  const mine = api.grid.deformSel?.cn === cn ? api.grid.deformSel!.frames : [];
  if (at && !mine.includes(frame)) api.grid.deformSel = { node, frames: [frame], cn };
  if (!at && api.grid.deformSel?.cn !== cn) api.grid.deformSel = null;
  api.store.setFrame(frame);
  const sel = api.grid.deformSel?.cn === cn ? api.grid.deformSel!.frames : [];
  const tween = (t: KeyTween): MenuEntry => ({
    label: t === "linear" ? "Linear" : t === "stepped" ? "Stepped" : "Smooth", enabled: sel.length > 0,
    run: () => doSetConstraintKeys(api.store, withConstraintTween(anim.constraintKeys, cn, sel,
      keyTweenSpec(t)), "Constraint Key Ease"),
  });
  showMenu(api.menuAnchor(x, y), [
    tween("linear"), tween("stepped"), tween("smooth"),
    "-",
    { label: sel.length > 1 ? `Delete ${sel.length} Constraint Keys` : "Delete Constraint Key", enabled: sel.length > 0, run: () => { api.deleteDeformKeys(); } },
  ]);
}

/** An Inherit row's menu: key a mode here, the picked keys' mode, or delete them. */
export function inheritMenu(api: TimelinePanel, node: NodeId, frame: number, x: number, y: number): void {
  const anim = api.store.currentAnimation;
  const bone = api.store.currentSymbol.nodes[node];
  if (!anim || !bone) return;
  const keys = anim.inherits?.[node] ?? [];
  const at = keys.find((k) => k.frame === frame);
  const mine = api.grid.deformSel?.node === node && api.grid.deformSel.inherit ? api.grid.deformSel.frames : [];
  if (at && !mine.includes(frame)) api.grid.deformSel = { node, frames: [frame], inherit: true };
  if (!at && !(api.grid.deformSel?.node === node && api.grid.deformSel.inherit)) api.grid.deformSel = null;
  api.store.setFrame(frame);
  const sel = api.grid.deformSel?.inherit ? api.grid.deformSel.frames : [];
  const now = inheritAt(bone, anim, frame);
  showMenu(api.menuAnchor(x, y), [
    ...INHERIT_MODES.map((mode): MenuEntry => ({
      label: `Inherit ${INHERIT_LABELS[mode]}`, checked: now === mode,
      run: () => {
        // Picked keys take the mode; with none picked, a key goes in here.
        const next = sel.length ? keys.map((k) => (sel.includes(k.frame) ? { ...k, inherit: mode } : k)) : withInheritKey(keys, frame, mode);
        doSetInheritKeys(api.store, node, next, "Inherit Key");
      },
    })),
    "-",
    { label: sel.length > 1 ? `Delete ${sel.length} Inherit Keys` : "Delete Inherit Key", enabled: sel.length > 0, run: () => { api.deleteDeformKeys(); } },
  ]);
}

/** A Sequence row's menu: key the sequence here (the image in force,
 *  looping), the picked keys' mode, or delete them. */
export function sequenceMenu(api: TimelinePanel, node: NodeId, frame: number, x: number, y: number): void {
  const anim = api.store.currentAnimation;
  const seq = api.store.currentSymbol.nodes[node]?.sequence;
  if (!anim || !seq) return;
  const keys = anim.sequences?.[node] ?? [];
  const at = keys.find((k) => k.frame === frame);
  const mine = api.grid.deformSel?.node === node && api.grid.deformSel.sequence ? api.grid.deformSel.frames : [];
  if (at && !mine.includes(frame)) api.grid.deformSel = { node, frames: [frame], sequence: true };
  if (!at && !(api.grid.deformSel?.node === node && api.grid.deformSel.sequence)) api.grid.deformSel = null;
  api.store.setFrame(frame);
  const sel = api.grid.deformSel?.sequence ? api.grid.deformSel.frames : [];
  const picked = keys.filter((k) => sel.includes(k.frame));
  showMenu(api.menuAnchor(x, y), [
    {
      label: "Key Sequence Here", enabled: !at,
      run: () => doSetSequenceKeys(api.store, node, withSequenceKey(keys, {
        frame, mode: "loop", index: sequenceIndexAt(keys, frame, seq.items.length, seq.setup), delay: 1,
      }), "Key Sequence"),
    },
    "-",
    ...SEQUENCE_MODES.map((mode): MenuEntry => ({
      label: SEQUENCE_MODE_LABELS[mode], enabled: picked.length > 0,
      checked: picked.length > 0 && picked.every((k) => k.mode === mode),
      run: () => doSetSequenceKeys(api.store, node, keys.map((k) => (sel.includes(k.frame) ? { ...k, mode } : k)), "Sequence Mode"),
    })),
    "-",
    { label: sel.length > 1 ? `Delete ${sel.length} Sequence Keys` : "Delete Sequence Key", enabled: sel.length > 0, run: () => { api.deleteDeformKeys(); } },
  ]);
}

/** A Deform row's menu: key the deform in force here, the picked keys'
 *  ease, or delete them. */
export function deformMenu(api: TimelinePanel, node: NodeId, frame: number, x: number, y: number): void {
  const anim = api.store.currentAnimation;
  const n = api.store.currentSymbol.nodes[node];
  const row = n ? deformRow(api.store.currentSymbol, n) : null;
  if (!anim || !row) return;
  const mesh = row.mesh;
  const keys = deformKeysOf(anim, row.target) ?? [];
  const at = keys.find((k) => k.frame === frame);
  if (at && !(api.grid.deformSel?.node === node && api.grid.deformSel.frames.includes(frame))) api.grid.deformSel = { node, frames: [frame] };
  if (!at && api.grid.deformSel?.node !== node) api.grid.deformSel = null;
  api.store.setFrame(frame);
  const sel = api.grid.deformSel?.frames ?? [];
  const picked = keys.filter((k) => sel.includes(k.frame));
  const tween = (t: KeyTween): MenuEntry => ({
    label: t === "linear" ? "Linear" : t === "stepped" ? "Stepped" : "Smooth",
    enabled: picked.length > 0,
    checked: picked.length > 0 && picked.every((k) => keyTweenOf(k) === t),
    run: () => doSetDeformKeys(api.store, node, withKeyTween(keys, sel, t), "Deform Key Ease"),
  });
  showMenu(api.menuAnchor(x, y), [
    {
      label: "Key Deform Here", enabled: !at,
      run: () => doSetDeformKeys(api.store, node, withDeformKey(keys, frame, deformAt(anim, row.target, frame) ?? new Array<number>(mesh.points.length).fill(0)), "Key Deform"),
    },
    "-",
    tween("linear"), tween("stepped"), tween("smooth"),
    "-",
    { label: sel.length > 1 ? `Delete ${sel.length} Deform Keys` : "Delete Deform Key", enabled: sel.length > 0, run: () => { api.deleteDeformKeys(); } },
  ]);
}

/** A transform constraint row's menu: key the mixes in force here, the
 *  picked keys' ease, or delete them. */
export function tcMenu(api: TimelinePanel, tc: TcId, frame: number, x: number, y: number): void {
  const anim = api.store.currentAnimation;
  const k = api.store.currentSymbol.transforms?.find((c) => c.id === tc);
  if (!anim || !k) return;
  const keys = anim.transforms?.[tc] ?? [];
  const at = keys.find((key) => key.frame === frame);
  if (at && !(api.grid.tcSel?.tc === tc && api.grid.tcSel.frames.includes(frame))) api.grid.tcSel = { tc, frames: [frame] };
  if (!at && api.grid.tcSel?.tc !== tc) api.grid.tcSel = null;
  api.store.setFrame(frame);
  const sel = api.grid.tcSel?.frames ?? [];
  const picked = keys.filter((key) => sel.includes(key.frame));
  const tween = (t: KeyTween): MenuEntry => ({
    label: t === "linear" ? "Linear" : t === "stepped" ? "Stepped" : "Smooth",
    enabled: picked.length > 0,
    checked: picked.length > 0 && picked.every((key) => keyTweenOf(key) === t),
    run: () => doSetTcKeys(api.store, tc, withKeyTween(keys, sel, t), "Transform Key Ease"),
  });
  showMenu(api.menuAnchor(x, y), [
    { label: "Key Transform Here", enabled: !at, run: () => doSetTcKeys(api.store, tc, withTcKey(keys, frame, tcMixAt(k, anim, frame)), "Key Transform") },
    "-",
    tween("linear"), tween("stepped"), tween("smooth"),
    "-",
    { label: sel.length > 1 ? `Delete ${sel.length} Transform Keys` : "Delete Transform Key", enabled: sel.length > 0, run: () => { api.deleteTcKeys(); } },
  ]);
}

/**
 * An IK row's menu: key the mix and bend in force here, the picked keys'
 * ease (linear, stepped, smooth), or delete them.
 */
export function ikMenu(api: TimelinePanel, ik: IkId, frame: number, x: number, y: number): void {
  const anim = api.store.currentAnimation;
  const k = api.store.currentSymbol.ik.find((c) => c.id === ik);
  if (!anim || !k) return;
  const keys = anim.ik?.[ik] ?? [];
  const at = keys.find((key) => key.frame === frame);
  if (at && !(api.grid.ikSel?.ik === ik && api.grid.ikSel.frames.includes(frame))) api.grid.ikSel = { ik, frames: [frame] };
  if (!at && api.grid.ikSel?.ik !== ik) api.grid.ikSel = null;
  api.store.setFrame(frame);
  const sel = api.grid.ikSel?.frames ?? [];
  const picked = keys.filter((key) => sel.includes(key.frame));
  const tween = (t: KeyTween): MenuEntry => ({
    label: t === "linear" ? "Linear" : t === "stepped" ? "Stepped" : "Smooth",
    enabled: picked.length > 0,
    checked: picked.length > 0 && picked.every((key) => keyTweenOf(key) === t),
    run: () => doSetIkKeys(api.store, ik, withKeyTween(keys, sel, t), "IK Key Ease"),
  });
  showMenu(api.menuAnchor(x, y), [
    { label: "Key IK Here", enabled: !at, run: () => doSetIkKeys(api.store, ik, withIkKey(keys, frame, ikPoseAt(k, anim, frame), k.softness), "Key IK") },
    "-",
    tween("linear"), tween("stepped"), tween("smooth"),
    "-",
    {
      label: sel.length > 1 ? `Delete ${sel.length} IK Keys` : "Delete IK Key",
      enabled: sel.length > 0, run: () => { api.deleteIkKeys(); },
    },
  ]);
}

/**
 * The Draw order row's menu: key the order in force here (to edit it with
 * Modify ▸ Draw Order), back to the setup order from here, or delete the
 * picked keys.
 */
export function drawOrderMenu(api: TimelinePanel, frame: number, x: number, y: number): void {
  const anim = api.store.currentAnimation;
  if (!anim) return;
  api.store.setFrame(frame);
  const keys = anim.drawOrder ?? [];
  const sym = api.store.currentSymbol;
  const keyed = keys.some((k) => k.frame === frame);
  const sel = api.grid.orderSel ?? [];
  showMenu(api.menuAnchor(x, y), [
    {
      label: "Key Draw Order Here", enabled: !keyed,
      run: () => doSetDrawOrder(api.store, withDrawOrderKey(keys, frame, orderAt(sym, anim, frame), drawingLayers(sym)), "Key Draw Order"),
    },
    {
      label: "Setup Draw Order From Here",
      run: () => doSetDrawOrder(api.store, withDrawOrderKey(keys, frame, null, drawingLayers(sym)), "Setup Draw Order"),
    },
    "-",
    {
      label: sel.length > 1 ? `Delete ${sel.length} Draw Order Keys` : "Delete Draw Order Key",
      enabled: sel.length > 0, run: () => { api.deleteDrawOrderKeys(); },
    },
  ]);
}

/** A property row's menu: key the property at the frame, or delete its
 *  picked keys (or the one under the pointer). */
export function propMenu(api: TimelinePanel, nodeId: NodeId, prop: TimelineProp, frame: number, x: number, y: number): void {
  const track = api.store.currentAnimation?.tracks[nodeId];
  const node = api.store.currentSymbol.nodes[nodeId];
  if (!node) return;
  const label = PROP_NAMES[prop];
  const onKey = !!track && propertyKeys(track, prop).includes(frame);
  const sel = api.grid.propSel;
  if (onKey && !(sel?.nodeId === nodeId && sel.prop === prop && sel.frames.includes(frame))) {
    api.grid.propSel = { nodeId, prop, frames: [frame] };
  }
  api.store.setFrame(frame);
  showMenu(api.menuAnchor(x, y), [
    {
      label: `Key ${label} Here`, enabled: !onKey,
      run: () => {
        const base = track ?? ensureTrack(api.store, node);
        doSetTrack(api.store, nodeId, keyChannelAt(base, node, prop, frame), `Key ${label}`);
      },
    },
    {
      label: api.grid.propSel && api.grid.propSel.frames.length > 1 ? `Delete ${api.grid.propSel.frames.length} ${label} Keys` : `Delete ${label} Key`,
      enabled: onKey, run: () => { api.deletePropKeys(); },
    },
  ]);
}

export function frameMenu(api: TimelinePanel, row: number, frame: number, x: number, y: number): void {
  const layer = api.grid.visibleRows()[row]?.layer;
  if (!layer) return;
  const nodeId = layer.nodeId;
  const prop = api.grid.visibleRows()[row]?.prop;
  if (prop) { propMenu(api, nodeId, prop, frame, x, y); return; }
  const ik = api.grid.visibleRows()[row]?.ik;
  if (ik) { ikMenu(api, ik, frame, x, y); return; }
  const tc = api.grid.visibleRows()[row]?.tc;
  if (tc) { tcMenu(api, tc, frame, x, y); return; }
  if (api.grid.visibleRows()[row]?.deform) { deformMenu(api, nodeId, frame, x, y); return; }
  if (api.grid.visibleRows()[row]?.sequence) { sequenceMenu(api, nodeId, frame, x, y); return; }
  if (api.grid.visibleRows()[row]?.inherit) { inheritMenu(api, nodeId, frame, x, y); return; }
  const cnRow = api.grid.visibleRows()[row]?.cn;
  if (cnRow) { constraintKeyMenu(api, nodeId, cnRow, frame, x, y); return; }
  // Right-clicking outside the selection moves it, as in Flash; inside it,
  // the selection is what the menu acts on.
  if (!api.store.selection.frames.includes(frameCell(nodeId, frame))) {
    api.store.selectNodes([nodeId]);
    api.store.selection = { ...api.store.selection, frames: [frameCell(nodeId, frame)] };
    api.store.emit("selection");
  }
  api.store.setFrame(frame);

  const track = api.store.currentAnimation?.tracks[nodeId];
  const onKey = !!track && keyIndexAt(track, frame) >= 0;
  const range = api.frameSelection();
  const count = range ? range.to - range.from + 1 : 1;

  const anchor = api.menuAnchor(x, y);

  // A radio group, like the Rotate submenu below: the preset the key
  // already carries is ticked.
  const keyHere = onKey ? track!.keys[keyIndexAt(track!, frame)]! : null;
  const tweenItems = [
    ...EASE_PRESETS.map((p) => ({
      label: p.label,
      enabled: onKey,
      checked: !!keyHere && sameEase(keyHere.tween, p.spec),
      run: () => api.applyTween(nodeId, frame, p.spec),
    })),
    { label: "Ease…", enabled: easeTargets(api.store).length > 0, run: () => api.openEase() },
  ];

  const sel = FrameClipboard.selectionOf(api.store);
  const runLabel = sel && sel.to > sel.from ? `${sel.to - sel.from + 1} Frames` : "Frame";

  // With a range selected the frame operations work on it; otherwise they
  // keep their single-cell meaning.
  const frameItems = range
    ? [
      { label: `Insert ${count} Frames`, command: "timeline.insertFrame",
        run: () => doInsertFrames(api.store, range.ids, range.from, count) },
      { label: `Remove ${count} Frames`, command: "timeline.removeFrame",
        run: () => doRemoveFrames(api.store, range.ids, range.from, count) },
      "-" as const,
      { label: "Convert to Keyframes", command: "timeline.insertKeyframe",
        run: () => doConvertToKeyframes(api.store, range.ids, range.from, range.to) },
      { label: "Insert Blank Keyframe", command: "timeline.insertBlankKeyframe",
        run: () => doInsertBlankKeyframe(api.store, frame) },
      { label: "Clear Keyframes", command: "timeline.clearKeyframe",
        run: () => doClearKeyframes(api.store, range.ids, range.from, range.to) },
    ]
    : [
      { label: "Insert Frame", command: "timeline.insertFrame", run: () => doInsertFrame(api.store, frame) },
      { label: "Remove Frame", command: "timeline.removeFrame", run: () => doRemoveFrame(api.store, frame) },
      "-" as const,
      { label: "Insert Keyframe", command: "timeline.insertKeyframe", run: () => doInsertKeyframe(api.store, frame) },
      { label: "Insert Blank Keyframe", command: "timeline.insertBlankKeyframe", run: () => doInsertBlankKeyframe(api.store, frame) },
      { label: "Clear Keyframe", command: "timeline.clearKeyframe", enabled: onKey, run: () => doClearKeyframe(api.store, frame) },
    ];

  // The "all layers" pair only earns its place when it would reach layers
  // the items above do not: with every layer already in the selection the
  // two would do exactly the same thing, which just reads as a puzzle.
  const allIds = api.allLayerIds();
  const targetCount = range ? range.ids.length : api.store.selection.nodes.length || 1;
  const allLayerItems = allIds.length > targetCount
    ? [
      { label: count > 1 ? `Insert ${count} Frames (All Layers)` : "Insert Frame (All Layers)",
        run: () => doInsertFrames(api.store, allIds, range?.from ?? frame, count) },
      { label: count > 1 ? `Remove ${count} Frames (All Layers)` : "Remove Frame (All Layers)",
        run: () => doRemoveFrames(api.store, allIds, range?.from ?? frame, count) },
      "-" as const,
    ]
    : [];

  showMenu(anchor, [
    ...frameItems,
    "-",
    ...allLayerItems,
    { label: `Copy ${runLabel}`, command: "edit.copy", run: () => api.copyFrames() },
    { label: `Cut ${runLabel}`, command: "edit.cut", run: () => api.frames.cut(api.store) },
    {
      label: api.frames.hasContent ? `Paste ${api.frames.span} Frame(s)` : "Paste Frames",
      command: "edit.paste",
      enabled: api.frames.hasContent,
      run: () => api.frames.paste(api.store, nodeId, frame),
    },
    {
      label: "Paste and Overwrite Frames",
      command: "edit.pasteOverwriteFrames",
      enabled: api.frames.hasContent,
      run: () => api.frames.paste(api.store, nodeId, frame, "overwrite"),
    },
    "-",
    ...tweenItems,
    "-",
    rotationMenu(api, nodeId, frame, keyHere),
  ]);
}

/**
 * Which way the tween leaving this keyframe turns — Flash's Rotate: Auto /
 * CW / CCW ×N. Without it the only way to reverse a spin was to retype the
 * angle 360° away, and the Properties panel shows the angle, not the path.
 */
export function rotationMenu(api: TimelinePanel, nodeId: NodeId, frame: number, key: Keyframe | null) {
  const dir = key?.rotateDir ?? null;
  const turns = Math.abs(key?.rotateTurns ?? 0);
  const set = (d: RotateDir | null, t: number) => doSetRotation(api.store, nodeId, frame, d, t);
  return {
    label: "Rotate",
    enabled: !!key,
    items: [
      { label: "As Keyed", checked: !dir && !turns, run: () => set(null, 0) },
      { label: "Clockwise", checked: dir === "cw", run: () => set("cw", turns) },
      { label: "Counter-clockwise", checked: dir === "ccw", run: () => set("ccw", turns) },
      "-" as const,
      {
        label: turns ? `Extra Turns: ${turns}…` : "Extra Turns…",
        run: () => promptNumber({
          title: "Extra Turns",
          label: "Turns",
          value: turns,
          min: 0,
          max: 100,
          onOk: (v) => set(dir, v),
        }),
      },
    ],
  };
}
/** Modify ▸ Draw Order's items: the selected layers moved in the draw order
 *  at the playhead, keyed there. */

export function drawOrderItems(enabled: boolean, run: (how: Reorder) => void): MenuEntry[] {
  return [
    { label: "Bring Forward", command: "modify.orderForward", enabled, run: () => run("forward") },
    { label: "Send Backward", command: "modify.orderBackward", enabled, run: () => run("backward") },
    { label: "Bring to Front", command: "modify.orderFront", enabled, run: () => run("front") },
    { label: "Send to Back", command: "modify.orderBack", enabled, run: () => run("back") },
  ];
}
