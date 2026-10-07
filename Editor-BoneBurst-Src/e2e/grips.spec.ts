import { expect, test, type Page } from "@playwright/test";

/** The resize lines (panel sashes, the Timeline's names splitter): blue at once under the pointer with a resize cursor, held blue through a drag. */

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
}

const look = (page: Page, selector: string, n = 0) => page.locator(selector).nth(n).evaluate((el) => {
  const c = getComputedStyle(el);
  return { bg: c.backgroundColor, image: c.backgroundImage, cursor: c.cursor, grip: getComputedStyle(el, "::after").content };
});
const accentOf = (page: Page) => page.evaluate(() => { const d = document.createElement("div"); d.style.color = "var(--accent)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c.replace(/\s/g, ""); });

for (const n of [0, 1]) test(`a panel sash (${n === 0 ? "a row divider" : "a column divider"}) turns blue the moment the pointer is on it, shows a resize cursor, has no grip icon, and stays blue through the drag`, async ({ page }) => {
  await open(page);
  const sel = ".dv-sash:not(.dv-disabled)", sash = page.locator(sel).nth(n), box = (await sash.boundingBox())!, col = box.height >= box.width;
  const accent = await accentOf(page), rest = await look(page, sel, n);
  expect(rest.bg.replace(/\s/g, "")).not.toBe(accent);
  const at = col ? { x: box.x + box.width / 2, y: box.y + box.height * 0.4 } : { x: box.x + box.width * 0.4, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(150);
  const on = await look(page, sel, n);
  // Blue within a fraction of a second (Dockview's half-second wait is gone), the resize cursor for the line's direction, nothing drawn on it.
  expect(on.bg.replace(/\s/g, "")).toBe(accent);
  expect(on.cursor).toBe(col ? "col-resize" : "row-resize");
  expect(on.grip === "none" || on.grip === "normal" || on.grip === "").toBe(true);
  // Pressed and dragged: held blue, the cursor kept everywhere, even with the pointer well off the line; let go clears it.
  await page.mouse.down();
  await expect(sash).toHaveClass(/bb-held/);
  await expect(page.locator("html")).toHaveClass(col ? /bb-gripping-col/ : /bb-gripping-row/);
  await page.mouse.move(at.x + (col ? 60 : 0), at.y + (col ? 0 : 60), { steps: 5 });
  expect((await look(page, sel, n)).bg.replace(/\s/g, "")).toBe(accent);
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe(col ? "col-resize" : "row-resize");
  await page.mouse.up();
  await expect(page.locator(".bb-held")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveClass(/bb-gripping/);
});

test("the Timeline's names-column splitter shows a blue line and the column-resize cursor under the pointer", async ({ page }) => {
  await open(page);
  await page.locator(".dv-tab", { hasText: /^Timeline$/ }).click();
  const box = (await page.locator(".timeline-split").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.waitForTimeout(150);
  const on = await look(page, ".timeline-split");
  expect(on.cursor).toBe("col-resize");
  expect(on.image).toContain("linear-gradient");
  await page.mouse.move(box.x - 60, box.y + 90);
  await page.waitForTimeout(150);
  expect((await look(page, ".timeline-split")).image).toBe("none");
});
