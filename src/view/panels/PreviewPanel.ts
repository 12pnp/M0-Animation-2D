import { clear, cls, h, on } from "@/view/widgets/dom";
import { icon } from "@/view/icons";
import type { Panel } from "@/view/widgets/Dock";
import { PreviewHost } from "@/preview/previewHost";
import type { PreviewSession, PreviewView } from "@/preview/PreviewSession";
import type { SoundStore } from "@/app/SoundStore";
import type { FrameToHost } from "@/preview/protocol";

/**
 * Runs the project through the ACTUAL DragonBones runtime.
 *
 * The panel exports the project in memory and feeds the runtime the exact
 * bytes that would go to disk, so this is not a second opinion about how the
 * animation looks — it is the answer. If the stage and this disagree, the
 * export is wrong, and that is worth finding out while authoring rather than
 * after shipping.
 *
 * The export itself belongs to `PreviewSession`, which any other runtime view
 * shares: this panel is one VIEW of that runtime, with its own iframe and its
 * own toggles.
 */
export class PreviewPanel implements Panel, PreviewView {
  readonly id = "preview";
  readonly title = "Preview";
  readonly icon = "preview" as const;
  readonly el: HTMLElement;
  readonly footer: HTMLElement;

  readonly host = new PreviewHost();
  private frameWrap: HTMLElement;
  private status: HTMLElement;
  private animSelect: HTMLSelectElement;
  private playBtn: HTMLButtonElement;
  private debugBtn: HTMLButtonElement;
  private debugDraw = false;
  private playing = false;
  private mounted = false;
  private floatBtn: HTMLButtonElement;
  private showStage = true;
  /** Mixing: play one animation, then crossfade into the chosen one. */
  private mixBar: HTMLElement;
  private mixFrom: HTMLSelectElement;
  private mixDuration: HTMLInputElement;
  /** The events the runtime fires, newest last, each fading out. */
  private eventLog: HTMLElement;
  private audio: AudioContext | null = null;
  private decoded = new Map<Blob, Promise<AudioBuffer | null>>();
  /**
   * "This rig needs the extension runtime." Masks and motion blur are not
   * part of the DragonBones format; a stock player would ignore them, and
   * nothing else in the UI would say so.
   */

  constructor(
    private readonly session: PreviewSession,
    /** Tear the panel out into a window of its own, or put it back. */
    private readonly onToggleFloat: () => void = () => {},
    /** Event sounds, played as the runtime fires their events. */
    private readonly sounds?: SoundStore,
  ) {
    this.frameWrap = h("div", { class: "preview-frame" }, this.host.iframe);
    this.status = h("div", { class: "preview-status" });
    this.animSelect = h("select", { class: "preview-anim", title: "Animation" });
    this.playBtn = h("button", { class: "iconbtn", title: "Play / pause" }) as HTMLButtonElement;
    this.debugBtn = h("button", { class: "iconbtn", title: "Show bones" }) as HTMLButtonElement;
    this.floatBtn = h("button", {
      class: "iconbtn", title: "Float this panel",
    }) as HTMLButtonElement;

    this.eventLog = h("div", { class: "preview-events" });
    this.frameWrap.appendChild(this.eventLog);
    this.mixFrom = h("select", { class: "preview-anim", title: "Play this animation first" }) as HTMLSelectElement;
    this.mixDuration = h("input", { type: "number", min: "0", step: "0.05", value: "0.2", class: "preview-mix-dur", title: "Mix duration, seconds" }) as HTMLInputElement;
    const playMix = h("button", { class: "btn", title: "Play the first animation once, then crossfade into the one chosen below, as a game changes animation" }, "Play Mix");
    on(playMix, "click", () => {
      const to = this.animSelect.value;
      if (!this.mixFrom.value || !to) return;
      this.setPlaying(true);
      this.host.post({ type: "playMix", from: this.mixFrom.value, to, duration: Number(this.mixDuration.value) || 0 });
    });
    this.mixBar = h("div", { class: "preview-mixbar" },
      h("span", null, "Mix from"), this.mixFrom, h("span", null, "over"), this.mixDuration, h("span", null, "s"), playMix);
    this.mixBar.hidden = true;
    this.el = h("div", { class: "preview" }, this.frameWrap, this.status, this.mixBar);
    this.footer = this.buildFooter();

    this.host.onMessage((msg) => {
      if (msg.type === "loaded") {
        this.setStatus("");
        clear(this.animSelect);
        for (const name of msg.animations) {
          this.animSelect.appendChild(h("option", { value: name }, name));
        }
        this.animSelect.value = msg.animation;
        this.animSelect.disabled = msg.animations.length <= 1;
        const from = this.mixFrom.value;
        clear(this.mixFrom);
        for (const name of msg.animations) this.mixFrom.appendChild(h("option", { value: name }, name));
        if (msg.animations.includes(from)) this.mixFrom.value = from;
      } else if (msg.type === "event") {
        this.showEvent(msg);
      } else if (msg.type === "error") {
        this.setStatus(msg.message, true);
      }
    });

    this.session.register(this);
  }

  // ── PreviewView ────────────────────────────────────────────────────────

  /** On screen: a tab in the background or a closed panel is detached by the
   *  dock, and rebuilding the export for it cost every edit an atlas pack. */
  active(): boolean { return this.mounted && this.el.isConnected; }
  options(): { debugDraw: boolean; showStage: boolean; play: boolean } {
    return { debugDraw: this.debugDraw, showStage: this.showStage, play: this.playing };
  }
  onStatus(text: string, isError = false): void { this.setStatus(text, isError); }

  onShow(): void {
    this.mounted = true;
    this.session.show(this);
  }

  private buildFooter(): HTMLElement {
    clear(this.playBtn);
    this.playBtn.appendChild(icon("play", 13));
    on(this.playBtn, "click", () => {
      this.setPlaying(!this.playing);
      this.host.post(this.playing ? { type: "play" } : { type: "pause" });
    });

    this.debugBtn.appendChild(icon("bone", 13));
    on(this.debugBtn, "click", () => {
      this.debugDraw = !this.debugDraw;
      cls(this.debugBtn, "on", this.debugDraw);
      this.host.post({ type: "setDebug", on: this.debugDraw });
    });

    on(this.animSelect, "change", () => {
      this.host.post({ type: "setAnimation", name: this.animSelect.value });
    });

    const stageBtn = h("button", { class: "iconbtn", title: "Show scene bounds" });
    stageBtn.appendChild(icon("scene", 13));
    cls(stageBtn, "on", this.showStage);
    on(stageBtn, "click", () => {
      this.showStage = !this.showStage;
      cls(stageBtn, "on", this.showStage);
      this.host.post({ type: "showStage", on: this.showStage });
    });

    const mixBtn = h("button", { class: "iconbtn", title: "Mix two animations" });
    mixBtn.appendChild(icon("film", 13));
    on(mixBtn, "click", () => {
      this.mixBar.hidden = !this.mixBar.hidden;
      cls(mixBtn, "on", !this.mixBar.hidden);
    });

    this.floatBtn.appendChild(icon("float", 13));
    on(this.floatBtn, "click", () => this.onToggleFloat());

    const refresh = h("button", { class: "iconbtn", title: "Refresh the preview" });
    refresh.appendChild(icon("loop", 13));
    on(refresh, "click", () => { this.session.invalidate(); void this.session.refresh(true); });

    return h("div", { class: "pfooter" },
      this.playBtn, this.debugBtn, stageBtn,
      h("div", { class: "sep-v" }),
      this.animSelect, mixBtn,
      h("div", { class: "spacer" }),
      this.floatBtn, refresh,
    );
  }

  private setPlaying(on_: boolean): void {
    this.playing = on_;
    clear(this.playBtn);
    this.playBtn.appendChild(icon(on_ ? "pause" : "play", 13));
  }

  /** An event the runtime fired: listed for two seconds, its sound played. */
  private showEvent(e: Extract<FrameToHost, { type: "event" }>): void {
    const values = [e.int ? `int ${e.int}` : "", e.float ? `float ${+e.float.toFixed(3)}` : "", e.string ? `"${e.string}"` : ""].filter(Boolean).join(", ");
    const line = h("div", { class: "preview-event" }, h("b", null, e.name), values ? ` ${values}` : "");
    this.eventLog.appendChild(line);
    while (this.eventLog.childElementCount > 6) this.eventLog.firstElementChild!.remove();
    setTimeout(() => line.classList.add("gone"), 1600);
    setTimeout(() => line.remove(), 2200);
    if (e.audio) void this.play(e.audio, e.volume, e.balance);
  }

  /** Play a sound file at a volume (0..1) and balance (−1 left .. 1 right). */
  private async play(path: string, volume: number, balance: number): Promise<void> {
    const blob = this.sounds?.get(path);
    if (!blob) return;
    this.audio ??= new AudioContext();
    const ctx = this.audio;
    let buffer = this.decoded.get(blob);
    if (!buffer) {
      buffer = blob.arrayBuffer().then((b) => ctx.decodeAudioData(b)).catch(() => null);
      this.decoded.set(blob, buffer);
    }
    const data = await buffer;
    if (!data) return;
    const src = ctx.createBufferSource();
    src.buffer = data;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, volume);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, balance));
    src.connect(gain).connect(pan).connect(ctx.destination);
    src.start();
  }

  private setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.style.display = text ? "block" : "none";
    cls(this.status, "error", isError);
  }
}
