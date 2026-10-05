import type { EventDef, EventKey } from "./types";

/**
 * Waveforms of event sounds on the timeline (ARCHITECTURE ▸ Events), pure:
 * a decoded sound reduced to its peaks, and which keys play which sound.
 */

export interface Waveform {
  /** The loudest sample (0..1, every channel) in each 1/`perSecond` s. */
  peaks: Float32Array;
  perSecond: number;
  /** Seconds. */
  duration: number;
}

export function waveformPeaks(channels: readonly Float32Array[], sampleRate: number, perSecond: number): Waveform {
  const length = channels[0]?.length ?? 0;
  const step = sampleRate / perSecond;
  const peaks = new Float32Array(Math.ceil(length / step));
  for (const data of channels) {
    for (let i = 0; i < length; i++) {
      const b = Math.floor(i / step);
      const v = Math.abs(data[i]!);
      if (v > peaks[b]!) peaks[b] = Math.min(1, v);
    }
  }
  return { peaks, perSecond, duration: length / sampleRate };
}

/** The loudest peak between `t0` and `t1` seconds; 0 outside the sound. */
export function peakBetween(w: Waveform, t0: number, t1: number): number {
  const a = Math.max(0, Math.floor(t0 * w.perSecond));
  const b = Math.min(w.peaks.length, Math.max(a + 1, Math.ceil(t1 * w.perSecond)));
  let peak = 0;
  for (let i = a; i < b; i++) if (w.peaks[i]! > peak) peak = w.peaks[i]!;
  return peak;
}

export interface EventSound {
  frame: number;
  path: string;
  /** The key's volume, else the event's, else 1. */
  volume: number;
}

/** The keys of an animation that play a sound, in frame order. */
export function eventSounds(keys: readonly EventKey[] | undefined, defs: readonly EventDef[] | undefined): EventSound[] {
  const byName = new Map((defs ?? []).map((d) => [d.name, d]));
  const out: EventSound[] = [];
  for (const k of keys ?? []) {
    const def = byName.get(k.name);
    if (!def?.audio) continue;
    out.push({ frame: k.frame, path: def.audio, volume: k.volume ?? def.volume ?? 1 });
  }
  return out.sort((a, b) => a.frame - b.frame);
}
