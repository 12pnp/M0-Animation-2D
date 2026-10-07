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

test("the Tags panel lists every tag with its count; a click lists its elements and selects one; ✎ renames it everywhere and merges; the bin deletes it; undo brings it back", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const add = async (bone: string, text: string) => {
    await page.evaluate((b) => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: b }), bone);
    await page.keyboard.press("Meta+l");
    const field = page.getByRole("dialog", { name: "Tags" }).getByLabel("Add a tag");
    await field.fill(text);
    await field.press("Enter");
    await page.keyboard.press("Escape");
  };
  await add("chest", "IK, arm");
  await add("hips", "ik");
  await page.locator(".dv-tab", { hasText: /^Tags$/ }).click();
  const panel = page.locator(".tags-panel");
  await expect(panel.locator(".tag-row .name")).toHaveText(["IK", "arm"]);
  await expect(panel.locator(".tag-row .note")).toHaveText(["2", "1"]);
  // Open a tag, select one of its elements.
  await panel.locator(".tag-row", { hasText: "IK" }).click();
  await expect(panel.locator(".tag-element .name")).toHaveText(["chest", "hips"]);
  await panel.locator(".tag-element", { hasText: "hips" }).click();
  expect(await page.evaluate(() => JSON.stringify((window as unknown as { boneburst: { session: { selected: unknown } } }).boneburst.session.selected))).toBe('{"kind":"bone","name":"hips"}');
  // Rename everywhere; into a name already used it merges.
  await panel.locator(".tag-row", { hasText: "arm" }).getByRole("button", { name: /^Rename the tag arm/ }).click();
  await panel.getByLabel("New name for the tag arm").fill("limb");
  await panel.getByLabel("New name for the tag arm").press("Enter");
  await expect(panel.locator(".tag-row .name")).toHaveText(["IK", "limb"]);
  await panel.locator(".tag-row", { hasText: "limb" }).getByRole("button", { name: /^Rename the tag limb/ }).click();
  await panel.getByLabel("New name for the tag limb").fill("ik");
  await panel.getByLabel("New name for the tag limb").press("Enter");
  await expect(panel.locator(".tag-row .name")).toHaveText(["IK"]);
  await expect(panel.locator(".tag-row .note")).toHaveText(["2"]);
  // Delete, then undo.
  await panel.getByRole("button", { name: /^Take the tag IK off/ }).click();
  await expect(panel.locator(".tag-row")).toHaveCount(0);
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  await expect(panel.locator(".tag-row .name")).toHaveText(["IK"]);
});
