import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import type { ReferenceService, SheetLayout } from "@/app/ReferenceService";
import type { Panel } from "@/view/widgets/Dock";
import { Modal } from "@/view/widgets/Modal";
import { NumberField } from "@/view/widgets/NumberField";
import { clear, h, on } from "@/view/widgets/dom";
import { referenceEnd, referenceFrameOf, referenceIndexAt, referencePlayFrame, sheetCells } from "@/core/doc/reference";
import type { AnimationReference } from "@/core/doc/types";

const SPEEDS = [0.25, 0.5, 1, 2];

/**
 * The Reference panel: pictures to animate against, for the animation being
 * edited (`Animation.reference`). A sprite sheet or a run of images becomes
 * one picture per `hold` frames from `start`, and each picture's frame can
 * then be moved on its own; the stage draws the one at the playhead, and the
 * AI can look at them (`get_reference`). Thumbnails jump the playhead to
 * their frame. A preview plays the pictures on a loop at the document's
 * frame rate (`referencePlayFrame`), or shows the one at the playhead while
 * paused. Saved with the document, never exported.
 */
export class ReferencePanel implements Panel {
  readonly id = "reference";
  readonly title = "Reference";
  readonly icon = "imageItem" as const;
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private thumbs: HTMLElement[] = [];
  private builtFor: unknown = null;
  /** The preview player. Its state outlives a rebuild of the panel: the
   *  loop restarts on the new canvas. */
  private preview: { canvas: HTMLCanvasElement; label: HTMLElement; button: HTMLButtonElement } | null = null;
  private playing = false;
  private speed = 1;
  private raf = 0;
  /** performance.now() when the shown loop began. */
  private clock = 0;
  private shownIndex: number | null = null;

  constructor(
    private readonly store: Store,
    private readonly assets: AssetStore,
    private readonly refs: ReferenceService,
    private readonly toast: (message: string, isError?: boolean) => void,
  ) {
    this.body = h("div", { class: "ref-body" });
    this.el = h("div", { class: "ref-panel" }, this.body);
    store.subscribe((t) => {
      if (t === "doc" || t === "timeline" || t === "stage" || t === "ui") this.render();
      if (t === "frame") this.syncCurrent();
    });
    store.prefs.subscribe(() => this.render(true));
    this.render();
  }

  onShow(): void { this.render(true); }

  private render(force = false): void {
    const anim = this.store.currentAnimation;
    const ref = anim?.reference;
    // Rebuilt only when the reference itself changed: the fields keep focus
    // while the playhead moves.
    const key = [anim?.id, ref, this.store.ui.mode];
    if (!force && this.builtFor && JSON.stringify(key) === JSON.stringify(this.builtFor)) { this.syncCurrent(); return; }
    this.builtFor = key;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.preview = null;
    this.shownIndex = null;
    clear(this.body);
    this.thumbs = [];
    if (!anim) { this.body.append(h("div", { class: "ref-empty" }, "No animation.")); return; }

    const addSheet = h("button", { class: "btn" }, "Add sprite sheet…");
    const addImages = h("button", { class: "btn" }, "Add images…");
    on(addSheet, "pointerup", () => this.pickSheet());
    on(addImages, "pointerup", () => this.pickImages());

    if (!ref) {
      this.playing = false;
      this.body.append(h("div", { class: "ref-empty" },
        h("div", {}, `No reference for “${anim.name}”.`),
        h("div", { class: "ref-hint" }, "Add a sprite sheet or a run of images to animate against, frame by frame. The AI can look at it too."),
        h("div", { class: "ref-actions" }, addSheet, addImages)));
      return;
    }

    const prefs = this.store.prefs;
    const stage = prefs.value.stage;
    const show = h("input", { type: "checkbox", checked: stage.showReference }) as HTMLInputElement;
    on(show, "change", () => prefs.set("stage", { showReference: show.checked }));
    const where = h("select", {}, h("option", { value: "behind" }, "Behind the rig"), h("option", { value: "above" }, "Over the rig")) as HTMLSelectElement;
    where.value = stage.referenceAbove ? "above" : "behind";
    on(where, "change", () => prefs.set("stage", { referenceAbove: where.value === "above" }));
    const opacity = h("input", { type: "range", min: "5", max: "100", value: String(Math.round(stage.referenceOpacity * 100)) }) as HTMLInputElement;
    on(opacity, "input", () => prefs.set("stage", { referenceOpacity: Number(opacity.value) / 100 }));

    const strip = h("div", { class: "ref-strip" });
    ref.frames.forEach((id, i) => {
      const canvas = h("canvas", { class: "ref-thumb-img" }) as HTMLCanvasElement;
      const th = 64, tw = Math.max(16, Math.round((ref.width / ref.height) * th));
      canvas.width = tw;
      canvas.height = th;
      const bmp = this.assets.get(id)?.bitmap;
      if (bmp) canvas.getContext("2d")!.drawImage(bmp as CanvasImageSource, 0, 0, tw, th);
      const frame = referenceFrameOf(ref, i);
      // The badge is the picture's frame, typed or dragged to move it; the
      // picture itself still jumps the playhead.
      const badge = new NumberField({
        min: 0, max: 100000, step: 1, decimals: 0,
        onInput: (v, committing) => { if (committing) this.refs.setFrameAt(i, v); },
      });
      badge.set(frame);
      const cell = h("div", { class: "ref-thumb", title: `Image ${i + 1}: from frame ${frame}` },
        canvas, badge.el);
      on(cell, "pointerup", (e) => {
        if ((e.target as HTMLElement).closest(".field")) return;
        this.store.setFrame(frame);
      });
      strip.appendChild(cell);
      this.thumbs.push(cell);
    });

    const num = (value: number, opts: ConstructorParameters<typeof NumberField>[0], commit: (v: number) => void) => {
      const f = new NumberField({ ...opts, onInput: (v, committing) => { if (committing) commit(v); } });
      f.set(value);
      return f.el;
    };
    const fit = h("button", { class: "btn" }, "Fit to rig");
    on(fit, "pointerup", () => this.refs.fitToRig());
    const del = h("button", { class: "btn" }, "Delete");
    on(del, "pointerup", () => this.refs.remove());

    const row = (label: string, ...els: Array<HTMLElement | string>) => h("div", { class: "ref-row" }, h("span", { class: "ref-label" }, label), ...els);
    this.body.append(
      this.buildPreview(),
      row("Show", show, where),
      row("Opacity", opacity),
      h("div", { class: "ref-hint" }, `${ref.frames.length} image${ref.frames.length === 1 ? "" : "s"}, ${ref.width}×${ref.height}, frames ${referenceFrameOf(ref, 0)}–${referenceEnd(ref)}. Click a picture to go to its frame; type its number to move it.`),
      strip,
      row("Each image", num(ref.hold, { min: 1, max: 1000, step: 1, decimals: 0, unit: "frames" }, (v) => this.refs.respace(ref.start, v))),
      row("Starts at", num(ref.start, { min: 0, max: 100000, step: 1, decimals: 0, unit: "frame" }, (v) => this.refs.respace(v, ref.hold))),
      row("Position", num(ref.x, { glyph: "X", step: 1, decimals: 1 }, (v) => this.refs.update({ x: v })),
        num(ref.y, { glyph: "Y", step: 1, decimals: 1 }, (v) => this.refs.update({ y: v }))),
      row("Scale", num(ref.scale * 100, { min: 0.1, max: 100000, step: 1, decimals: 1, unit: "%" }, (v) => this.refs.update({ scale: v / 100 })), fit),
      h("div", { class: "ref-actions" }, addSheet, addImages, h("div", { class: "spacer" }), del),
      this.store.ui.mode === "setup" ? h("div", { class: "ref-hint" }, "The stage shows the reference in Animate mode.") : "",
    );
    addSheet.textContent = "Replace with sheet…";
    addImages.textContent = "Replace with images…";
    this.syncCurrent();
    if (this.playing) this.loop(); else this.showAtPlayhead();
  }

  private buildPreview(): HTMLElement {
    const canvas = h("canvas", { class: "ref-preview-canvas" }) as HTMLCanvasElement;
    // Acts on pointerup, and only its label changes, never the element:
    // ARCHITECTURE ▸ A DOM trap that has bitten twice.
    const button = h("button", { class: "btn" }, this.playing ? "Pause" : "Play") as HTMLButtonElement;
    on(button, "pointerup", () => this.setPlaying(!this.playing));
    const speed = h("select", { title: "Playback speed" },
      ...SPEEDS.map((v) => h("option", { value: String(v) }, `${v}×`))) as HTMLSelectElement;
    speed.value = String(this.speed);
    on(speed, "change", () => {
      // Keep the frame on screen: restart the clock from it at the new speed.
      const frame = this.playFrame();
      this.speed = Number(speed.value);
      if (frame !== null) this.startClockAt(frame);
    });
    const label = h("span", { class: "ref-preview-label" });
    this.preview = { canvas, label, button };
    return h("div", { class: "ref-preview" }, canvas, h("div", { class: "ref-preview-bar" }, button, speed, label));
  }

  private setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    if (this.preview) this.preview.button.textContent = playing ? "Pause" : "Play";
    if (playing) {
      // From the playhead's picture when the playhead is on the reference.
      const ref = this.store.currentAnimation?.reference;
      const f = this.store.ui.frame;
      this.startClockAt(ref && referenceIndexAt(ref, f) !== null ? f : null);
      this.loop();
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.showAtPlayhead();
    }
  }

  /** Set the clock so playback is at reference frame `frame` now (null: its first frame). */
  private startClockAt(frame: number | null): void {
    const ref = this.store.currentAnimation?.reference;
    const fps = this.store.project.frameRate;
    const first = ref ? referencePlayFrame(ref, 0, fps) : 0;
    this.clock = performance.now() - (frame === null ? 0 : ((frame - first) / (fps * this.speed)) * 1000);
  }

  private playFrame(): number | null {
    const ref = this.store.currentAnimation?.reference;
    if (!ref || !this.playing) return null;
    return referencePlayFrame(ref, (performance.now() - this.clock) / 1000, this.store.project.frameRate, this.speed);
  }

  private loop(): void {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const canvas = this.preview?.canvas;
      // A hidden tab stops the loop; onShow rebuilds and restarts it.
      if (!canvas || !canvas.isConnected || canvas.offsetParent === null) { this.raf = 0; return; }
      const frame = this.playFrame();
      if (frame !== null) this.draw(frame, true);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private showAtPlayhead(): void {
    if (!this.playing) this.draw(this.store.ui.frame, false);
  }

  /** The picture at reference frame `frame`, fitted into the preview. */
  private draw(frame: number, playing: boolean): void {
    const ref: AnimationReference | undefined = this.store.currentAnimation?.reference;
    const p = this.preview;
    if (!ref || !p) return;
    const index = referenceIndexAt(ref, frame);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(p.canvas.clientWidth * dpr)), hgt = Math.max(1, Math.round(p.canvas.clientHeight * dpr));
    if (p.canvas.width !== w || p.canvas.height !== hgt) { p.canvas.width = w; p.canvas.height = hgt; }
    const ctx = p.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, hgt);
    const bmp = index === null ? undefined : this.assets.get(ref.frames[index]!)?.bitmap;
    if (bmp) {
      const s = Math.min(w / ref.width, hgt / ref.height);
      const dw = ref.width * s, dh = ref.height * s;
      ctx.drawImage(bmp as CanvasImageSource, (w - dw) / 2, (hgt - dh) / 2, dw, dh);
    }
    p.label.textContent = index === null
      ? `Frame ${frame}: no picture`
      : `Frame ${frame} · picture ${index + 1} of ${ref.frames.length}`;
    // While playing, light the picture's thumbnail without scrolling the strip under the user.
    if (playing && index !== this.shownIndex) this.thumbs.forEach((t, i) => t.classList.toggle("on", i === index));
    this.shownIndex = index;
  }

  /** The thumbnail the playhead is on. */
  private syncCurrent(): void {
    if (this.playing) return;
    this.showAtPlayhead();
    const ref = this.store.currentAnimation?.reference;
    const at = ref ? referenceIndexAt(ref, this.store.ui.frame) : null;
    this.thumbs.forEach((t, i) => t.classList.toggle("on", i === at));
    // Scroll the strip alone: scrollIntoView would scroll the panel too and
    // take the preview off screen whenever the playhead moved.
    const cell = at === null ? undefined : this.thumbs[at];
    const strip = cell?.parentElement;
    if (cell && strip) {
      const left = cell.offsetLeft - strip.offsetLeft, right = left + cell.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
    }
  }

  private pick(multiple: boolean, then: (files: File[]) => void): void {
    const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", ...(multiple ? { multiple: true } : {}) }) as HTMLInputElement;
    input.style.display = "none";
    document.body.appendChild(input);
    on(input, "change", () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (files.length) then(files);
    });
    input.click();
  }

  private pickSheet(): void {
    this.pick(false, (files) => void openSheetDialog(files[0]!, (layout) => this.run(this.refs.addSheet(files[0]!, layout))));
  }

  private pickImages(): void {
    this.pick(true, (files) => {
      if (files.length === 1) void openSheetDialog(files[0]!, (layout) => this.run(this.refs.addSheet(files[0]!, layout)));
      else void this.run(this.refs.addImages(files, 1, 0));
    });
  }

  private async run(job: Promise<void>): Promise<void> {
    try {
      await job;
      this.toast("Reference added.");
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), true);
    }
  }
}

/**
 * How a sheet divides: columns, rows, how many cells hold frames, and their
 * timing, with the grid drawn over the sheet as it will be cut.
 */
async function openSheetDialog(file: File, done: (layout: SheetLayout) => void): Promise<void> {
  const bitmap = await createImageBitmap(file);
  const W = bitmap.width, H = bitmap.height;
  // A first guess: square cells along the long side.
  const layout: SheetLayout = W >= H
    ? { columns: Math.max(1, Math.round(W / H)), rows: 1, count: Math.max(1, Math.round(W / H)), hold: 1, start: 0 }
    : { columns: 1, rows: Math.max(1, Math.round(H / W)), count: Math.max(1, Math.round(H / W)), hold: 1, start: 0 };

  const modal = new Modal({ title: `Sprite sheet: ${file.name}`, width: 760, height: 560, onClose: () => bitmap.close() });
  const canvas = h("canvas", { class: "ref-sheet" }) as HTMLCanvasElement;
  const info = h("div", { class: "ref-hint" });
  const draw = () => {
    const box = canvas.parentElement?.getBoundingClientRect();
    const maxW = Math.max(200, (box?.width ?? 480) - 8), maxH = 380;
    const s = Math.min(maxW / W, maxH / H, 4);
    canvas.width = Math.round(W * s);
    canvas.height = Math.round(H * s);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = s < 1;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const cells = sheetCells(W, H, layout.columns, layout.rows, layout.count);
    ctx.lineWidth = 1;
    ctx.font = "11px sans-serif";
    cells.forEach((c, i) => {
      ctx.strokeStyle = "rgba(0,188,217,0.95)";
      ctx.strokeRect(Math.round(c.x * s) + 0.5, Math.round(c.y * s) + 0.5, Math.round(c.w * s) - 1, Math.round(c.h * s) - 1);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(c.x * s + 1, c.y * s + 1, 22, 14);
      ctx.fillStyle = "#fff";
      ctx.fillText(String(i + 1), c.x * s + 4, c.y * s + 12);
    });
    const cw = Math.floor(W / Math.max(1, layout.columns)), ch = Math.floor(H / Math.max(1, layout.rows));
    info.textContent = `${W}×${H} sheet → ${cells.length} frame${cells.length === 1 ? "" : "s"} of ${cw}×${ch}, playing frames ${layout.start}–${layout.start + cells.length * layout.hold - 1}.`;
    ok.disabled = cells.length === 0;
  };

  const field = (label: string, key: keyof SheetLayout, min: number) => {
    const f = new NumberField({
      min, max: 10000, step: 1, decimals: 0,
      onInput: (v, committing) => {
        if (!committing) return;
        layout[key] = Math.max(min, Math.round(v));
        if (key === "columns" || key === "rows") layout.count = layout.columns * layout.rows;
        f.set(layout[key]);
        syncFields();
        draw();
      },
    });
    f.set(layout[key]);
    return { f, el: h("label", { class: "ref-row" }, h("span", { class: "ref-label" }, label), f.el) };
  };
  const fields = {
    columns: field("Columns", "columns", 1), rows: field("Rows", "rows", 1), count: field("Frames", "count", 1),
    hold: field("Each image", "hold", 1), start: field("Starts at frame", "start", 0),
  };
  const syncFields = () => { for (const [k, v] of Object.entries(fields)) v.f.set(layout[k as keyof SheetLayout]); };

  const ok = h("button", { class: "btn primary" }, "Add") as HTMLButtonElement;
  const cancel = h("button", { class: "btn" }, "Cancel");
  on(cancel, "pointerup", () => modal.close());
  on(ok, "pointerup", () => { const l = { ...layout }; modal.close(); done(l); });

  modal.body.classList.add("ref-sheet-dlg");
  modal.body.append(
    h("div", { class: "ref-sheet-view" }, canvas),
    h("div", { class: "ref-sheet-fields" }, ...Object.values(fields).map((f) => f.el), info),
  );
  modal.footer.append(h("div", { class: "spacer" }), cancel, ok);
  requestAnimationFrame(draw);
}
