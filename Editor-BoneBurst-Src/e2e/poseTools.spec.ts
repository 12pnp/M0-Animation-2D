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
  await page.mouse.click(box.x + 70, box.y + 70);
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
