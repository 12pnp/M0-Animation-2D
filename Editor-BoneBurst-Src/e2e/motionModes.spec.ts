import { expect, type Page, test } from "@playwright/test";
import { chooseParent } from "./motionHelpers";

/** The Motion Path panel's two tabs (docs/MOTION-MODES-PLAN.md): Key frame and TwinSpline, each with a ⋮ menu; both kept, the tab chooses which is used. */

type Live = { boneburst: { session: { sidecar: { motion: { bone: string; nodes: unknown[]; closed: boolean; duration: number; active?: boolean }[] }; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: unknown[] }[] }[] }[] }; select(s: unknown): void; changed(): void } } };

async function open(page: Page, bone: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate((b) => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: b }), bone);
}

const panelOf = (page: Page) => page.locator(".panel.motion-path");
const path = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion[0] ?? null);
const selected = (panel: ReturnType<typeof panelOf>) => panel.getByRole("tab", { selected: true });

test("the tab opens by what the bone has: keys open Key frame (no path editor), nothing opens TwinSpline with a Create new card; the choice stays", async ({ page }) => {
  await open(page, "hips");
  const panel = panelOf(page);
  await expect(selected(panel)).toHaveText("Key frame");
  await expect(panel.getByRole("button", { name: "Edit Path", exact: true })).toBeHidden();
  await expect(panel.locator(".lp-card")).toBeHidden();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
  await expect(selected(panel)).toHaveText("TwinSpline");
  await expect(panel.locator(".lp-card")).toContainText("No TwinSpline for head");
  await expect(panel.locator(".lp-card").getByRole("button", { name: "Create new" })).toBeVisible();
  await expect(panel.locator(".lp-card").getByRole("button", { name: /Create from Key frame/ })).toHaveCount(0);
  await panel.getByRole("tab", { name: "Key frame" }).click();
  await expect(selected(panel)).toHaveText("Key frame");
});

test("Create new on the card makes the path; the Key frame tab then uses the keys and says the TwinSpline is kept, with Use TwinSpline", async ({ page }) => {
  await open(page, "head");
  const panel = panelOf(page);
  await chooseParent(panel);
  await panel.locator(".lp-card").getByRole("button", { name: "Create new" }).click();
  await expect.poll(async () => (await path(page))?.bone).toBe("head");
  await expect(panel.locator(".lp-card")).toBeHidden();
  await panel.getByRole("tab", { name: "Key frame" }).click();
  await expect(panel.locator(".lp-card")).toContainText("head uses its key frames. Its TwinSpline is kept, not used.");
  await expect(panel.getByRole("button", { name: "Edit Path", exact: true })).toBeHidden();
  await panel.locator(".lp-card").getByRole("button", { name: "Use TwinSpline" }).click();
  await expect(selected(panel)).toHaveText("TwinSpline");
  expect((await path(page))?.active).toBeUndefined();
});

test("the ⋮ menus are the two conversions and the two deletes, each off when there is nothing to act on", async ({ page }) => {
  await open(page, "head");
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Key frame menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Create new TwinSpline from Key frame" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete Key frame data" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "TwinSpline menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Create new Key frame from TwinSpline" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete TwinSpline data" })).toBeDisabled();
});
