import { expect, test } from "@playwright/test";

/** The Create group (docs/STAGE-POSE-PLAN.md step 2): bone, point, bounding box, clipping and path from the Stage. */

type Live = {
  boneburst: {
    session: {
      doc: { bones: { name: string; parent?: string; x?: number; y?: number; length?: number; rotation?: number }[]; slots: { name: string; bone: string }[]; skins: { name: string; attachments?: { slot: string; entries: { key: string; attachment: { type?: string; vertexCount?: number; end?: string } }[] }[] }[] };
      selected: { kind: string; name?: string } | null;
      select(s: unknown): void;
      animation: unknown;
      history: { undo(): void };
    };
    stage: { screenBones(): { name: string; x0: number; y0: number; x1: number; y1: number }[]; createKind: string | null };
  };
};

async function open(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, stagePanels: true })));
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
}

const bonesOf = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc.bones.map((b) => ({ ...b })));

test("the Bone tool: a drag makes a bone under the selected one, as long as the drag; the next press carries on under it; one undo each", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await page.locator('[data-create="bone"]').click();
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const before = (await bonesOf(page)).length;
  // The top left of the stage, clear of the floating panels.
  const at = { x: box.x + 70, y: box.y + 70 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y, { steps: 5 });
  await page.mouse.up();
  let bones = await bonesOf(page);
  expect(bones.length).toBe(before + 1);
  const first = bones.find((b) => b.name === "bone")!;
  expect(first.parent).toBe("hips");
  expect(first.length ?? 0).toBeGreaterThan(5);
  // Carried on: a second press makes its child.
  await page.mouse.move(at.x + 60, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 40, { steps: 5 });
  await page.mouse.up();
  bones = await bonesOf(page);
  expect(bones.find((b) => b.name === "bone2")?.parent).toBe("bone");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.history.undo());
  expect((await bonesOf(page)).length).toBe(before + 1);
});

test("a click makes the default of each kind: a point, a bounding box, a clipping polygon and a path, each on a new slot", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  for (const [kind, type] of [["point", "point"], ["boundingbox", "boundingbox"], ["clipping", "clipping"], ["path", "path"]] as const) {
    await page.locator(`[data-create="${kind}"]`).click();
    await page.mouse.click(box.x + 70, box.y + 70);
    const made = await page.evaluate((t) => {
      const doc = (window as unknown as Live).boneburst.session.doc;
      return doc.skins.flatMap((k) => k.attachments ?? []).flatMap((a) => a.entries.map((e) => ({ slot: a.slot, type: e.attachment.type, n: e.attachment.vertexCount, end: e.attachment.end }))).filter((e) => e.type === t).length;
    }, type);
    expect(made, kind).toBeGreaterThan(0);
  }
  const clip = await page.evaluate(() => {
    const doc = (window as unknown as Live).boneburst.session.doc;
    return doc.skins.flatMap((k) => k.attachments ?? []).flatMap((a) => a.entries.map((e) => e.attachment)).find((a) => a.type === "clipping")!;
  });
  expect(clip.vertexCount).toBe(4);
  expect(clip.end).toBeTruthy();
});

test("Esc leaves the Create tool; the group is hidden in Animate mode", async ({ page }) => {
  await open(page);
  await page.locator('[data-create="bone"]').click();
  await expect(page.locator('[data-create="bone"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-create="bone"]')).toHaveAttribute("aria-pressed", "false");
  await page.locator('[data-create="point"]').click();
  await page.locator(".stage-panel button.mode").click();
  await expect(page.locator(".stage-tools .create")).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.stage.createKind)).toBeNull();
});

test("the Region tool places an image chosen from the atlas on a new slot of the bone under the press, one undo", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await page.locator('[data-create="region"]').click();
  const pick = page.locator(".create-region");
  await expect(pick).toBeVisible();
  const names = await pick.locator("option").allTextContents();
  expect(names.length).toBeGreaterThan(0);
  await pick.selectOption(names[names.length - 1]!);
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const before = await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.slots.length);
  await page.mouse.click(box.x + 70, box.y + 70);
  const made = await page.evaluate(() => {
    const doc = (window as unknown as Live).boneburst.session.doc;
    return { slots: doc.slots.length, last: doc.slots[doc.slots.length - 1], entries: doc.skins.flatMap((k) => k.attachments ?? []).filter((a) => a.slot === doc.slots[doc.slots.length - 1]!.name).flatMap((a) => a.entries.map((e) => e.key)) };
  });
  expect(made.slots).toBe(before + 1);
  expect(made.last).toMatchObject({ bone: "hips" });
  expect(made.entries).toEqual([names[names.length - 1]]);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.slots.length)).toBe(before);
});
