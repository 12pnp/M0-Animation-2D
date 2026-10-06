import { describe, expect, it } from "vitest";
import { addAnimation, duplicateAnimation } from "@/edit/animations";
import { EditRefused } from "@/edit/history";
import { newSkeleton } from "@/edit/newSkeleton";
import type { Skeleton } from "@/model/skeleton";

describe("duplicateAnimation", () => {
  const base = (): Skeleton => addAnimation("walk")(newSkeleton("hash"));

  it("adds a copy after the others, leaving the original alone", () => {
    const s = duplicateAnimation("walk", "walk copy")(base());
    expect(s.animations?.map((a) => a.name)).toEqual(["walk", "walk copy"]);
  });

  it("refuses a name that is taken, empty, or an animation that is not there", () => {
    expect(() => duplicateAnimation("walk", "walk")(base())).toThrow(EditRefused);
    expect(() => duplicateAnimation("walk", " ")(base())).toThrow(EditRefused);
    expect(() => duplicateAnimation("run", "run 2")(base())).toThrow(EditRefused);
  });
});
