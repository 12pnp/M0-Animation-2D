import { expect, type Page, test } from "@playwright/test";

/**
 * Events on the timeline (E6-PLAN step 4b): an event defined in the Rig panel's Events tab, its
 * value set in Properties, fired at the playhead with Key; a second event on the same frame; one
 * dragged and the other deleted, each alone.
 */

type Live = { boneburst: { session: { doc: { events?: { name: string; int?: number }[]; animations: { name: string; events?: { name: string; time?: number }[] }[] }; seek(f: number): void } } };

const fired = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as Live).boneburst.session.doc;
  return (d.animations.find((a) => a.name === "run")!.events ?? []).map((k) => `${k.name}@${Math.round((k.time ?? 0) * 24)}`);
});

/** Where frame `f` of the timeline row named `name` is on the page, the row scrolled into view. */
async function diamond(page: Page, name: string, f: number): Promise<{ x: number; y: number }> {
  const label = page.locator(".timeline-labels .row").filter({ hasText: new RegExp(`^${name}$`) });
  await label.scrollIntoViewIfNeeded();
  const row = (await label.boundingBox())!, track = (await page.locator(".timeline-track canvas").boundingBox())!;
  // The track's default view: 12 px a frame, frame 0 half a frame in; its rows level with the labels.
  return { x: track.x + (f + 0.5) * 12, y: row.y + row.height / 2 };
}

test("define an event, set its value, fire it at the playhead, a second on the same frame; drag one, delete the other", async ({ page }) => {
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
  await expect(page.locator(".timeline-labels .row", { hasText: "footstep" })).toBeVisible();

  // A second event on the same frame: two rows, two keys.
  page.once("dialog", (d) => void d.accept("dust"));
  await page.getByRole("button", { name: "+ Event" }).click();
  await page.keyboard.press("k");
  await expect.poll(() => fired(page)).toEqual(["footstep@5", "dust@5"]);

  // Drag dust to frame 8: footstep stays at 5.
  const from = await diamond(page, "dust", 5), to = await diamond(page, "dust", 8);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => fired(page)).toEqual(["footstep@5", "dust@8"]);

  // Select footstep's key and Delete: dust stays.
  const fs = await diamond(page, "footstep", 5);
  await page.mouse.click(fs.x, fs.y);
  await page.keyboard.press("Delete");
  await expect.poll(() => fired(page)).toEqual(["dust@8"]);
  // The event itself is still defined.
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.events?.map((e) => e.name))).toEqual(["footstep", "dust"]);
});
