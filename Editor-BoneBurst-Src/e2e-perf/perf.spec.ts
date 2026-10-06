import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, test } from "@playwright/test";

/**
 * Where the time goes in the browser (E9-PLAN step 1), on mix-and-match-pro:
 * - open through Open…, to "Opened";
 * - a drag step, in its parts: the edit and every change listener (each timed: the panels, the
 *   status line, the stage's queueing), then the stage's paint;
 * - a real drag with the mouse, paced at 60 Hz: the frame intervals while it runs;
 * - playback: the frame intervals over 3 s;
 * - Export to Unity, to its message;
 * - the JS heap after 500 edits, and after they are undone and the history let go.
 * Medians and 95th percentiles; written to node_modules/.cache/perf/browser.json.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MM = join(ROOT, "..", "Packages", "com.module.ta-creator-boneburst", "Tests", "Editor", "Data~", "samples", "mix-and-match");
type Live = { boneburst: { session: any; stage: any } };

const stats = (t: number[]) => {
  const s = [...t].sort((a, b) => a - b);
  return { n: s.length, med: s[Math.floor(s.length / 2)] ?? 0, p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0, max: s.at(-1) ?? 0 };
};

/** Frame intervals in the page while `during` runs. */
async function frames(page: Page, during: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __on: boolean };
    w.__frames = []; w.__on = true;
    let last = performance.now();
    const tick = (now: number) => { w.__frames.push(now - last); last = now; if (w.__on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await during();
  return page.evaluate(() => { const w = window as unknown as { __frames: number[]; __on: boolean }; w.__on = false; return w.__frames.slice(1); });
}

test("mix-and-match-pro in the browser: open, drag, playback, export, memory", async ({ page }) => {
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("PerfUnity", { create: true });
  });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // Open.
  // PERF_RIG=double: mix-and-match with its skins and animations twice over (as scripts/perf.ts makes it).
  let files = readdirSync(MM).map((f) => join(MM, f));
  if (process.env.PERF_RIG === "double") {
    const dir = join(ROOT, "node_modules", ".cache", "perf", "double");
    mkdirSync(dir, { recursive: true });
    const j = JSON.parse(readFileSync(join(MM, "mix-and-match-pro.json"), "utf8")) as { skins: { name: string }[]; animations: Record<string, unknown> };
    j.skins = [...j.skins, ...j.skins.filter((k) => k.name !== "default").map((k) => ({ ...structuredClone(k), name: `${k.name}-copy` }))];
    j.animations = Object.fromEntries(Object.entries(j.animations).flatMap(([n, a]) => [[n, a], [`${n}-copy`, structuredClone(a)]]));
    writeFileSync(join(dir, "mix-and-match-pro.json"), JSON.stringify(j));
    files = [join(dir, "mix-and-match-pro.json"), ...files.filter((f) => !f.endsWith(".json"))];
  }
  out.rig = process.env.PERF_RIG ?? "mix-and-match-pro";
  const t0 = Date.now();
  await page.locator('input[type=file][accept*=".psd"]').setInputFiles(files);
  await page.locator(".message", { hasText: /Opened/ }).waitFor({ timeout: 60_000 });
  out.open = { ms: Date.now() - t0 };

  // The parts of a drag step, in the page: the edit and each change listener, then the stage's paint.
  out.dragStep = await page.evaluate(async () => {
    const s = (window as unknown as Live).boneburst.session, stage = (window as unknown as Live).boneburst.stage;
    const url = "/src/edit/bones.ts";
    const { updateBone } = await import(/* @vite-ignore */ url);
    const bone = s.doc.bones[1].name;
    s.selectBone(bone);
    const listeners: (() => void)[] = [...s.listeners];
    const names = listeners.map((f, i) => `${i}: ${(f.toString().replace(/\s+/g, " ").slice(0, 60))}`);
    const each: number[][] = listeners.map(() => []), edit: number[] = [], paint: number[] = [], total: number[] = [];
    let x = 0;
    for (let n = 0; n < 60; n++) {
      const a = performance.now();
      s.history.apply("step", updateBone(bone, { x: (x += 0.5) }));
      const b = performance.now();
      edit.push(b - a);
      // As session.changed() does, each listener timed.
      s.followReimports?.();
      listeners.forEach((f, i) => { const c = performance.now(); f(); each[i]!.push(performance.now() - c); });
      const d = performance.now();
      stage.paint();
      paint.push(performance.now() - d);
      total.push(performance.now() - a);
    }
    const st = (t: number[]) => { const q = [...t].sort((u, v) => u - v); return { med: q[Math.floor(q.length / 2)], p95: q[Math.ceil(q.length * 0.95) - 1] }; };
    return { bone, edit: st(edit), paint: st(paint), total: st(total), listeners: names.map((name, i) => ({ name, ...st(each[i]!) })) };
  });

  // A real drag on the stage, paced at 60 Hz: the frame intervals.
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const at = await page.evaluate(() => {
    const s = (window as unknown as Live).boneburst.session, stage = (window as unknown as Live).boneburst.stage;
    const p = s.pose(), i = p.bones.get(s.selectedBone) * 6;
    return { x: p.rig.world[i + 4], y: p.rig.world[i + 5], cam: stage.camera };
  });
  const sx = box.x + box.width / 2 + (at.x - at.cam.x) * at.cam.zoom, sy = box.y + box.height / 2 - (at.y - at.cam.y) * at.cam.zoom;
  out.dragFrames = stats(await frames(page, async () => {
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let n = 1; n <= 120; n++) { await page.mouse.move(sx + n, sy + n * 0.5); await page.waitForTimeout(16); }
    await page.mouse.up();
  }));

  // Playback, 3 s.
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.showAnimation(s.doc.animations[0].name); s.changed(); });
  out.playFrames = stats(await frames(page, async () => {
    await page.evaluate(() => (window as unknown as Live).boneburst.session.play?.());
    await page.keyboard.press("Space");
    await page.waitForTimeout(3000);
    await page.keyboard.press("Space");
  }));

  // Export to Unity.
  const t1 = Date.now();
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Export to Unity…/ }).click();
  await page.locator(".message", { hasText: /Exported to |failed/ }).waitFor({ timeout: 60_000 });
  out.export = { ms: Date.now() - t1, message: await page.locator(".message").textContent() };

  // Memory: 500 edits, then undone and the history let go (a new document of the same file).
  out.memory = await page.evaluate(async () => {
    const heap = () => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576;
    const gc = (window as unknown as { gc?: () => void }).gc;
    const settle = async () => { gc?.(); await new Promise((r) => setTimeout(r, 200)); gc?.(); return heap(); };
    const s = (window as unknown as Live).boneburst.session;
    const url = "/src/edit/bones.ts";
    const { updateBone } = await import(/* @vite-ignore */ url);
    const before = await settle(), bone = s.doc.bones[1].name;
    for (let n = 0; n < 500; n++) { s.history.apply(`edit ${n}`, updateBone(bone, { x: n })); s.changed(); }
    const after = await settle();
    s.goToStep(0);
    const undone = await settle();
    return { beforeMB: before, after500MB: after, undoneMB: undone, steps: s.history.entries.labels.length };
  });

  mkdirSync(join(ROOT, "node_modules", ".cache", "perf"), { recursive: true });
  writeFileSync(join(ROOT, "node_modules", ".cache", "perf", `browser-${process.env.PERF_RIG ?? "mm"}.json`), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
});
