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
  await dialog.getByRole("button", { name: "New" }).click();
  await expect(theme.locator("option")).toHaveText(["Follow the system", "Light", "Dark", "Dark 2"]);
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeEnabled();
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
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeDisabled();
  await theme.selectOption("theme-1");
  await expect(indent).toHaveValue("30");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(theme.locator("option")).toHaveText(["Follow the system", "Light", "Dark"]);
});
