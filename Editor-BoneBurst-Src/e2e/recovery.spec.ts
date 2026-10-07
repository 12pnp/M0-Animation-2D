import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * Autosave and recovery (E6-PLAN step 4a): unsaved work kept in the browser every few seconds,
 * offered back after a reload; Restore gives it back unsaved, Save and Discard clear the copy, and
 * a PSD rig restored still saves its atlas and pages.
 */

const FIGURE = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "psd", "figure.psd");
type Live = { boneburst: { session: { name: string; dirty: boolean; doc: { bones: { name: string; x?: number }[] } | null; generated: { pages: unknown[] } | null; history: { apply(label: string, edit: (d: unknown) => unknown): boolean }; changed(): void } } };

/** Whether the browser holds a recovery copy, and of what. */
const kept = (page: Page) => page.evaluate(() => new Promise<string | null>((ok) => {
  const r = indexedDB.open("boneburst-editor", 2);
  r.onupgradeneeded = () => { for (const s of ["handles", "recovery"]) r.result.createObjectStore(s); };
  r.onsuccess = () => {
    const g = r.result.transaction("recovery").objectStore("recovery").getAll();
    g.onsuccess = () => { const one = g.result[0]; ok(one ? `${one.name}:${(JSON.parse(one.skeleton) as { bones: { name: string; x?: number }[] }).bones.find((b) => b.name === "hips")?.x ?? "-"}` : null); };
    g.onerror = () => ok(null);
  };
  r.onerror = () => ok(null);
}));

/** Move the hips by 33 in the document, as an edit. */
const edit = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as Live).boneburst.session;
  s.history.apply("Move hips", (d) => {
    const doc = d as { bones: { name: string; x?: number }[] };
    return { ...doc, bones: doc.bones.map((b) => (b.name === "hips" ? { ...b, x: (b.x ?? 0) + 33 } : b)) };
  });
  s.changed();
});

const hipsX = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc?.bones.find((b) => b.name === "hips")?.x ?? null);

/** Choose an item from a menu in the menu bar (there is no toolbar row any more). */
async function menuItem(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole("button", { name: menu, exact: true }).click();
  // Its name carries the shortcut text too ("Save⌘S"), so match the start.
  await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
}

test("autosave keeps unsaved work; after a reload Restore gives it back unsaved; Save and Discard clear the copy; a PSD rig restored saves its atlas", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    // A copy every 5 s (the shortest the preferences allow).
    localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, autosave: true, autosaveSeconds: 5, saveTo: "file" }));
    await new Promise((ok) => { const r = indexedDB.deleteDatabase("boneburst-editor"); r.onsuccess = r.onerror = r.onblocked = ok; });
  });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const before = await hipsX(page);
  // Nothing unsaved: nothing kept.
  await page.waitForTimeout(6000);
  expect(await kept(page)).toBeNull();
  await edit(page);
  await expect.poll(() => kept(page), { timeout: 8000 }).toBe(`Stickman_IK:${(before ?? 0) + 33}`);

  // A reload: offered back, restored unsaved.
  await page.reload();
  const bar = page.locator(".recovery-bar");
  await expect(bar).toContainText("Unsaved work on Stickman_IK.json");
  await bar.getByRole("button", { name: "Restore" }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => hipsX(page)).toBe((before ?? 0) + 33);
  await expect(page).toHaveTitle(/^• Stickman_IK\.json/);

  // Saved: nothing unsaved, the copy cleared.
  const [download] = await Promise.all([page.waitForEvent("download"), menuItem(page, "File", "Save Project(?! As)")]);
  expect(download.suggestedFilename()).toBe("Stickman_IK.bbdata");
  await expect.poll(() => kept(page), { timeout: 8000 }).toBeNull();
  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.locator(".recovery-bar")).toHaveCount(0);

  // Discard clears it.
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await edit(page);
  await expect.poll(() => kept(page), { timeout: 8000 }).not.toBeNull();
  await page.reload();
  await page.locator(".recovery-bar").getByRole("button", { name: "Discard" }).click();
  await expect(page.locator(".recovery-bar")).toHaveCount(0);
  expect(await kept(page)).toBeNull();

  // A PSD rig (unsaved from the start) restored: Save Project still keeps its atlas and pages.
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(FIGURE);
  await expect(page.locator(".outline .row", { hasText: "arm L" })).toBeVisible();
  await expect.poll(() => kept(page), { timeout: 8000 }).toMatch(/^figure:/);
  await page.reload();
  await page.locator(".recovery-bar").getByRole("button", { name: "Restore" }).click();
  await expect(page.locator(".outline .row", { hasText: "arm L" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.generated?.pages.length ?? 0)).toBe(1);
  const names: string[] = [];
  page.on("download", (d) => names.push(d.suggestedFilename()));
  await menuItem(page, "File", "Save Project(?! As)");
  await expect.poll(() => names).toEqual(["figure.bbdata"]);
});

test("Save with the default (this browser) downloads nothing, keeps the project here, and a reload offers it back as saved; Save Project As… still writes a file", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((ok) => { const r = indexedDB.deleteDatabase("boneburst-editor"); r.onsuccess = r.onerror = r.onblocked = ok; });
  });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  let downloads = 0;
  page.on("download", () => { downloads++; });
  await menuItem(page, "File", "Save Project(?! As)");
  await expect(page.locator(".message")).toContainText("in this browser");
  await expect(page.locator(".flash")).toContainText("Saved in this browser");
  await expect(page.locator(".flash .detail")).toContainText("Stickman_IK.json");
  await expect(page.locator(".flash")).toHaveCount(0);
  expect(downloads).toBe(0);
  // Nothing unsaved, yet the copy is kept (it is the save).
  await page.reload();
  const bar = page.locator(".recovery-bar");
  await expect(bar).toContainText("saved in this browser");
  await bar.getByRole("button", { name: "Restore" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await expect(page.locator(".message")).toContainText("as saved");
  await expect(bar).toHaveCount(0);
});

test("several open files are each kept in this browser: Save in one tab does not replace another's copy, and a reload offers them all back as tabs", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((ok) => { const r = indexedDB.deleteDatabase("boneburst-editor"); r.onsuccess = r.onerror = r.onblocked = ok; });
  });
  await page.reload();
  const copies = () => page.evaluate(() => new Promise<string[]>((ok) => {
    const r = indexedDB.open("boneburst-editor", 2);
    r.onsuccess = () => { const g = r.result.transaction("recovery").objectStore("recovery").getAll(); g.onsuccess = () => ok((g.result as { name: string }[]).map((x) => x.name).sort()); };
  }));
  const tabs = () => page.locator(".doc-tabs .doc-name");
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await menuItem(page, "File", "Save Project(?! As)");
  await expect.poll(() => copies()).toEqual(["Stickman_IK"]);
  // A second file in a tab of its own; Save there keeps both.
  await menuItem(page, "File", "New Project");
  await expect(tabs()).toHaveCount(2);
  await menuItem(page, "File", "Save Project(?! As)");
  await expect.poll(() => copies()).toEqual(["Stickman_IK", "untitled"]);
  // Change the first (still saved to this browser) and set it aside: the copy of the unsaved work is written as it leaves.
  await page.locator(".doc-tab", { hasText: "Stickman_IK" }).click();
  await edit(page);
  await page.locator(".doc-tab", { hasText: "untitled" }).click();
  await page.waitForTimeout(500);
  // A reload: both come back, each in a tab, the changed one unsaved.
  await page.reload();
  const bar = page.locator(".recovery-bar");
  await expect(bar).toContainText("2 projects");
  await bar.getByRole("button", { name: "Restore all" }).click();
  await expect(tabs()).toHaveCount(2);
  expect((await tabs().allTextContents()).map((t) => t.replace(/^• /, "")).sort()).toEqual(["Stickman_IK.json", "untitled.json"]);
  // The one changed after it was saved comes back unsaved, the other as saved.
  await expect(page.locator(".doc-tab", { hasText: "Stickman_IK" })).toContainText("•");
  await expect(page.locator(".doc-tab", { hasText: "untitled" })).not.toContainText("•");
  await page.locator(".doc-tab", { hasText: "Stickman_IK" }).click();
  expect(await hipsX(page)).not.toBeNull();
  await expect(bar).toHaveCount(0);
});
