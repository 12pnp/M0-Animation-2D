import type { SpanEase } from "@/edit/keySpeed";
import type { Vec } from "@/edit/keySpeed";
import { graphColours } from "../graphLook";
import { iconButton } from "../icons";
import { localPoint, pageScale } from "../pageScale";

/**
 * FramePath's Curves sub-panel (docs/CURVES-PANEL-PLAN.md, step 2): one span, the one the playhead is in, drawn as Spine's Curves
 * view: the span's time across, how far along it up, the start key's out handle and the end key's in handle. Its toolbar sets the
 * span's kind (stepped · linear · bezier); dragging a handle sets it. It holds no document: the Motion Path panel (its host) says
 * what the span is and makes the edits.
 */
export interface CurvesHost {
  /** The span shown (by its first key's index), its ease, and the playhead's place across it (0..1); or why there is none. */
  span(): { index: number; ease: SpanEase; at: number } | string;
  /** The curve's colour (the path's) and the two legs' (in, out). */
  colours(): { path: string; in: string; out: string };
  /** A drag of a handle begins and ends: one undo step. */
  begin(label: string): void;
  end(): void;
  /** The span's kind, or one handle (`side`: whose leg it is) moved: the host writes it, and links the key's other leg if Linked. */
  apply(index: number, ease: { kind: SpanEase["kind"]; out?: Vec; in?: Vec }, side?: "out" | "in"): void;
}

const KINDS = [
  { kind: "stepped", icon: "curveStepped", title: "Stepped: hold the key until the next" },
  { kind: "linear", icon: "curveLinear", title: "Linear: an even pace to the next key" },
  { kind: "bezier", icon: "curveEaseInOut", title: "Bezier: drag the handles to ease in and out" },
] as const;
const PAD = 10;
const PLAYHEAD_GREEN = "#30a46c";

export class CurvesView {
  readonly element = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly note = document.createElement("p");
  private readonly kindBtns: Record<SpanEase["kind"], HTMLButtonElement>;
  /** The handles on the canvas as last drawn; the one being dragged, where it began, and Shift's axis once chosen. */
  private handles: { side: "out" | "in"; x: number; y: number }[] = [];
  private drag: { side: "out" | "in"; index: number; startX: number; startY: number; from: Vec; axis: "x" | "y" | null } | null = null;
  /** The value range the canvas shows, as last drawn (the handles can reach outside 0..1). */
  private range = { y0: 0, y1: 1 };

  constructor(private readonly host: CurvesHost) {
    this.element.className = "lp-curves";
    const bar = document.createElement("div");
    bar.className = "lp-curves-bar";
    this.kindBtns = {} as Record<SpanEase["kind"], HTMLButtonElement>;
    for (const k of KINDS) {
      const b = document.createElement("button");
      b.type = "button";
      b.title = k.title;
      b.textContent = k.kind[0]!.toUpperCase() + k.kind.slice(1);
      iconButton(b, k.icon, false);
      b.addEventListener("click", () => {
        const s = this.host.span();
        if (typeof s === "string" || s.ease.kind === k.kind) return;
        this.host.apply(s.index, { kind: k.kind });
      });
      this.kindBtns[k.kind] = b;
      bar.append(b);
    }
    this.canvas.className = "lp-curves-canvas";
    this.note.className = "lp-curves-note";
    this.element.append(bar, this.canvas, this.note);
    this.events();
  }

  /** The handles on the canvas, for tests. */
  get handlePoints(): readonly { side: "out" | "in"; x: number; y: number }[] {
    return this.handles;
  }

  /** The canvas point of an ease point, and back. */
  private toCanvas(p: Vec): [number, number] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, { y0, y1 } = this.range;
    return [PAD + p[0] * (w - 2 * PAD), h - PAD - ((p[1] - y0) / (y1 - y0)) * (h - 2 * PAD)];
  }

  private fromCanvas(x: number, y: number): Vec {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, { y0, y1 } = this.range;
    return [(x - PAD) / Math.max(1, w - 2 * PAD), y0 + ((h - PAD - y) / Math.max(1, h - 2 * PAD)) * (y1 - y0)];
  }

  draw(): void {
    const c = this.canvas, s = this.host.span();
    this.handles = [];
    for (const k of KINDS) {
      const on = typeof s !== "string" && s.ease.kind === k.kind;
      this.kindBtns[k.kind].setAttribute("aria-pressed", String(on));
      this.kindBtns[k.kind].disabled = typeof s === "string";
    }
    this.note.textContent = typeof s === "string" ? s : "";
    this.note.hidden = typeof s !== "string";
    if (!c.isConnected) return;
    const w = Math.max(1, Math.floor(c.clientWidth)), h = Math.max(1, Math.floor(c.clientHeight)), dpr = (window.devicePixelRatio || 1) * pageScale();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = graphColours(getComputedStyle(this.element));
    g.fillStyle = col("--panel") || "#2a2a2a";
    g.fillRect(0, 0, w, h);
    if (typeof s === "string") return;
    const e = s.ease;
    // Room for handles above 1 or below 0, while a drag is not under way (the scale holds still under the pointer).
    if (!this.drag) {
      const ys = e.kind === "bezier" ? [e.out[1], e.in[1]] : [];
      this.range = { y0: Math.min(0, ...ys) - 0.05, y1: Math.max(1, ...ys) + 0.05 };
    }
    const at = (p: Vec) => this.toCanvas(p);
    // A 4 × 4 grid, the box 0..1 and the even pace's diagonal, dashed.
    g.strokeStyle = col("--line") || "#555";
    g.lineWidth = 1;
    g.globalAlpha = 0.6;
    g.beginPath();
    for (let n = 0; n <= 4; n++) {
      const [x] = at([n / 4, 0]), [, y] = at([0, n / 4]);
      g.moveTo(Math.round(x) + 0.5, at([0, 0])[1]); g.lineTo(Math.round(x) + 0.5, at([0, 1])[1]);
      g.moveTo(at([0, 0])[0], Math.round(y) + 0.5); g.lineTo(at([1, 0])[0], Math.round(y) + 0.5);
    }
    g.stroke();
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(...at([0, 0])); g.lineTo(...at([1, 1])); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
    // The playhead's place across the span.
    const [px] = at([s.at, 0]);
    g.strokeStyle = PLAYHEAD_GREEN;
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(Math.round(px) + 0.5, 0); g.lineTo(Math.round(px) + 0.5, h); g.stroke();
    // The curve: Spine's per-channel bezier, its control points the ends and the two handles.
    const cl = this.host.colours();
    g.strokeStyle = cl.path;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(...at([0, 0]));
    if (e.kind === "stepped") { g.lineTo(...at([1, 0])); g.lineTo(...at([1, 1])); }
    else if (e.kind === "linear") g.lineTo(...at([1, 1]));
    else g.bezierCurveTo(...at(e.out), ...at(e.in), ...at([1, 1]));
    g.stroke();
    // The handles (also on a linear span, at its thirds: a drag makes it a bezier), dashed from their ends, in the legs' colours.
    if (e.kind === "stepped") return;
    for (const side of ["out", "in"] as const) {
      const p = at(e[side]), from = at(side === "out" ? [0, 0] : [1, 1]), colour = cl[side], lit = this.drag?.side === side;
      g.strokeStyle = colour;
      g.lineWidth = 1.25;
      g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(...from); g.lineTo(...p); g.stroke();
      g.setLineDash([]);
      g.fillStyle = lit ? "#ffffff" : colour;
      g.beginPath(); g.arc(p[0], p[1], lit ? 5.5 : 4.5, 0, Math.PI * 2); g.fill();
      this.handles.push({ side, x: p[0], y: p[1] });
    }
  }

  private events(): void {
    const c = this.canvas, at = (e: PointerEvent): [number, number] => localPoint(c, e);
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const s = this.host.span();
      if (typeof s === "string") return;
      const [x, y] = at(e), hit = this.handles.find((q) => Math.hypot(q.x - x, q.y - y) <= 9);
      if (!hit) return;
      e.preventDefault();
      this.drag = { side: hit.side, index: s.index, startX: x, startY: y, from: s.ease[hit.side], axis: null };
      this.host.begin(`Ease key ${hit.side === "out" ? s.index + 1 : s.index + 2}'s ${hit.side} handle`);
      c.setPointerCapture(e.pointerId);
      this.draw();
    });
    c.addEventListener("pointermove", (e) => {
      const d = this.drag, [x, y] = at(e);
      if (!d) { c.style.cursor = this.handles.some((q) => Math.hypot(q.x - x, q.y - y) <= 9) ? "pointer" : ""; return; }
      let p = this.fromCanvas(x, y);
      // Shift: held to the axis the drag went along most, from where it began.
      if (e.shiftKey) {
        d.axis ??= Math.abs(x - d.startX) >= Math.abs(y - d.startY) ? "x" : "y";
        p = d.axis === "x" ? [p[0], d.from[1]] : [d.from[0], p[1]];
      } else d.axis = null;
      const r = (v: number): number => Math.round(v * 1e4) / 1e4;
      this.host.apply(d.index, { kind: "bezier", [d.side]: [Math.min(1, Math.max(0, r(p[0]))), r(p[1])] as Vec }, d.side);
    });
    const end = (): void => {
      if (!this.drag) return;
      this.drag = null;
      this.host.end();
      this.draw();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }
}
