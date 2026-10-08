import type { AgentContext } from "./context";
import { docOf } from "./read";

/**
 * `export_to_unity` (E5-PLAN step 8): the editor writes the rig into the Unity folder chosen with
 * Export to Unity…; Unity's BoneBurst import rebakes a folder it baked before on its next refresh.
 */
async function exportToUnity(_args: Record<string, unknown>, ctx: AgentContext) {
  docOf(ctx);
  const out = await ctx.exportToUnity();
  return { folder: out.folder, files: out.files, note: "Unity rebakes this folder on its next refresh if it baked it before (BoneBurst import); otherwise bake it once there." };
}

export const UNITY_TOOLS = { export_to_unity: exportToUnity } as const;
