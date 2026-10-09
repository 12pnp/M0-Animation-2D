import { icon } from "../icons";
import { type Shortcut, type ShortcutGroup, SHORTCUTS } from "../shortcuts";
import { PANEL_ICONS, PANEL_TITLES, type PanelId } from "./panelIds";

/** What each panel is for, in a line or two, and which shortcut groups are its own. */
const INFO: Readonly<Record<PanelId, { readonly what: string; readonly use: readonly string[]; readonly keys: readonly ShortcutGroup[] }>> = {
  stage: {
    what: "The skeleton as it is posed: bones, their images, guides and rulers.",
    use: ["Drag a bone with the chosen tool (Move, Rotate, Scale, Shear); in Animate mode with Auto Key on, a drag keys the animation.", "Wheel zooms, a drag on empty space pans, F centres the selected bone.", "Drop guides from the rulers; reference images sit under the rig."],
    keys: ["Tools", "Stage"],
  },
  timeline: {
    what: "The animation's keys over time, with the playhead and the curve graph.",
    use: ["Click a frame to move the playhead; K keys the selection there.", "Drag keys to move them; drag a curve handle in the graph to shape the ease.", "Loop, frame rate and the animation's length are set along the top."],
    keys: ["Timeline", "Playback"],
  },
  rigTree: {
    what: "The rig as a tree: bones, slots, constraints and what hangs on them.",
    use: ["Click to select; the selection follows the Stage and Properties.", "Drag to re-parent or reorder; Delete removes the selected item (Undo brings it back)."],
    keys: [],
  },
  properties: {
    what: "The selected item's values: a bone's position, rotation, scale and shear, an attachment's settings, a constraint's.",
    use: ["Type a value or drag a field; each change is one undo step.", "In Animate mode a changed value is keyed at the playhead when Auto Key is on."],
    keys: [],
  },
  preview: {
    what: "The animation playing on its own, with no tools over it: just the picture.",
    use: ["Pick an animation (it follows the Timeline's until you choose one), then Play; Loop starts it over at its end.", "It has a clock of its own: the Timeline's playhead and the Stage do not move.", "Wheel zooms, a middle-button drag pans, Fit shows the whole rig."],
    keys: [],
  },
  reference: {
    what: "Reference images placed under the rig on the Stage.",
    use: ["Add an image, then drag it on the Stage to place it; opacity is set here.", "They are kept in the project's sidecar, not in the Spine file."],
    keys: [],
  },
  ai: {
    what: "Ask AI: Claude or GLM works the open rig with the editor's own tools, each step shown live.",
    use: ["Describe what you want (rig a figure, key a walk, check the preview); the steps run on this document.", "Every step is in the History and can be undone."],
    keys: [],
  },
  history: {
    what: "Every undo step, oldest first, with the ones an Undo took back.",
    use: ["Click a step to go back (or forward) to it.", "FramePath edits are steps here too."],
    keys: ["Edit"],
  },
  skins: {
    what: "The skins of the rig and which attachments each one holds.",
    use: ["Pick a skin to show it on the Stage; add, rename or delete skins here."],
    keys: [],
  },
  animations: {
    what: "The animations of the rig.",
    use: ["Pick one to edit it on the Timeline; add, rename, duplicate or delete here.", "Loop ticks say which animations loop."],
    keys: [],
  },
  tags: {
    what: "Every tag in use, and how many elements have it.",
    use: ["Click a tag to list the elements that have it; click an element to select it.", "✎ renames the tag on every element (a name already in use merges the two); the bin takes it off every element.", "Add tags to the selected element with the tags key, or from Properties."],
    keys: [],
  },
  motionPath: {
    what: "The selected bone over the animation (FramePath): where it goes frame by frame, its translate keys on a frame strip, and how fast it goes, written into the keys' own curves.",
    use: [
      "The picture: drag a dot to move the bone on that frame; Cmd (Ctrl) + click the path adds a key there, Cmd (Ctrl) + click a key's dot gives Mirror, Break, Plain and Delete; Shift + click a key's dot deletes it.",
      "The frame strip: click or drag to move the playhead; Cmd (Ctrl) + drag where two tabs meet moves that key in time; ◆ keys the bone's place on the frame, or deletes the key there. At its left the frame rate and the frame lock.",
      "Curves (left, under the strip) eases the span the playhead is in: stepped, linear or bezier, and drag its two handles. The speed graph beside it shows every span: green faster, red slower; click it to pick a span or a key.",
      "Image, Bone and Onion have a count each side: one more tier of parents (or frame before) on the left, of children (or frame after) on the right. ⋮ by FramePath has Closed and Delete FramePath data.",
    ],
    keys: [],
  },
};

/**
 * The extra menu's Info window: what the panel is for, how it is used, and the keys that belong
 * to it, in a native `<dialog>` like the shortcuts sheet. Escape or Close shuts it.
 */
export class PanelInfo {
  readonly element: HTMLDialogElement;
  private readonly body: HTMLDivElement;

  constructor() {
    this.element = document.createElement("dialog");
    this.element.className = "shortcuts panel-info";
    this.body = document.createElement("div");
    this.body.className = "shortcut-list";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => this.element.close());
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(close);
    this.element.append(this.body, actions);
    this.element.addEventListener("click", (e) => { if (e.target === this.element) this.element.close(); });
  }

  open(id: PanelId): void {
    const info = INFO[id], title = document.createElement("h2");
    title.className = "panel-info-title";
    title.append(icon(PANEL_ICONS[id]), ` ${PANEL_TITLES[id]}`);
    this.element.setAttribute("aria-label", `${PANEL_TITLES[id]} info`);
    const what = document.createElement("p");
    what.textContent = info.what;
    const parts: HTMLElement[] = [title, what];
    if (info.use.length) {
      const h = document.createElement("h3"), ul = document.createElement("ul");
      h.textContent = "How it works";
      for (const line of info.use) { const li = document.createElement("li"); li.textContent = line; ul.append(li); }
      parts.push(h, ul);
    }
    for (const g of info.keys) {
      const rows = (SHORTCUTS as readonly Shortcut[]).filter((s) => s.group === g);
      if (!rows.length) continue;
      const h = document.createElement("h3"), dl = document.createElement("dl");
      h.textContent = `Keys: ${g}`;
      for (const s of rows) {
        const dt = document.createElement("dt"), kbd = document.createElement("kbd"), dd = document.createElement("dd");
        kbd.textContent = s.keys;
        dt.append(kbd);
        dd.textContent = s.what;
        dl.append(dt, dd);
      }
      parts.push(h, dl);
    }
    this.body.replaceChildren(...parts);
    if (!this.element.open) this.element.showModal();
  }
}
