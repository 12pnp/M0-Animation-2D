import type { MenuItem } from "./menubar";

/**
 * A right-click menu at a point, in the page's own style (the menu bar's lists). It closes when an
 * item runs, on Escape, on a click elsewhere, or when the window loses focus. Only one is open.
 */
let open: { list: HTMLElement; close: () => void } | null = null;

export function showContextMenu(clientX: number, clientY: number, items: readonly MenuItem[], host: HTMLElement = document.body): void {
  open?.close();
  const list = document.createElement("div");
  list.className = "menu-list context-menu";
  list.setAttribute("role", "menu");
  for (const item of items) {
    if (!item.run) { list.append(document.createElement("hr")); continue; }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-item";
    row.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (item.checked !== undefined) row.setAttribute("aria-checked", String(item.checked));
    row.disabled = !!item.disabled;
    row.append(
      Object.assign(document.createElement("span"), { className: "menu-check", textContent: item.checked ? "✓" : "" }),
      Object.assign(document.createElement("span"), { className: "menu-label", textContent: item.label ?? "" }),
      Object.assign(document.createElement("span"), { className: "menu-keys", textContent: item.keys ?? "" }),
    );
    const run = item.run;
    row.addEventListener("click", () => { close(); run(); });
    list.append(row);
  }
  const doc = host.ownerDocument, win = doc.defaultView ?? window;
  const close = () => {
    list.remove();
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", key, true);
    win.removeEventListener("blur", close);
    if (open?.list === list) open = null;
  };
  const outside = (e: Event) => { if (!list.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  host.append(list);
  // Inside the window: it opens left or up when there is not room to the right or below.
  const w = list.offsetWidth, h = list.offsetHeight;
  list.style.left = `${Math.max(4, Math.min(clientX, win.innerWidth - w - 4))}px`;
  list.style.top = `${Math.max(4, Math.min(clientY, win.innerHeight - h - 4))}px`;
  setTimeout(() => doc.addEventListener("pointerdown", outside, true));
  doc.addEventListener("keydown", key, true);
  win.addEventListener("blur", close);
  open = { list, close };
}
