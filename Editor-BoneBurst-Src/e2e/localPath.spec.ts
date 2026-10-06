import { expect, test } from "@playwright/test";

/** The Local Path panel (docs/MOTION-PREVIEW-PLAN.md): only the selected bone, over every frame of the animation shown. */

type Live = { boneburst: { session: { select(s: unknown): void; showAnimation(n: string | null): void; frame: number } } };

test("Local Path shows the selected bone's path over the animation, Local or World; a click on a mark seeks", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  // In Animate; the panel is a tab behind Properties.
  await page.locator(".stage-tools button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Local Path$/ }).click();
  const panel = page.locator(".local-path");
  await expect(panel.locator(".lp-note")).toContainText("Select a bone");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
  await expect(panel.locator(".lp-head span")).toHaveText("head · Local");
  await expect(panel.locator(".lp-note")).toBeHidden();
  await panel.getByRole("button", { name: "World", exact: true }).click();
  await expect(panel.locator(".lp-head span")).toHaveText("head · World");
  // A mark: sweep the canvas for one (the page's own pointer events); the playhead moves off frame 0.
  const moved = await page.evaluate(() => {
    const live = (window as unknown as Live).boneburst, cv = document.querySelector(".local-path canvas")!, r = cv.getBoundingClientRect(), before = live.session.frame;
    for (let x = 6; x < r.width - 6; x += 5) {
      for (let y = 6; y < r.height - 6; y += 5) {
        cv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerId: 1 }));
        if (live.session.frame !== before) return true;
      }
    }
    return false;
  });
  expect(moved).toBe(true);
});
