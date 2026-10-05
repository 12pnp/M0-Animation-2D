/** What the editor is, for the title bar and About. */
export const EDITOR_NAME = "BoneBurst Editor";

/** The Spine version the document format follows (docs/SPEC.md ▸ Document). */
export const SPINE_VERSION = "4.3";

/** The title for a document, or for no document. */
export function titleFor(fileName: string | null, dirty: boolean): string {
  return fileName ? `${dirty ? "• " : ""}${fileName} — ${EDITOR_NAME}` : EDITOR_NAME;
}
