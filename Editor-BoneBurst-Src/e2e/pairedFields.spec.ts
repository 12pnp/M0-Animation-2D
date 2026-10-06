import { expect, test } from "@playwright/test";

/** Properties: fields that come in twos share a line, each box with its green letter; the boxes still edit. */

type Live = { boneburst: { session: { select(s: unknown): void } } };

test("a bone's X Y, Scale and Shear each share one line with x / y letters, and still edit", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const labels = page.locator(".inspector .field > span");
  await expect(labels.filter({ hasText: /^(Position|Scale|Shear)$/ })).toHaveCount(3);
  await expect(page.locator(".inspector .pair")).toHaveCount(3);
  const tags = await page.locator(".inspector .axis-tag").allTextContents();
  expect(tags.join("")).toBe("xyrxyxyl");
  const x = page.getByRole("textbox", { name: "X", exact: true });
  await x.fill("12.5");
  await x.press("Enter");
  await expect(x).toHaveValue("12.5");
});

test("dragging a letter left or right changes its number, as one edit", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const x = page.getByRole("textbox", { name: "X", exact: true });
  const before = Number(await x.inputValue());
  await expect(page.locator(".inspector .axis-tag").first()).toHaveCSS("cursor", "ew-resize");
  const box = (await page.locator(".inspector .axis-tag").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(x).toHaveValue(String(before + 25));
  await page.keyboard.press("Control+z");
  await expect(x).toHaveValue(String(before));
});

test("the Stage's transform panel: x / y letters on Translate, Scale and Shear; dragging one changes its cell", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await expect(page.locator(".t-values .axis-tag")).toHaveCount(7);
  const cell = page.getByRole("textbox", { name: "translate x" });
  const before = Number(await cell.inputValue());
  const box = (await page.locator(".t-values .axis-tag").nth(1).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(cell).toHaveValue(String(before + 10));
});

test("Snapping settings sit in Properties (nothing selected) and in Preferences ▸ Grid, and are the preferences", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("boneburst.preferences") ?? "{}"));
  const size = page.locator(".inspector").getByRole("textbox", { name: "Snap size" });
  await size.fill("25");
  await size.press("Enter");
  await expect.poll(async () => (await stored()).gridSize).toBe(25);
  const guides = page.locator(".inspector").getByRole("checkbox", { name: "Snap to guides" });
  const was = await guides.isChecked();
  await guides.click();
  await expect.poll(async () => (await stored()).snapGuides).toBe(!was);
  await page.locator(".app-icon").click();
  const dialog = page.locator("dialog.preferences");
  await dialog.getByText("Grid", { exact: true }).first().click();
  await expect(dialog.getByRole("spinbutton", { name: /^Grid spacing and snap size/ })).toHaveValue("25");
  await expect(dialog.getByRole("checkbox", { name: "Snap to guides" })).toBeChecked({ checked: !was });
});
