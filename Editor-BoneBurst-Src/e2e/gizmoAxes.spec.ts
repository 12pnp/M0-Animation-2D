import { expect, test } from "@playwright/test";

/** The move gizmo's arrows: x red, y green, lettered; a press on one drags along that axis only. */

type Live = {
  boneburst: {
    session: { doc: { bones: { name: string; x?: number; y?: number }[] }; select(s: unknown): void; pose(): { bones: Map<string, number> } };
    stage: { gizmoArrows(p: unknown, i: number): { angle: number; len: number; name: string; colour: string }[]; screenBones(): { name: string; x0: number; y0: number }[] };
  };
};

test("a press on the x arrow moves the bone along x only, whichever way the pointer strays", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await page.locator(".stage").first().waitFor();
  const info = await page.evaluate(() => {
    const { session, stage } = (window as unknown as Live).boneburst;
    const i = session.pose().bones.get("hips")!, o = stage.screenBones().find((b) => b.name === "hips")!;
    return { o: [o.x0, o.y0], arrows: stage.gizmoArrows(session.pose(), i), x: session.doc.bones.find((b) => b.name === "hips")!.x ?? 0, y: session.doc.bones.find((b) => b.name === "hips")!.y ?? 0 };
  });
  expect(info.arrows.map((a) => a.name + a.colour)).toEqual(["x#f53352", "y#87d603"]);
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const a = info.arrows[0]!, k = 0.8 * a.len, dir = [Math.cos(a.angle), Math.sin(a.angle)] as const, side = [-dir[1], dir[0]] as const;
  const start = [box.x + info.o[0]! + dir[0] * k, box.y + info.o[1]! + dir[1] * k] as const;
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  await page.mouse.move(start[0] + dir[0] * 30 + side[0] * 25, start[1] + dir[1] * 30 + side[1] * 25, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(() => { const b = (window as unknown as Live).boneburst.session.doc.bones.find((n) => n.name === "hips")!; return { x: b.x ?? 0, y: b.y ?? 0 }; });
  expect(Math.abs(after.x - info.x)).toBeGreaterThan(1);
  expect(after.y).toBeCloseTo(info.y, 1);
});

for (const [tool, fields] of [["scale", ["scaleX", "scaleY"]], ["shear", ["shearX", "shearY"]]] as const) {
  test(`a press on the ${tool} gizmo's x arrow changes ${fields[0]} only`, async ({ page }) => {
    await page.goto("/");
    // The tool panels hidden, so nothing floats over the gizmo; the tool by its key.
    await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, stagePanels: false })));
    await page.reload();
    await page.getByRole("button", { name: "Open the stickman fixture" }).click();
    await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
    await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(tool === "scale" ? "s" : "h");
    const info = await page.evaluate(() => {
      const { session, stage } = (window as unknown as Live).boneburst;
      const i = session.pose().bones.get("hips")!, o = stage.screenBones().find((b) => b.name === "hips")!;
      return { o: [o.x0, o.y0], arrows: stage.gizmoArrows(session.pose(), i) };
    });
    const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
    const a = info.arrows[0]!, k = 0.8 * a.len, dir = [Math.cos(a.angle), Math.sin(a.angle)] as const, side = [-dir[1], dir[0]] as const;
    const start = [box.x + info.o[0]! + dir[0] * k, box.y + info.o[1]! + dir[1] * k] as const;
    await page.mouse.move(start[0], start[1]);
    await page.mouse.down();
    await page.mouse.move(start[0] + dir[0] * 25 + side[0] * 25, start[1] + dir[1] * 25 + side[1] * 25, { steps: 6 });
    await page.mouse.up();
    const after = await page.evaluate((f) => { const b = (window as unknown as Live).boneburst.session.doc.bones.find((n) => n.name === "hips") as unknown as Record<string, number | undefined>; return f.map((key) => b[key]); }, fields);
    expect(after[0]).not.toBeUndefined();
    expect(after[1]).toBeUndefined();
  });
}

test("F centres the view on the selected bone; Z cycles the space with a short label; T is Move, R is Rotate", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("f");
  const centred = await page.evaluate(() => {
    const { stage } = (window as unknown as { boneburst: { stage: { screenBones(): { name: string; x0: number; y0: number }[]; size: { width: number; height: number } } } }).boneburst;
    const o = stage.screenBones().find((b) => b.name === "hips")!;
    return [o.x0 - stage.size.width / 2, o.y0 - stage.size.height / 2];
  });
  expect(Math.abs(centred[0]!)).toBeLessThan(1);
  expect(Math.abs(centred[1]!)).toBeLessThan(1);
  await expect(page.getByRole("button", { name: "Parent" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("z");
  await expect(page.getByRole("button", { name: "World" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".stage-flash")).toHaveText("World");
  await expect(page.locator(".stage-flash")).toHaveCount(0, { timeout: 2000 });
  await page.keyboard.press("z");
  await expect(page.getByRole("button", { name: "Local", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("r");
  await expect(page.locator('[data-tool="rotate"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("t");
  await expect(page.locator('[data-tool="move"]')).toHaveAttribute("aria-pressed", "true");
});

test("arrow keys nudge the chosen tool's value: R then → adds to rotation, Shift ten times; Move uses x and y", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, nudgeStep: 1 })));
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const rot = page.getByRole("textbox", { name: "rotate rotation" });
  const before = Number(await rot.inputValue());
  await page.keyboard.press("r");
  await page.keyboard.press("ArrowRight");
  await expect(rot).toHaveValue(String(before + 1));
  await page.keyboard.press("Shift+ArrowRight");
  await expect(rot).toHaveValue(String(before + 11));
  await page.keyboard.press("ArrowLeft");
  await expect(rot).toHaveValue(String(before + 10));
  await page.keyboard.press("t");
  const x = page.getByRole("textbox", { name: "translate x" }), y = page.getByRole("textbox", { name: "translate y" });
  const [x0, y0] = [Number(await x.inputValue()), Number(await y.inputValue())];
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await expect(x).toHaveValue(String(x0 + 1));
  await expect(y).toHaveValue(String(y0 + 1));
});

test("the arrow-key step is a preference: 5 degrees a press, Shift times 3", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, nudgeStep: 5, nudgeBigFactor: 3 })));
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const rot = page.getByRole("textbox", { name: "rotate rotation" });
  const before = Number(await rot.inputValue());
  await page.keyboard.press("r");
  await page.keyboard.press("ArrowRight");
  await expect(rot).toHaveValue(String(before + 5));
  await page.keyboard.press("Shift+ArrowRight");
  await expect(rot).toHaveValue(String(before + 20));
});

test("Q steps to the previous frame and W to the next", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const frame = () => page.evaluate(() => (window as unknown as { boneburst: { session: { frame: number } } }).boneburst.session.frame);
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  expect(await frame()).toBe(2);
  await page.keyboard.press("q");
  expect(await frame()).toBe(1);
});
