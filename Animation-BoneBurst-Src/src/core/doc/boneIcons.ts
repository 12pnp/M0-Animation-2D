/**
 * Spine's bone icons (nonessential): the names Spine writes in a bone's `icon`
 * and the glyph the Tree shows for each. A name not listed is kept and shown
 * by name.
 */
export const BONE_ICONS: Readonly<Record<string, string>> = {
  arrows: "✥", arrowsB: "⇄", arrowUpDown: "↕", arrowLeftRight: "↔",
  star: "★", ik: "⌖", triangle: "▲", diamond: "◆", diamondB: "◇", circle: "●", square: "■",
  romanII: "Ⅱ", eye: "◉", warning: "⚠", mouth: "◡", spiral: "@", handLeft: "☚",
};

/** The glyph for a bone icon's name. */
export function boneIconGlyph(name: string): string {
  return BONE_ICONS[name] ?? "•";
}
