/**
 * The prompt the Poses panel sends with its pictures: the poses named by
 * frame, and the ask — animate between them. Pure, so it tests without a
 * page. The pictures themselves are `AgentApi.renderPoses` output.
 */

/** `frames` are all the poses; the first `shownCount` of them ride along as
 *  pictures (the bridge's budget) — the rest the model can render itself.
 *  `withBones`: the pictures carry the bones, drawn and named. */
export function posePrompt(animName: string, fps: number, frames: number[], shownCount: number, withBones = true): string {
  const pictures = frames.slice(0, shownCount).map((f, i) => `picture ${i + 1} = frame ${f}`).join(", ");
  const pairs = frames.slice(0, -1).map((f, i) => `${f} to ${frames[i + 1]!}`).join(", ");
  return [
    `The animation "${animName}" (${fps} fps) has its key poses already keyed, at frames ${frames.join(", ")}: the attached pictures (${pictures})${withBones ? ", bones drawn and named" : ""}.`,
    shownCount < frames.length ? `Only the first ${shownCount} are attached — render_frame shows the other poses.` : "",
    `Keep the pose frames' keys exactly as they are (get_animation reads them). Animate the in-betweens: for each pair of neighbouring poses (${pairs}), key the frames between them — few keys, "inout" eases for body motion, x linear where the motion is steady — one set_keys call per segment. Do not key past the last pose unless a loop needs it.`,
    `Then check_preview the whole animation, show it, and tell me briefly what you did.`,
  ].filter(Boolean).join("\n");
}
