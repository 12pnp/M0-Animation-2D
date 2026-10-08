import { expect, test } from "@playwright/test";

/** The transform panel works on the bone an image hangs from when the image (its slot, or its attachment) is what is selected. */

type Live = { boneburst: { session: { select(s: unknown): void; doc: { slots: { name: string; bone: string }[]; bones: { name: string; x?: number }[] } } } };

test("select an image: the transform panel shows its bone's values and typing in it moves that bone", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const slot = await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session, sl = s.doc.slots.find((x) => s.doc.bones.find((b) => b.name === x.bone)!.x !== undefined) ?? s.doc.slots[0]!; s.select({ kind: "slot", name: sl.name }); return sl; });
  const x = page.getByLabel("translate x", { exact: true });
  await expect(x).toBeEnabled();
  const bone = await page.evaluate((b) => (window as unknown as Live).boneburst.session.doc.bones.find((q) => q.name === b)!.x ?? 0, slot.bone);
  await expect(x).toHaveValue(String(Math.round(bone * 1e3) / 1e3));
  await x.fill("123");
  await x.press("Enter");
  await expect.poll(() => page.evaluate((b) => (window as unknown as Live).boneburst.session.doc.bones.find((q) => q.name === b)!.x, slot.bone)).toBe(123);
});
