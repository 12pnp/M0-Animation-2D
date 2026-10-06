import type { LocalPose } from "@/edit/boneKeys";
import { subtree } from "@/edit/bones";
import { EditRefused } from "@/edit/history";
import { type CopiedKeys, type CopiedPose, pastePose } from "@/edit/paste";
import type { Session } from "./session";
import { animatedLocal } from "./stage/posed";

/**
 * The page's clipboard (E6-PLAN step 4c): the keys last copied and the pose last copied, each
 * kept until the next copy of its kind. Not the system clipboard: nothing to grant, and keys mean
 * something only with a rig.
 */
export const clipboard: { keys: CopiedKeys | null; pose: CopiedPose | null } = { keys: null, pose: null };

/** Every bone's local pose as the editor shows it now (the animation at the playhead, or the setup pose). */
function posedLocals(session: Session): Map<string, LocalPose> {
  const p = session.pose(), out = new Map<string, LocalPose>();
  if (!p) return out;
  for (const [name, i] of p.bones) out.set(name, animatedLocal(p, i));
  return out;
}

/** Copy the selected bone's pose and the bones' under it (every bone when none, or the root, is selected); what it says. */
export function copyPose(session: Session): string {
  const doc = session.doc;
  if (!doc?.bones?.length) return "Open a skeleton first.";
  const sel = session.selectedBone, root = doc.bones[0]!.name;
  const names = sel && sel !== root ? subtree(doc, sel) : doc.bones.map((b) => b.name);
  const now = posedLocals(session);
  clipboard.pose = { kind: "pose", bones: new Map(names.filter((n) => now.has(n)).map((n) => [n, now.get(n)!])) };
  const where = session.animation ? `${session.animation.name} at frame ${session.frame}` : "the setup pose";
  return `Copied the pose of ${sel && sel !== root ? `${sel} and the ${names.length - 1} bones under it` : `all ${names.length} bones`} from ${where}.`;
}

/** Paste the copied pose: keyed at the playhead where it differs, or as the setup pose; what it says. */
export function pastePoseHere(session: Session): string {
  const pose = clipboard.pose, h = session.history;
  if (!pose) return "Copy a pose first (⌥⌘C).";
  if (!h) return "Open a skeleton first.";
  const anim = session.animation?.name ?? null;
  session.pause();
  try {
    if (!h.apply(anim ? `Paste pose at frame ${session.frame}` : "Paste pose into the setup pose", pastePose(pose, anim, session.keyTime, posedLocals(session)))) return "Nothing changed.";
  } catch (err) {
    if (err instanceof EditRefused) return err.message;
    throw err;
  }
  session.changed();
  return anim ? `Pasted the pose at frame ${session.frame} of ${anim}.` : "Pasted the pose into the setup pose.";
}
