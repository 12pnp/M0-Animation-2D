/**
 * Lights the scrollbars of every scrolling panel the mouse is inside. CSS `:hover` on a scrollbar's
 * thumb is not reliable (the browser repaints it only after another mouse move), so the lit state is
 * a class, set from the pointer's position and cleared when the pointer leaves.
 */
const HOT = "scroll-hot";

function scrolls(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  const y = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
  const x = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
  return y || x;
}

export function litScrollbars(doc: Document = document): void {
  let lit: HTMLElement[] = [];
  const clear = (): void => {
    for (const el of lit) el.classList.remove(HOT);
    lit = [];
  };
  doc.addEventListener("pointermove", (e) => {
    const next: HTMLElement[] = [];
    for (let el = e.target instanceof Element ? e.target : null; el; el = el.parentElement) {
      if (scrolls(el)) next.push(el as HTMLElement);
    }
    if (next.length === lit.length && next.every((el, i) => el === lit[i])) return;
    clear();
    for (const el of next) el.classList.add(HOT);
    lit = next;
  }, { passive: true });
  doc.documentElement.addEventListener("pointerleave", clear);
  doc.defaultView?.addEventListener("blur", clear);
}
