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

/**
 * A tool that builds on what it just made (bones under new bones, pictures onto them) as one
 * History step: a gesture whose parts are applied one by one, the rig readable between them
 * (the context poses the document as it now is). A refusal anywhere takes every part back.
 */
export function inStep<T>(ctx: AgentContext, label: string, build: (step: (edit: Edit<Skeleton>) => void) => T): T {
  const h = ctx.history;
  if (!h) throw new AgentRefused("Nothing is open in the editor: open a skeleton (or drop a PSD) first.");
  h.begin(`AI: ${label}`);
  try {
    const out = build((edit) => { h.apply("step", edit); });
    h.end();
    ctx.changed();
    return out;
  } catch (err) {
    h.cancel();
    if (err instanceof EditRefused) throw new AgentRefused(err.message);
    throw err;
  }
}
