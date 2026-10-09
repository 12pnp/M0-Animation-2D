import { expect, test } from "@playwright/test";

/**
 * Row actions (docs/ROW-ACTIONS-PLAN.md): in the Animations and Skins panels an editable row shows
 * Duplicate, Rename and Delete as icons while hovered; each acts on that row, chosen or not. The
 * bar keeps only New… and Nest by /.
 */

type Live = { boneburst: { session: { doc: { animations?: Record<string, unknown> | { name: string }[]; skins?: { name: string }[] } } } };

test("hovering an animation or skin row shows Duplicate, Rename and Delete; each acts on that row", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();

  await page.locator(".dv-tab", { hasText: "Animations" }).click();
  const panel = page.locator(".list-panel").filter({ has: page.getByRole("heading", { name: "Animations" }) });
  await expect(panel.locator(".list-bar button")).toHaveText(["New…"]);
  const row = (name: string) => panel.locator(".history-list li").filter({ has: page.locator(".history-step", { hasText: name }) });

  // The setup pose has none; an animation's are hidden until hovered.
  await expect(row("Setup pose").locator(".row-actions")).toHaveCount(0);
  const run = row("run").locator(".row-actions button");
  await expect(run).toHaveCount(3);
  await expect(run.first()).toBeHidden();
  await row("run").hover();
  for (const b of await run.all()) await expect(b).toBeVisible();
  expect(await run.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")))).toEqual(["Duplicate run…", "Rename run…", "Delete run (Undo brings it back)"]);

  // The chosen row keeps its accent while hovered.
  await row("dance").locator(".history-step").click();
  await row("dance").hover();
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  const bg = await row("dance").locator(".history-step").evaluate((b) => getComputedStyle(b).backgroundColor);
  const probe = await page.evaluate((c) => { const d = document.createElement("div"); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }, accent);
  expect(bg).toBe(probe);

  // Rename acts on the hovered row, not the chosen one.
  page.once("dialog", (d) => void d.accept("sprint"));
  await row("run").hover();
  await row("run").getByRole("button", { name: "Rename run…" }).click();
  const names = () => page.evaluate(() => {
    const a = (window as unknown as Live).boneburst.session.doc.animations ?? [];
    return Array.isArray(a) ? a.map((x) => x.name) : Object.keys(a);
  });
  expect(await names()).toEqual(["dance", "sprint"]);

  page.once("dialog", (d) => void d.accept("sprint copy"));
  await row("sprint").hover();
  await row("sprint").getByRole("button", { name: "Duplicate sprint…" }).click();
  expect(await names()).toEqual(["dance", "sprint", "sprint copy"]);

  page.once("dialog", (d) => void d.accept());
  await row("sprint copy").hover();
  await row("sprint copy").getByRole("button", { name: /^Delete sprint copy/ }).click();
  expect(await names()).toEqual(["dance", "sprint"]);

  // Skins: the default skin has none; "alt" has all three.
  await page.locator(".dv-tab", { hasText: "Skins" }).click();
  const skins = page.locator(".list-panel").filter({ has: page.getByRole("heading", { name: "Skins" }) });
  await expect(skins.locator(".list-bar button")).toHaveText(["New…"]);
  const skin = (name: string) => skins.locator(".history-list li").filter({ has: page.locator(".history-step", { hasText: name }) });
  await expect(skin("default").locator(".row-actions")).toHaveCount(0);
  await skin("alt").hover();
  await expect(skin("alt").locator(".row-actions button")).toHaveCount(3);
  await expect(skin("alt").getByRole("button", { name: "Rename alt…" })).toBeVisible();
});

test("Rig ▸ Skins: a skin row but the default one shows Duplicate, Rename and Delete while hovered; each acts on that row", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const rig = page.locator(".panel.outline:not(.list-panel)");
  await rig.locator(".outline-bar").getByRole("button", { name: "Skins", exact: true }).click();
  // The bar: + Skin, no Duplicate.
  await expect(rig.locator(".outline-bar").getByRole("button", { name: "+ Skin" })).toBeVisible();
  await expect(rig.locator(".outline-bar").getByRole("button", { name: "Duplicate", exact: true })).toHaveCount(0);
  const skin = (name: string) => rig.locator(".rows .row.skin").filter({ has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
  const skinNames = () => page.evaluate(() => ((window as unknown as Live).boneburst.session.doc.skins ?? []).map((k) => k.name));

  await expect(skin("default").locator(".row-actions")).toHaveCount(0);
  const alt = skin("alt").locator(".row-actions button");
  await expect(alt).toHaveCount(3);
  await expect(alt.first()).toBeHidden();
  await skin("alt").hover();
  for (const b of await alt.all()) await expect(b).toBeVisible();

  // Acts on the hovered row while the default skin is the one selected.
  await skin("default").click();
  page.once("dialog", (d) => void d.accept("spare"));
  await skin("alt").hover();
  await skin("alt").getByRole("button", { name: "Rename alt…" }).click();
  expect(await skinNames()).toEqual(["default", "spare"]);

  page.once("dialog", (d) => void d.accept("spare copy"));
  await skin("spare").hover();
  await skin("spare").getByRole("button", { name: "Duplicate spare…" }).click();
  expect(await skinNames()).toEqual(["default", "spare", "spare copy"]);

  page.once("dialog", (d) => void d.accept());
  await skin("spare copy").hover();
  await skin("spare copy").getByRole("button", { name: /^Delete spare copy/ }).click();
  expect(await skinNames()).toEqual(["default", "spare"]);
});
