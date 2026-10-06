import { expect, type Page, test } from "@playwright/test";

/**
 * The notes are live (E8-PLAN step 1): the stickman opens with none; an attachment's path set to
 * a region the atlas lacks (a typo in Properties) shows its note at once, naming the attachment;
 * a click on it selects the attachment; undo takes the note away.
 */

type Live = { boneburst: { session: any } };

/** Apply `updatePath` to the first attachment of the default skin, as one undo step; its ref. */
const breakPath = (page: Page) => page.evaluate(async () => {
  const url = "/src/edit/attachments.ts";
  const { updateAttachment } = await import(/* @vite-ignore */ url);
  const s = (window as unknown as Live).boneburst.session;
  const sk = s.doc.skins.find((k: { name: string }) => k.name === "default");
  const ss = sk.attachments[0], ref = { skin: "default", slot: ss.slot, key: ss.entries[0].key };
  s.history.apply(`Path of ${ref.key}`, updateAttachment(ref, { path: "no-such-region" }));
  s.changed();
  return ref;
});

test("notes: an edit that breaks the file says so at once, naming what; a click selects it; undo clears it", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const notes = page.locator(".issues");
  await expect(notes).toBeHidden();

  const ref = await breakPath(page);
  await expect(notes).toBeVisible();
  await expect(notes).toHaveText("1 note");
  await notes.click();
  const note = page.locator(".issue-list li button", { hasText: 'region "no-such-region" is not in the atlas' });
  await expect(note).toBeVisible();
  await expect(note).toContainText(`skins/default/${ref.slot}/${ref.key}`);

  await note.click();
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.selected)).toEqual({ kind: "attachment", ...ref });

  await page.keyboard.press("ControlOrMeta+z");
  await expect(notes).toBeHidden();
});
