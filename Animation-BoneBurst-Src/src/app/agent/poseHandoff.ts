/**
 * The prompt the Poses panel sends with its pictures: the poses named by
 * frame, and the ask — animate between them. Pure, so it tests without a
 * page. The pictures themselves are `AgentApi.renderPoses` output.
 */

export interface PosePromptOptions {
  /** The pictures carry the bones, drawn and named. */
  withBones?: boolean;
  /** Each picture is the rig over the reference picture at that frame. */
  overReference?: boolean;
  /** The pose frames that have keys; absent: all of them. A pose marked
   *  from the reference on a new animation has none yet. */
  keyed?: readonly number[];
}

/** `frames` are all the poses; the first `shownCount` of them ride along as
 *  pictures (the bridge's budget) — the rest the model can render itself. */
export function posePrompt(animName: string, fps: number, frames: number[], shownCount: number, opts: PosePromptOptions = {}): string {
  const { withBones = true, overReference = false } = opts;
  const keyed = opts.keyed ? frames.filter((f) => opts.keyed!.includes(f)) : frames;
  const unkeyed = frames.filter((f) => !keyed.includes(f));
  const pictures = frames.slice(0, shownCount).map((f, i) => `picture ${i + 1} = frame ${f}`).join(", ");
  const pairs = frames.slice(0, -1).map((f, i) => `${f} to ${frames[i + 1]!}`).join(", ");
  const drawn = [withBones ? "bones drawn and named" : "", overReference ? "each see-through over the reference picture at its frame" : ""].filter(Boolean).join(", ");
  return [
    `The animation "${animName}" (${fps} fps) has key poses at frames ${frames.join(", ")}: the attached pictures (${pictures})${drawn ? `, ${drawn}` : ""}.`,
    shownCount < frames.length ? `Only the first ${shownCount} are attached — render_frame shows the other poses.` : "",
    unkeyed.length
      ? overReference
        ? `Frames ${unkeyed.join(", ")} have no keys yet: first pose the rig at each to match the reference picture there (get_reference shows it; render_frame draws your pose over it), one set_keys call per pose, and look again until the body lines up.`
        : `Frames ${unkeyed.join(", ")} have no keys yet: key a pose at each that fits between its neighbours, one set_keys call per pose.`
      : "",
    keyed.length ? `Keep the keys at frame${keyed.length === 1 ? "" : "s"} ${keyed.join(", ")} exactly as they are (get_animation reads them).` : "",
    `Then animate the in-betweens: for each pair of neighbouring poses (${pairs}), key the frames between them — few keys, "inout" eases for body motion, x linear where the motion is steady — one set_keys call per segment. Do not key past the last pose unless a loop needs it.`,
    `Then check_preview the whole animation, show it, and tell me briefly what you did.`,
  ].filter(Boolean).join("\n");
}
