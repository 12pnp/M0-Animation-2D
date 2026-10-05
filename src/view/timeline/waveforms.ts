import type { SoundStore } from "@/app/SoundStore";
import { type Waveform, waveformPeaks } from "@/core/doc/waveform";

const PEAKS_PER_SECOND = 400;

/**
 * Event sounds decoded for the Events row, once per file: by the blob, so a
 * sound replaced under the same path is decoded again. `onReady` redraws
 * when a decode finishes.
 */
export class Waveforms {
  private cache = new WeakMap<Blob, Waveform | "pending" | "failed">();

  constructor(private readonly sounds: SoundStore, private readonly onReady: () => void) {
    sounds.onChange(onReady);
  }

  /** The sound's waveform, or null while it decodes or when it cannot. */
  get(path: string): Waveform | null {
    const blob = this.sounds.get(path);
    if (!blob) return null;
    const known = this.cache.get(blob);
    if (known === undefined) {
      this.cache.set(blob, "pending");
      void decode(blob).then(
        (w) => { this.cache.set(blob, w); this.onReady(); },
        () => { this.cache.set(blob, "failed"); },
      );
      return null;
    }
    return typeof known === "object" ? known : null;
  }
}

async function decode(blob: Blob): Promise<Waveform> {
  // An offline context decodes without a user gesture and plays nothing.
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return waveformPeaks(channels, buffer.sampleRate, PEAKS_PER_SECOND);
}
