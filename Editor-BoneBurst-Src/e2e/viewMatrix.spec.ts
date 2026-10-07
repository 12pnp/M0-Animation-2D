import { expect, test } from "@playwright/test";

/** The Stage's Select · Visible · Names matrix (docs/STAGE-POSE-PLAN.md step 1). */

type Live = {
  boneburst: {
    session: { selected: { kind: string; name?: string } | null; select(s: unknown): void };
    stage: { imageAt(x: number, y: number): string | null; screenBones(): { name: string; x0: number; y0: number; x1: number; y1: number }[]; size: { width: number; height: number } };
  };
};

async function open(page: import("@playwright/test").Page, prefs: object = {}): Promise<void> {
  await page.goto("/");
  await page.evaluate((p) => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, ...p })), prefs);
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
}

test("the matrix has Bones, Images and Others by Select, Visible and Names; cells without a column are dimmed", async ({ page }) => {
  await open(page);
  await expect(page.locator(".view-matrix .vm-head")).toHaveCount(3);
  await expect(page.locator(".view-matrix .vm-cell")).toHaveCount(9);
  await expect(page.locator(".view-matrix .vm-cell:disabled")).toHaveCount(3);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("boneburst.preferences") ?? "{}"));
  const names = page.getByRole("button", { name: "Bones: names" });
  await expect(names).toHaveAttribute("aria-pressed", "false");
  await names.click();
  await expect(names).toHaveAttribute("aria-pressed", "true");
  expect((await stored()).boneNames).toBe(true);
  await page.getByRole("button", { name: "Bones: visible" }).click();
  expect((await stored()).bones).toBe(false);
});

test("Select ▸ Bones off: a press on a bone does not pick it; on, it does", async ({ page }) => {
  await open(page, { boneSelect: false });
  const where = await page.evaluate(() => {
    const { stage } = (window as unknown as Live).boneburst, b = stage.screenBones().find((x) => x.name === "hips")!;
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  });
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  await page.mouse.click(box.x + where.x, box.y + where.y);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.selected?.kind)).not.toBe("bone");
  await page.getByRole("button", { name: "Bones: select" }).click();
  await page.mouse.click(box.x + where.x, box.y + where.y);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.selected?.kind)).toBe("bone");
});

test("Select ▸ Images: a press on an image picks its slot; off, it does not", async ({ page }) => {
  await open(page, { boneSelect: false, imageSelect: true });
  const point = await page.evaluate(() => {
    const { stage } = (window as unknown as Live).boneburst;
    for (let y = 40; y < stage.size.height - 40; y += 6) for (let x = 40; x < stage.size.width - 40; x += 6) { const n = stage.imageAt(x, y); if (n) return { x, y, n }; }
    return null;
  });
  expect(point).not.toBeNull();
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  await page.mouse.click(box.x + point!.x, box.y + point!.y);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.selected)).toMatchObject({ kind: "slot", name: point!.n });
  await page.getByRole("button", { name: "Images: select" }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  await page.mouse.click(box.x + point!.x, box.y + point!.y);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.selected)).toBeNull();
});
