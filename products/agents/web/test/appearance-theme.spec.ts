import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ status: 401, json: { error: { code: "SIGN_IN_REQUIRED", message: "Sign in to continue" } } }));
});

test("default and legacy indigo use blue, while other stored accents are retained", async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("appearance-test-seeded")) { localStorage.setItem("kasitek-theme", "dark"); localStorage.removeItem("kasitek-accent"); sessionStorage.setItem("appearance-test-seeded", "1"); } });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
  await expect(page.locator("html")).toHaveCSS("--brand", "#5099F8");

  // The old default was persisted on some clients.
  await page.evaluate(() => localStorage.setItem("kasitek-accent", "indigo"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");

  await page.evaluate(() => localStorage.setItem("kasitek-accent", "emerald"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "emerald");
  await expect(page.locator("html")).toHaveCSS("--brand", "#34D399");
});

test("system appearance follows OS changes without replacing the saved preference", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kasitek-theme", "system"));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("kasitek-theme"))).toBe("system");
});
