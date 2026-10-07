import type { Session } from "./session";

/**
 * The editor remembers how each project was left (this browser only, not in the project's files): the camera, what was
 * selected and shown, the playhead, the tool and space, the Motion Path panel and the timeline's view. Opening the project
 * again puts it all back. The panel layout is kept apart, by the workspace.
 */

export interface MotionMemory {
  readonly node: number;
  readonly zoom: number;
  readonly pan: { readonly x: number; readonly y: number };
  /** `"local"` is what an earlier build wrote for Parent. */
  readonly axes: "parent" | "world";
  /** The height of the area under the picture (node numbers and speed graph), in pixels. */
  readonly lower?: number;
}

export interface TimelineMemory { readonly frameWidth: number; readonly first: number; readonly scroll: number }

export interface Remembered {
  readonly version: 1;
  readonly camera?: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly skin?: string;
  readonly animation?: string;
  readonly bone?: string;
  readonly frame?: number;
  readonly tool?: string;
  readonly space?: string;
  readonly motion?: MotionMemory;
  readonly timeline?: TimelineMemory;
}

const KEY = "boneburst.view.";
/** How many projects' views are kept: the oldest go first. */
const KEEP = 40;
const INDEX = "boneburst.view.index";

/** What the memory reads from and puts back into the editor: each piece is the app's own. */
export interface Places {
  readonly session: Session;
  camera(): { x: number; y: number; zoom: number };
  tool: string;
  space: string;
  motion: MotionMemory | null;
  timeline: TimelineMemory | null;
}

export function readView(name: string): Remembered | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY + name) ?? "null") as Remembered | null;
    return r && r.version === 1 ? r : null;
  } catch { return null; }
}

function writeView(name: string, r: Remembered): void {
  try {
    localStorage.setItem(KEY + name, JSON.stringify(r));
    const index = (JSON.parse(localStorage.getItem(INDEX) ?? "[]") as string[]).filter((n) => n !== name);
    index.push(name);
    for (const old of index.splice(0, Math.max(0, index.length - KEEP))) localStorage.removeItem(KEY + old);
    localStorage.setItem(INDEX, JSON.stringify(index));
  } catch { /* storage full or blocked: not kept */ }
}

/** The view now: what is worth coming back to. */
export function viewNow(p: Places): Remembered {
  const s = p.session;
  return {
    version: 1, camera: p.camera(),
    ...(s.skin ? { skin: s.skin } : {}), ...(s.animation ? { animation: s.animation.name } : {}), ...(s.selectedBone ? { bone: s.selectedBone } : {}),
    frame: s.frame, tool: p.tool, space: p.space,
    ...(p.motion ? { motion: p.motion } : {}), ...(p.timeline ? { timeline: p.timeline } : {}),
  };
}

/**
 * Keeps the open project's view as it changes (and when the page is hidden or closed), and gives it back. A project with no
 * name of its own yet ("untitled") is not kept: any new project would meet the last one's view.
 */
export class ViewMemory {
  private last = "";
  /** The project whose view is being kept: a project is first seen, not written, so the moment between its opening and its view coming back never overwrites it. */
  private armedFor: string | null = null;
  private timer = 0;

  constructor(private readonly places: () => Places, private readonly usable: (name: string) => boolean = (n) => n !== "untitled") {}

  start(): void {
    this.timer = window.setInterval(() => this.save(), 1500);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") this.save(); });
    window.addEventListener("pagehide", () => this.save());
  }

  stop(): void { clearInterval(this.timer); }

  save(): void {
    const p = this.places(), s = p.session;
    if (!s.doc || !this.usable(s.name)) return;
    if (this.armedFor !== s.name) { this.armedFor = s.name; this.last = JSON.stringify(viewNow(p)); return; }
    const r = viewNow(p), text = JSON.stringify(r);
    if (text === this.last + "") return;
    this.last = text;
    writeView(s.name, r);
  }

  /** Put the project's remembered view back (the open document's name); false when none was kept. Call before the stage's `opened()`. */
  restore(apply: { tool(t: string): void; space(s: string): void; motion(m: MotionMemory): void; timeline(t: TimelineMemory): void }): boolean {
    const p = this.places(), s = p.session, r = s.doc && this.usable(s.name) ? readView(s.name) : null;
    this.armedFor = s.doc && this.usable(s.name) ? s.name : null;
    this.last = "";
    if (!r) return false;
    const doc = s.doc!;
    if (r.skin !== undefined && doc.skins?.some((k) => k.name === r.skin)) s.skin = r.skin === "default" ? null : r.skin;
    if (r.animation !== undefined && doc.animations?.some((a) => a.name === r.animation)) s.showAnimation(r.animation);
    if (r.bone !== undefined && doc.bones?.some((b) => b.name === r.bone)) s.select({ kind: "bone", name: r.bone });
    if (r.frame !== undefined && s.animation) s.seek(r.frame);
    if (r.camera) s.openedCamera = r.camera;
    if (r.tool) apply.tool(r.tool);
    if (r.space) apply.space(r.space);
    if (r.motion) apply.motion(r.motion);
    if (r.timeline) apply.timeline(r.timeline);
    return true;
  }
}
