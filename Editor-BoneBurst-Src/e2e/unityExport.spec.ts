import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { decodePng } from "../src/io/png";

/**
 * Export to Unity (E5-PLAN step 8): the folder picker answered with a real folder handle (one in
 * the page's private file system, so IndexedDB keeps it as it keeps a chosen folder), the files
 * written into it, the skeleton last; the second export goes to the same folder without asking.
 */

const STICK = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "stickman");

/** Choose an item from a menu in the menu bar (there is no toolbar row any more). */
async function menuItem(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole("button", { name: menu, exact: true }).click();
  // Its name carries the shortcut text too ("Save⌘S"), so match the start.
  await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
}

test("Export to Unity…: the skeleton, atlas and page written into the chosen folder, the skeleton last; the folder remembered", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { picks: number; order: string[]; showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
    w.picks = 0;
    w.order = [];
    w.showDirectoryPicker = async () => {
      w.picks++;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("Unity", { create: true });
      // Record the order files are written in.
      const get = dir.getFileHandle.bind(dir);
      (dir as unknown as { getFileHandle: typeof get }).getFileHandle = async (name, o) => { w.order.push(name); return get(name, o); };
      return dir;
    };
  });
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("Unity", { recursive: true }).catch(() => undefined);
    await new Promise((ok) => { const r = indexedDB.deleteDatabase("boneburst-editor"); r.onsuccess = r.onerror = r.onblocked = ok; });
  });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();

  await menuItem(page, "File", "Export to Unity…");
  await expect(page.locator(".message").getByText(/Exported to Unity/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { order: string[] }).order)).toEqual(["Stickman_IK.atlas.txt", "Stickman_IK_tex.png", "Stickman_IK.json"]);

  const read = (name: string) => page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("Unity");
    return Array.from(new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer()));
  }, name);
  const json = JSON.parse(Buffer.from(await read("Stickman_IK.json")).toString("utf8"));
  expect(json.bones.map((b: { name: string }) => b.name)).toContain("hips");
  expect(Buffer.from(await read("Stickman_IK.atlas.txt")).toString("utf8")).toContain("Stickman_IK_tex.png");
  // The page's pixels exactly as opened.
  const written = await decodePng(new Uint8Array(await read("Stickman_IK_tex.png")));
  const given = await decodePng(new Uint8Array(readFileSync(join(STICK, "Stickman_IK_tex.png"))));
  expect([written.width, written.height]).toEqual([given.width, given.height]);
  expect(Buffer.from(written.pixels).equals(Buffer.from(given.pixels))).toBe(true);

  // Again: the same folder, without the picker (the skeleton written anew). Across a reload the
  // folder comes from IndexedDB; Playwright's Chromium closes the page when a private-file-system
  // handle is read back from there, so that read is not tested here.
  const has = () => page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("Unity");
    return dir.getFileHandle("Stickman_IK.json").then(() => true, () => false);
  });
  await page.evaluate(async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle("Unity")).removeEntry("Stickman_IK.json"));
  expect(await has()).toBe(false);
  await menuItem(page, "File", "Export to Unity…");
  await expect.poll(has).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { picks: number }).picks)).toBe(1);
});

test("Export to Unity… where the browser has no folder picker saves the files as downloads and says where they go", async ({ page }) => {
  await page.addInitScript(() => { delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker; });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const names: string[] = [];
  page.on("download", (d) => names.push(d.suggestedFilename()));
  await menuItem(page, "File", "Export to Unity…");
  await expect(page.locator(".message")).toContainText("saved as downloads");
  await expect.poll(() => names.length).toBe(3);
  expect(names).toEqual(expect.arrayContaining(["Stickman_IK.json", "Stickman_IK.atlas.txt", "Stickman_IK_tex.png"]));
});
