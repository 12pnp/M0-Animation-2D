import { describe, expect, it } from "vitest";
import { SPEED_SLIDER_MAX, sliderFromSpeed, speedFromSlider, speedLabel } from "@/view/timeline/playSpeed";

const one = sliderFromSpeed(1);

describe("play speed slider", () => {
  it.each([
    { v: 0, speed: 0.01 },
    { v: SPEED_SLIDER_MAX, speed: 5 },
    { v: one, speed: 1 },
    { v: one + 8, speed: 1 },
    { v: one - 8, speed: 1 },
    { v: -50, speed: 0.01 },
    { v: 5000, speed: 5 },
  ])("slider $v → $speed×", ({ v, speed }) => {
    expect(speedFromSlider(v)).toBe(speed);
  });

  it.each([0.01, 0.05, 0.25, 0.5, 2, 3, 5])("%s× survives the round trip", (speed) => {
    expect(speedFromSlider(sliderFromSpeed(speed))).toBeCloseTo(speed, 1);
  });

  it("0.5× and 2× sit the same distance either side of 1×", () => {
    expect(one - sliderFromSpeed(0.5)).toBe(sliderFromSpeed(2) - one);
  });

  it.each([
    { speed: 0, v: one },
    { speed: 100, v: SPEED_SLIDER_MAX },
    { speed: 0.001, v: 0 },
  ])("$speed× → slider $v", ({ speed, v }) => {
    expect(sliderFromSpeed(speed)).toBe(v);
  });

  it.each([
    { speed: 1, text: "1×" },
    { speed: 0.01, text: "0.01×" },
    { speed: 1.25, text: "1.25×" },
  ])("$speed → $text", ({ speed, text }) => {
    expect(speedLabel(speed)).toBe(text);
  });
});
