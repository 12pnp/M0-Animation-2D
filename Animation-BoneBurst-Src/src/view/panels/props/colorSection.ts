import { h, on } from "@/view/widgets/dom";
import { NumberField } from "@/view/widgets/NumberField";
import {
  SetNodeBlendMode
} from "@/core/history/commands";
import {
  applyColors, colorAtFrame,
  displayAtFrame
} from "@/app/TimelineOps";
import {
  type BlendMode,
  type ColorTransform,
  DEFAULT_COLOR,
  isSymbol,
  type Node
} from "@/core/doc/types";
import { displayAt, withDisplayTint } from "@/core/doc/displays";
import { EditNode } from "@/core/history/attachmentCommands";
import { type ColorMode, deriveColorMode, colorToHex, hexToPct } from "@/core/doc/colorEffect";
import type { PropertiesPanel } from "@/view/panels/PropertiesPanel";

/**
 * Properties ▸ Colour: the colour effect, image tint and blend mode.
 */

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
export function colorSection(api: PropertiesPanel, nodes: Node[]): HTMLElement {
  const node = nodes[0]!;
  const ids = nodes.map((n) => n.id);
  const shown = displayAtFrame(api.store, node).display;
  const isInstance = isSymbol(shown ? api.store.project.items[shown.itemId] : undefined);
  const current = colorAtFrame(api.store, node);

  const mode = api.colorModes.get(node.id) ?? deriveColorMode(current, isInstance);
  api.colorModes.set(node.id, mode);

  const write = (next: ColorTransform, committing: boolean) => {
    api.scrubStep("node.color", committing);
    // The commit belongs to the scrub's entry: a different kind on the last
    // step left a second undo step that restored the same colour.
    applyColors(api.store, new Map(ids.map((id) => [id, next])), api.store.history.inInteraction);
    api.store.emit("stage");
    api.store.emit("timeline");
    if (committing) api.store.history.endInteraction();
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
    api.colorModes.set(node.id, next);
    if (next === "none") write({ ...DEFAULT_COLOR }, true);
    api.rebuild();
  });

  const rows: HTMLElement[] = [api.row("Effect", [modeSel])];

  const pct = (glyph: string, value: number, pick: (v: number) => ColorTransform) => {
    const nf = new NumberField({
      glyph, min: 0, max: 100, step: 1, decimals: 0, unit: "%",
      onInput: (v, committing) => write(pick(v), committing),
    });
    nf.set(value);
    return nf.el;
  };

  if (mode === "alpha" || mode === "advanced") {
    rows.push(api.row("Alpha", [
      pct("A", current.aM, (v) => ({ ...colorAtFrame(api.store, node), aM: v })),
    ]));
  }

  if (mode === "brightness") {
    // Flash brightens with an offset; without offsets the honest range is
    // "darken to black", so the label says multiply rather than promising
    // Flash's curve.
    rows.push(api.row("Brightness", [
      pct("B", current.rM, (v) => ({ ...colorAtFrame(api.store, node), rM: v, gM: v, bM: v })),
    ]));
  }

  if (mode === "tint") {
    const swatch = h("input", { type: "color", value: colorToHex(current), class: "swatch" });
    on(swatch, "input", () => {
      const { r, g, b } = hexToPct(swatch.value);
      write({ ...colorAtFrame(api.store, node), rM: r, gM: g, bM: b }, false);
    });
    on(swatch, "change", () => {
      const { r, g, b } = hexToPct(swatch.value);
      write({ ...colorAtFrame(api.store, node), rM: r, gM: g, bM: b }, true);
    });
    rows.push(api.row("Tint", [swatch]));
    rows.push(h("div", { class: "prow wide" },
      h("div", { class: "hint", style: "padding:2px 0" },
        "Tint multiplies the colours, so it can only darken: black artwork stays black.")));
  }

  if (mode === "advanced") {
    const base = () => colorAtFrame(api.store, node);
    rows.push(api.row("Red", [pct("R", current.rM, (v) => ({ ...base(), rM: v }))]));
    rows.push(api.row("Green", [pct("G", current.gM, (v) => ({ ...base(), gM: v }))]));
    rows.push(api.row("Blue", [pct("B", current.bM, (v) => ({ ...base(), bM: v }))]));
  }

  const blend = h("select", { class: "preview-anim" },
    ...BLEND_MODES.map(([value, label]) => h("option", { value }, label)));
  blend.value = node.blendMode ?? "normal";
  blend.disabled = isInstance;
  on(blend, "change", () => {
    api.store.apply(new SetNodeBlendMode(
      api.store.currentSymbolId, ids, blend.value as BlendMode,
    ));
    api.store.emit("stage");
    api.store.emit("doc");
  });
  rows.push(api.row("Blend", [blend]));

  // The shown image's own colour (Spine's attachment `color`, ARCHITECTURE ▸
  // Colour, alpha and blend mode), multiplied into the slot's.
  if (nodes.length === 1 && shown && !isInstance) {
    const index = displayAtFrame(api.store, node).index;
    const tint = shown.tint ?? "ffffffff";
    const swatch = h("input", { type: "color", class: "bone-color", title: "The image's own colour, multiplied into the layer's: Spine's attachment colour" }) as HTMLInputElement;
    swatch.value = `#${tint.slice(0, 6)}`;
    const setTint = (value: string | undefined, label: string, kind?: string) => {
      api.store.apply(new EditNode(label, api.store.currentSymbolId, node.id, (n) => withDisplayTint(n, index, value), kind));
      api.store.emit("stage");
    };
    const alphaHex = () => (displayAt(api.store.currentSymbol.nodes[node.id]!, index)?.tint ?? "ffffffff").slice(6);
    on(swatch, "change", () => setTint(`${swatch.value.slice(1)}${alphaHex()}`, "Image Tint"));
    const alpha = new NumberField({
      glyph: "A", min: 0, max: 100, step: 1, decimals: 0, unit: "%",
      onInput: (v, committing) => {
        api.scrubStep("node.tint", committing);
        const rgb = (displayAt(api.store.currentSymbol.nodes[node.id]!, index)?.tint ?? "ffffffff").slice(0, 6);
        setTint(`${rgb}${Math.round((Math.min(100, Math.max(0, v)) / 100) * 255).toString(16).padStart(2, "0")}`, "Image Tint", "node.tint");
        if (committing) api.store.history.endInteraction();
      },
    });
    alpha.set(Math.round((parseInt(tint.slice(6), 16) / 255) * 100));
    const white = h("button", { class: "btn", title: "No tint: the image's own colours" }, "None");
    on(white, "click", () => setTint(undefined, "No Image Tint"));
    rows.push(api.row("Image tint", [swatch, alpha.el, ...(shown.tint ? [white] : [])]));
  }

  if (isInstance) {
    rows.push(h("div", { class: "prow wide" },
      h("div", { class: "hint", style: "padding:2px 0" },
        "Symbol instances are not in the Spine export yet, so their colour " +
        "and blend do not reach it either.")));
  }

  return api.section("Color Effect", true, rows);
}
/** Spine's four blend modes, as the menu lists them. */
const BLEND_MODES: Array<[BlendMode, string]> = [
  ["normal", "Normal"],
  ["add", "Add"],
  ["multiply", "Multiply"],
  ["screen", "Screen"],
];
