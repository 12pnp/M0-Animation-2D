import { describe, expect, it } from "vitest";
import { eventSounds, peakBetween, waveformPeaks } from "@/core/doc/waveform";

describe("waveform peaks", () => {
  // 1 s at 8 samples/s: quiet, a loud spike on the right channel, then silence.
  const left = new Float32Array([0.1, -0.2, 0.1, 0, 0, 0, 0, 0]);
  const right = new Float32Array([0, 0, 0, -0.9, 0.3, 0, 0, 0]);
  const w = waveformPeaks([left, right], 8, 4);

  it("the loudest sample of every channel per bucket, as a magnitude", () => {
    expect([...w.peaks].map((v) => Math.round(v * 100) / 100)).toEqual([0.2, 0.9, 0.3, 0]);
    expect(w.duration).toBe(1);
  });

  it.each([
    { t0: 0, t1: 0.25, want: 0.2 },
    { t0: 0.1, t1: 0.6, want: 0.9 },
    { t0: 0.75, t1: 1, want: 0 },
    { t0: 0.3, t1: 0.3, want: 0.9 },
    { t0: 2, t1: 3, want: 0 },
  ])("between $t0 and $t1 s: $want", ({ t0, t1, want }) => {
    expect(peakBetween(w, t0, t1)).toBeCloseTo(want, 5);
  });

  it("clips past full scale", () => {
    expect(waveformPeaks([new Float32Array([1.7])], 1, 1).peaks[0]).toBe(1);
  });
});

describe("which keys play a sound", () => {
  it("keys of events with audio, the key's volume over the event's, by frame", () => {
    const defs = [{ name: "step", audio: "step.wav", volume: 0.5 }, { name: "hit" }, { name: "boom", audio: "boom.ogg" }];
    const keys = [{ frame: 9, name: "boom" }, { frame: 2, name: "step", volume: 0.8 }, { frame: 4, name: "hit" }, { frame: 6, name: "step" }, { frame: 7, name: "gone" }];
    expect(eventSounds(keys, defs)).toEqual([
      { frame: 2, path: "step.wav", volume: 0.8 },
      { frame: 6, path: "step.wav", volume: 0.5 },
      { frame: 9, path: "boom.ogg", volume: 1 },
    ]);
    expect(eventSounds(undefined, defs)).toEqual([]);
  });
});
