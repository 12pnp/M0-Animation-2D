import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/** Through the analysis window a Spine export now opens with (docs/SPINE-IMPORT-FRAMEPATH-PLAN.md): opened as it is. */
async function openAsIs(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("dialog", { name: "Open: analysis" }).getByRole("button", { name: /^Open( as is)?$/ }).click();
}


/** File ▸ Import Spine Folder…: a folder with the skeleton, atlas and page image opens; one that lacks something says so. */

const ROOT = join(import.meta.dirname, "..");

test("Import Spine Folder opens a complete folder, and says what an incomplete one lacks", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "File", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^Import Spine Folder…/ })).toBeVisible();
  await page.keyboard.press("Escape");
  const folder = page.locator("input[webkitdirectory]");

  // Only a skeleton: nothing opens, and the status line names the atlas and the page image.
  const partial = mkdtempSync(join(tmpdir(), "spine-partial-"));
  writeFileSync(join(partial, "hero.json"), "{}");
  await folder.setInputFiles(partial);
  await expect(page.locator(".message")).toContainText("is missing the atlas (.atlas) and a page image (.png)");
  await expect(page.locator(".doc-tab")).toHaveCount(0);

  // The stickman folder has all three: it opens in a tab.
  await folder.setInputFiles(join(ROOT, "tests", "fixtures", "stickman"));
  await openAsIs(page);
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await expect(page.locator(".doc-tab")).toHaveCount(1);
});
