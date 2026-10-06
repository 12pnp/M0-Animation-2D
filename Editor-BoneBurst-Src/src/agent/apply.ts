import { EditRefused, type Edit } from "@/edit/history";
import type { Skeleton } from "@/model/skeleton";
import { type AgentContext, AgentRefused } from "./context";

/**
 * A tool's edits as one History step labelled "AI: …" (SPEC §8), so one undo takes the whole call
 * back. An edit's refusal is the model's to fix: it becomes the tool's refusal.
 */
export function applyEdit(ctx: AgentContext, label: string, edit: Edit<Skeleton>): boolean {
  const h = ctx.history;
  if (!h) throw new AgentRefused("Nothing is open in the editor: open a skeleton (or drop a PSD) first.");
  let changed: boolean;
  try {
    changed = h.apply(`AI: ${label}`, edit);
  } catch (err) {
    if (err instanceof EditRefused) throw new AgentRefused(err.message);
    throw err;
  }
  if (changed) ctx.changed();
  return changed;
}
