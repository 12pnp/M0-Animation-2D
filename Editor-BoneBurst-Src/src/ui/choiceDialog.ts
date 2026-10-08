/** One button of a choice dialog: its label and the value it answers with; `primary` is the one Enter takes. */
export interface Choice<T extends string> { readonly label: string; readonly value: T; readonly primary?: boolean }

/**
 * Ask a question with a few answers, in a modal dialog (the same one the document tabs ask "save before closing?" with): resolves with the
 * value of the button pressed, or `cancel` for Escape or a click away. `cancel` should be one of the choices' values too.
 */
export function askChoice<T extends string>(text: string, note: string, choices: readonly Choice<T>[], cancel: T): Promise<T> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    const p = document.createElement("p");
    p.textContent = text;
    const n = document.createElement("p");
    n.className = "note";
    n.textContent = note;
    const row = document.createElement("div");
    row.className = "row";
    let primary: HTMLButtonElement | null = null;
    for (const c of choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c.label;
      if (c.primary) { b.setAttribute("aria-pressed", "true"); primary = b; }
      b.addEventListener("click", () => dialog.close(c.value));
      row.append(b);
    }
    dialog.append(p, n, row);
    dialog.addEventListener("close", () => { dialog.remove(); resolve((dialog.returnValue || cancel) as T); });
    document.body.append(dialog);
    dialog.showModal();
    primary?.focus();
  });
}
