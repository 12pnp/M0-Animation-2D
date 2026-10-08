import { type AgentContext, AgentRefused } from "./context";
import { docOf } from "./read";

/**
 * `export_to_unity` (E5-PLAN step 8): the editor writes the rig into the Unity folder chosen with
 * Export to Unity…; Unity's BoneBurst import rebakes a folder it baked before on its next refresh.
 */
async function exportToUnity(args: Record<string, unknown>, ctx: AgentContext) {
  docOf(ctx);
  const mode = args["mode"] === undefined ? "keys" : args["mode"];
  if (mode !== "keys" && mode !== "twinspline") throw new AgentRefused('`mode` is "keys" or "twinspline".');
  const out = await ctx.exportToUnity(mode);
  return { folder: out.folder, files: out.files, ...(out.note ? { twinspline: out.note } : {}), note: "Unity rebakes this folder on its next refresh if it baked it before (BoneBurst import); otherwise bake it once there." };
}

export const UNITY_TOOLS = { export_to_unity: exportToUnity } as const;
