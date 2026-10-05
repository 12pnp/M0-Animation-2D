/**
 * Every panel the editor has or will have, by the id its layout is saved under (D6). Reserved now
 * so saved layouts and cross-references stay stable; a panel registers only in the phase that
 * builds it (reference in E4, AI in E5, preview when it exists).
 */
export const PANEL_IDS = ["stage", "timeline", "rigTree", "properties", "preview", "reference", "ai"] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export const PANEL_TITLES: Readonly<Record<PanelId, string>> = {
  stage: "Stage",
  timeline: "Timeline",
  rigTree: "Rig",
  properties: "Properties",
  preview: "Preview",
  reference: "Reference",
  ai: "AI",
};

export function isPanelId(id: string): id is PanelId {
  return (PANEL_IDS as readonly string[]).includes(id);
}
