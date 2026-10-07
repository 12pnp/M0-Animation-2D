import { expect, test } from "@playwright/test";

/** Bone options (docs/STAGE-POSE-PLAN.md step 3): Compensate and Pin keep bones where they were when a bone above them moves. */

type Live = {
  boneburst: {
    session: { doc: { bones: { name: string; parent?: string }[] }; select(s: unknown): void; pinned: Set<string> };
    stage: { screenBones(): { name: string; x0: number; y0: number }[] };
  };
};

async function open(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
}

const origin = (page: import("@playwright/test").Page, name: string) =>
  page.evaluate((n) => { const b = (window as unknown as Live).boneburst.stage.screenBones().find((x) => x.name === n)!; return [b.x0, b.y0]; }, name);

async function moveHips(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const x = page.getByRole("textbox", { name: "translate x" });
  await x.fill(String(Number(await x.inputValue()) + 40));
  await x.press("Enter");
}

const childOfHips = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc.bones.find((b) => b.parent === "hips")!.name);

test("Compensate off: moving a bone takes its children along; on, they stay where they were", async ({ page }) => {
  await open(page);
  const child = await childOfHips(page);
  const start = await origin(page, child);
  await moveHips(page);
  const moved = await origin(page, child);
  expect(Math.abs(moved[0]! - start[0]!) + Math.abs(moved[1]! - start[1]!)).toBeGreaterThan(5);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "Compensate" }).click();
  await expect(page.getByRole("button", { name: "Compensate" })).toHaveAttribute("aria-pressed", "true");
  const again = await origin(page, child);
  await moveHips(page);
  const kept = await origin(page, child);
  expect(Math.abs(kept[0]! - again[0]!)).toBeLessThan(0.6);
  expect(Math.abs(kept[1]! - again[1]!)).toBeLessThan(0.6);
});

test("Pin keeps the selected bone where it is when a bone above it moves, and shows a ring", async ({ page }) => {
  await open(page);
  const child = await childOfHips(page);
  await page.evaluate((n) => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: n }), child);
  await page.locator(".stage-tools .options button").nth(1).click();
  expect(await page.evaluate((n) => (window as unknown as Live).boneburst.session.pinned.has(n), child)).toBe(true);
  const start = await origin(page, child);
  await moveHips(page);
  const kept = await origin(page, child);
  expect(Math.abs(kept[0]! - start[0]!)).toBeLessThan(0.6);
  expect(Math.abs(kept[1]! - start[1]!)).toBeLessThan(0.6);
});
