/**
 * The page's interface size (Preferences ▸ Interface size) is CSS `zoom` on the page: a layout pixel
 * is then drawn `pageScale` of a pixel, and the pointer's client coordinates, `getBoundingClientRect`
 * and the window's size are in drawn pixels while styles, `offsetWidth` and canvas sizes are in layout
 * pixels. These convert between the two.
 */

/** The page's zoom: 1 at the browser's own size, 0.95 at 95%. */
export function pageScale(doc: Document = document): number {
  const z = Number.parseFloat(doc.defaultView?.getComputedStyle(doc.documentElement).zoom ?? "1");
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** The pointer's place in `el`'s own pixels (from its top left), whatever the page's zoom. */
export function localPoint(el: Element, e: { clientX: number; clientY: number }): [number, number] {
  const r = el.getBoundingClientRect(), k = pageScale(el.ownerDocument);
  return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
}

/** A drawn (client) coordinate as a style value (`left`, `top`) of a fixed-position element. */
export function toStyle(drawn: number, doc: Document = document): number {
  return drawn / pageScale(doc);
}
