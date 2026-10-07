import type { Locator } from "@playwright/test";

/**
 * Edit Path in the Motion Path panel (docs/MOTION-PARENT-PLAN.md): a path cannot be started until a parent bone is chosen, so
 * when none is, the selected bone's own parent is chosen first (what the earlier Local space was measured from).
 */
export async function startEditPath(panel: Locator): Promise<void> {
  await chooseParent(panel);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
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
