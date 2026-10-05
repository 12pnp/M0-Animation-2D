import type { Store } from "@/app/Store";
import { icon } from "@/view/icons";
import { clear, cls, h, on } from "@/view/widgets/dom";
import type { Playback } from "./Playback";

/**
 * The transport buttons the Timeline and the Graph share: first, previous,
 * play, next, last and loop, driving one `Playback`. `sync` follows the
 * store, so either panel's buttons show what the other's did.
 */
export function transportButtons(store: Store, playback: Playback): { buttons: HTMLElement[]; sync(): void } {
  const iconBtn = (name: Parameters<typeof icon>[0], title: string, run: () => void) => {
    const b = h("button", { class: "iconbtn", title });
    b.appendChild(icon(name, 13));
    on(b, "click", run);
    return b;
  };
  const playBtn = h("button", { class: "iconbtn" });
  on(playBtn, "click", () => playback.toggle());
  const loopBtn = iconBtn("loop", "Loop", () => store.setUi({ loop: !store.ui.loop }, "playback"));

  // The play icon is rebuilt only when the state changes. This runs every
  // frame while playing, and replacing the SVG under a real click (100ms
  // between pointerdown and pointerup) lost the click's target, so Pause
  // looked dead; synthetic clicks passed regardless.
  let shown: boolean | null = null;
  const sync = () => {
    cls(loopBtn, "on", store.ui.loop);
    if (shown === store.ui.playing) return;
    shown = store.ui.playing;
    clear(playBtn);
    playBtn.appendChild(icon(shown ? "pause" : "play", 13));
    playBtn.title = shown ? "Pause (space)" : "Play (space)";
  };
  sync();
  store.subscribe((t) => { if (t === "playback" || t === "frame" || t === "ui") sync(); });

  return {
    buttons: [
      iconBtn("first", "First frame", () => playback.toStart()),
      iconBtn("prev", "Previous frame", () => playback.stepBy(-1)),
      playBtn,
      iconBtn("next", "Next frame", () => playback.stepBy(1)),
      iconBtn("last", "Last frame", () => playback.toEnd()),
      loopBtn,
    ],
    sync,
  };
}
