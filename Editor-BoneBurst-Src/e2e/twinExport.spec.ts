import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chooseParent } from "./motionHelpers";

/** The TwinSpline export (docs/UNITY-EXPORT-PLAN.md): File ▸ Export TwinSpline JSON… on the stickman. */

type Live = { boneburst: { session: { select(s: unknown): void; sidecar: { motion: { animation: string; bone: string }[] }; doc: { animations: { name: string; bones?: { name: string; timelines: { name: string }[] }[] }[] } } } };
type Twin = { twinspline: number; animations: Record<string, Record<string, { nodes: unknown[]; duration: number; parent?: string }>> };
type Skel = { animations: Record<string, { bones?: Record<string, Record<string, unknown>> }> };

test("Export TwinSpline JSON writes a bone's path in its own file and takes its translate keys out of the skeleton; bones that cannot be converted closely stay keys, listed; the document is untouched", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
  const panel = page.locator(".panel.motion-path");
  await chooseParent(panel);
  await panel.locator(".lp-card").getByRole("button", { name: "Create new" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion.length)).toBe(1);
  const made = await page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion[0]!);

  const saved = new Map<string, string>();
  const dir = mkdtempSync(join(tmpdir(), "twin-"));
  page.on("download", (d) => void d.saveAs(join(dir, d.suggestedFilename())).then(() => saved.set(d.suggestedFilename(), join(dir, d.suggestedFilename()))));
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Export TwinSpline JSON/ }).click();
  const status = page.getByRole("contentinfo");
  await expect(status).toContainText("as TwinSpline", { timeout: 20_000 });
  // The bones with a path are counted; the stickman's keyed bones (a hold, an ease, a retraced line) stay keys, and the status line says why.
  await expect(status).toContainText(/1 bone as TwinSpline \(1 from their paths, 0 converted from keys\)/);
  await expect(status).toContainText(/left as keys:.*run\/hips \(a path would stray/);
  await expect.poll(() => [...saved.keys()].some((n) => n.endsWith(".twinspline.json")) && [...saved.keys()].some((n) => /^[^.]+\.json$/.test(n))).toBe(true);
  const twinName = [...saved.keys()].find((n) => n.endsWith(".twinspline.json"))!, skelName = twinName.replace(".twinspline.json", ".json");
  const twin = JSON.parse(readFileSync(saved.get(twinName)!, "utf8")) as Twin;
  expect(twin.twinspline).toBe(1);
  const p = twin.animations[made.animation]?.["head"];
  expect(p?.nodes.length).toBeGreaterThanOrEqual(2);
  expect(p?.parent).toBeTruthy();
  expect(Object.keys(twin.animations)).toEqual([made.animation]);
  const skel = JSON.parse(readFileSync(saved.get(skelName)!, "utf8")) as Skel;
  expect(Object.keys(skel.animations[made.animation]?.bones?.["head"] ?? {}).filter((k) => /^translate/.test(k))).toEqual([]);
  // The kept bones still have their keys in the exported skeleton, and in the editor.
  expect(Object.keys(skel.animations["run"]?.bones?.["hips"] ?? {}).some((k) => /^translate/.test(k))).toBe(true);
  const live = await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.animations.find((a) => a.name === "run")!.bones!.find((b) => b.name === "hips")!.timelines.map((t) => t.name));
  expect(live.some((n) => /^translate/.test(n))).toBe(true);
});

test("Export Spine JSON bakes a bone that uses its path into translate keys, says so, and leaves the document and the sidecar alone", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
  const panel = page.locator(".panel.motion-path");
  await chooseParent(panel);
  await panel.locator(".lp-card").getByRole("button", { name: "Create new" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion.length)).toBe(1);
  const made = await page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion[0]!);
  const saved = new Map<string, string>();
  const dir = mkdtempSync(join(tmpdir(), "bake-"));
  page.on("download", (d) => void d.saveAs(join(dir, d.suggestedFilename())).then(() => saved.set(d.suggestedFilename(), join(dir, d.suggestedFilename()))));
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Export Spine JSON/ }).click();
  await expect(page.getByRole("contentinfo")).toContainText(/1 bone from their TwinSpline \(\d+ keys\)/, { timeout: 20_000 });
  await expect.poll(() => [...saved.keys()].some((n) => /^[^.]+\.json$/.test(n))).toBe(true);
  const skel = JSON.parse(readFileSync(saved.get([...saved.keys()].find((n) => /^[^.]+\.json$/.test(n))!)!, "utf8")) as Skel;
  const head = skel.animations[made.animation]?.bones?.["head"]?.["translate"] as { time?: number }[] | undefined;
  expect(head?.length).toBeGreaterThanOrEqual(2);
  // The document still has no translate keys for the head; the sidecar still has its path.
  const live = await page.evaluate((an) => (window as unknown as Live).boneburst.session.doc.animations.find((a) => a.name === an)!.bones?.find((b) => b.name === "head")?.timelines.map((t) => t.name) ?? [], made.animation);
  expect(live.some((n) => /^translate/.test(n))).toBe(false);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion.length)).toBe(1);
});
