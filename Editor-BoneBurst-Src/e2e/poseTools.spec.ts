import { expect, test } from "@playwright/test";

/** The Pose tools group (docs/STAGE-POSE-PLAN.md step 4): Mesh, Weights, Path and Reset from the Stage. */

type Live = {
  boneburst: {
    session: {
      doc: { slots: { name: string; bone: string; attachment?: string }[]; skins: { name: string; attachments?: { slot: string; entries: { key: string; attachment: { type?: string } }[] }[] }[] };
      selected: { kind: string; name?: string; key?: string; slot?: string } | null;
      select(s: unknown): void;
      history: { undo(): void };
    };
  };
};

async function open(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
}

const tool = (page: import("@playwright/test").Page, id: string) => page.locator(`[data-pose="${id}"]`);

test("Mesh turns the selected image's region into a mesh (one undo) and selects it; Weights then toggles the brush", async ({ page }) => {
  await open(page);
  const slot = await page.evaluate(() => {
    const doc = (window as unknown as Live).boneburst.session.doc;
    for (const sl of doc.slots) {
      const key = sl.attachment;
      const e = key ? doc.skins.flatMap((k) => k.attachments ?? []).find((a) => a.slot === sl.name)?.entries.find((x) => x.key === key) : undefined;
      if (e?.attachment.type === undefined || e?.attachment.type === "region") return sl.name;
    }
    return null;
  });
  expect(slot).not.toBeNull();
  await page.evaluate((n) => (window as unknown as Live).boneburst.session.select({ kind: "slot", name: n }), slot);
  await tool(page, "weights").click();
  await expect(tool(page, "weights")).toHaveAttribute("aria-pressed", "false");
  await tool(page, "mesh").click();
  const sel = await page.evaluate(() => (window as unknown as Live).boneburst.session.selected);
  expect(sel).toMatchObject({ kind: "attachment", slot });
  const type = () => page.evaluate((n) => {
    const doc = (window as unknown as Live).boneburst.session.doc;
    return doc.skins.flatMap((k) => k.attachments ?? []).filter((a) => a.slot === n).flatMap((a) => a.entries).map((e) => e.attachment.type ?? "region");
  }, slot);
  expect(await type()).toContain("mesh");
  await tool(page, "weights").click();
  await expect(tool(page, "weights")).toHaveAttribute("aria-pressed", "true");
  await tool(page, "weights").click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.history.undo());
  expect(await type()).not.toContain("mesh");
});

test("Reset puts the selected bone's rotation back to 0; Path selects a bone's path", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const rot = page.getByRole("textbox", { name: "rotate rotation" });
  expect(Number(await rot.inputValue())).not.toBe(0);
  await tool(page, "reset").click();
  await expect(rot).toHaveValue("0");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(rot).not.toHaveValue("0");
  // A path made by the Create tool is found again by the Path tool.
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  await page.locator('[data-create="path"]').click();
  await page.mouse.click(box.x + 330, box.y + 130);
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await tool(page, "path").click();
  expect((await page.evaluate(() => (window as unknown as Live).boneburst.session.selected))).toMatchObject({ kind: "attachment" });
});

test("the Pose tools are hidden in Animate mode", async ({ page }) => {
  await open(page);
  await page.locator(".stage-panel button.mode").click();
  await expect(page.locator(".stage-tools .poses")).toBeHidden();
});

test("keys: D, P, G, C and N pick the Create tools, U edits the mesh, I pins; in Animate they do nothing; tooltips carry them", async ({ page }) => {
  await open(page);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (const [key, kind] of [["d", "bone"], ["p", "point"], ["g", "boundingbox"], ["c", "clipping"], ["n", "path"]] as const) {
    await page.keyboard.press(key);
    await expect(page.locator(`[data-create="${kind}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`[data-create="${kind}"]`)).toHaveAttribute("title", new RegExp(`\\(${key.toUpperCase()}\\)$`));
  }
  await page.keyboard.press("n");
  await expect(page.locator('[data-create="path"]')).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await page.keyboard.press("i");
  await expect(page.locator(".stage-tools .options button").nth(1)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("i");
  await expect(page.locator(".stage-tools .options button").nth(1)).toHaveAttribute("aria-pressed", "false");
  await page.locator(".stage-panel button.mode").click();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("d");
  expect(await page.evaluate(() => (window as unknown as { boneburst: { stage: { createKind: string | null } } }).boneburst.stage.createKind)).toBeNull();
});

test("the picked name shows for half a second; small buttons on the stage's left edge show and hide each panel", async ({ page }) => {
  await open(page);
  await expect(page.locator(".stage-crumb")).toBeHidden();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await expect(page.locator(".stage-crumb")).toBeVisible();
  await expect(page.locator(".stage-crumb")).toContainText("hips");
  await expect(page.locator(".stage-crumb")).toBeHidden({ timeout: 2000 });
  const create = page.locator('[data-panel-id="create"]');
  await expect(create).toHaveAttribute("aria-pressed", "true");
  await create.click();
  await expect(page.locator(".stage-tools .create")).toBeHidden();
  await expect(create).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".stage-tools .create")).toBeHidden();
  await page.locator('[data-panel-id="create"]').click();
  await expect(page.locator(".stage-tools .create")).toBeVisible();
});

test("a panel dragged onto another stops at its edge: cards never overlap; a free place works", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await open(page);
  const rect = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const start = await rect(".stage-tools .create");
  const grip = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  const target = await rect(".stage-tools .options");
  // Cmd held: the stage's panels show they can be moved, and a left drag moves one.
  await page.keyboard.down("Meta");
  await page.mouse.move(grip.x, grip.y);
  await expect(page.locator(".stage-tools").first()).toHaveClass(/drag-ready/);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.keyboard.up("Meta");
  await expect(page.locator(".stage-tools").first()).not.toHaveClass(/drag-ready/);
  const create = await rect(".stage-tools .create");
  expect(overlap(create, await rect(".stage-tools .options"))).toBeLessThan(2);
  expect(overlap(create, await rect(".stage-tools .poses"))).toBeLessThan(2);
  expect(overlap(create, await rect(".stage-tools .transform"))).toBeLessThan(2);
  // It did move (toward the target) rather than stay put.
  expect(Math.abs(create.x - start.x) + Math.abs(create.y - start.y)).toBeGreaterThan(5);
});

test("the picked name floats about 2 cm (76 px) above the pointer", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await open(page);
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const at = { x: box.x + 300, y: box.y + 300 };
  await page.mouse.move(at.x, at.y);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const name = (await page.locator(".stage-crumb").boundingBox())!;
  expect(Math.abs(name.x + name.width / 2 - at.x)).toBeLessThan(6);
  expect(Math.abs(name.y + name.height - (at.y - 75.6))).toBeLessThan(6);
});

test("the panel menu (⋮) has Reset This Panel's Layout, Put This Panel Back and Reset All Panels", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await open(page);
  // The Stage's: a hidden panel comes back, and the cards go where they started.
  await page.locator('[data-panel-id="create"]').click();
  await expect(page.locator(".stage-tools .create")).toBeHidden();
  const stageGroup = page.locator(".dv-groupview", { has: page.locator(".stage-panel") });
  await stageGroup.locator(".panel-menu-button").click();
  await expect(page.getByText("Reset This Panel's Layout")).toBeVisible();
  await expect(page.getByText("Put This Panel Back")).toBeVisible();
  await expect(page.getByText("Reset All Panels")).toBeVisible();
  await page.getByText("Reset This Panel's Layout").click();
  await expect(page.locator(".stage-tools .create")).toBeVisible();
  // Reset All Panels: a closed panel is back.
  await page.locator('button[data-panel="timeline"]').click();
  await expect(page.locator(".timeline")).toBeHidden();
  await stageGroup.locator(".panel-menu-button").click();
  await page.getByText("Reset All Panels").click();
  await expect(page.locator(".timeline").first()).toBeVisible();
});

test("Reset This Panel's Layout on the Stage: the matrix top left; Create, Pose tools, Bone options, the space and the transform panel along the bottom, left to right", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, toolbarPosition: "center" })));
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const stageGroup = page.locator(".dv-groupview", { has: page.locator(".stage-panel") });
  await stageGroup.locator(".panel-menu-button").click();
  await page.getByText("Reset This Panel's Layout").click();
  await expect(page.locator(".stage-tools").first()).toHaveAttribute("data-align", "left");
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const [create, poses, options, space, transform, matrix, stage] = [await box(".stage-tools .create"), await box(".stage-tools .poses"), await box(".stage-tools .options"), await box(".stage-tools .group:has(button:text-is('Local'))"), await box(".stage-tools .transform"), await box(".stage-tools-top .group"), await box(".stage-panel")];
  expect(create.x).toBeLessThan(poses.x);
  expect(poses.x).toBeLessThan(options.x);
  expect(options.x).toBeLessThan(space.x);
  expect(space.x).toBeLessThan(transform.x);
  expect(matrix.y - stage.y).toBeLessThan(30);
  expect(matrix.x - stage.x).toBeLessThan(30);
  expect(create.y + create.height).toBeGreaterThan(stage.y + stage.height - 40);
});

test("the small panel buttons follow the mode: Create, Bone options and Pose tools only in Pose", async ({ page }) => {
  await open(page);
  for (const id of ["create", "options", "poses", "transform", "space", "show"]) await expect(page.locator(`[data-panel-id="${id}"]`)).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  for (const id of ["create", "options", "poses"]) await expect(page.locator(`[data-panel-id="${id}"]`)).toBeHidden();
  for (const id of ["transform", "space", "show"]) await expect(page.locator(`[data-panel-id="${id}"]`)).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await expect(page.locator('[data-panel-id="create"]')).toBeVisible();
});

test("a picked bone glows for 0.4 s, then not, in Pose mode and in Animate mode", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await open(page);
  const glow = () => page.evaluate(() => (window as unknown as { boneburst: { stage: { glow: { kind: string; name: string } | null } } }).boneburst.stage.glow);
  const mid = () => page.evaluate(() => {
    const b = (window as unknown as { boneburst: { stage: { screenBones(): { name: string; x0: number; y0: number; x1: number; y1: number }[] } } }).boneburst.stage.screenBones().find((x) => x.name === "hips")!;
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  });
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const at = await mid();
  await page.mouse.click(box.x + at.x, box.y + at.y);
  expect(await glow()).toMatchObject({ kind: "bone" });
  await expect.poll(glow, { timeout: 2000 }).toBeNull();
  await page.locator(".stage-panel button.mode").click();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  const at2 = await mid();
  await page.mouse.click(box.x + at2.x, box.y + at2.y);
  expect(await glow()).toMatchObject({ kind: "bone" });
  await expect.poll(glow, { timeout: 2000 }).toBeNull();
});

test("the small Glow button at the stage's bottom left turns the pick glow off and on", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await open(page);
  const glow = () => page.evaluate(() => (window as unknown as { boneburst: { stage: { glow: unknown } } }).boneburst.stage.glow);
  const mid = () => page.evaluate(() => {
    const b = (window as unknown as { boneburst: { stage: { screenBones(): { name: string; x0: number; y0: number; x1: number; y1: number }[] } } }).boneburst.stage.screenBones().find((x) => x.name === "hips")!;
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  });
  const button = page.getByRole("button", { name: "Glow" });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const at = await mid();
  await page.mouse.click(box.x + at.x, box.y + at.y);
  expect(await glow()).toBeNull();
  await button.click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  await page.mouse.click(box.x + at.x, box.y + at.y);
  expect(await glow()).not.toBeNull();
});

test("the glow and the name stay while the mouse button is down; their countdown starts when it comes up", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await open(page);
  const glow = () => page.evaluate(() => (window as unknown as { boneburst: { stage: { glow: unknown } } }).boneburst.stage.glow);
  const at = await page.evaluate(() => {
    const b = (window as unknown as { boneburst: { stage: { screenBones(): { name: string; x0: number; y0: number; x1: number; y1: number }[] } } }).boneburst.stage.screenBones().find((x) => x.name === "hips")!;
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  });
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  await page.mouse.move(box.x + at.x, box.y + at.y);
  await page.mouse.down();
  await page.waitForTimeout(900);
  expect(await glow()).not.toBeNull();
  await expect(page.locator(".stage-crumb")).toBeVisible();
  await page.mouse.up();
  await expect.poll(glow, { timeout: 2000 }).toBeNull();
  await expect(page.locator(".stage-crumb")).toBeHidden({ timeout: 2000 });
});
