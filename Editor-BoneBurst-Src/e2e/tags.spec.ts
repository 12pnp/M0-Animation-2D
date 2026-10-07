import { expect, test } from "@playwright/test";

/** Tags on any element of the rig (docs/TAGS-PLAN.md): the tags key opens the popup, the rig tree finds by tag, undo and rename carry them. */

type Live = { boneburst: { session: { select(s: unknown): void; changed(): void; history: { undo(): boolean; entries: { labels: string[]; done: number } }; sidecar: { tags: { key: string; tags: string[] }[] } } } };

test("⌘L tags the selected element; the rig tree finds it by tag; tags show in Properties; undo and rename carry them", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "chest" }));
  const tags = () => page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.tags);
  await page.keyboard.press("Meta+l");
  const pop = page.getByRole("dialog", { name: "Tags" });
  await expect(pop).toBeVisible();
  await pop.getByLabel("Add a tag").fill("IK, upper body");
  await pop.getByLabel("Add a tag").press("Enter");
  expect(await tags()).toEqual([{ key: "bone:chest", tags: ["IK", "upper body"] }]);
  await expect(pop.locator(".tag-chip")).toHaveText(["IK×", "upper body×"]);
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  // On the row and in Properties.
  await expect(page.locator(".outline .row.bone", { hasText: "chest" }).locator(".tag-chip")).toHaveText(["IK", "upper body"]);
  await expect(page.locator(".inspector .tags-row .tag-chip")).toHaveText(["IK×", "upper body×"]);
  // Another element, with the same tag.
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await page.keyboard.press("Meta+l");
  await pop.getByLabel("Add a tag").fill("ik");
  await pop.getByLabel("Add a tag").press("Enter");
  expect(await tags()).toEqual([{ key: "bone:chest", tags: ["IK", "upper body"] }, { key: "bone:hips", tags: ["ik"] }]);
  await page.keyboard.press("Escape");
  // Find by tag: a name search finds tagged rows too; # only the tag itself.
  const search = page.getByLabel("Search the rig");
  await search.fill("upper");
  await expect(page.locator(".outline .rows .row")).toHaveCount(1);
  await search.fill("#ik");
  await expect(page.locator(".outline .rows .row")).toHaveCount(2);
  await search.fill("#i");
  await expect(page.locator(".outline .rows .row")).toHaveCount(0);
  await search.fill("");
  // Undo takes the tag back, as a step.
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  expect(await tags()).toEqual([{ key: "bone:chest", tags: ["IK", "upper body"] }]);
  // Renaming the bone moves its tags.
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "chest" }));
  const name = page.locator(".inspector input").first();
  await name.fill("ribcage");
  await name.press("Enter");
  await expect.poll(() => tags()).toEqual([{ key: "bone:ribcage", tags: ["IK", "upper body"] }]);
  // Remove with the ×.
  await page.locator(".inspector .tags-row .tag-chip", { hasText: "IK" }).locator(".tag-x").click();
  expect(await tags()).toEqual([{ key: "bone:ribcage", tags: ["upper body"] }]);
});
