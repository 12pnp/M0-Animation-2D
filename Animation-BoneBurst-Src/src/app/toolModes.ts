import type { ToolId } from "./Store";

/**
 * Which tools a mode offers, as in Spine: Setup edits the skeleton, so it has
 * every tool; Animate only keys, so the tools that build or reshape the
 * skeleton (Bone, IK Target, Transform Point) go — Rotate / Translate / Scale
 * / Shear stay, they key like any drag, and Mesh keys deforms.
 */
export function availableTools(mode: "setup" | "animate"): ToolId[] {
  const transform: ToolId[] = ["rotate", "translate", "scale", "shear"];
  if (mode === "animate") return ["select", "freeTransform", "mesh", ...transform, "hand", "zoom"];
  return ["select", "freeTransform", "pivot", "bone", "ik", "mesh", ...transform, "hand", "zoom"];
}

/** The tool to be on after a mode change: the same one if the mode still
 *  offers it, otherwise the mode's first. */
export function toolForMode(tool: ToolId, mode: "setup" | "animate"): ToolId {
  const tools = availableTools(mode);
  return tools.includes(tool) ? tool : tools[0]!;
}
