import type { Store } from "@/app/Store";
import type { AgentApi, AgentImage, PoseStyle } from "@/app/agent/AgentApi";
import { PosesService } from "@/app/PosesService";
import type { Picture } from "@/view/agent/AiPanel";
import type { Panel } from "@/view/widgets/Dock";
import { downloadBlob } from "@/io/export/ExportBundle";
import { zipFiles } from "@/io/zip";
import { posePrompt } from "@/app/agent/poseHandoff";
import { NumberField } from "@/view/widgets/NumberField";
import { clear, h, on } from "@/view/widgets/dom";
import { referenceStarts } from "@/core/doc/reference";
import { renderPoses } from "@/app/agent/agentLook";

/** How many poses ride along as pictures: the bridge's per-message budget. */
const HANDOFF_PICTURES = 6;

/**
 * The Poses panel: the animation's key-pose frames (`Animation.poses`),
 * curated by hand — add the playhead's frame, every keyed frame, or the
 * frame of every reference picture — each with a rendered thumbnail (over
 * its reference picture, when "Reference" is on) and an editable frame
 * number. "Ask AI to fill in" hands the poses to the AI panel as pictures
 * and asks for what is missing: the poses not keyed yet, then the
 * in-betweens; "Export…" writes them to a zip for keeping or another AI.
 */
/** How a pose is captured, the panel's Capture choice. */
const STYLES: Array<{ value: PoseStyle; label: string }> = [
  { value: "bones", label: "Bones only" },
  { value: "artwork", label: "Artwork only" },
  { value: "both", label: "Bones + artwork" },
];

export class PosesPanel implements Panel {
  readonly id = "poses";
  readonly title = "Poses";
  readonly icon = "multiFrames" as const;
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private builtFor: unknown = null;
  private renderToken = 0;
  private style: PoseStyle = "both";
  /** Draw each pose over the reference picture at its frame. */
  private withReference = true;

  constructor(
    private readonly store: Store,
    private readonly agent: AgentApi,
    private readonly poses: PosesService,
    private readonly askAi: (text: string, pictures: Picture[]) => void,
    private readonly toast: (message: string, isError?: boolean) => void,
  ) {
    this.body = h("div", { class: "pose-body" });
    this.el = h("div", { class: "pose-panel" }, this.body);
    store.subscribe((t) => {
      if (t === "doc" || t === "timeline" || t === "ui") this.render();
      if (t === "frame") this.syncCurrent();
    });
    this.render();
  }

  onShow(): void { this.render(true); }

  private render(force = false): void {
    const anim = this.store.currentAnimation;
    const frames = anim?.poses ?? [];
    // Rebuilt only when the pose list itself changed: renders are async and
    // the fields keep focus while the playhead moves.
    const key = [anim?.id, frames, !!anim?.reference];
    if (!force && this.builtFor && JSON.stringify(key) === JSON.stringify(this.builtFor)) { this.syncCurrent(); return; }
    this.builtFor = key;
    clear(this.body);
    if (!anim) { this.body.append(h("div", { class: "pose-empty" }, "No animation.")); return; }

    const add = h("button", { class: "btn", title: "A pose at the playhead's frame" }, "Playhead frame");
    on(add, "pointerup", () => this.poses.add([this.store.ui.frame]));
    const fromKeys = h("button", { class: "btn" }, "From keyed frames");
    on(fromKeys, "pointerup", () => {
      const keyed = PosesService.keyedFrames(this.store.currentAnimation);
      this.poses.add(keyed, "Add Poses from Keys");
    });
    // The reference's key drawings as poses: the AI then poses each one from its picture.
    const ref = anim.reference;
    const fromRef = ref ? h("button", { class: "btn", title: "A pose at the frame of every reference picture" }, "From reference") : "";
    if (fromRef) on(fromRef, "pointerup", () => this.poses.add(referenceStarts(ref!), "Add Poses from Reference"));

    if (frames.length === 0) {
      this.body.append(h("div", { class: "pose-empty" },
        h("div", {}, `No poses for “${anim.name}”.`),
        h("div", { class: "pose-hint" }, ref
          ? "Mark the frames whose poses matter — from the reference's pictures, or frames already keyed. The AI poses what is not keyed from the reference, then animates between them."
          : "Mark the frames whose poses are right — the AI animates between them."),
        h("div", { class: "pose-actions" }, add, fromKeys, fromRef)));
      return;
    }

    const keyed = new Set(PosesService.keyedFrames(anim));
    const strip = h("div", { class: "pose-strip" });
    frames.forEach((frame) => {
      const img = h("img", { class: "pose-thumb-img", alt: "" }) as HTMLImageElement;
      const badge = new NumberField({
        min: 0, max: 100000, step: 1, decimals: 0,
        onInput: (v, committing) => { if (committing) this.poses.move(frame, v); },
      });
      badge.set(frame);
      const x = h("button", { class: "pose-x", title: "Remove this pose" }, "×");
      on(x, "pointerup", () => this.poses.remove(frame));
      const cell = h("div", { class: "pose-thumb", title: `Pose at frame ${frame}` }, img, badge.el, x);
      on(cell, "pointerup", (e) => {
        if ((e.target as HTMLElement).closest(".field, .pose-x")) return;
        this.store.setFrame(frame);
      });
      cell.dataset.frame = String(frame);
      if (!keyed.has(frame)) {
        cell.classList.add("unkeyed");
        cell.title = `Pose at frame ${frame}: not keyed yet`;
      }
      strip.appendChild(cell);
    });

    const ask = h("button", { class: "btn primary" }, "Ask AI to fill in");
    on(ask, "pointerup", () => void this.handoff());
    const exportBtn = h("button", { class: "btn" }, "Export…");
    on(exportBtn, "pointerup", () => void this.exportZip());
    const capture = h("select", { title: "How a pose is captured, here and for the AI" },
      ...STYLES.map((s) => h("option", { value: s.value }, s.label))) as HTMLSelectElement;
    capture.value = this.style;
    on(capture, "change", () => { this.style = capture.value as PoseStyle; this.render(true); });
    const overRef = ref ? h("label", { class: "pose-check", title: "Draw each pose over the reference picture at its frame, here, in the export and for the AI" },
      h("input", { type: "checkbox", checked: this.withReference }), "Reference") : "";
    if (overRef) on(overRef.querySelector("input")!, "change", (e) => { this.withReference = (e.target as HTMLInputElement).checked; this.render(true); });

    const unkeyed = frames.filter((f) => !keyed.has(f)).length;
    this.body.append(
      h("div", { class: "pose-hint" }, `${frames.length} pose${frames.length === 1 ? "" : "s"} of “${anim.name}”${unkeyed ? `, ${unkeyed} not keyed yet` : ""}${frames.length > HANDOFF_PICTURES ? `, the first ${HANDOFF_PICTURES} as pictures` : ""}. Click a pose to go to its frame; type its number to move it.`),
      strip,
      h("div", { class: "pose-actions" }, h("span", { class: "pose-label" }, "Capture"), capture, overRef, h("div", { class: "spacer" }), ask, exportBtn),
      h("div", { class: "pose-actions" }, h("span", { class: "pose-label" }, "Add"), add, fromKeys, fromRef));
    this.syncCurrent();
    void this.paint(strip, frames);
  }

  /** The thumbnails: all poses, one shared framing, in the Capture style —
   *  each shown as soon as it is rendered. */
  private async paint(strip: HTMLElement, frames: number[]): Promise<void> {
    const anim = this.store.currentAnimation;
    if (!anim) return;
    const token = ++this.renderToken;
    try {
      const imgs = [...strip.querySelectorAll(".pose-thumb-img")] as HTMLImageElement[];
      await renderPoses(this.agent, anim.name, frames, this.style, (image, i) => {
        if (token === this.renderToken && imgs[i]) imgs[i]!.src = `data:${image.mimeType};base64,${image.data}`;
      }, this.overReference());
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), true);
    }
  }

  private overReference(): boolean {
    return this.withReference && !!this.store.currentAnimation?.reference;
  }

  /** The thumbnail the playhead is on: the latest pose at or before it. */
  private syncCurrent(): void {
    const frames = this.store.currentAnimation?.poses ?? [];
    const frame = this.store.ui.frame;
    let onFrame = -1;
    for (let i = 0; i < frames.length; i++) if (frames[i]! <= frame) onFrame = i;
    for (const cell of [...this.body.querySelectorAll(".pose-thumb")] as HTMLElement[]) {
      cell.classList.toggle("on", Number(cell.dataset.frame) === frames[onFrame]);
    }
  }

  /** The pictures the AI reads: the first few poses, in the Capture style. */
  private async handoff(): Promise<void> {
    const anim = this.store.currentAnimation;
    const frames = anim?.poses ?? [];
    if (!anim || frames.length === 0) return;
    try {
      const images = await renderPoses(this.agent, anim.name, frames.slice(0, HANDOFF_PICTURES), this.style, undefined, this.overReference());
      const text = posePrompt(anim.name, this.store.project.frameRate, frames, images.length, {
        withBones: this.style !== "artwork", overReference: this.overReference(), keyed: PosesService.keyedFrames(anim),
      });
      this.askAi(text, images.map(toPicture));
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), true);
    }
  }

  /** One proper artifact: a picture per pose in the Capture style, and the
   *  frame list. */
  private async exportZip(): Promise<void> {
    const anim = this.store.currentAnimation;
    const frames = anim?.poses ?? [];
    if (!anim || frames.length === 0) return;
    try {
      const images = await renderPoses(this.agent, anim.name, frames, this.style, undefined, this.overReference());
      const files: Record<string, Uint8Array> = {};
      images.forEach((im, i) => { files[`${anim.name}-pose-f${frames[i]!}.png`] = bytesOf(im); });
      files["poses.json"] = new TextEncoder().encode(JSON.stringify({ animation: anim.name, fps: this.store.project.frameRate, frames }, null, 2));
      const zipped = await zipFiles(files);
      downloadBlob(new Blob([zipped as unknown as BlobPart], { type: "application/zip" }), `${anim.name}-poses.zip`);
      this.toast(`Exported ${frames.length} pose${frames.length === 1 ? "" : "s"}.`);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), true);
    }
  }
}

function toPicture(image: AgentImage): Picture {
  return { mimeType: image.mimeType, data: image.data };
}

/** base64 PNG → bytes, for the zip. */
function bytesOf(image: AgentImage): Uint8Array {
  const bin = atob(image.data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
