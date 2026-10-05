import { type ConstraintKind, constraintEntries, withConstraintMoved } from "@/core/doc/constraintOrder";
import { clear, cls, h, on } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import { NumberField } from "@/view/widgets/NumberField";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import {
    type DocumentSettingsPatch,
    RenameNode,
    SetDocumentSettings,
    SetNodeBlendMode,
    SetPathDrag, SetBonePrimary,
    SetNodeMotionBlur,
    SetPivot,
} from "@/core/history/commands";
import {
    applyColors,
    applyEdit,
    colorAtFrame,
    displayAtFrame,
    doSetIkKeys,
    doSetTcKeys,
    doSetTransforms,
    editsMultipleFrames,
    transformAtFrame,
} from "@/app/TimelineOps";
import { type IkPose, ikPoseAt, withIkKey } from "@/core/doc/ikKeys";
import { tcMixAt, transformPlan, usedMixes, withTcKey } from "@/core/doc/transformKeys";
import { TC_CHANNELS, type TcChannel } from "@/core/math/transformConstraint";
import { newTcId } from "@/core/doc/ids";
import { alertDialog, chooseDialog } from "@/view/widgets/dialogs";
import { cloneTf, type Transform } from "@/core/math/Transform";
import type { ItemId, NodeId } from "@/core/doc/ids";
import type { Rect } from "@/core/math/geom";
import { instancesOf, type PoseAt, selectionBounds } from "@/view/tools/gizmo";
import {
    applyWorldMatrix,
    moveBy,
    type NodeSnapshot,
    rotateAbout,
    snapshotOf,
    topmostSelected,
    worldScaleMatrix,
} from "@/view/tools/transformOps";
import { displaySize, type Pose } from "@/core/doc/pose";
import { frameDirections, SCENE_FRAME } from "@/view/viewport/nodeFrame";
import {
    type BlendMode,
    type ColorTransform,
    DEFAULT_COLOR,
    DEFAULT_MOTION_BLUR,
    isDefaultColor,
    isSymbol,
    type Node,
    type TransformConstraint,
} from "@/core/doc/types";
import { ikRelations } from "@/core/doc/ikGraph";
import { DEFAULT_SKIN, editedSkin, skinsOf, stageSkinOf } from "@/core/doc/skins";
import { displaysOf } from "@/core/doc/displays";
import { isImage } from "@/core/doc/types";
import { doSetSkinImage, doSetSkinMembers, doSetSkinOnly } from "@/app/SkinOps";
import { doAddPhysics, doAddSlider, doMakeSequence, doRemoveSequence, doSetConstraints, doSetSequenceKeys, doSetSequenceSetup } from "@/app/AttachmentOps";
import { PHYSICS_DEFAULTS, type PhysicsSetting, SLIDER_PROPERTIES } from "@/core/doc/constraints";
import { type ConstraintField, EditNode, SetConstraintOrder } from "@/core/history/attachmentCommands";
import type { CnId } from "@/core/doc/ids";
import { SEQUENCE_MODE_LABELS, SEQUENCE_MODES, withSequenceKey } from "@/core/doc/sequence";
import type { PathShape, SequenceKey, SymbolItem } from "@/core/doc/types";
import { type IkPatch, RemoveIkConstraint, SetBoneLength, SetIkOptions, } from "@/core/history/ikCommands";

/**
 * A multi-selection edited as one object — Flash's behaviour, and the
 * "virtual group" of Edit Multiple Frames: X/Y/W/H are its bounding box, and
 * every write moves, scales or rotates the whole group.
 */
interface GroupSnapshot {
  bounds: Rect;
  snaps: NodeSnapshot[];
  /** The first selected node's transform: the typed Scale, Rotate and Skew
   *  are for it, and the rest of the group follows rigidly. */
  first: Transform;
}

type FieldKey =
  | "x" | "y" | "w" | "h"
  | "scaleX" | "scaleY"
  | "rotation" | "skewX" | "skewY"
  | "pivotX" | "pivotY";

/**
 * The inspector. Every field writes through the same commands the stage
 * gizmo uses, so numeric entry and direct manipulation share one undo story.
 */
/** One piece of a link row: a separator, or a name that selects nodes. */
type LinkPart = string | { text: string; select: NodeId[]; title?: string };

const CONSTRAINT_KIND_LABELS: Record<ConstraintKind, string> = {
  ik: "IK", transform: "Transform", physics: "Physics", path: "Path", slider: "Slider", carried: "From file",
};

export class PropertiesPanel implements Panel {
  readonly id = "properties";
  readonly title = "Properties";
  readonly icon = "properties" as const;
  readonly el: HTMLElement;

  private body: HTMLElement;
  private fields = new Map<FieldKey, NumberField>();
  private nameInput: HTMLInputElement | null = null;
  /** The "this frame is turned" badge, refreshed on every sync: the pose it
   *  reads is the RENDERED one, which does not exist yet at layout time and
   *  changes under the playhead anyway. */
  private frameNote: HTMLElement | null = null;
  private suppress = false;
  /** With nothing selected: refreshes the document fields in place. The
   *  section used to be rebuilt on every "frame" event, which during playback
   *  destroyed the field under the cursor sixty times a second. */
  private docSync: Array<() => void> = [];
  /** The IK section's values at the playhead in Animate mode, refreshed on
   *  every sync. */
  private ikSync: Array<() => void> = [];
  private rebuilding = false;
  /** A field scrub in progress: one interaction from the first step to the
   *  commit, so Edit Multiple Frames edits the keys as they were when it
   *  began. */
  private scrubbing = false;
  /** The virtual group being edited, captured at the first step of a scrub
   *  (or for one typed value). Every step is computed from it, not from the
   *  last rendered pose, which lags a step behind a fast scrub. */
  private group: GroupSnapshot | null = null;
  /** Chain toggles: keep the paired fields proportional. Remembered across
   *  selections and sessions, the way Animate's link button behaves. */
  private linked: Record<"size" | "scale" | "stage", boolean> = {
    size: loadLinked("size"),
    scale: loadLinked("scale"),
    stage: loadLinked("stage"),
  };

  /** Identity of what is currently laid out. A change here means the panel's
   *  STRUCTURE is stale (different item, different node kind), not just its
   *  numbers, so it must be rebuilt rather than merely re-synced. */
  private signature = "";

  /** Chosen colour-effect mode per node. Not in the document: it is a view of
   *  one ColorTransform, so it is re-derived when a node is first shown and
   *  then remembered while the selection lasts. */
  private colorModes = new Map<NodeId, ColorMode>();

  /**
   * The panel needs the RENDERED pose, not a freshly composed one: a bone
   * driven by IK is rotated by the solver at display time, and the note below
   * would otherwise name the frame the file describes rather than the one the
   * user is looking at.
   */
  constructor(
    private readonly store: Store,
    private readonly poseOf: () => Pose | null = () => null,
    /** Every pose on stage the selection can be edited in: the playhead's,
     *  plus each frame Edit Multiple Frames shows. */
    private readonly posesOf: () => PoseAt[] = () => [],
    /** Runs an app command by id (the mesh commands need the image store). */
    private readonly run: (command: string) => void = () => {},
  ) {
    this.body = h("div", { class: "props" });
    this.el = this.body;
    store.subscribe((t) => {
      if (t === "selection" || t === "doc" || t === "frame" || t === "stage") this.sync();
    });
    this.rebuild();
  }

  // ── Structure ──────────────────────────────────────────────────────────

  private signatureOf(): string {
    const nodes = this.store.selectedNodes;
    if (nodes.length === 0) {
      const order = constraintEntries(this.store.currentSymbol).map((e) => e.name).join("\n");
      return `doc:${this.store.project.motionBlur?.enabled === true}:${this.store.currentSymbolId}:${order}`;
    }
    // The display shown decides the Instance and Colour sections, and
    // changes under the playhead on a layer that switches artwork.
    // Animate mode keys the IK section's mix and bend, Setup edits the constraint.
    const anim = this.store.ui.mode === "animate" ? this.store.currentAnimation?.id ?? "" : "setup";
    // Which transform constraints exist and what they connect: the section's
    // structure. Their values are synced, not rebuilt.
    const tcs = (this.store.currentSymbol.transforms ?? [])
      .map((k) => [k.id, k.name, k.sourceId, k.boneIds.join(","), !!k.localSource, !!k.localTarget, !!k.additive, !!k.clamp, usedMixes(k).join("")].join(":")).join(";");
    // Skins are replaced as values: their identity says when they changed.
    const sym = this.store.currentSymbol;
    const skins = `${valueId(sym.skins)}:${stageSkinOf(sym).join(",")}:${editedSkin(sym, this.store.ui.editSkin) ?? ""}`
      // Physics, sliders and paths: which there are, not their values (synced).
      + [...(sym.physics ?? []), ...(sym.sliders ?? []), ...(sym.paths ?? [])].map((k) => `${k.id}:${k.name}:${"boneId" in k ? k.boneId : ""}:${"boneIds" in k ? k.boneIds.join(",") : ""}:${"animId" in k ? k.animId : ""}`).join(";");
    return `${anim}|${tcs}|${skins}|` + nodes.map((n) => `${n.id}:${n.kind}:${displaysOf(n).map((d) => (d.skinOnly ? "s" : "d")).join("")}${n.boneColor ?? ""}:${displayAtFrame(this.store, n).display?.itemId ?? ""}:${n.mesh ? `m${n.mesh.points.length}${n.mesh.weights ? "w" : ""}` : ""}${n.sequence ? `q${n.sequence.items.length}` : ""}`).join("|");
  }

  /**
   * Rebuild the panel's DOM.
   *
   * Never re-entrant: removing a focused field fires its `blur`, the blur
   * commits, the commit emits, and the emit used to land back here in the
   * middle of `clear` — "removeChild: the node is no longer a child", thrown
   * from inside Playback's tick, which killed the playback loop while the
   * transport still said Pause. A nested request is covered by the sync that
   * always follows.
   */
  private rebuild(): void {
    if (this.rebuilding) return;
    this.rebuilding = true;
    try {
      // Commit what is being typed while its field still exists.
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.body.contains(active)) active.blur();
      this.build();
    } finally {
      this.rebuilding = false;
    }
    this.sync();
  }

  private build(): void {
    clear(this.body);
    this.fields.clear();
    this.nameInput = null;
    this.docSync = [];
    this.ikSync = [];
    this.signature = this.signatureOf();
    const nodes = this.store.selectedNodes;

    if (nodes.length === 0) {
      this.body.appendChild(this.documentSection());
      const order = this.constraintOrderSection();
      if (order) this.body.appendChild(order);
      return;
    }

    // A bone has no artwork, so width, height and a transform point would be
    // fields with nothing behind them.
    const bone = nodes.length === 1 && nodes[0]!.kind === "bone" ? nodes[0]! : null;

    this.body.appendChild(this.instanceSection(nodes.length));
    this.body.appendChild(this.section("Position and Size", true, [
      this.row("", [this.field("x", "X"), this.field("y", "Y")]),
      ...(bone ? [] : [this.linkedRow("", "size", this.field("w", "W"), this.field("h", "H"))]),
    ], this.makeFrameNote()));
    this.body.appendChild(this.section("Transform", true, [
      this.linkedRow("Scale", "scale",
        this.field("scaleX", "X", { step: 0.01, decimals: 3, sensitivity: 60 }),
        this.field("scaleY", "Y", { step: 0.01, decimals: 3, sensitivity: 60 })),
      this.row("Rotate", [this.field("rotation", "∠", { unit: "°" })]),
      // Skew X and Skew Y ARE the two angular degrees of freedom, exactly as
      // in Flash: a pure rotation shows the same value in both, and pulling
      // them apart is what shears the object.
      this.row("Skew", [
        this.field("skewX", "X", { unit: "°" }),
        this.field("skewY", "Y", { unit: "°" }),
      ]),
      ...(bone ? [] : [this.row("Pivot", [this.field("pivotX", "X"), this.field("pivotY", "Y")])]),
    ]));
    // A bone produces no slot, so it has neither colour nor blend mode.
    if (!bone) this.body.appendChild(this.colorSection(nodes));
    if (!bone && nodes.length === 1 && nodes[0]!.kind === "image" && !nodes[0]!.attachment) this.body.appendChild(this.meshSection(nodes[0]!));
    if (!bone && nodes.length === 1 && nodes[0]!.kind === "image" && !nodes[0]!.attachment && !nodes[0]!.mesh) this.body.appendChild(this.sequenceSection(nodes[0]!));
    if (nodes.length === 1 && (bone || nodes[0]!.kind === "image")) this.body.appendChild(this.skinSection(nodes[0]!));
    if (bone) {
      this.body.appendChild(this.boneSection(bone));
      const section = this.ikSection(bone);
      if (section) this.body.appendChild(section);
      this.body.appendChild(this.transformSection(bone));
      this.body.appendChild(this.physicsSection(bone));
      this.body.appendChild(this.sliderSection(bone));
    }
    if (nodes.length === 1 && (bone || nodes[0]!.kind === "path")) {
      const section = this.pathSection(nodes[0]!);
      if (section) this.body.appendChild(section);
    }
  }

  /**
   * Colour effect and blend mode.
   *
   * Only MULTIPLIERS are offered. The runtime parses and tweens the four
   * offsets but `PixiSlot._updateColor` never reads them — it puts
   * `alphaMultiplier` into `display.alpha` and packs the three colour
   * multipliers into `display.tint`, which is a pure multiply. Exposing an
   * offset would look right on the stage and vanish in the preview, so Flash's
   * additive Tint is deliberately not reproduced here; "Tint" below is
   * multiplicative and says so.
   *
   * A symbol instance gets Alpha only: its display is a Container, so the
   * `instanceof PIXI.Sprite` guards in `_updateColor` and `_updateBlendMode`
   * both fail and neither tint nor blend mode reaches it.
   */
  private colorSection(nodes: Node[]): HTMLElement {
    const node = nodes[0]!;
    const ids = nodes.map((n) => n.id);
    const shown = displayAtFrame(this.store, node).display;
    const isInstance = isSymbol(shown ? this.store.project.items[shown.itemId] : undefined);
    const current = colorAtFrame(this.store, node);

    const mode = this.colorModes.get(node.id) ?? deriveColorMode(current, isInstance);
    this.colorModes.set(node.id, mode);

    const write = (next: ColorTransform, committing: boolean) => {
      this.scrubStep("node.color", committing);
      // The commit belongs to the scrub's entry: a different kind on the last
      // step left a second undo step that restored the same colour.
      applyColors(this.store, new Map(ids.map((id) => [id, next])), this.store.history.inInteraction);
      this.store.emit("stage");
      this.store.emit("timeline");
      if (committing) this.store.history.endInteraction();
    };

    const modeSel = h("select", { class: "preview-anim" },
      h("option", { value: "none" }, "None"),
      h("option", { value: "alpha" }, "Alpha"),
      ...(isInstance ? [] : [
        h("option", { value: "brightness" }, "Brightness"),
        h("option", { value: "tint" }, "Tint (multiply)"),
        h("option", { value: "advanced" }, "Advanced"),
      ]));
    modeSel.value = mode;
    on(modeSel, "change", () => {
      const next = modeSel.value as ColorMode;
      this.colorModes.set(node.id, next);
      if (next === "none") write({ ...DEFAULT_COLOR }, true);
      this.rebuild();
    });

    const rows: HTMLElement[] = [this.row("Effect", [modeSel])];

    const pct = (glyph: string, value: number, pick: (v: number) => ColorTransform) => {
      const nf = new NumberField({
        glyph, min: 0, max: 100, step: 1, decimals: 0, unit: "%",
        onInput: (v, committing) => write(pick(v), committing),
      });
      nf.set(value);
      return nf.el;
    };

    if (mode === "alpha" || mode === "advanced") {
      rows.push(this.row("Alpha", [
        pct("A", current.aM, (v) => ({ ...colorAtFrame(this.store, node), aM: v })),
      ]));
    }

    if (mode === "brightness") {
      // Flash brightens with an offset; without offsets the honest range is
      // "darken to black", so the label says multiply rather than promising
      // Flash's curve.
      rows.push(this.row("Brightness", [
        pct("B", current.rM, (v) => ({ ...colorAtFrame(this.store, node), rM: v, gM: v, bM: v })),
      ]));
    }

    if (mode === "tint") {
      const swatch = h("input", { type: "color", value: colorToHex(current), class: "swatch" });
      on(swatch, "input", () => {
        const { r, g, b } = hexToPct(swatch.value);
        write({ ...colorAtFrame(this.store, node), rM: r, gM: g, bM: b }, false);
      });
      on(swatch, "change", () => {
        const { r, g, b } = hexToPct(swatch.value);
        write({ ...colorAtFrame(this.store, node), rM: r, gM: g, bM: b }, true);
      });
      rows.push(this.row("Tint", [swatch]));
      rows.push(h("div", { class: "prow wide" },
        h("div", { class: "hint", style: "padding:2px 0" },
          "Tint multiplies the colours, so it can only darken: black artwork stays black.")));
    }

    if (mode === "advanced") {
      const base = () => colorAtFrame(this.store, node);
      rows.push(this.row("Red", [pct("R", current.rM, (v) => ({ ...base(), rM: v }))]));
      rows.push(this.row("Green", [pct("G", current.gM, (v) => ({ ...base(), gM: v }))]));
      rows.push(this.row("Blue", [pct("B", current.bM, (v) => ({ ...base(), bM: v }))]));
    }

    const blend = h("select", { class: "preview-anim" },
      ...BLEND_MODES.map(([value, label]) => h("option", { value }, label)));
    blend.value = node.blendMode ?? "normal";
    blend.disabled = isInstance;
    on(blend, "change", () => {
      this.store.apply(new SetNodeBlendMode(
        this.store.currentSymbolId, ids, blend.value as BlendMode,
      ));
      this.store.emit("stage");
      this.store.emit("doc");
    });
    rows.push(this.row("Blend", [blend]));

    const blurStrength = new NumberField({
      glyph: "", min: 0, max: 200, step: 1, decimals: 0, unit: "%",
      onInput: (v, committing) => {
        this.scrubStep("node.motionBlur", committing);
        this.store.apply(new SetNodeMotionBlur(this.store.currentSymbolId, ids, v / 100));
        this.store.emit("doc");
        if (committing) this.store.history.endInteraction();
      },
    });
    blurStrength.set(Math.round((node.motionBlur ?? 1) * 100));
    rows.push(this.row("Motion blur", [blurStrength.el]));
    if (!this.store.project.motionBlur?.enabled) {
      rows.push(h("div", { class: "prow wide" },
        h("div", { class: "hint", style: "padding:2px 0" },
          "Motion blur is off for this document. Click an empty spot on the stage to turn it on under Document.")));
    }
    if (isInstance) {
      rows.push(h("div", { class: "prow wide" },
        h("div", { class: "hint", style: "padding:2px 0" },
          "Symbol instances are not in the Spine export yet, so their colour " +
          "and blend do not reach it either.")));
    }

    return this.section("Color Effect", true, rows);
  }

  /** Bone length: the second segment of a two-bone IK solve, not decoration. */
  private boneSection(node: Node): HTMLElement {
    const length = new NumberField({
      glyph: "L", min: 1, max: 4096, step: 1, decimals: 0,
      onInput: (v, committing) => {
        this.scrubStep("bone.length", committing);
        this.store.apply(new SetBoneLength(
          this.store.currentSymbolId, new Map([[node.id, v]]),
        ));
        this.store.emit("stage");
        if (committing) this.store.history.endInteraction();
      },
    });
    length.set(node.boneLength ?? 0);

    // What dragging this bone's path on the stage turns (core/doc/pathEdit.ts).
    const drag = h("select", { class: "preview-anim", title: "Dragging this bone's path turns this bone alone, or it and its parent. Hold ⌥ to use the other for one drag." },
      h("option", { value: "" }, "This bone"), h("option", { value: "parent" }, "With parent"));
    drag.value = node.pathDrag ?? "";
    on(drag, "change", () => {
      this.store.apply(new SetPathDrag(this.store.currentSymbolId, [node.id], drag.value === "parent" ? "parent" : undefined));
      this.store.emit("doc");
    });
    // A main bone (a leg, an arm, the head): the stage toolbar's Primary row governs it.
    const primary = h("input", { type: "checkbox", class: "switch", title: "A main bone: the stage toolbar's Primary row shows, picks and names it instead of the Bones row" }) as HTMLInputElement;
    primary.checked = !!node.primary;
    on(primary, "change", () => {
      const ids = this.store.selection.nodes.filter((id) => this.store.currentSymbol.nodes[id]?.kind === "bone");
      this.store.apply(new SetBonePrimary(this.store.currentSymbolId, ids.length ? ids : [node.id], primary.checked));
      this.store.emit("doc");
    });
    // Spine's bone colour: the stage and the Tree draw it; exported as nonessential data.
    const color = h("input", { type: "color", class: "bone-color", title: "This bone's colour on the stage and in the Tree" }) as HTMLInputElement;
    color.value = `#${(node.boneColor ?? "989898").slice(0, 6)}`;
    const setColor = (value: string | undefined, label: string) => {
      const ids = this.store.selection.nodes.filter((id) => this.store.currentSymbol.nodes[id]?.kind === "bone");
      this.store.transaction(label, () => {
        for (const id of ids.length ? ids : [node.id]) {
          this.store.apply(new EditNode(label, this.store.currentSymbolId, id, (n) => {
            const out = { ...n };
            if (value) out.boneColor = value; else delete out.boneColor;
            return out;
          }));
        }
      });
      this.store.emit("stage");
    };
    on(color, "change", () => setColor(`${color.value.slice(1)}ff`, "Bone Colour"));
    const reset = h("button", { class: "btn", title: "Spine's default bone colour" }, "Default");
    on(reset, "click", () => setColor(undefined, "Default Bone Colour"));
    return this.section("Bone", true, [
      this.row("Length", [length.el]), this.row("Path drag", [drag]), this.row("Primary", [primary]),
      this.row("Colour", [color, ...(node.boneColor ? [reset] : [])]),
    ]);
  }

  /**
   * Every constraint this bone takes part in — as the target doing the
   * pulling, as the effector being solved, or as the chain ROOT, which the
   * constraint never names and the solver moves anyway.
   *
   * A list, not a lookup: one target can drive several chains, and `find`
   * showed the first and hid the rest. The named bones matter more than the
   * options do — a target is parented OUTSIDE the chain it drives, so nothing
   * in the layer tree says what it is attached to, and this section is the
   * only place that spells the relationship out.
   */
  private ikSection(node: Node): HTMLElement | null {
    const symbol = this.store.currentSymbol;
    const relations = ikRelations(symbol, node.id);
    if (relations.length === 0) return null;
    const nameOf = (id: NodeId) => symbol.nodes[id]?.name ?? "\u2014";

    const rows: HTMLElement[] = [];
    for (const rel of relations) {
      const constraint = rel.constraint;
      const write = (patch: IkPatch) => {
        this.store.apply(new SetIkOptions(this.store.currentSymbolId, constraint.id, patch));
        this.store.emit("stage");
        this.store.emit("doc");
      };

      const chainSel = h("select", { class: "preview-anim" },
        h("option", { value: "1" }, "2 bones"),
        h("option", { value: "0" }, "1 bone"));
      chainSel.value = String(constraint.chain);
      on(chainSel, "change", () => write({ chain: chainSel.value === "1" ? 1 : 0 }));

      // In Animate mode the mix and bend are keyed at the playhead (Spine's
      // IK timeline); in Setup mode they are the constraint's own.
      const animate = this.store.ui.mode === "animate" ? this.store.currentAnimation : null;
      const keysOf = () => this.store.currentAnimation?.ik?.[constraint.id] ?? [];
      const poseNow = () => ikPoseAt(constraint, this.store.currentAnimation, this.store.ui.frame);
      const keyAt = (pose: IkPose, label: string, kind?: string) =>
        doSetIkKeys(this.store, constraint.id, withIkKey(keysOf(), this.store.ui.frame, pose, constraint.softness), label, kind);

      const bend = h("button", { class: "btn" }, constraint.bendPositive ? "Positive" : "Negative");
      on(bend, "click", () => {
        if (!animate) { write({ bendPositive: !constraint.bendPositive }); return; }
        const now = poseNow();
        keyAt({ ...now, bendPositive: !now.bendPositive }, "IK Bend");
      });

      const weight = new NumberField({
        glyph: animate ? "M" : "W", min: 0, max: 1, step: 0.05, decimals: 2, sensitivity: 200,
        onInput: (v, committing) => {
          if (animate) {
            this.scrubStep("ik.key", committing);
            keyAt({ ...poseNow(), mix: v }, "IK Mix", "ik.key");
          } else {
            this.scrubStep("ik.options", committing);
            write({ weight: v });
          }
          if (committing) this.store.history.endInteraction();
        },
      });
      weight.set(constraint.weight);

      // Softness eases a two-bone chain into straight near full reach.
      const softness = new NumberField({
        glyph: "S", min: 0, step: 1, decimals: 1, sensitivity: 4, unit: "px",
        onInput: (v, committing) => {
          if (animate) {
            this.scrubStep("ik.key", committing);
            keyAt({ ...poseNow(), softness: v }, "IK Softness", "ik.key");
          } else {
            this.scrubStep("ik.options", committing);
            write({ softness: v });
          }
          if (committing) this.store.history.endInteraction();
        },
      });
      softness.set(constraint.softness ?? 0);

      // Stretch and compress scale the bone along its length (Spine's IK
      // options); scale y follows the stretch, keeps the area, or stays.
      const check = (label: string, title: string, read: () => boolean, patch: (on: boolean) => IkPatch) => {
        const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
        box.checked = read();
        on(box, "change", () => write(patch(box.checked)));
        this.ikSync.push(() => { box.checked = read(); });
        return { label: h("label", { class: "switch-label", title }, box, label) };
      };
      const live = () => this.store.currentSymbol.ik.find((k) => k.id === constraint.id) ?? constraint;
      const stretchBox = check("Stretch", "Scale the bones along their length to reach a target out of reach", () => !!live().stretch, (v) => ({ stretch: v }));
      const compressBox = check("Compress", "Scale the bone down for a target nearer than its length", () => !!live().compress, (v) => ({ compress: v }));
      const scaleYSel = h("select", { class: "preview-anim", title: "What scale y does when a bone stretches or compresses" }) as HTMLSelectElement;
      for (const [value, text] of [["", "Stays"], ["uniform", "Follows (uniform)"], ["volume", "Keeps the area (volume)"]]) scaleYSel.appendChild(h("option", { value }, text));
      scaleYSel.value = live().scaleY ?? "";
      on(scaleYSel, "change", () => write({ scaleY: (scaleYSel.value || null) as IkPatch["scaleY"] }));
      this.ikSync.push(() => { scaleYSel.value = live().scaleY ?? ""; });

      const key = h("button", { class: "btn", title: "Key the mix and bend in force here" }, "Key");
      on(key, "click", () => keyAt(poseNow(), "Key IK"));
      if (animate) {
        this.ikSync.push(() => {
          const now = poseNow();
          bend.textContent = now.bendPositive ? "Positive" : "Negative";
          weight.show(now.mix);
          softness.show(now.softness);
          const keyed = keysOf().some((k) => k.frame === this.store.ui.frame);
          key.textContent = keyed ? "Keyed" : "Key";
          (key as HTMLButtonElement).disabled = keyed;
        });
      }

      const remove = h("button", { class: "btn" }, "Remove");
      on(remove, "click", () => {
        this.store.apply(new RemoveIkConstraint(this.store.currentSymbolId, constraint.id));
        this.store.emit("stage");
        this.store.emit("doc");
      });

      const role = rel.role === "target" ? "Target: drag this"
        : rel.role === "root" ? "Solved bone (chain root)"
        : "Solved bone (effector)";

      // Which bones this constraint MOVES, root first, and which one pulls
      // them. Both named, whichever end of the constraint is selected: the
      // question is always "what is on the other side of this?".
      // The names are the navigation. A constraint's cast is scattered down
      // the layer column — the target is not even near the bones, since it is
      // parented outside the chain — so reading a name here and then hunting
      // for its row is the actual work this section was leaving to the user.
      const chainLinks: LinkPart[] = [];
      rel.chain.forEach((id, i) => {
        if (i > 0) chainLinks.push(" \u2192 ");
        chainLinks.push({ text: nameOf(id), select: [id] });
      });

      rows.push(
        // The constraint itself has no layer: clicking it selects everything
        // it touches, which is the nearest true answer.
        this.linkRow("Constraint", [{
          text: constraint.name,
          select: [...rel.chain, constraint.targetId],
          title: "Select the target and every bone it moves",
        }]),
        this.staticRow("Role", role),
        this.linkRow("Solves", chainLinks),
        // The pulling end, unless it is the node already selected.
        ...(rel.role === "target" ? [] : [this.linkRow("Target", [
          { text: nameOf(constraint.targetId), select: [constraint.targetId] },
        ])]),
        this.row("Chain", [chainSel]),
        this.row("Bend", [bend]),
        this.row(animate ? "Mix" : "Weight", [weight.el]),
        ...(rel.chain.length > 1 ? [this.row("Softness", [softness.el])] : []),
        this.row("Scale", [stretchBox.label, ...(rel.chain.length > 1 ? [] : [compressBox.label])]),
        this.row("Scale Y", [scaleYSel]),
        ...(animate ? [this.row("", [key])] : []),
        this.row("", [remove]),
      );
    }

    // Two things nothing else in the UI answers: where targets come from, and
    // which mode a drag writes into. Setup moves the rest pose the file
    // carries; Animate keys the target at the playhead. The solved bones are
    // never keyed either way \u2014 the runtime re-solves them on playback, so a
    // keyframe on one fights the solver and the preview drifts off the stage.
    rows.push(this.noteRow(
      "To add IK, pick the IK tool (K) and click the last bone of a chain: a target "
      + "appears at its end. Drag the target to pose the chain. In Animate mode that "
      + "sets a keyframe on the target, in Setup mode it changes the rest pose. The "
      + "bones themselves never get keyframes: they follow the target. In Animate mode "
      + "Mix and Bend are keyed at the playhead, on the constraint's IK row.",
    ));

    return this.section("IK", true, rows);
  }

  /**
   * A row of names that select what they name. A part with no live node falls
   * back to plain text rather than a dead link — a constraint can outlive the
   * bone it points at while the document is mid-edit.
   */
  private linkRow(label: string, parts: LinkPart[]): HTMLElement {
    const symbol = this.store.currentSymbol;
    const fields = h("div", { class: "fields links" });
    for (const part of parts) {
      if (typeof part === "string") {
        fields.appendChild(h("span", { class: "hint sep" }, part));
        continue;
      }
      const live = part.select.filter((id) => symbol.nodes[id]);
      if (live.length === 0) {
        fields.appendChild(h("span", { class: "hint" }, part.text));
        continue;
      }
      const btn = h("button", {
        class: "nodelink",
        title: part.title ?? `Select ${part.text}`,
      }, part.text);
      on(btn, "click", () => this.store.selectNodes(live));
      fields.appendChild(btn);
    }
    return h("div", { class: "prow" }, h("label", null, label), fields);
  }

  /**
   * The transform constraints this bone takes part in, as the source or as one
   * of the bones that follow it, and a button that makes the selected bones
   * follow another (ARCHITECTURE ▸ Transform constraints). In Animate mode the
   * mixes are keyed at the playhead; offsets and the switches belong to the
   * constraint itself.
   */
  private transformSection(node: Node): HTMLElement {
    const symbol = this.store.currentSymbol;
    const nameOf = (id: NodeId) => symbol.nodes[id]?.name ?? "\u2014";
    const animate = this.store.ui.mode === "animate" ? this.store.currentAnimation : null;
    const rows: HTMLElement[] = [];
    const list = () => this.store.currentSymbol.transforms ?? [];
    const replace = (k: TransformConstraint, label: string, kind?: string) =>
      doSetTransforms(this.store, list().map((c) => (c.id === k.id ? k : c)), label, kind);

    for (const k of symbol.transforms ?? []) {
      if (k.sourceId !== node.id && !k.boneIds.includes(node.id)) continue;
      const current = () => list().find((c) => c.id === k.id) ?? k;
      const keysOf = () => this.store.currentAnimation?.transforms?.[k.id] ?? [];
      const boneLinks: LinkPart[] = [];
      k.boneIds.forEach((id, i) => {
        if (i > 0) boneLinks.push(", ");
        boneLinks.push({ text: nameOf(id), select: [id] });
      });
      rows.push(
        this.linkRow("Constraint", [{ text: k.name, select: [k.sourceId, ...k.boneIds], title: "Select the source and every bone that follows it" }]),
        this.linkRow("Source", [{ text: nameOf(k.sourceId), select: [k.sourceId] }]),
        this.linkRow("Bones", boneLinks),
      );

      const MIX_LABEL: Record<TcChannel, string> = { rotate: "Rotate", x: "X", y: "Y", scaleX: "Scale X", scaleY: "Scale Y", shearY: "Shear Y" };
      for (const c of usedMixes(k)) {
        const field = new NumberField({
          glyph: "%", min: 0, max: 1, step: 0.05, decimals: 2, sensitivity: 200,
          onInput: (v, committing) => {
            if (animate) {
              this.scrubStep("tc.key", committing);
              const now = tcMixAt(current(), this.store.currentAnimation, this.store.ui.frame);
              doSetTcKeys(this.store, k.id, withTcKey(keysOf(), this.store.ui.frame, { ...now, [c]: v }), "Transform Mix", "tc.key");
            } else {
              this.scrubStep(`tc.mix.${k.id}.${c}`, committing);
              const cur = current();
              replace({ ...cur, mix: { ...cur.mix, [c]: v } }, "Transform Mix", `tc.mix.${k.id}.${c}`);
            }
            if (committing) this.store.history.endInteraction();
          },
        });
        field.set(k.mix[c]);
        if (animate) this.ikSync.push(() => field.show(tcMixAt(current(), this.store.currentAnimation, this.store.ui.frame)[c]));
        rows.push(this.row(`Mix ${MIX_LABEL[c]}`, [field.el]));
      }
      if (animate) {
        const key = h("button", { class: "btn", title: "Key every mix in force here" }, "Key");
        on(key, "click", () => doSetTcKeys(this.store, k.id,
          withTcKey(keysOf(), this.store.ui.frame, tcMixAt(current(), this.store.currentAnimation, this.store.ui.frame)), "Key Transform"));
        this.ikSync.push(() => {
          const keyed = keysOf().some((x) => x.frame === this.store.ui.frame);
          key.textContent = keyed ? "Keyed" : "Key";
          (key as HTMLButtonElement).disabled = keyed;
        });
        rows.push(this.row("", [key]));
      } else {
        for (const c of TC_CHANNELS) {
          const field = new NumberField({
            glyph: c === "rotate" || c === "shearY" ? "°" : c.startsWith("scale") ? "×" : "px",
            step: c.startsWith("scale") ? 0.01 : 1, decimals: c.startsWith("scale") ? 3 : 1, sensitivity: c.startsWith("scale") ? 200 : 4,
            onInput: (v, committing) => {
              this.scrubStep(`tc.offset.${k.id}.${c}`, committing);
              const cur = current();
              const offsets = { ...cur.offsets, [c]: v };
              if (!v) delete offsets[c];
              replace({ ...cur, offsets }, "Transform Offset", `tc.offset.${k.id}.${c}`);
              if (committing) this.store.history.endInteraction();
            },
          });
          field.set(k.offsets?.[c] ?? 0);
          rows.push(this.row(`Offset ${MIX_LABEL[c]}`, [field.el]));
        }
      }
      const toggle = (f: "localSource" | "localTarget" | "additive" | "clamp", label: string, title: string) => {
        const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
        box.checked = !!k[f];
        on(box, "change", () => {
          const cur = current();
          const next = { ...cur };
          if (box.checked) next[f] = true; else delete next[f];
          replace(next, label);
        });
        return h("label", { class: "switch-label", title }, box, label);
      };
      rows.push(this.row("", [
        toggle("localSource", "Local source", "Read the source's local values instead of its world ones"),
        toggle("localTarget", "Local bones", "Write the bones' local values instead of their world ones"),
      ]));
      rows.push(this.row("", [
        toggle("additive", "Relative", "Add the source's values to the bones' own instead of replacing them"),
        toggle("clamp", "Clamp", "Keep each value between its offset and its maximum"),
      ]));
      const remove = h("button", { class: "btn" }, "Remove");
      on(remove, "click", () => doSetTransforms(this.store, list().filter((c) => c.id !== k.id), `Remove "${k.name}"`));
      rows.push(this.row("", [remove]));
      const identity = k.properties.every((p) => p.to.length === 1 && p.to[0]!.to === p.from && p.to[0]!.scale === 1 && !p.to[0]!.offset && !p.offset);
      if (!identity) rows.push(this.noteRow("This constraint maps one property to another (from the file it was opened from); the map is kept and exported as it is."));
    }

    const add = h("button", { class: "btn", title: "Make the selected bones follow a bone you choose next" }, "Follow a Bone…");
    on(add, "click", async () => {
      const sym = this.store.currentSymbol;
      const followers = this.store.selectedNodes.filter((n) => n.kind === "bone").map((n) => n.id);
      const choices = Object.values(sym.nodes).filter((n) => n.kind === "bone" && !followers.includes(n.id));
      const picked = await chooseDialog({
        title: "Follow a Bone",
        message: `${followers.map(nameOf).join(", ")} will follow the bone you choose.`,
        options: choices.map((n) => n.name),
        ok: "Follow",
      });
      const now = this.store.currentSymbol;
      const source = choices.find((n) => n.name === picked);
      if (!source || now.id !== sym.id) return;
      const plan = transformPlan(now, followers, source.id, newTcId());
      if ("refused" in plan) { await alertDialog({ title: "Follow a Bone", message: plan.refused }); return; }
      doSetTransforms(this.store, [...(now.transforms ?? []), plan], `Transform Constraint "${plan.name}"`);
    });
    rows.push(this.row("", [add]));
    rows.push(this.noteRow("Offsets are as Spine writes them: y up, angles counter-clockwise. In Animate mode the mixes are keyed at the playhead."));
    return this.section("Transform", (symbol.transforms ?? []).some((k) => k.sourceId === node.id || k.boneIds.includes(node.id)), rows);
  }

  /**
   * The image as a mesh (ARCHITECTURE ▸ Meshes): make or remove it, bind it to
   * bones, and the Mesh tool's weight brush.
   */
  private meshSection(node: Node): HTMLElement {
    const mesh = node.mesh;
    const btn = (label: string, command: string, title: string) => {
      const b = h("button", { class: "btn", title }, label);
      on(b, "click", () => this.run(command));
      return b;
    };
    const rows: HTMLElement[] = [];
    if (!mesh) {
      rows.push(this.row("", [btn("Make Mesh", "modify.makeMesh", "Turn the image into a mesh from its outline")]));
      rows.push(this.noteRow("A mesh can bend: bind it to bones, or key its points with the Mesh tool (N) in Animate mode."));
      return this.section("Mesh", false, rows);
    }
    rows.push(this.staticRow("Points", `${mesh.points.length / 2} (${mesh.hull} on the outline), ${mesh.triangles.length / 3} triangles`));
    rows.push(this.staticRow("Follows", mesh.weights ? `${new Set(mesh.weights.flat().map(([b]) => b)).size} bone(s), weighted` : "its own node"));
    rows.push(this.row("", [
      btn("Bind to Bones", "modify.bindMesh", "Weight the mesh to the bones selected with it (⇧-click them), each point to the nearest two"),
      ...(mesh.weights ? [btn("Unbind", "modify.unbindMesh", "Follow its own node again")] : []),
    ]));
    rows.push(this.row("", [
      btn("Edit Points", "tool.mesh", "The Mesh tool: drag points, click inside to add, Delete to remove; in Animate, keys a deform"),
      btn("Remove Mesh", "modify.removeMesh", "Back to a plain image; its deform keys go too"),
    ]));

    // The weight brush: the Mesh tool paints the chosen bone's weight.
    const paint = this.store.ui.meshPaint;
    const sym = this.store.currentSymbol;
    const set = (patch: Partial<typeof paint>) => this.store.setUi({ meshPaint: { ...this.store.ui.meshPaint, ...patch } }, "stage");
    const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
    box.checked = paint.on;
    on(box, "change", () => { set({ on: box.checked }); if (box.checked) this.run("tool.mesh"); });
    const boneSel = h("select", { class: "preview-anim" }) as HTMLSelectElement;
    boneSel.appendChild(h("option", { value: node.id }, `${node.name} (its own)`));
    for (const b of Object.values(sym.nodes).filter((n) => n.kind === "bone")) boneSel.appendChild(h("option", { value: b.id }, b.name));
    boneSel.value = paint.bone && (paint.bone === node.id || sym.nodes[paint.bone]?.kind === "bone") ? paint.bone : node.id;
    if (paint.bone !== boneSel.value) queueMicrotask(() => set({ bone: boneSel.value as NodeId }));
    on(boneSel, "change", () => set({ bone: boneSel.value as NodeId }));
    const radius = new NumberField({ glyph: "R", min: 4, max: 400, step: 1, decimals: 0, unit: "px", onInput: (v) => set({ radius: v }) });
    radius.set(paint.radius);
    const strength = new NumberField({ glyph: "%", min: 0.01, max: 1, step: 0.01, decimals: 2, sensitivity: 200, onInput: (v) => set({ strength: v }) });
    strength.set(paint.strength);
    rows.push(this.row("Weights", [h("label", { class: "switch-label", title: "Drag over points with the Mesh tool to add this bone's weight" }, box, "Paint")]));
    rows.push(this.row("Bone", [boneSel]));
    rows.push(this.row("Brush", [radius.el, strength.el]));
    return this.section("Mesh", true, rows);
  }

  /**
   * Rows editing one physics, slider or path constraint by `specs`, each
   * synced with the document; a value at Spine's default is written absent.
   */
  private constraintRows<F extends ConstraintField>(field: F, id: CnId, specs: ConstraintSpec[]): HTMLElement[] {
    type K = NonNullable<SymbolItem[F]>[number];
    const current = (): K | undefined => (this.store.currentSymbol[field] as K[] | undefined)?.find((k) => k.id === id);
    const write = (key: string, value: unknown, def: unknown, label: string, committing: boolean) => {
      const list = (this.store.currentSymbol[field] ?? []) as K[];
      const next = list.map((k) => {
        if (k.id !== id) return k;
        const out = { ...k } as Record<string, unknown>;
        if (value === def || value === undefined || value === "") delete out[key]; else out[key] = value;
        return out as unknown as K;
      });
      const kind = `constraint.edit.${id}.${key}`;
      this.scrubStep(kind, committing);
      doSetConstraints(this.store, field, next as NonNullable<SymbolItem[F]>, label, kind);
      if (committing) this.store.history.endInteraction();
    };
    const read = (key: string, def: unknown) => (current() as Record<string, unknown> | undefined)?.[key] ?? def;
    return specs.map((spec) => {
      if (spec.type === "number") {
        const nf = new NumberField({
          glyph: spec.glyph, min: spec.min, max: spec.max, step: spec.step, decimals: spec.decimals ?? 2, unit: spec.unit,
          onInput: (v, committing) => write(spec.key, v, spec.def, spec.label, committing),
        });
        nf.set(read(spec.key, spec.def) as number);
        this.ikSync.push(() => nf.show(read(spec.key, spec.def) as number));
        return this.row(spec.label, [nf.el]);
      }
      if (spec.type === "select") {
        const sel = h("select", { class: "preview-anim" }) as HTMLSelectElement;
        for (const [value, text] of spec.options) sel.appendChild(h("option", { value }, text));
        sel.value = String(read(spec.key, spec.def));
        on(sel, "change", () => write(spec.key, sel.value, spec.def, spec.label, true));
        this.ikSync.push(() => { sel.value = String(read(spec.key, spec.def)); });
        return this.row(spec.label, [sel]);
      }
      const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
      box.checked = read(spec.key, false) === true;
      on(box, "change", () => write(spec.key, box.checked || undefined, undefined, spec.label, true));
      this.ikSync.push(() => { box.checked = read(spec.key, false) === true; });
      return this.row("", [h("label", { class: "switch-label", title: spec.title ?? "" }, box, spec.label)]);
    });
  }

  private removeButton<F extends ConstraintField>(field: F, id: CnId, label: string): HTMLElement {
    const b = h("button", { class: "btn" }, "Remove");
    on(b, "click", () => {
      const list = ((this.store.currentSymbol[field] ?? []) as Array<{ id: CnId }>).filter((k) => k.id !== id);
      doSetConstraints(this.store, field, list as NonNullable<SymbolItem[F]>, label);
    });
    return b;
  }

  /** Physics on a bone (Spine's physics constraint): it lags, springs and
   *  sways, simulated by the runtime while the stage and the Preview play. */
  private physicsSection(bone: Node): HTMLElement {
    const sym = this.store.currentSymbol;
    const mine = (sym.physics ?? []).filter((k) => k.boneId === bone.id);
    const rows: HTMLElement[] = [];
    const d = PHYSICS_DEFAULTS;
    const num = (key: PhysicsSetting, label: string, glyph: string, min: number, max: number, step: number): ConstraintSpec =>
      ({ type: "number", key, label, glyph, min, max, step, def: d[key] });
    for (const k of mine) {
      rows.push(this.staticRow("Constraint", k.name));
      rows.push(...this.constraintRows("physics", k.id, [
        num("x", "Move X", "X", 0, 1, 0.05), num("y", "Move Y", "Y", 0, 1, 0.05), num("rotate", "Rotate", "∠", 0, 1, 0.05),
        num("scaleX", "Scale X", "S", 0, 1, 0.05), num("shearX", "Shear X", "⧄", 0, 1, 0.05),
        num("inertia", "Inertia", "I", 0, 1, 0.05), num("strength", "Strength", "K", 0, 1000, 1), num("damping", "Damping", "D", 0, 1, 0.01),
        num("mass", "Mass", "M", 0.01, 100, 0.1), num("wind", "Wind", "W", -1000, 1000, 1), num("gravity", "Gravity", "G", -1000, 1000, 1),
        num("mix", "Mix", "%", 0, 1, 0.05), num("limit", "Limit", "L", 0, 100000, 10), num("fps", "Steps/s", "#", 1, 240, 1),
      ]));
      rows.push(this.row("", [this.removeButton("physics", k.id, "Remove Physics")]));
    }
    const add = h("button", { class: "btn", title: "This bone lags, springs and sways as its parent moves (Spine's physics)" }, mine.length ? "Add Another" : "Add Physics");
    on(add, "click", () => doAddPhysics(this.store, bone.id));
    rows.push(this.row("", [add]));
    rows.push(this.noteRow("The stage simulates physics while it plays and shows it at rest when you scrub; the Preview plays it."));
    return this.section("Physics", mine.length > 0, rows);
  }

  /** Sliders this bone drives (Spine 4.3): an animation played by one of its values. */
  private sliderSection(bone: Node): HTMLElement {
    const sym = this.store.currentSymbol;
    const mine = (sym.sliders ?? []).filter((k) => k.boneId === bone.id);
    const rows: HTMLElement[] = [];
    for (const k of mine) {
      rows.push(this.staticRow("Constraint", k.name));
      rows.push(...this.constraintRows("sliders", k.id, [
        { type: "select", key: "animId", label: "Plays", options: sym.animations.map((a) => [a.id, a.name]), def: "" },
        { type: "select", key: "property", label: "By its", options: SLIDER_PROPERTIES.map((p) => [p, p]), def: "rotate" },
        { type: "number", key: "from", label: "From", glyph: "↦", min: -100000, max: 100000, step: 1, def: 0 },
        { type: "number", key: "to", label: "At (s)", glyph: "t", min: -1000, max: 1000, step: 0.05, def: 0 },
        { type: "number", key: "scale", label: "s per unit", glyph: "×", min: -100, max: 100, step: 0.001, decimals: 4, def: 1 },
        { type: "number", key: "mix", label: "Mix", glyph: "%", min: 0, max: 1, step: 0.05, def: 1 },
        { type: "check", key: "loop", label: "Loop" },
        { type: "check", key: "additive", label: "Additive" },
        { type: "check", key: "local", label: "Local value" },
      ]));
      rows.push(this.row("", [this.removeButton("sliders", k.id, "Remove Slider")]));
    }
    const add = h("button", { class: "btn", title: "Play an animation by this bone's rotation (Spine's slider)" }, "Add Slider…");
    on(add, "click", async () => {
      const symbolId = this.store.currentSymbolId;
      const name = await chooseDialog({ title: "Add Slider", message: `Which animation does ${bone.name} play as it turns?`, options: this.store.currentSymbol.animations.map((a) => a.name), ok: "Add" });
      const anim = this.store.currentSymbol.animations.find((a) => a.name === name);
      if (!anim || this.store.currentSymbolId !== symbolId || !this.store.currentSymbol.nodes[bone.id]) return;
      doAddSlider(this.store, anim.id, bone.id);
    });
    rows.push(this.row("", [add]));
    return this.section("Slider", mine.length > 0, rows);
  }

  /** The path constraints a bone follows or a path node carries, and a
   *  path's own shape settings. */
  private pathSection(node: Node): HTMLElement | null {
    const sym = this.store.currentSymbol;
    const mine = (sym.paths ?? []).filter((k) => k.pathId === node.id || k.boneIds.includes(node.id));
    if (!mine.length && node.kind !== "path") return null;
    const rows: HTMLElement[] = [];
    if (node.kind === "path" && node.path) {
      const shape = node.path;
      const flag = (label: string, read: () => boolean, patch: (on: boolean) => Partial<PathShape>) => {
        const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
        box.checked = read();
        on(box, "change", () => {
          this.store.apply(new EditNode(label, this.store.currentSymbolId, node.id, (n) => {
            const next = { ...n.path!, ...patch(box.checked) };
            if (!next.closed) delete next.closed;
            if (next.constantSpeed !== false) delete next.constantSpeed;
            return { ...n, path: next };
          }));
          this.store.emit("stage");
        });
        return h("label", { class: "switch-label" }, box, label);
      };
      rows.push(this.staticRow("Knots", String(shape.points.length / 6)));
      rows.push(this.row("", [flag("Closed", () => !!shape.closed, (v) => ({ closed: v })), flag("Constant speed", () => shape.constantSpeed !== false, (v) => ({ constantSpeed: v }))]));
      const edit = h("button", { class: "btn", title: "The Mesh tool (N): drag knots (their handles follow) and handles; Delete removes a knot" }, "Edit Points");
      on(edit, "click", () => this.run("tool.mesh"));
      rows.push(this.row("", [edit]));
    }
    for (const k of mine) {
      rows.push(this.staticRow("Constraint", `${k.name}: ${k.boneIds.map((id) => sym.nodes[id]?.name ?? "?").join(", ")}`));
      rows.push(...this.constraintRows("paths", k.id, [
        { type: "select", key: "positionMode", label: "Position", options: [["percent", "Percent"], ["fixed", "Fixed"]], def: "percent" },
        { type: "number", key: "position", label: "At", glyph: "→", min: -100000, max: 100000, step: 0.01, def: 0 },
        { type: "select", key: "spacingMode", label: "Spacing", options: [["length", "Bone length"], ["fixed", "Fixed"], ["percent", "Percent"], ["proportional", "Proportional"]], def: "length" },
        { type: "number", key: "spacing", label: "Gap", glyph: "↔", min: -100000, max: 100000, step: 0.5, def: 0 },
        { type: "select", key: "rotateMode", label: "Rotate", options: [["tangent", "Tangent"], ["chain", "Chain"], ["chainScale", "Chain, scaled"]], def: "tangent" },
        { type: "number", key: "rotation", label: "Offset", glyph: "∠", min: -360, max: 360, step: 1, unit: "°", def: 0 },
        { type: "number", key: "mixRotate", label: "Mix rotate", glyph: "%", min: 0, max: 1, step: 0.05, def: 1 },
        { type: "number", key: "mixX", label: "Mix X", glyph: "%", min: 0, max: 1, step: 0.05, def: 1 },
        { type: "number", key: "mixY", label: "Mix Y", glyph: "%", min: 0, max: 1, step: 0.05, def: 1 },
      ]));
      rows.push(this.row("", [this.removeButton("paths", k.id, "Remove Path Constraint")]));
    }
    return this.section("Path", true, rows);
  }

  /**
   * A sequence (ARCHITECTURE ▸ Sequences): made from the library images
   * numbered like this one; the setup frame; in Animate, the key in force at
   * the playhead (mode, first image, frames per image), edited by keying here.
   */
  private sequenceSection(node: Node): HTMLElement {
    const rows: HTMLElement[] = [];
    const seq = node.sequence;
    if (!seq) {
      const make = h("button", { class: "btn", title: "Use the library images numbered like this one (fire_01, fire_02, …) as frames" }, "Make Sequence");
      on(make, "click", () => {
        const problem = doMakeSequence(this.store, node.id);
        if (problem) void alertDialog({ title: "Make Sequence", message: problem });
      });
      rows.push(this.row("", [make]));
      rows.push(this.noteRow("Frame-by-frame images in one layer, as Spine's sequence: keys pick which image shows and how they play."));
      return this.section("Sequence", false, rows);
    }
    const names = seq.items.map((id) => this.store.project.items[id]?.name ?? "?");
    rows.push(this.staticRow("Frames", `${seq.items.length}: ${names[0]} … ${names[names.length - 1]}`));
    const setup = new NumberField({
      glyph: "#", min: 0, max: seq.items.length - 1, step: 1, decimals: 0,
      onInput: (v, committing) => { doSetSequenceSetup(this.store, node.id, v); if (committing) this.store.history.endInteraction(); },
    });
    setup.set(seq.setup ?? 0);
    rows.push(this.row("Setup", [setup.el]));
    const anim = this.store.ui.mode === "animate" ? this.store.currentAnimation : null;
    if (anim) {
      const keysOf = () => this.store.currentAnimation?.sequences?.[node.id] ?? [];
      const inForce = (): SequenceKey => {
        const keys = keysOf(), frame = this.store.ui.frame;
        const k = [...keys].reverse().find((x) => x.frame <= frame);
        return k ? { ...k, frame } : { frame, mode: "loop", index: seq.setup ?? 0, delay: 1 };
      };
      const keyWith = (patch: Partial<SequenceKey>, label: string) =>
        doSetSequenceKeys(this.store, node.id, withSequenceKey(keysOf(), { ...inForce(), ...patch, frame: this.store.ui.frame }), label);
      const mode = h("select", { class: "preview-anim", title: "How the images play from the key" }) as HTMLSelectElement;
      for (const m of SEQUENCE_MODES) mode.appendChild(h("option", { value: m }, SEQUENCE_MODE_LABELS[m]));
      on(mode, "change", () => keyWith({ mode: mode.value as SequenceKey["mode"] }, "Sequence Mode"));
      const index = new NumberField({ glyph: "#", min: 0, max: seq.items.length - 1, step: 1, decimals: 0, onInput: (v, c) => { if (c) keyWith({ index: Math.round(v) }, "Sequence Image"); } });
      const delay = new NumberField({ glyph: "⏱", min: 0.05, max: 1000, step: 0.25, decimals: 2, unit: "f", onInput: (v, c) => { if (c) keyWith({ delay: v }, "Sequence Delay"); } });
      const key = h("button", { class: "btn", title: "Key the sequence here with these values" }, "Key");
      on(key, "click", () => keyWith({}, "Key Sequence"));
      const sync = () => {
        const k = inForce();
        mode.value = k.mode;
        index.show(k.index);
        delay.show(k.delay);
        const keyed = keysOf().some((x) => x.frame === this.store.ui.frame);
        key.textContent = keyed ? "Keyed" : "Key";
        (key as HTMLButtonElement).disabled = keyed;
      };
      sync();
      this.ikSync.push(sync);
      rows.push(this.row("Mode", [mode]), this.row("From", [index.el]), this.row("Delay", [delay.el]), this.row("", [key]));
    } else {
      rows.push(this.noteRow("In Animate mode, key which image plays and how at the playhead; the Sequence row shows the keys."));
    }
    const remove = h("button", { class: "btn", title: "Back to one image; the sequence keys go too" }, "Remove Sequence");
    on(remove, "click", () => doRemoveSequence(this.store, node.id));
    rows.push(this.row("", [remove]));
    return this.section("Sequence", true, rows);
  }

  /**
   * Skins (ARCHITECTURE ▸ Skins). On an image: what the skin being edited
   * shows in place of each of its displays, and which displays only skins
   * fill. On a bone: the skins it (with the bones below it) belongs to, and
   * those of the constraints it drives.
   */
  private skinSection(node: Node): HTMLElement {
    const sym = this.store.currentSymbol;
    const named = skinsOf(sym).filter((n) => n !== DEFAULT_SKIN);
    if (!named.length) {
      return this.section("Skins", false, [this.noteRow("No skins. The Skins panel makes them; then each layer can show its own image in each skin.")]);
    }
    const rows: HTMLElement[] = [];
    if (node.kind === "bone") {
      const iks = sym.ik.filter((k) => k.targetId === node.id);
      const tcs = (sym.transforms ?? []).filter((k) => k.sourceId === node.id);
      for (const name of named) {
        const def = sym.skins?.find((d) => d.name === name);
        const check = (label: string, title: string, checked: boolean, run: (on: boolean) => void) => {
          const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
          box.checked = checked;
          on(box, "change", () => run(box.checked));
          return h("label", { class: "switch-label", title }, box, label);
        };
        rows.push(this.row(name, [
          check("Bone", "Only this skin (and others that list it) has the bone and the bones and pictures below it", !!def?.bones?.includes(node.id),
            (v) => doSetSkinMembers(this.store, name, { bones: [node.id] }, v)),
          ...iks.map((k) => check(k.name, `Only this skin solves the IK "${k.name}"`, !!def?.ik?.includes(k.id),
            (v) => doSetSkinMembers(this.store, name, { ik: [k.id] }, v))),
          ...tcs.map((k) => check(k.name, `Only this skin applies the transform constraint "${k.name}"`, !!def?.transforms?.includes(k.id),
            (v) => doSetSkinMembers(this.store, name, { transforms: [k.id] }, v))),
        ]));
      }
      rows.push(this.noteRow("A bone in a skin exists only while a skin listing it shows, with the bones and pictures below it; a constraint in a skin applies only then."));
      return this.section("Skins", named.some((n) => sym.skins?.find((d) => d.name === n)?.bones?.includes(node.id)), rows);
    }

    const edited = editedSkin(sym, this.store.ui.editSkin)!;
    const skinSel = h("select", { class: "preview-anim", title: "The skin edited here (also picked in the Skins panel)" }) as HTMLSelectElement;
    for (const name of named) skinSel.appendChild(h("option", { value: name }, name));
    skinSel.value = edited;
    on(skinSel, "change", () => this.store.setUi({ editSkin: skinSel.value }, "stage"));
    rows.push(this.row("Skin", [skinSel]));
    const images = this.store.project.itemOrder.map((id) => this.store.project.items[id]).filter(isImage);
    const def = sym.skins?.find((d) => d.name === edited);
    displaysOf(node).forEach((own, index) => {
      const ownName = this.store.project.items[own.itemId]?.name ?? "?";
      const sel = h("select", { class: "preview-anim", title: `What “${edited}” shows here` }) as HTMLSelectElement;
      sel.appendChild(h("option", { value: "" }, own.skinOnly ? "— nothing —" : `— ${ownName} (default) —`));
      for (const item of images) sel.appendChild(h("option", { value: item.id }, item.name));
      sel.value = def?.displays?.[node.id]?.[String(index)]?.itemId ?? "";
      on(sel, "change", () => {
        const problem = doSetSkinImage(this.store, edited, node.id, index, (sel.value || null) as ItemId | null);
        if (problem) void alertDialog({ title: "Skin Image", message: problem });
      });
      const only = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
      only.checked = !!own.skinOnly;
      on(only, "change", () => doSetSkinOnly(this.store, node.id, index, only.checked));
      const onlyLabel = h("label", { class: "switch-label", title: `The default skin shows nothing here; only skins fill it (Spine's skin placeholder). ${ownName} stands in while editing.` }, only, "Only in skins");
      rows.push(this.row(index === 0 ? "Image" : `Display ${index}`, [sel]));
      rows.push(this.row("", [onlyLabel]));
    });
    const used = named.some((n) => Object.keys(sym.skins?.find((d) => d.name === n)?.displays?.[node.id] ?? {}).length) || displaysOf(node).some((d) => d.skinOnly);
    return this.section("Skins", used, rows);
  }

  /** A paragraph inside a section, for the rule a row of fields cannot say. */
  /** The symbol's constraints in the order they are applied (ARCHITECTURE ▸
   *  Constraint order), each moved up or down a place. */
  private constraintOrderSection(): HTMLElement | null {
    const entries = constraintEntries(this.store.currentSymbol);
    if (entries.length < 2) return null;
    const move = (name: string, to: number) => {
      const order = withConstraintMoved(this.store.currentSymbol, name, to);
      if (!order) return;
      this.store.apply(new SetConstraintOrder("Constraint Order", this.store.currentSymbolId, order));
      this.store.emit("stage");
      this.store.emit("doc");
    };
    const rows: HTMLElement[] = entries.map((e, i) => {
      const up = h("button", { class: "iconbtn", title: `Apply “${e.name}” before “${entries[i - 1]?.name ?? ""}”` }, "▲") as HTMLButtonElement;
      const down = h("button", { class: "iconbtn", title: `Apply “${e.name}” after “${entries[i + 1]?.name ?? ""}”` }, "▼") as HTMLButtonElement;
      up.disabled = i === 0;
      down.disabled = i === entries.length - 1;
      on(up, "click", () => move(e.name, i - 1));
      on(down, "click", () => move(e.name, i + 1));
      return h("div", { class: "prow" },
        h("label", null, CONSTRAINT_KIND_LABELS[e.kind]),
        h("div", { class: "fields corder" }, h("span", { class: "corder-name", title: e.name }, e.name), up, down));
    });
    rows.push(this.noteRow("Applied from the top down: a constraint lower in the list reads what the ones above it did to the bones."));
    return this.section("Constraints", true, rows);
  }

  private noteRow(text: string): HTMLElement {
    return h("div", { class: "pnote" }, text);
  }

  /**
   * With nothing selected the panel becomes the document's own settings —
   * frame rate, stage size, background — which is where Animate puts them
   * and therefore where people look for them.
   */
  private documentSection(): HTMLElement {
    const p = this.store.project;

    const docField = (
      glyph: string, read: () => number, min: number, max: number,
      write: (v: number) => DocumentSettingsPatch,
    ) => {
      const nf = new NumberField({
        glyph, min, max, step: 1, decimals: 0,
        onInput: (v, committing) => {
          this.scrubStep("doc.settings", committing);
          this.store.apply(new SetDocumentSettings(write(v)));
          this.store.emit("stage");
          this.store.emit("timeline");
          if (committing) this.store.history.endInteraction();
        },
      });
      nf.set(read());
      this.docSync.push(() => nf.show(read()));
      return nf.el;
    };

    const swatch = h("input", { type: "color", value: p.stage.background, class: "swatch" });
    on(swatch, "input", () => {
      this.store.apply(new SetDocumentSettings({ background: swatch.value }));
      this.store.emit("stage");
    });
    this.docSync.push(() => {
      if (document.activeElement !== swatch) swatch.value = this.store.project.stage.background;
    });

    // NOT the document's name on disk — the tab shows the file for that. This
    // is the name the exporter writes into `_ske.json`, uses for the atlas
    // pages and for the export's own file name, so it is the one thing about
    // the project that a runtime actually reads back.
    const nameInput = h("input", {
      type: "text", value: p.name,
      title: "Name of the exported files and of the armature inside them. Not the name of the project file.",
    });
    const commitName = () => {
      const next = nameInput.value.trim();
      if (!next || next === this.store.project.name) { nameInput.value = this.store.project.name; return; }
      this.store.apply(new SetDocumentSettings({ name: next }));
      this.store.emit("doc");
    };
    on(nameInput, "change", commitName);
    on(nameInput, "blur", commitName);
    on(nameInput, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      if (e.key === "Enter") { commitName(); nameInput.blur(); }
      if (e.key === "Escape") { nameInput.value = this.store.project.name; nameInput.blur(); }
      e.stopPropagation();
    });
    this.docSync.push(() => {
      if (document.activeElement !== nameInput) nameInput.value = this.store.project.name;
    });

    // Motion blur is the export's, not the stage's: the runtime extension
    // draws it, so it shows in the Preview only.
    const blur = p.motionBlur ?? DEFAULT_MOTION_BLUR;
    const blurOn = h("input", { type: "checkbox", checked: blur.enabled });
    on(blurOn, "change", () => {
      this.store.apply(new SetDocumentSettings({ motionBlur: { enabled: blurOn.checked } }));
      this.store.emit("doc");
    });
    const blurField = (
      glyph: string, read: () => number, min: number, max: number, unit: string,
      write: (v: number) => DocumentSettingsPatch,
    ) => {
      const nf = new NumberField({
        glyph, min, max, step: 1, decimals: 0, unit,
        onInput: (v, committing) => {
          this.scrubStep("doc.settings", committing);
          this.store.apply(new SetDocumentSettings(write(v)));
          this.store.emit("doc");
          if (committing) this.store.history.endInteraction();
        },
      });
      nf.set(read());
      this.docSync.push(() => nf.show(read()));
      return nf.el;
    };
    const blurOf = () => this.store.project.motionBlur ?? DEFAULT_MOTION_BLUR;
    const blurRows = blur.enabled
      ? [
        this.row("Shutter", [blurField("", () => blurOf().shutter, 0, 360, "°", (v) => ({ motionBlur: { shutter: v } }))]),
        this.row("Max trail", [blurField("", () => blurOf().maxLength, 1, 4096, "px", (v) => ({ motionBlur: { maxLength: v } }))]),
        h("div", { class: "prow wide" },
          h("div", { class: "hint", style: "padding:2px 0" },
            "Motion blur shows only while the animation plays in the Preview, " +
            "not while you edit. Shutter sets the length of the blur: 180° looks like a film " +
            "camera, 360° is twice as long. Max trail caps it in pixels. Each layer's amount " +
            "is under Color Effect.")),
      ]
      : [];

    const frameValue = h("span", { class: "hint" }, `${this.store.ui.frame + 1}`);
    this.docSync.push(() => {
      const text = `${this.store.ui.frame + 1}`;
      if (frameValue.textContent !== text) frameValue.textContent = text;
    });

    return this.section("Document", true, [
      this.row("Name", [nameInput]),
      this.row("FPS", [docField("", () => this.store.project.frameRate, 1, 120, (v) => ({ frameRate: v }))]),
      this.linkedRow("Size", "stage",
        docField("W", () => this.store.project.stage.width, 1, 16384, (v) => ({ width: v })),
        docField("H", () => this.store.project.stage.height, 1, 16384, (v) => ({ height: v }))),
      this.row("Background", [swatch]),
      this.row("Motion blur", [blurOn]),
      ...blurRows,
      h("div", { class: "prow" }, h("label", null, "Frame"), h("div", { class: "fields" }, frameValue)),
      h("div", { class: "prow wide" },
        h("div", { class: "hint", style: "padding:6px 0 2px" },
          "Nothing selected. Drag an item from the Library onto the stage.")),
    ]);
  }

  private instanceSection(count: number): HTMLElement {
    const node = this.store.selectedNodes[0]!;
    const shown = displayAtFrame(this.store, node).display;
    const item = shown ? this.store.project.items[shown.itemId] : undefined;
    const name = h("input", { type: "text", value: count > 1 ? "" : node.name });
    if (count > 1) { name.placeholder = `${count} objects selected`; name.disabled = true; }
    this.nameInput = name;

    const commitName = () => {
      const next = name.value.trim();
      if (count > 1 || !next || next === node.name) { name.value = node.name; return; }
      this.store.apply(new RenameNode(this.store.currentSymbolId, node.id, next));
      this.store.emit("doc");
    };
    on(name, "change", commitName);
    on(name, "blur", commitName);
    on(name, "keydown", (ev) => {
      const e = ev as unknown as KeyboardEvent;
      if (e.key === "Enter") { commitName(); name.blur(); }
      if (e.key === "Escape") { name.value = node.name; name.blur(); }
      e.stopPropagation();
    });

    // An empty layer has no library item at all: saying "Of: empty / Type:
    // Bitmap" would describe artwork that is not there.
    const kindLabel =
      node.kind === "empty" ? "Empty layer"
      : node.kind === "bone" ? "Bone"
      : node.kind === "group" ? "Group"
      : node.kind === "box" ? "Bounding box"
      : node.kind === "point" ? "Point"
      : node.kind === "path" ? "Path"
      : isSymbol(item) ? "Symbol instance"
      : "Bitmap";

    return this.section("Instance", true, [
      this.row("Name", [name]),
      ...(node.kind === "empty" || node.kind === "group" || node.kind === "bone" || node.kind === "box" || node.kind === "point" || node.kind === "path"
        ? []
        : [this.staticRow("Of", item ? item.name : "—")]),
      this.staticRow("Type", kindLabel),
    ]);
  }

  // ── Builders ───────────────────────────────────────────────────────────

  /**
   * "X and Y are not measured the way the screen is."
   *
   * A node's position is the translation of its LOCAL matrix, so it moves
   * along its PARENT's axes — and a bone chain rotates those. `hips` at -90
   * makes `chest`, `head` and everything under them measure y across the stage
   * rather than down it, which reads as a bug the first time you type a number
   * into the field. The badge names the frame and the angle; the stage draws
   * the same thing as a dashed pair of axes.
   */
  private makeFrameNote(): HTMLElement {
    this.frameNote = h("span", { class: "framenote" });
    this.frameNote.hidden = true;
    return this.frameNote;
  }

  /** One frame behind while scrubbing, since the viewport renders on rAF and
   *  this runs on the store event — invisible on a rounded degree value. */
  private syncFrameNote(nodes: Node[]): void {
    const note = this.frameNote;
    if (!note) return;
    note.hidden = true;

    const pose = this.poseOf();
    if (!pose || nodes.length === 0) return;

    // Only when the whole selection shares one parent: two nodes in different
    // frames have no single answer, and a wrong badge is worse than none.
    const parentId = nodes[0]!.parentId;
    if (nodes.some((n) => n.parentId !== parentId)) return;

    const parentWorld = (parentId ? pose.byNode.get(parentId)?.world : null) ?? SCENE_FRAME;
    const dirs = frameDirections(parentWorld);
    if (!dirs) return;

    const sym = this.store.currentSymbol;
    const parentName = parentId ? sym.nodes[parentId]?.name ?? "the parent" : "the scene";
    const angle = `${dirs.rotation > 0 ? "+" : ""}${Math.round(dirs.rotation)}\u00b0`;
    note.textContent = `\u21bb ${angle}`;
    note.title =
      `X and Y follow ${parentName}, which is rotated ${angle}: ` +
      `+X points ${dirs.x}, +Y points ${dirs.y}. The dashed axes on the stage show the same directions.`;
    note.hidden = false;
  }

  private section(
    title: string, open: boolean, rows: HTMLElement[], note?: HTMLElement | null,
  ): HTMLElement {
    const tri = h("span", { class: "tri" });
    const head = h("div", { class: "shead" }, tri, h("span", null, title));
    if (note) head.appendChild(note);
    const body = h("div", { class: "sbody" }, ...rows);
    const sec = h("div", { class: `section${open ? " open" : ""}` }, head, body);
    on(head, "click", () => sec.classList.toggle("open"));
    return sec;
  }

  private row(label: string, controls: HTMLElement[]): HTMLElement {
    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: `fields${controls.length > 1 ? " pair" : ""}` }, ...controls));
  }

  /** A pair of fields with a chain toggle between them. */
  private linkedRow(
    label: string, key: "size" | "scale" | "stage", a: HTMLElement, b: HTMLElement,
  ): HTMLElement {
    const btn = h("button", { class: "iconbtn linkbtn" });
    const paint = () => {
      clear(btn);
      btn.appendChild(icon(this.linked[key] ? "link" : "linkOff", 13));
      cls(btn, "on", this.linked[key]);
      btn.title = this.linked[key]
        ? "Linked: changing one changes the other"
        : "Not linked";
    };
    on(btn, "click", () => {
      this.linked[key] = !this.linked[key];
      saveLinked(key, this.linked[key]);
      paint();
    });
    paint();

    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: "fields pair linked" }, a, btn, b));
  }

  private staticRow(label: string, value: string): HTMLElement {
    return h("div", { class: "prow" },
      h("label", null, label),
      h("div", { class: "fields" }, h("span", { class: "hint" }, value)));
  }

  private field(
    key: FieldKey, glyph: string,
    opts: { step?: number; decimals?: number; unit?: string; sensitivity?: number } = {},
  ): HTMLElement {
    const nf = new NumberField({
      glyph,
      unit: opts.unit,
      step: opts.step ?? 1,
      decimals: opts.decimals ?? 2,
      sensitivity: opts.sensitivity ?? 2,
      onInput: (v, committing) => this.write(key, v, committing),
    });
    this.fields.set(key, nf);
    return nf.el;
  }

  // ── Read / write ───────────────────────────────────────────────────────

  private sync(): void {
    if (this.rebuilding) return;
    if (!this.scrubbing) this.group = null;
    const nodes = this.store.selectedNodes;
    if (this.signatureOf() !== this.signature) {
      this.rebuild();
      return;
    }
    if (nodes.length === 0) {
      for (const update of this.docSync) update();
      return;
    }
    if (this.fields.size === 0) {
      this.rebuild();
      return;
    }
    if (this.nameInput && document.activeElement !== this.nameInput) {
      this.nameInput.value = nodes.length > 1 ? "" : nodes[0]!.name;
    }

    this.syncFrameNote(nodes);
    for (const update of this.ikSync) update();

    this.suppress = true;
    const first = nodes[0]!;
    // In Animate mode the fields show what is on screen at the playhead, not
    // the bind pose — otherwise typing a value would silently jump the object.
    const at = new Map(nodes.map((n) => [n.id, transformAtFrame(this.store, n)]));
    const tfOf = (n: typeof first) => at.get(n.id) ?? n.bind;
    const firstTf = tfOf(first);
    const size = displaySize(this.store.project, first, displayAtFrame(this.store, first).index);
    const pivotOf = (n: typeof first) => displayAtFrame(this.store, n).display?.pivot ?? n.pivot;
    const set = (k: FieldKey, value: number, mixed: boolean) => {
      const f = this.fields.get(k);
      if (!f || f.focused) return;
      if (mixed) f.setMixed(); else f.set(value);
    };
    const varies = (read: (n: typeof first) => number) =>
      nodes.some((n) => Math.abs(read(n) - read(first)) > 1e-6);

    const bounds = this.isGroup(nodes) ? this.groupBounds() : null;
    if (bounds) {
      set("x", bounds.x, false);
      set("y", bounds.y, false);
      set("w", bounds.w, false);
      set("h", bounds.h, false);
    } else {
      set("x", firstTf.x, varies((n) => tfOf(n).x));
      set("y", firstTf.y, varies((n) => tfOf(n).y));
      set("w", size.w * firstTf.scaleX, nodes.length > 1);
      set("h", size.h * firstTf.scaleY, nodes.length > 1);
    }
    set("scaleX", firstTf.scaleX, varies((n) => tfOf(n).scaleX));
    set("scaleY", firstTf.scaleY, varies((n) => tfOf(n).scaleY));
    set("rotation", firstTf.skewY, varies((n) => tfOf(n).skewY));
    set("skewX", firstTf.skewX, varies((n) => tfOf(n).skewX));
    set("skewY", firstTf.skewY, varies((n) => tfOf(n).skewY));
    set("pivotX", pivotOf(first).x, varies((n) => pivotOf(n).x));
    set("pivotY", pivotOf(first).y, varies((n) => pivotOf(n).y));
    this.suppress = false;
  }

  /**
   * Opens a NumberField scrub's interaction on its FIRST step: the field
   * reports no start, and `beginInteraction` on every step closed the entry
   * each time — one undo step per pointermove.
   */
  private scrubStep(kind: string, committing: boolean): void {
    const history = this.store.history;
    if (!committing && !history.inInteraction) history.beginInteraction(kind);
  }

  private write(key: FieldKey, value: number, committing: boolean): void {
    if (this.suppress) return;
    const nodes = this.store.selectedNodes;
    if (nodes.length === 0) return;

    if (key === "pivotX" || key === "pivotY") {
      this.writePivot(key, value, committing);
      return;
    }

    const next = this.isGroup(nodes)
      ? this.groupWrite(key, value)
      : this.singleWrite(nodes, key, value);
    if (!next) return;

    if (!committing && !this.scrubbing) {
      this.store.history.beginInteraction("node.transform");
      this.scrubbing = true;
    }
    applyEdit(this.store, next, this.scrubbing);
    if (committing) {
      if (this.scrubbing) this.store.history.endInteraction();
      this.scrubbing = false;
      this.group = null;
    }
  }

  private singleWrite(nodes: Node[], key: FieldKey, value: number): Map<NodeId, Transform> {
    const next = new Map<NodeId, Transform>();
    for (const n of nodes) {
      const t = cloneTf(transformAtFrame(this.store, n));
      const size = displaySize(this.store.project, n, displayAtFrame(this.store, n).index);
      // Ratio against the value being replaced, so the partner field follows
      // proportionally rather than being set to the same number.
      const ratio = (before: number) =>
        Math.abs(before) > 1e-6 ? value / before : 1;

      switch (key) {
        case "x": t.x = value; break;
        case "y": t.y = value; break;
        case "w":
          if (size.w > 0) {
            if (this.linked.size) t.scaleY *= ratio(size.w * t.scaleX);
            t.scaleX = value / size.w;
          }
          break;
        case "h":
          if (size.h > 0) {
            if (this.linked.size) t.scaleX *= ratio(size.h * t.scaleY);
            t.scaleY = value / size.h;
          }
          break;
        case "scaleX":
          if (this.linked.scale) t.scaleY *= ratio(t.scaleX);
          t.scaleX = value || 1e-4;
          break;
        case "scaleY":
          if (this.linked.scale) t.scaleX *= ratio(t.scaleY);
          t.scaleY = value || 1e-4;
          break;
        case "rotation": {
          // Rotation moves both skew angles together, so shear is preserved.
          const shear = t.skewX - t.skewY;
          t.skewY = value;
          t.skewX = value + shear;
          break;
        }
        case "skewX": t.skewX = value; break;
        case "skewY": t.skewY = value; break;
      }
      next.set(n.id, t);
    }
    return next;
  }

  // ── The virtual group ──────────────────────────────────────────────────

  /** Several nodes, or one node shown in several frames by Edit Multiple
   *  Frames: either way more than one thing on stage answers to the fields. */
  private isGroup(nodes: Node[]): boolean {
    if (nodes.length > 1) return true;
    return editsMultipleFrames(this.store) && instancesOf(this.posesOf(), this.groupIds()).length > 1;
  }

  private groupIds(): NodeId[] {
    const sym = this.store.currentSymbol;
    return topmostSelected(
      this.store.selection.nodes.filter((id) => sym.nodes[id]),
      (id) => sym.nodes[id]?.parentId,
    );
  }

  private groupBounds(): Rect | null {
    return selectionBounds(this.store.project, this.posesOf(), this.groupIds());
  }

  private captureGroup(): GroupSnapshot | null {
    const pose = this.poseOf();
    const bounds = this.groupBounds();
    if (!pose || !bounds) return null;
    const snaps: NodeSnapshot[] = [];
    for (const id of this.groupIds()) {
      const n = this.store.node(id);
      const entry = pose.byNode.get(id);
      if (!n || !entry) continue;
      const parent = n.parentId ? pose.byNode.get(n.parentId)?.world : undefined;
      const shown = displayAtFrame(this.store, n);
      snaps.push(snapshotOf(
        id, transformAtFrame(this.store, n), entry.world, parent, shown.display?.pivot ?? n.pivot, shown.index,
      ));
    }
    const first = this.store.selectedNodes[0];
    if (!snaps.length || !first) return null;
    return { bounds, snaps, first: transformAtFrame(this.store, first) };
  }

  /**
   * One write to the group. Position and size are the bounding box: X moves
   * everything by the difference, W scales everything from the box's left
   * edge. Rotate, Scale and Skew are the FIRST node's values, reached by
   * turning or scaling the whole group about the box's centre — so a
   * selection of differently rotated objects keeps its arrangement instead of
   * being flattened to one angle.
   */
  private groupWrite(key: FieldKey, value: number): Map<NodeId, Transform> | null {
    this.group ??= this.captureGroup();
    const g = this.group;
    if (!g) return null;
    const b = g.bounds;
    const centre = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const ratio = (before: number) => (Math.abs(before) > 1e-6 ? value / before : 1);
    const next = new Map<NodeId, Transform>();
    const each = (fn: (s: NodeSnapshot) => Transform) => {
      for (const s of g.snaps) next.set(s.id, fn(s));
    };

    switch (key) {
      case "x": each((s) => moveBy(s, value - b.x, 0)); break;
      case "y": each((s) => moveBy(s, 0, value - b.y)); break;
      case "w":
      case "h": {
        const sx = key === "w" ? ratio(b.w) : this.linked.size ? ratio(b.h) : 1;
        const sy = key === "h" ? ratio(b.h) : this.linked.size ? ratio(b.w) : 1;
        const m = worldScaleMatrix({ x: b.x, y: b.y }, sx || 1e-4, sy || 1e-4);
        each((s) => applyWorldMatrix(s, m));
        break;
      }
      case "scaleX":
      case "scaleY": {
        const sx = key === "scaleX" ? ratio(g.first.scaleX) : this.linked.scale ? ratio(g.first.scaleY) : 1;
        const sy = key === "scaleY" ? ratio(g.first.scaleY) : this.linked.scale ? ratio(g.first.scaleX) : 1;
        const m = worldScaleMatrix(centre, sx || 1e-4, sy || 1e-4);
        each((s) => applyWorldMatrix(s, m));
        break;
      }
      case "rotation":
        each((s) => rotateAbout(s, centre, value - g.first.skewY));
        break;
      case "skewX":
      case "skewY": {
        const delta = value - (key === "skewX" ? g.first.skewX : g.first.skewY);
        each((s) => ({ ...cloneTf(s.local), [key]: s.local[key] + delta }));
        break;
      }
      default:
        return null;
    }
    return next;
  }

  /**
   * Setting the transform point numerically must behave exactly like dragging
   * it: the point moves, the artwork does not. That needs the node's world
   * matrix, which is why the panel is handed a pose provider.
   */
  private writePivot(key: "pivotX" | "pivotY", value: number, committing: boolean): void {
    const pivots = new Map<NodeId, { x: number; y: number }>();
    const displays = new Map<NodeId, number>();
    for (const n of this.store.selectedNodes) {
      const shown = displayAtFrame(this.store, n);
      const pivot = shown.display?.pivot ?? n.pivot;
      pivots.set(n.id, {
        x: key === "pivotX" ? value : pivot.x,
        y: key === "pivotY" ? value : pivot.y,
      });
      displays.set(n.id, shown.index);
    }
    if (pivots.size === 0) return;

    this.scrubStep("node.pivot", committing);
    // The command does the compensation, on the bind pose and on every
    // keyframe, so the artwork stays put whatever mode we are in.
    this.store.apply(new SetPivot(this.store.currentSymbolId, pivots, { displays }));
    if (committing) this.store.history.endInteraction();
  }
}

const LINK_KEY = "animo.props.linked";

function loadLinked(key: "size" | "scale" | "stage"): boolean {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    return raw ? !!(JSON.parse(raw) as Record<string, boolean>)[key] : false;
  } catch { return false; }
}

function saveLinked(key: "size" | "scale" | "stage", value: boolean): void {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    all[key] = value;
    localStorage.setItem(LINK_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
}

/* ── Colour effect helpers ───────────────────────────────────────────────*/

type ColorMode = "none" | "alpha" | "brightness" | "tint" | "advanced";

/** Which view of a ColorTransform best explains the value already stored. */
function deriveColorMode(c: ColorTransform, isInstance: boolean): ColorMode {
  if (isDefaultColor(c)) return "none";
  const grey = c.rM === c.gM && c.gM === c.bM;
  if (c.rM === 100 && grey) return "alpha";
  if (isInstance) return "alpha";
  if (c.aM === 100 && grey) return "brightness";
  return "advanced";
}

function colorToHex(c: ColorTransform): string {
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v / 100) * 255))).toString(16).padStart(2, "0");
  return `#${ch(c.rM)}${ch(c.gM)}${ch(c.bM)}`;
}

function hexToPct(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  const pc = (v: number) => Math.round((v / 255) * 100);
  return { r: pc((n >> 16) & 255), g: pc((n >> 8) & 255), b: pc(n & 255) };
}

/** Only the modes `PixiSlot._updateBlendMode` actually applies. */
const BLEND_MODES: Array<[BlendMode, string]> = [
  ["normal", "Normal"],
  ["add", "Add"],
  ["multiply", "Multiply"],
  ["screen", "Screen"],
  ["overlay", "Overlay"],
  ["darken", "Darken"],
  ["lighten", "Lighten"],
  ["difference", "Difference"],
  ["hardlight", "Hard Light"],
];

/** A number per object, the same while the object is: a replaced value gets a new one. */
const valueIds = new WeakMap<object, number>();
let nextValueId = 1;
function valueId(o: object | undefined): number {
  if (!o) return 0;
  let id = valueIds.get(o);
  if (!id) valueIds.set(o, id = nextValueId++);
  return id;
}

/** One row of a constraint's section (`constraintRows`). */
type ConstraintSpec =
  | { type: "number"; key: string; label: string; glyph: string; min: number; max: number; step: number; decimals?: number; unit?: string; def: number }
  | { type: "select"; key: string; label: string; options: Array<[string, string]>; def: string }
  | { type: "check"; key: string; label: string; title?: string };
