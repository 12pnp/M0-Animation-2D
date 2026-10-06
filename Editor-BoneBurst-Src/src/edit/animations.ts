import type { Animation, Skeleton } from "@/model/skeleton";
import { EditRefused, type Edit } from "./history";

/** Add an empty animation after the others. Refused for an empty name or one already taken. */
export function addAnimation(name: string): Edit<Skeleton> {
  return (s) => {
    if (!name.trim()) throw new EditRefused("An animation needs a name.");
    if (s.animations?.some((a) => a.name === name)) throw new EditRefused(`There is already an animation "${name}".`);
    const a: Animation = { name, extra: new Map() };
    return { ...s, animations: [...(s.animations ?? []), a] };
  };
}

/** Remove an animation. Refused while a slider constraint plays it. */
export function deleteAnimation(name: string): Edit<Skeleton> {
  return (s) => {
    if (!s.animations?.some((a) => a.name === name)) throw new EditRefused(`There is no animation "${name}".`);
    const slider = s.constraints?.find((c) => c.type === "slider" && c.animation === name);
    if (slider) throw new EditRefused(`The slider "${slider.name}" plays "${name}".`);
    const rest = s.animations.filter((a) => a.name !== name);
    if (rest.length) return { ...s, animations: rest };
    const { animations: _, ...out } = s;
    return out as Skeleton;
  };
}

/** Rename an animation, and the sliders that play it. */
export function renameAnimation(from: string, to: string): Edit<Skeleton> {
  return (s) => {
    if (from === to) return s;
    if (!s.animations?.some((a) => a.name === from)) throw new EditRefused(`There is no animation "${from}".`);
    if (!to.trim()) throw new EditRefused("An animation needs a name.");
    if (s.animations.some((a) => a.name === to)) throw new EditRefused(`There is already an animation "${to}".`);
    return {
      ...s,
      animations: s.animations.map((a) => (a.name === from ? { ...a, name: to } : a)),
      ...(s.constraints ? { constraints: s.constraints.map((c) => (c.type === "slider" && c.animation === from ? { ...c, animation: to } : c)) } : {}),
    };
  };
}

/** Add a copy of an animation, after the others, under a new name. */
export function duplicateAnimation(from: string, to: string): Edit<Skeleton> {
  return (s) => {
    const a = s.animations?.find((x) => x.name === from);
    if (!a) throw new EditRefused(`There is no animation "${from}".`);
    if (!to.trim()) throw new EditRefused("An animation needs a name.");
    if (s.animations!.some((x) => x.name === to)) throw new EditRefused(`There is already an animation "${to}".`);
    return { ...s, animations: [...s.animations!, { ...a, name: to, extra: new Map(a.extra) }] };
  };
}
