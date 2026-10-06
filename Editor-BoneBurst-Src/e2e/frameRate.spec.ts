import { expect, test } from "@playwright/test";

/**
 * The frame rate (E6-PLAN step 4i): Properties, with nothing selected, shows the skeleton; its
 * Frame rate set from 24 to 30 changes the timeline's frames, not the keys' times; one undo.
 */

type Live = { boneburst: { session: { doc: { animations: { name: string; bones?: { name: string; timelines: { keys: { time?: number }[] }[] }[] }[] }; select(s: unknown): void } } };

const hipsTimes = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc.animations
  .find((a) => a.name === "run")!.bones!.find((g) => g.name === "hips")!.timelines[0]!.keys.map((k) => k.time ?? 0));

test("Properties ▸ Skeleton ▸ Frame rate: 24 to 30 changes the timeline's frames, not the keys' times; one undo", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  await expect(page.locator(".frame")).toContainText("/ 17 · 24 fps");
  const before = await hipsTimes(page);

  const rate = page.getByRole("textbox", { name: "Frame rate" });
  await expect(rate).toHaveValue("24");
  await rate.fill("30");
  await rate.press("Enter");
  await expect(page.locator(".frame")).toContainText("/ 21 · 30 fps");
  expect(await hipsTimes(page)).toEqual(before);
  await expect(page.locator(".message")).toContainText("keys keep their times");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".frame")).toContainText("· 24 fps");
});
