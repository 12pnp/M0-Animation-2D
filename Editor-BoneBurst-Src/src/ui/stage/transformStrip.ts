import { type BoneProperty, keyBone, type LocalPose } from "@/edit/boneKeys";
import { updateBone } from "@/edit/bones";
import { EditRefused } from "@/edit/history";
import { BONE_DEFAULTS, boneNumber, type BoneNumber } from "@/model/defaults";
import { keysAt } from "@/model/timelines";
import { icon } from "../icons";
import type { Session } from "../session";
import type { Tool } from "./gizmo";
import { animatedLocal } from "./posed";

/** What the strip needs of the stage: whether a change keys, and the status line. */
export interface StripHost {
  readonly autoKey: () => boolean;
  readonly status: (message: string) => void;
}

interface Row { readonly tool: Tool; readonly property: BoneProperty; readonly fields: readonly BoneNumber[]; readonly timelines: readonly string[] }

/** The four rows, in Spine's order: the property each tool changes, its fields, and the timelines that key it. */
const ROWS: readonly Row[] = [
  { tool: "rotate", property: "rotate", fields: ["rotation"], timelines: ["rotate"] },
  { tool: "move", property: "translate", fields: ["x", "y"], timelines: ["translate", "translatex", "translatey"] },
  { tool: "scale", property: "scale", fields: ["scaleX", "scaleY"], timelines: ["scale", "scalex", "scaley"] },
  { tool: "shear", property: "shear", fields: ["shearX", "shearY"], timelines: ["shear", "shearx", "sheary"] },
];

/**
 * The stage's transform panel (after Spine's): a row for each of rotate, translate, scale and shear,
 * with the tool's button (the chosen tool lit), the selected bone's values to type into, and a key
 * button that keys the property at the playhead (red where it already has a key there). Values show
 * the pose at the playhead in an animation, the setup pose otherwise.
 */
export class TransformStrip {
  readonly element: HTMLElement;
  private readonly cells = new Map<BoneNumber, HTMLInputElement>();
  private readonly keyButtons = new Map<BoneProperty, HTMLButtonElement>();

  constructor(private readonly session: Session, tools: ReadonlyMap<Tool, HTMLButtonElement>, private readonly host: StripHost) {
    this.element = document.createElement("div");
    this.element.className = "group transform";
    for (const row of ROWS) {
      const r = document.createElement("div");
      r.className = "t-row";
      r.append(tools.get(row.tool)!);
      const values = document.createElement("div");
      values.className = "t-values";
      for (const key of row.fields) {
        const input = document.createElement("input");
        input.className = "cell";
        input.inputMode = "decimal";
        input.spellcheck = false;
        input.setAttribute("aria-label", `${row.property} ${key}`);
        input.addEventListener("keydown", (e) => {
          // Typing a number is not a shortcut.
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); input.blur(); }
          if (e.key === "Escape") { this.update(); input.blur(); }
        });
        input.addEventListener("change", () => this.set(row, key, input.value));
        this.cells.set(key, input);
        values.append(input);
      }
      const keyBtn = document.createElement("button");
      keyBtn.type = "button";
      keyBtn.className = "t-key";
      keyBtn.title = `Key ${row.property} at the playhead`;
      keyBtn.setAttribute("aria-label", `Key ${row.property}`);
      keyBtn.append(icon("key"));
      keyBtn.addEventListener("click", () => this.key(row));
      this.keyButtons.set(row.property, keyBtn);
      r.append(values, keyBtn);
      this.element.append(r);
    }
    session.onChange(() => this.update());
    this.update();
  }

  /** The pose the cells show for the selected bone: the animation at the playhead, or the setup pose. */
  private local(): { name: string; pose: LocalPose } | null {
    const s = this.session, doc = s.doc, name = s.selectedBone;
    const bone = doc?.bones?.find((b) => b.name === name);
    if (!doc || !name || !bone) return null;
    const p = s.animation ? s.pose() : null, i = p?.bones.get(name);
    if (p && i !== undefined) return { name, pose: animatedLocal(p, i) };
    const n = (k: BoneNumber) => boneNumber(bone, k);
    return { name, pose: { x: n("x"), y: n("y"), rotation: n("rotation"), scaleX: n("scaleX"), scaleY: n("scaleY"), shearX: n("shearX"), shearY: n("shearY") } };
  }

  private update(): void {
    const at = this.local(), s = this.session, anim = s.animation;
    for (const [key, input] of this.cells) {
      input.disabled = !at;
      if (document.activeElement !== input) input.value = at ? fmt(at.pose[key as keyof LocalPose]) : "";
    }
    for (const row of ROWS) {
      const b = this.keyButtons.get(row.property)!;
      b.disabled = !at || !anim;
      const keyed = !!at && !!anim && row.timelines.some((t) => keysAt(anim, { section: "bones", owner: at.name, timeline: t })?.some((k) => Math.abs((k.time ?? 0) - s.keyTime) < 1e-6));
      b.classList.toggle("keyed", keyed);
    }
  }

  /** A typed value: keyed at the playhead (Auto Key on), held unkeyed (off), or the setup pose without an animation. */
  private set(row: Row, key: BoneNumber, text: string): void {
    const at = this.local(), s = this.session, h = s.history;
    const n = Number(text);
    if (!at || !h || text.trim() === "" || !Number.isFinite(n)) { this.update(); return; }
    const anim = s.animation;
    try {
      if (anim && !this.host.autoKey()) {
        s.setUnkeyed(at.name, { ...at.pose, [key]: n });
        this.host.status(`Unkeyed pose of ${at.name}: press Key to key it; moving the playhead drops it.`);
      } else if (anim) {
        s.pause();
        h.apply(`Key ${row.property} of ${at.name} at frame ${s.frame}`, keyBone(anim.name, at.name, [row.property], { ...at.pose, [key]: n }, s.keyTime));
      } else {
        // Back at its default: leave the key out, as Spine writes it.
        h.apply(`Set ${key} of bone ${at.name}`, updateBone(at.name, { [key]: n === BONE_DEFAULTS[key] ? undefined : n }));
      }
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.host.status(err.message);
    }
    s.changed();
  }

  /** Key the row's property at the playhead, with the values shown now. */
  private key(row: Row): void {
    const at = this.local(), s = this.session, h = s.history, anim = s.animation;
    if (!at || !h || !anim) return;
    s.pause();
    try {
      h.apply(`Key ${row.property} of ${at.name} at frame ${s.frame}`, keyBone(anim.name, at.name, [row.property], at.pose, s.keyTime));
      s.clearUnkeyed(at.name);
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.host.status(err.message);
    }
    s.changed();
  }
}

/** A value as a cell shows it: up to three decimals, no trailing zeros. */
function fmt(n: number): string {
  return String(Math.round(n * 1e3) / 1e3);
}
