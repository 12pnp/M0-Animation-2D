import { pickColour } from "./colourPopup";
import { AUTOSAVE_RANGE, BUILT_IN_THEMES, BONE_SIZE_RANGE, DEFAULTS, GRID_RANGE, NUDGE_FACTOR_RANGE, NUDGE_RANGE, ONION_RANGE, DEFAULT_FPS_RANGE, type FontSize, type Preferences, type PreferenceValues, type SaveTo, TREE_INDENT_RANGE, type ToolbarLabels, type ToolbarPosition, THICKNESS_RANGE, UI_SCALE_RANGE, UNDO_RANGE } from "./preferences";
import { showContextMenu } from "./contextMenu";
import { toStyle } from "./pageScale";

/**
 * The Preferences dialog (E4-PLAN step 10): a native `<dialog>`; each change applies at once.
 * Reset puts every preference back to its default; Close or Escape closes it.
 */
export class PreferencesDialog {
  readonly element: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  /** The category or section shown, and the content column (its scroll is kept across redraws). */
  private selected = "application";
  private content: HTMLElement | null = null;

  constructor(private readonly prefs: Preferences) {
    this.element = document.createElement("dialog");
    this.element.className = "preferences";
    this.element.setAttribute("aria-label", "Preferences");
    this.form = document.createElement("form");
    this.form.method = "dialog";
    this.element.append(this.form);
    prefs.onChange(() => { if (this.element.open) this.draw(); });
  }

  open(): void {
    this.draw();
    if (!this.element.open) this.element.showModal();
  }

  private draw(): void {
    const p = this.prefs.values;
    const range = `${THICKNESS_RANGE[0]}–${THICKNESS_RANGE[1]}`;
    const note = (text: string) => { const n = document.createElement("p"); n.className = "note"; n.textContent = text; return n; };
    const sections: Record<string, readonly HTMLElement[]> = {
      general: [
        number(`Undo steps kept (${UNDO_RANGE[0]}–${UNDO_RANGE[1]})`, p.undoSteps, 1, (n) => this.prefs.set({ undoSteps: n })),
        note("Takes effect for the next document opened."),
        number("New references' opacity (%)", Math.round(p.referenceOpacity * 100), 1, (n) => this.prefs.set({ referenceOpacity: n / 100 })),
        check("Go full screen on the first click or key", p.fullScreenOnStart, (on) => this.prefs.set({ fullScreenOnStart: on })),
        note("The browser hides its address and tab bars. A page may only ask for full screen from a click or a key, so it starts with your first one; Esc leaves, and View ▸ Full Screen toggles it any time."),
      ],
      interface: [
        select("Font size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]], p.fontSize, (v) => this.prefs.set({ fontSize: v as FontSize })),
        slider(`Interface scale (%, ${UI_SCALE_RANGE[0]}–${UI_SCALE_RANGE[1]})`, p.uiScale, UI_SCALE_RANGE[0], UI_SCALE_RANGE[1], 5, (n) => this.prefs.set({ uiScale: n })),
        note("Scales the whole interface larger or smaller, like the browser's zoom."),
        select("Toolbar position", [["left", "Left"], ["center", "Center"], ["right", "Right"]], p.toolbarPosition, (v) => this.prefs.set({ toolbarPosition: v as ToolbarPosition })),
        select("Toolbar text labels", [["auto", "Automatic"], ["show", "Show"], ["hide", "Hide"]], p.toolbarLabels, (v) => this.prefs.set({ toolbarLabels: v as ToolbarLabels })),
        note("Automatic hides the labels when the Stage is narrow."),
      ],
      timeline: [
        number(`Default timeline FPS (${DEFAULT_FPS_RANGE[0]}–${DEFAULT_FPS_RANGE[1]})`, p.defaultFps, 1, (n) => this.prefs.set({ defaultFps: n })),
        note("The frame rate a new project starts with."),
        check("Fewer timeline ticks (1-2-5 series)", p.fewerTicks, (on) => this.prefs.set({ fewerTicks: on })),
        note("The height of each row in the timeline and graph."),
      ],
      tree: [
        check("Tree colours", p.treeColours, (on) => this.prefs.set({ treeColours: on })),
        note("Names and icons in the rig tree take each bone's colour."),
        slider(`Tree indentation (pixels, ${TREE_INDENT_RANGE[0]}–${TREE_INDENT_RANGE[1]})`, p.treeIndent, TREE_INDENT_RANGE[0], TREE_INDENT_RANGE[1], 1, (n) => this.prefs.set({ treeIndent: n })),
        colourPicker("Indent guide colour", p.treeGuideColour, (c) => this.prefs.set({ treeGuideColour: c }), true, themeColour("--bb-field-border")),
      ],
      files: [
        select("Save keeps the project in", [["browser", "This browser"], ["file", "A file"]], p.saveTo, (v) => this.prefs.set({ saveTo: v as SaveTo })),
        note("This browser: nothing is downloaded; the project is offered back when the editor opens. Save Project As… always writes a file."),
        check("Keep a recovery copy of unsaved work", p.autosave, (on) => this.prefs.set({ autosave: on })),
        number(`Every (seconds, ${AUTOSAVE_RANGE[0]}–${AUTOSAVE_RANGE[1]})`, p.autosaveSeconds, 1, (n) => this.prefs.set({ autosaveSeconds: n })),
        note("One copy, in this browser. It is not your file: Save writes that."),
      ],
      display: [
        check("Show rulers on the stage", p.rulers, (on) => this.prefs.set({ rulers: on })),
        colourPicker("Ruler background colour", p.rulerColour, (c) => this.prefs.set({ rulerColour: c }), true, themeColour("--panel")),
        number("Ruler background opacity (%, 0 = invisible)", Math.round(p.rulerOpacity * 100), 1, (n) => this.prefs.set({ rulerOpacity: n / 100 })),
        colourPicker("Ruler number colour", p.rulerTextColour, (c) => this.prefs.set({ rulerTextColour: c }), true, themeColour("--text")),
        note("The ruler's ticks and numbers always show; only its background fades."),
        check("Show the tool panels over the stage (View ▸ Stage Panels)", p.stagePanels, (on) => this.prefs.set({ stagePanels: on })),
        check("Show bones on the stage", p.bones, (on) => this.prefs.set({ bones: on })),
        number(`Bone size (× the default, ${BONE_SIZE_RANGE[0]}–${BONE_SIZE_RANGE[1]})`, p.boneSize, 0.1, (n) => this.prefs.set({ boneSize: n })),
        colourPicker("Default bone colour", p.boneColour, (c) => this.prefs.set({ boneColour: c }), true, themeColour("--bone")),
        colourPicker("Selected bone colour", p.selectedBoneColour, (c) => this.prefs.set({ selectedBoneColour: c }), true, themeColour("--accent")),
        note("A bone can have a colour and an icon of its own: select it and see Properties."),
        check("Show constraints on the stage", p.constraints, (on) => this.prefs.set({ constraints: on })),
        check("Compensate: children keep their place when a bone is moved (Pose mode)", p.compensate, (on) => this.prefs.set({ compensate: on })),
        check("A picked bone or image glows for a moment", p.pickGlow, (on) => this.prefs.set({ pickGlow: on })),
        check("Show bone names on the stage", p.boneNames, (on) => this.prefs.set({ boneNames: on })),
        check("A press on the stage picks bones", p.boneSelect, (on) => this.prefs.set({ boneSelect: on })),
        check("A press on the stage picks images", p.imageSelect, (on) => this.prefs.set({ imageSelect: on })),
        check("A press on the stage picks constraints", p.otherSelect, (on) => this.prefs.set({ otherSelect: on })),
      ],
      background: [
        check("Checkerboard (View ▸ Checkerboard)", p.checker, (on) => this.prefs.set({ checker: on })),
        colourPicker("Checkerboard colour", p.checkerColour, (c) => this.prefs.set({ checkerColour: c }), true),
        colourPicker("Grid line colour", p.gridColour, (c) => this.prefs.set({ gridColour: c }), true),
        number(`Grid line thickness (pixels, ${range})`, p.gridThickness, 0.5, (n) => this.prefs.set({ gridThickness: n })),
        check("Centre axes (View ▸ Centre Axes)", p.axes, (on) => this.prefs.set({ axes: on })),
        colourPicker("X axis colour", p.axisXColour, (c) => this.prefs.set({ axisXColour: c }), false),
        colourPicker("Y axis colour", p.axisYColour, (c) => this.prefs.set({ axisYColour: c }), false),
        number(`Axis line thickness (pixels, ${range})`, p.axisThickness, 0.5, (n) => this.prefs.set({ axisThickness: n })),
      ],
      tabs: [
        colourPicker("Tab bar colour (behind the tabs)", p.tabBarColour, (c) => this.prefs.set({ tabBarColour: c }), true),
        colourPicker("Shown tab colour", p.tabActiveColour, (c) => this.prefs.set({ tabActiveColour: c }), true),
        colourPicker("Tab text colour (the shown tab)", p.tabTextColour, (c) => this.prefs.set({ tabTextColour: c }), true, themeColour("--text")),
        colourPicker("Other tabs' text colour", p.tabDimTextColour, (c) => this.prefs.set({ tabDimTextColour: c }), true, themeColour("--muted")),
      ],
      grid: [
        number(`Grid spacing and snap size (units, ${GRID_RANGE[0]}–${GRID_RANGE[1]})`, p.gridSize, 1, (n) => this.prefs.set({ gridSize: n })),
        check("Snapping", p.snap, (on) => this.prefs.set({ snap: on })),
        check("Snap to grid", p.snapGrid, (on) => this.prefs.set({ snapGrid: on })),
        check("Snap to guides", p.snapGuides, (on) => this.prefs.set({ snapGuides: on })),
        check("Snap to bones", p.snapBones, (on) => this.prefs.set({ snapBones: on })),
        check("Snap to pixels", p.snapPixels, (on) => this.prefs.set({ snapPixels: on })),
        number(`Arrow-key step (degrees or units, ${NUDGE_RANGE[0]}–${NUDGE_RANGE[1]})`, p.nudgeStep, 0.1, (n) => this.prefs.set({ nudgeStep: n })),
        number("Arrow-key step for Scale", p.nudgeScaleStep, 0.01, (n) => this.prefs.set({ nudgeScaleStep: n })),
        number(`Shift multiplies the arrow-key step by (${NUDGE_FACTOR_RANGE[0]}–${NUDGE_FACTOR_RANGE[1]})`, p.nudgeBigFactor, 1, (n) => this.prefs.set({ nudgeBigFactor: n })),
        note("View ▸ Grid shows the grid; what a dragged bone or vertex snaps to is set here, in View ▸ Snapping, and in Properties."),
      ],
      onion: [
        check("Onion skin (View ▸ Onion Skin)", p.onion, (on) => this.prefs.set({ onion: on })),
        number(`Frames before (${ONION_RANGE[0]}–${ONION_RANGE[1]})`, p.onionBefore, 1, (n) => this.prefs.set({ onionBefore: n })),
        number(`Frames after (${ONION_RANGE[0]}–${ONION_RANGE[1]})`, p.onionAfter, 1, (n) => this.prefs.set({ onionAfter: n })),
        check("Keyed frames only", p.onionKeyedOnly, (on) => this.prefs.set({ onionKeyedOnly: on })),
        check("Colour-coded (past red, future green)", p.onionColour, (on) => this.prefs.set({ onionColour: on })),
      ],
    };

    // The title bar: the window's name on an accent tab; it is the handle the dialog is dragged by.
    const bar = document.createElement("div");
    bar.className = "pref-title";
    const tab = document.createElement("span");
    tab.textContent = "Preferences";
    bar.append(tab, this.themeBar());
    this.dragBy(bar);

    // The left list: a category shows all of its sections; a section inside it, only that one.
    const nav = document.createElement("nav");
    nav.className = "pref-nav";
    const item = (node: NavNode, child: boolean) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = node.label;
      b.className = child ? "child" : "";
      b.setAttribute("aria-current", String(node.id === this.selected));
      b.addEventListener("click", () => { this.selected = node.id; this.draw(); });
      return b;
    };
    for (const node of NAV) {
      nav.append(item(node, false));
      for (const c of node.children ?? []) nav.append(item(c, true));
    }

    const shown = NAV.flatMap((n) => (n.id === this.selected ? n.children ?? [n] : n.children?.filter((c) => c.id === this.selected) ?? (n.id === this.selected ? [n] : [])));
    const scroll = this.content?.scrollTop ?? 0;
    const content = document.createElement("div");
    content.className = "pref-content";
    for (const sec of shown) {
      const h = document.createElement("h3");
      const name = document.createElement("span");
      name.textContent = sec.label;
      // Reset puts back only this section's settings.
      const keys = KEYS[sec.id] ?? [];
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "reset";
      reset.textContent = "Reset";
      reset.title = `Put the ${sec.label} settings back to their defaults`;
      reset.disabled = keys.every((k) => p[k] === DEFAULTS[k]);
      reset.addEventListener("click", () => this.prefs.set(Object.fromEntries(keys.map((k) => [k, DEFAULTS[k]]))));
      h.append(name, reset);
      content.append(h, ...(sections[sec.id] ?? []));
    }
    this.content = content;

    const actions = document.createElement("div");
    actions.className = "actions";
    const close = document.createElement("button");
    close.textContent = "Close";
    close.value = "close";
    actions.append(close);

    const body = document.createElement("div");
    body.className = "pref-body";
    body.append(nav, content);
    this.form.replaceChildren(bar, body, actions);
    content.scrollTop = scroll;
  }

  /**
   * The theme controls in the title bar, over every section: pick the theme in use (every colour and size below belongs to it); the ⋮ menu makes a new
   * one as a copy, renames or deletes one of your own, and chooses the scheme (Light or Dark) it starts from.
   */
  private themeBar(): HTMLElement {
    const box = document.createElement("div");
    box.className = "pref-themes";
    const label = document.createElement("span");
    label.textContent = "Theme";
    const pick = document.createElement("select");
    pick.setAttribute("aria-label", "Theme");
    pick.append(new Option("Follow the system", "system"), ...this.prefs.themes.map((t) => new Option(t.name, t.id)));
    pick.value = this.prefs.values.theme;
    pick.addEventListener("change", () => this.prefs.set({ theme: pick.value }));
    const active = this.prefs.active, own = this.prefs.themes.findIndex((t) => t.id === active.id) >= BUILT_IN_THEMES.length;
    // New, Rename, Delete and the base scheme are in a ⋮ menu beside the picker.
    const more = document.createElement("button");
    more.type = "button";
    more.className = "theme-more";
    more.textContent = "⋮";
    more.title = "New, rename, delete and base scheme for themes";
    more.setAttribute("aria-label", "Theme menu");
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      showContextMenu(r.left, r.bottom, [
        { label: `New Theme (a copy of ${active.name})…`, run: () => {
          const name = prompt(`Name of the new theme (a copy of "${active.name}"):`, uniqueName(active.name, this.prefs.themes.map((t) => t.name)))?.trim();
          if (name) this.prefs.addTheme(name);
        } },
        { label: `Rename ${active.name}…`, disabled: !own, run: () => {
          const name = prompt(`Rename "${active.name}" to:`, active.name)?.trim();
          if (name) this.prefs.renameTheme(active.id, name);
        } },
        { label: `Delete ${active.name}`, disabled: !own, run: () => { if (confirm(`Delete the theme "${active.name}"?`)) this.prefs.deleteTheme(active.id); } },
        {},
        { label: "Based on Light", checked: active.base === "light", disabled: !own, run: () => this.prefs.setThemeBase(active.id, "light") },
        { label: "Based on Dark", checked: active.base === "dark", disabled: !own, run: () => this.prefs.setThemeBase(active.id, "dark") },
      ], this.element);
    });
    box.append(label, pick, more);
    if (this.prefs.values.theme === "system") {
      const hint = document.createElement("span");
      hint.className = "theme-now";
      hint.textContent = `now ${active.name}`;
      box.append(hint);
    }
    return box;
  }

  /** Drag the dialog by `handle`: it leaves the centre on the first move and stays where it was put. */
  private dragBy(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("select, button, input")) return;
      const box = this.element.getBoundingClientRect();
      const dx = e.clientX - box.left, dy = e.clientY - box.top;
      handle.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        const left = Math.min(Math.max(0, m.clientX - dx), window.innerWidth - 80);
        const top = Math.min(Math.max(0, m.clientY - dy), window.innerHeight - 40);
        this.element.style.margin = "0";
        this.element.style.left = `${toStyle(left)}px`;
        this.element.style.top = `${toStyle(top)}px`;
      };
      const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }
}

/** The preferences each section holds: what its Reset puts back. */
const KEYS: Readonly<Record<string, readonly (keyof PreferenceValues)[]>> = {
  general: ["undoSteps", "referenceOpacity", "fullScreenOnStart"],
  interface: ["fontSize", "uiScale", "toolbarPosition", "toolbarLabels"],
  timeline: ["defaultFps", "fewerTicks"],
  tree: ["treeColours", "treeIndent", "treeGuideColour"],
  files: ["saveTo", "autosave", "autosaveSeconds"],
  display: ["rulers", "rulerColour", "rulerOpacity", "rulerTextColour", "stagePanels", "bones", "boneColour", "boneSize", "selectedBoneColour", "constraints", "compensate", "pickGlow", "boneNames", "boneSelect", "imageSelect", "otherSelect"],
  background: ["checker", "checkerColour", "gridColour", "gridThickness", "axes", "axisXColour", "axisYColour", "axisThickness"],
  tabs: ["tabBarColour", "tabActiveColour", "tabTextColour", "tabDimTextColour"],
  grid: ["gridSize", "nudgeStep", "nudgeScaleStep", "nudgeBigFactor", "snap", "snapGrid", "snapGuides", "snapBones", "snapPixels"],
  onion: ["onion", "onionBefore", "onionAfter", "onionKeyedOnly", "onionColour"],
};

/** One entry of the left list: a category, or a section inside one. */
interface NavNode { readonly id: string; readonly label: string; readonly children?: readonly NavNode[] }

const NAV: readonly NavNode[] = [
  { id: "application", label: "Application", children: [{ id: "general", label: "General" }, { id: "files", label: "Files" }] },
  { id: "viewport", label: "Viewport", children: [{ id: "display", label: "Display" }, { id: "background", label: "Background" }, { id: "grid", label: "Grid" }] },
  { id: "ui", label: "User interface", children: [{ id: "interface", label: "Interface" }, { id: "timeline", label: "Timeline" }, { id: "tree", label: "Tree" }, { id: "tabs", label: "Panel tabs" }] },
  { id: "behavior", label: "Behavior", children: [{ id: "onion", label: "Onion skin" }] },
];

/** `base` with a number after it until no name in `taken` is the same. */
function uniqueName(base: string, taken: readonly string[]): string {
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.className = "field";
  const s = document.createElement("span");
  s.textContent = label;
  control.setAttribute("aria-label", label);
  l.append(s, control);
  return l;
}

function select(label: string, options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void): HTMLLabelElement {
  const sel = document.createElement("select");
  sel.append(...options.map(([v, t]) => new Option(t, v)));
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return row(label, sel);
}

/** A slider with its number beside it, as Spine's settings have: either changes the value. */
function slider(label: string, value: number, min: number, max: number, step: number, onChange: (n: number) => void): HTMLLabelElement {
  const box = document.createElement("span");
  box.className = "slider";
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(value);
  const out = document.createElement("input");
  out.type = "number";
  out.min = String(min);
  out.max = String(max);
  out.step = String(step);
  out.value = String(value);
  range.addEventListener("input", () => { out.value = range.value; });
  range.addEventListener("change", () => onChange(Number(range.value)));
  out.addEventListener("change", () => { const n = Number(out.value); if (out.value.trim() !== "" && Number.isFinite(n)) onChange(n); });
  box.append(range, out);
  return row(label, box);
}

function check(label: string, value: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = value;
  box.addEventListener("change", () => onChange(box.checked));
  const r = row(label, box);
  r.classList.add("check");
  return r;
}

/** A colour the theme defines (a CSS variable on the page), as #rrggbb; undefined when it is not one. */
function themeColour(variable: string): string | undefined {
  const v = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
}

/** A colour swatch that opens the picker popup (Apply, Close); with `canAuto`, an Auto button puts back the colour that shows on the background. */
function colourPicker(label: string, value: string, onChange: (c: string) => void, canAuto: boolean, autoColour?: string): HTMLLabelElement {
  const box = document.createElement("span");
  box.className = "colour";
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "swatch";
  swatch.title = "Choose a colour";
  // Auto shows the theme's own colour when there is one (striped, so it reads as "not chosen").
  const shown = /^#[0-9a-f]{6}$/i.test(value) ? value : autoColour ?? "";
  swatch.style.backgroundColor = shown;
  swatch.classList.toggle("auto", value === "auto");
  if (value === "auto" && autoColour) swatch.classList.add("with-colour");
  swatch.addEventListener("click", (e) => { e.preventDefault(); pickColour(swatch, shown || value, onChange); });
  box.append(swatch);
  if (canAuto) {
    const auto = document.createElement("button");
    auto.type = "button";
    auto.textContent = "Auto";
    auto.title = "The colour that shows on the background";
    auto.disabled = value === "auto";
    auto.addEventListener("click", () => onChange("auto"));
    box.append(auto);
  }
  return row(label, box);
}

function number(label: string, value: number, step: number, onChange: (n: number) => void): HTMLLabelElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("change", () => {
    const n = Number(input.value);
    // A change redraws the dialog with what was kept (brought into range); anything else shows the old value.
    if (input.value.trim() !== "" && Number.isFinite(n)) onChange(n);
    if (input.isConnected) input.value = String(value);
  });
  return row(label, input);
}

