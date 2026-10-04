import type { ToolId } from "./Store";

/**
 * Which tools a mode offers, as in Spine: Setup edits the skeleton, so it has
 * every tool; Animate only keys, so the tools that build or reshape the
 * skeleton (Bone, IK Target, Transform Point) go — Rotate / Translate / Scale
 * / Shear stay, they key like any drag; Play mode shows the runtime, where
 * only the view can be moved.
 */
export function availableTools(mode: "setup" | "animate", playMode: boolean): ToolId[] {
  if (playMode) return ["hand", "zoom"];
  const transform: ToolId[] = ["rotate", "translate", "scale", "shear"];
  if (mode === "animate") return ["select", "freeTransform", ...transform, "hand", "zoom"];
  return ["select", "freeTransform", "pivot", "bone", "ik", ...transform, "hand", "zoom"];
}

/** The tool to be on after a mode change: the same one if the mode still
 *  offers it, otherwise the mode's first. */
export function toolForMode(tool: ToolId, mode: "setup" | "animate", playMode: boolean): ToolId {
  const tools = availableTools(mode, playMode);
  return tools.includes(tool) ? tool : tools[0]!;
}
