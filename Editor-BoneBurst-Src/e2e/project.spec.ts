import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

/** The project file (docs/BBDATA-PLAN.md): ⌘S writes one .bbdata; opening it gives the same rig; Export writes the Spine files. */

type Live = { boneburst: { session: { doc: { bones: { name: string; x?: number }[] } | null; dirty: boolean } } };

const hipsX = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc?.bones.find((b) => b.name === "hips")?.x ?? null);
const dirty = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.dirty);

async function menuItem(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
}

test("Save Project writes one .bbdata that opens as the same rig; Export Spine JSON writes the three Spine files", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, saveTo: "file" })); });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const before = await hipsX(page);
  await page.evaluate(() => {
    const s = (window as unknown as { boneburst: { session: { history: { apply(l: string, f: (d: unknown) => unknown): void }; changed(): void } } }).boneburst.session;
    s.history.apply("Move hips", (d) => {
      const doc = d as { bones: { name: string; x?: number }[] };
      return { ...doc, bones: doc.bones.map((b) => (b.name === "hips" ? { ...b, x: (b.x ?? 0) + 41 } : b)) };
    });
    s.changed();
  });
  await expect.poll(() => hipsX(page)).toBe((before ?? 0) + 41);
  expect(await dirty(page)).toBe(true);

  const [saved] = await Promise.all([page.waitForEvent("download"), menuItem(page, "File", "Save Project(?! As)")]);
  expect(saved.suggestedFilename()).toBe("Stickman_IK.bbdata");
  const path = join(mkdtempSync(join(tmpdir(), "bbdata-")), "Stickman_IK.bbdata");
  await saved.saveAs(path);
  expect(await dirty(page)).toBe(false);

  // Reload, open the project alone: the edit is there, nothing else was given.
  await page.reload();
  await page.locator('input[type=file][accept*=".bbdata"]').setInputFiles(path);
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await expect.poll(() => hipsX(page)).toBe((before ?? 0) + 41);
  expect(await dirty(page)).toBe(false);
  expect(readFileSync(path).subarray(0, 8).toString()).toBe("BBDATA1\n");

  // Export writes the Spine files.
  const names: string[] = [];
  page.on("download", (d) => names.push(d.suggestedFilename()));
  await menuItem(page, "File", "Export Spine JSON");
  await expect.poll(() => names.slice().sort()).toEqual(["Stickman_IK.atlas.txt", "Stickman_IK.json", "Stickman_IK_tex.png"]);
});

test("New Project opens a blank rig in its own tab, clean until edited, and the open rig stays in its tab", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, saveTo: "file" })); });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await menuItem(page, "File", "New Project");
  await expect(page.locator(".doc-tab")).toHaveCount(2);
  await expect(page.locator(".outline .row", { hasText: "root" })).toBeVisible();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toHaveCount(0);
  expect(await dirty(page)).toBe(false);
  await expect(page).toHaveTitle(/^untitled/);
});

test("Open dialog: + works where the browser cannot keep folders: the folder's projects are listed and one opens", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined; });
  // A folder holding one project: the stickman, saved as .bbdata by the editor itself.
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, saveTo: "file" })); });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const [saved] = await Promise.all([page.waitForEvent("download"), menuItem(page, "File", "Save Project(?! As)")]);
  const dir = mkdtempSync(join(tmpdir(), "bbfolder-"));
  await saved.saveAs(join(dir, "Stickman_IK.bbdata"));

  await page.reload();
  await menuItem(page, "File", "Open…");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "+", exact: true }).click()]);
  await chooser.setFiles(dir);
  await expect(page.locator("dialog.open-project .op-list").first().getByRole("button", { name: "Stickman_IK" })).toBeVisible();
  await page.locator("dialog.open-project .op-list").first().getByRole("button", { name: "Stickman_IK" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await expect(page.locator("dialog.open-project")).not.toBeVisible();
});

test("a project remembers the selected bone and the animation shown, and opens on them", async ({ page }) => {
  type Remembered = { boneburst: { session: { selectedBone: string | null; animation: { name: string } | null; doc: { animations?: { name: string }[] }; select(s: unknown): void; showAnimation(n: string | null): void } } };
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, saveTo: "file" })); });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const chosen = await page.evaluate(() => {
    const s = (window as unknown as Remembered).boneburst.session, anim = s.doc.animations![0]!.name;
    s.select({ kind: "bone", name: "head" });
    s.showAnimation(anim);
    return { anim };
  });
  const [saved] = await Promise.all([page.waitForEvent("download"), menuItem(page, "File", "Save Project(?! As)")]);
  const path = join(mkdtempSync(join(tmpdir(), "bbdata-")), "Stickman_IK.bbdata");
  await saved.saveAs(path);
  await page.reload();
  await page.locator('input[type=file][accept*=".bbdata"]').setInputFiles(path);
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const back = await page.evaluate(() => { const s = (window as unknown as Remembered).boneburst.session; return { bone: s.selectedBone, anim: s.animation?.name ?? null }; });
  expect(back.bone).toBe("head");
  expect(back.anim).toBe(chosen.anim);
});
