import { expect, type Page, test } from "@playwright/test";

/** Motion Path relative to a parent bone (docs/MOTION-PARENT-PLAN.md): the picker is required, the nodes live in that bone's space. */

type Live = {
  boneburst: {
    session: {
      select(s: unknown): void;
      sidecar: { motion: { bone: string; parent?: string; nodes: { x: number; y: number }[] }[] };
      doc: { bones: { name: string; parent?: string }[] };
    };
    motionPath: { stageLine(): { points: number[] } | null };
  };
};

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
}

const motion = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion[0] ?? null);

test("no path can be made until a parent bone is chosen: Edit Path is off, and the key says why", async ({ page }) => {
  await open(page);
  const panel = page.locator(".motion-path"), pick = panel.getByRole("combobox", { name: "Parent bone" });
  await expect(pick).toBeVisible();
  await expect(pick).toHaveValue("");
  await expect(panel.getByRole("button", { name: "Edit Path", exact: true })).toBeDisabled();
  const box = (await panel.locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("e");
  expect(await motion(page)).toBeNull();
  await expect(page.locator(".message")).toContainText("Choose the parent bone first");
  // The bone and the bones under it are not offered.
  const options = await pick.locator("option").allTextContents();
  expect(options).not.toContain("head");
  expect(options).toContain("hips");
});

test("a chosen parent is kept with the path; changing it keeps the path where it is on screen", async ({ page }) => {
  await open(page);
  const panel = page.locator(".motion-path"), pick = panel.getByRole("combobox", { name: "Parent bone" });
  await pick.selectOption("hips");
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await expect.poll(() => motion(page)).not.toBeNull();
  const first = (await motion(page))!;
  expect(first.parent).toBe("hips");
  await panel.getByRole("button", { name: "Stage", exact: true }).click();
  const line = () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.stageLine()!.points);
  const before = await line();
  await pick.selectOption("root");
  await expect.poll(async () => (await motion(page))!.parent).toBe("root");
  // The nodes are in root's space now (numbers changed), the path on the Stage is where it was.
  const second = (await motion(page))!;
  expect(second.nodes[0]).not.toEqual(first.nodes[0]);
  const after = await line();
  expect(after.length).toBe(before.length);
  for (let i = 0; i < before.length; i += 20) expect(after[i]).toBeCloseTo(before[i]!, 1);
});

test("the path follows the parent bone: its first node sits where that bone's matrix puts it, at any frame", async ({ page }) => {
  await open(page);
  const panel = page.locator(".motion-path");
  await panel.getByRole("combobox", { name: "Parent bone" }).selectOption("hips");
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await expect.poll(() => motion(page)).not.toBeNull();
  await panel.getByRole("button", { name: "Stage", exact: true }).click();
  const check = (frame: number) => page.evaluate(async (f) => {
    const posedUrl = "/src/ui/stage/posed.ts";
    const posed: any = await import(/* @vite-ignore */ posedUrl);
    const b = (window as any).boneburst, s = b.session;
    s.seek(f);
    const p = s.pose(), M = posed.boneMatrix(p, p.bones.get("hips")), n = s.sidecar.motion[0].nodes[0], line = b.motionPath.stageLine().points;
    return { got: [line[0], line[1]], want: [M[4] + M[0] * n.x + M[1] * n.y, M[5] + M[2] * n.x + M[3] * n.y], m4: M[4], m5: M[5] };
  }, frame);
  const a = await check(0), c = await check(7);
  for (const r of [a, c]) { expect(r.got[0]).toBeCloseTo(r.want[0], 1); expect(r.got[1]).toBeCloseTo(r.want[1], 1); }
  // And hips did move between the two frames, so the path moved with it.
  expect(Math.abs(a.m4 - c.m4) + Math.abs(a.m5 - c.m5)).toBeGreaterThan(0.5);
});
