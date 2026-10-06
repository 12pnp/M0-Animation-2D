import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * A bone the pose leaves without one (E8-PLAN step 2), on a rig where BoneBurst's C# runtime
 * leaves it without one too (tests/fixtures/unposed: a two-bone IK on an arm scaled to 0 in y):
 * the notes name it; a click selects it; Properties says it has no pose here; the stage neither
 * draws nor picks it, and draws no gizmo for it; no page error.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "unposed", "unposed.json");
type Live = { boneburst: { session: any; stage: any } };

test("a bone without a pose: named in the notes, said in Properties, not drawn or picked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('input[type=file][accept*=".psd"]').setInputFiles(FILE);
  await expect(page.locator(".message")).toHaveText(/Opened/);

  await page.locator(".issues").click();
  const note = page.locator(".issue-list li button", { hasText: 'bone "hand" has no pose' });
  await expect(note).toBeVisible();
  await expect(note).toContainText("setup pose");
  await note.click();
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.selected)).toEqual({ kind: "bone", name: "hand" });

  // Properties says so.
  await page.locator(".dv-tab", { hasText: "Properties" }).click();
  await expect(page.locator(".panel", { hasText: "none here: a constraint it is in cannot be solved" }).first()).toBeVisible();

  // The stage: the bones it draws and picks leave "hand" out; the others are there.
  const drawn = await page.evaluate(() => ((window as unknown as Live).boneburst.stage as { screenBones(): { name: string }[] }).screenBones().map((b) => b.name));
  expect(drawn).not.toContain("hand");
  expect(drawn).toEqual(expect.arrayContaining(["arm", "target"]));
  expect(errors).toEqual([]);
});
