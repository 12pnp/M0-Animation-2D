import type { Shape } from "@/edit/curves";

/**
 * The eases `set_keys` names, as cubic shapes over a key's interval (E6-PLAN step 2). They are the
 * contract's, so they are version 1's curves, measured by running the old editor: handles at
 * thirds, "in" and "out" quadratic, "inout" smoothstep. Not the editor's own curve buttons
 * (`edit/curves.ts` PRESETS), which are the CSS eases.
 */
export const AI_EASES = {
  in: [1 / 3, 0, 2 / 3, 1 / 3],
  out: [1 / 3, 2 / 3, 2 / 3, 1],
  inout: [1 / 3, 0, 2 / 3, 1],
} as const satisfies Record<string, Shape>;
