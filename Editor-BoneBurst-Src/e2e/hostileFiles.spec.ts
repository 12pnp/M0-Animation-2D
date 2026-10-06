import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Hostile files through Open… (E7-PLAN step 5): a page image that is not one opens the rig
 * without it, said; a cut-off skeleton, a PSD that is not one, a skeleton whose slot names a
 * missing bone, and JSON nested too deep are each refused with a message, the open document kept;
 * no page error; and the editor still opens a good file after them all.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STICK = join(ROOT, "tests", "fixtures", "stickman");
const json = readFileSync(join(STICK, "Stickman_IK.json"), "utf8"), atlas = readFileSync(join(STICK, "Stickman_IK.atlas.txt"));
const file = (name: string, text: string | Buffer) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(text) });

test("hostile files through Open…: each said or refused with a reason, no page error, the editor still works", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const open = page.locator('input[type=file][accept*=".psd"]');
  const message = page.locator(".message");

  // A page image that is not one: the rig opens without it, and says so.
  await open.setInputFiles([file("Stickman_IK.json", json), file("Stickman_IK.atlas.txt", atlas), file("Stickman_IK_tex.png", "not a png")]);
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".issues").click();
  await expect(page.locator(".issue-list")).toContainText("is not an image this browser can read");

  // Refused, each with its reason; the stickman stays open.
  const refused: [string, ReturnType<typeof file>[], RegExp][] = [
    ["a cut-off skeleton", [file("cut.json", json.slice(0, json.length / 2))], /at offset \d+/],
    ["a PSD that is not one", [file("x.psd", "8BPS nothing")], /x\.psd/],
    ["a slot on a missing bone", [file("ghost.json", json.replace(/"bone":\s*"[^"]+"/, '"bone": "nobody"'))], /names a bone "nobody"/],
    ["JSON nested too deep", [file("deep.json", `${"[".repeat(5000)}${"]".repeat(5000)}`)], /nested deeper than 1000/],
  ];
  for (const [what, files, why] of refused) {
    await open.setInputFiles(files);
    await expect(message, what).toHaveText(why);
    // The stickman is still the open document: the refused file did not take its place.
    await expect(page, `${what}: the open rig kept`).toHaveTitle(/^Stickman_IK\.json/);
  }

  // A good file still opens.
  await open.setInputFiles(["Stickman_IK.json", "Stickman_IK.atlas.txt", "Stickman_IK_tex.png"].map((f) => join(STICK, f)));
  await expect(message).toHaveText(/Opened/);
  expect(errors).toEqual([]);
});
