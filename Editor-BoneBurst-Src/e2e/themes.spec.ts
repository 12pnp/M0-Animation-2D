import { expect, test } from "@playwright/test";

/** Preferences' title bar: the theme in use; a new theme is a copy with its own appearance, and the page follows each. */

test("a new theme keeps its own tree indentation, and switching themes switches what the tree shows", async ({ page }) => {
  page.on("dialog", (d) => void d.accept("Dark 2"));
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator(".app-icon").click();
  const dialog = page.locator("dialog.preferences");
  const theme = dialog.getByLabel("Theme", { exact: true });
  await expect(theme.locator("option")).toHaveText(["Follow the system", "Light", "Dark"]);
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await dialog.getByRole("button", { name: "Theme menu" }).click();
  await page.getByRole("menuitem", { name: /^New Theme/ }).click();
  await expect(theme.locator("option")).toHaveText(["Follow the system", "Light", "Dark", "Dark 2"]);
  await dialog.getByRole("button", { name: "Theme menu" }).click();
  await expect(page.getByRole("menuitem", { name: /^Delete/ })).toBeEnabled();
  await page.keyboard.press("Escape");
  await dialog.getByText("Tree", { exact: true }).first().click();
  const indent = dialog.getByLabel(/^Tree indentation/).locator("input[type=number]");
  await indent.fill("30");
  await indent.press("Enter");
  const stored = (id: string) => page.evaluate((i) => JSON.parse(localStorage.getItem("boneburst.preferences")!).themes.find((t: { id: string }) => t.id === i)?.values.treeIndent, id);
  await expect.poll(() => stored("theme-1")).toBe(30);
  expect(await stored("dark")).toBe(14);
  // Back on Dark: its own 14.
  await theme.selectOption("dark");
  await expect(indent).toHaveValue("14");
  await dialog.getByRole("button", { name: "Theme menu" }).click();
  await expect(page.getByRole("menuitem", { name: /^Delete/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await theme.selectOption("theme-1");
  await expect(indent).toHaveValue("30");
  await dialog.getByRole("button", { name: "Theme menu" }).click();
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  await expect(theme.locator("option")).toHaveText(["Follow the system", "Light", "Dark"]);
});

test("following the system: when the system's scheme changes, what is drawn and what is worked out from the theme is made again (no old colours left on the canvases)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  // The rulers' background is worked out from the panel colour when preferences are applied: it is the thing that goes stale.
  const ruler = () => page.evaluate(() => document.documentElement.style.getPropertyValue("--ruler-bg"));
  await expect.poll(ruler).toContain("45 45 45");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(ruler).toContain("255 255 255");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(ruler).toContain("45 45 45");
});
