import type { Dialog, Locator } from "@playwright/test";

/**
 * Edit Path in the Motion Path panel (docs/MOTION-PARENT-PLAN.md): a path cannot be started until a parent bone is chosen, so
 * when none is, the selected bone's own parent is chosen first (what the earlier Local space was measured from).
 */
export async function startEditPath(panel: Locator): Promise<void> {
  await chooseParent(panel);
  await twinMenu(panel, "Create new TwinSpline");
}

/** An item of the TwinSpline tab's ⋮ menu; `accept` answers the confirm a replace or a delete asks. */
export async function twinMenu(panel: Locator, item: string, accept = false): Promise<void> {
  const page = panel.page(), answer = (d: Dialog): void => { void d.accept().catch(() => undefined); };
  if (accept) page.on("dialog", answer);
  try {
    await panel.getByRole("button", { name: "TwinSpline menu" }).click();
    await page.getByRole("menuitem", { name: item }).click();
  } finally { if (accept) page.off("dialog", answer); }
}

/** Choose the selected bone's own parent in the picker when none is chosen. */
export async function chooseParent(panel: Locator): Promise<void> {
  const pick = panel.getByRole("combobox", { name: "Parent bone" });
  await pick.waitFor({ state: "visible" });
  await pick.locator("option").nth(1).waitFor({ state: "attached" });
  if ((await pick.inputValue()) === "") {
    const parent = await panel.page().evaluate(() => {
      const b = (window as unknown as { boneburst: { session: { doc: { bones: { name: string; parent?: string }[] }; selectedBone: string | null } } }).boneburst.session;
      return b.doc.bones.find((x) => x.name === b.selectedBone)?.parent ?? null;
    });
    if (parent) await pick.selectOption(parent);
  }
}
