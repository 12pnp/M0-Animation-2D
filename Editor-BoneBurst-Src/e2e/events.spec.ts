import { expect, type Page, test } from "@playwright/test";

/**
 * Events (E6-PLAN step 4b): an event defined in the Rig panel's Events tab, its value set in
 * Properties, fired at the playhead with Key; a second on the same frame. The Timeline is the curve
 * graph only now (docs/TIMELINE-GRAPH-PLAN.md), so an event's keys are not shown there: moving and
 * deleting them is covered at the edit level by tests/eventKeys.test.ts.
 */

type Live = { boneburst: { session: { doc: { events?: { name: string; int?: number }[]; animations: { name: string; events?: { name: string; time?: number }[] }[] }; seek(f: number): void } } };

const fired = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as Live).boneburst.session.doc;
  return (d.animations.find((a) => a.name === "run")!.events ?? []).map((k) => `${k.name}@${Math.round((k.time ?? 0) * 24)}`);
});

test("define an event, set its value, fire it at the playhead, a second on the same frame", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");

  // Rig ▸ Events ▸ + Event.
  await page.getByRole("button", { name: "Events", exact: true }).click();
  page.once("dialog", (d) => void d.accept("footstep"));
  await page.getByRole("button", { name: "+ Event" }).click();
  await expect(page.locator(".outline .row", { hasText: "footstep" })).toHaveClass(/selected/);
  // Its value in Properties.
  const int = page.getByRole("textbox", { name: "Int" });
  await int.fill("3");
  await int.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.session.doc.events?.find((e) => e.name === "footstep")?.int)).toBe(3);

  // Fired at frame 5 with Key; Key again there is refused.
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(5));
  await page.getByRole("button", { name: "Key", exact: true }).click();
  await expect.poll(() => fired(page)).toEqual(["footstep@5"]);

  // A second event on the same frame: two keys.
  page.once("dialog", (d) => void d.accept("dust"));
  await page.getByRole("button", { name: "+ Event" }).click();
  await page.keyboard.press("k");
  await expect.poll(() => fired(page)).toEqual(["footstep@5", "dust@5"]);
  // Both events are defined, whatever the animation fires.
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.events?.map((e) => e.name))).toEqual(["footstep", "dust"]);
});
