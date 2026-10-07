import { expect, test } from "@playwright/test";

/**
 * Help ▸ Keyboard Shortcuts (E7-PLAN step 2): `?` and the Help menu open the sheet, which lists
 * the table by group and filters; Escape closes it, also with a button focused (the key handler
 * leaves Escape's default alone). Keys dispatched from the table still do what they did.
 */

type Live = { boneburst: { session: any } };

test("the shortcuts sheet lists and filters the table; Escape closes it; the keys still work", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();

  // `?` opens it, every group listed.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+?");
  const sheet = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("h3")).toHaveText(["File", "Edit", "View", "Tools", "Stage", "Timeline", "Playback", "Motion Path", "Help"]);
  await expect(sheet.locator("dt", { hasText: "⇧⌘Z" })).toBeVisible();

  // The filter: by what a key does.
  await sheet.getByRole("searchbox", { name: "Filter shortcuts" }).fill("pose");
  await expect(sheet.locator("dd")).toHaveText(["Copy the pose at the playhead", "Paste the copied pose"]);
  await sheet.getByRole("searchbox", { name: "Filter shortcuts" }).fill("zzz");
  await expect(sheet.locator(".empty")).toHaveText("No shortcut matches.");

  // Escape with the Close button focused (not a text field): the dialog still closes.
  await sheet.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // The Help menu opens it too, showing the same keys the menus show.
  await page.locator(".menu-title", { hasText: "Help" }).click();
  await expect(page.locator(".menu-item", { hasText: "Keyboard Shortcuts" }).locator(".menu-keys")).toHaveText("?");
  await page.locator(".menu-item", { hasText: "Keyboard Shortcuts" }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  // Keys from the table: R picks Rotate; ⌘Z undoes an edit; Space plays and pauses.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("r");
  await expect(page.locator('[data-tool="rotate"]')).toHaveAttribute("aria-pressed", "true");
  const x0 = await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.bones.find((b: { name: string }) => b.name === "hips").x ?? 0);
  await page.evaluate(async () => {
    const bonesUrl = "/src/edit/bones.ts";
    const { updateBone } = await import(/* @vite-ignore */ bonesUrl);
    const s = (window as unknown as Live).boneburst.session;
    s.history.apply("Move hips", updateBone("hips", { x: 123 }));
    s.changed();
  });
  await page.keyboard.press("ControlOrMeta+z");
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.bones.find((b: { name: string }) => b.name === "hips").x ?? 0)).toBe(x0);
  await page.locator(".timeline select").first().selectOption("run");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.playing)).toBe(true);
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.playing)).toBe(false);
});
