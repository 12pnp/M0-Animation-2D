/**
 * The lines the pointer drags to resize (Dockview's sashes between panels, the Timeline's names-column splitter): under the
 * pointer a line turns blue at once (style.css), and while it is held it stays blue, with the resize cursor over the whole
 * page, until the button is let go, even when the pointer runs ahead of the line. This only says when a drag is on.
 */
const GRIPS = ".dv-sash, .timeline-split";

export function watchGrips(doc: Document = document): void {
  const root = doc.documentElement;
  const grip = (e: Event): HTMLElement | null => ((e.target as Element | null)?.closest?.(GRIPS) as HTMLElement | null) ?? null;
  const release = (): void => {
    for (const held of doc.querySelectorAll(".bb-held")) held.classList.remove("bb-held");
    root.classList.remove("bb-gripping-col", "bb-gripping-row");
  };
  doc.addEventListener("pointerdown", (e) => {
    const line = grip(e);
    if (!line || e.button !== 0) return;
    const r = line.getBoundingClientRect();
    line.classList.add("bb-held");
    root.classList.add(r.height >= r.width ? "bb-gripping-col" : "bb-gripping-row");
  }, true);
  for (const type of ["pointerup", "pointercancel", "blur"]) (type === "blur" ? doc.defaultView! : doc).addEventListener(type, release, true);
}
