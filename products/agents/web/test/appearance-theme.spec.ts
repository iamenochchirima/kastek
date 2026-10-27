import { expect, test } from "@playwright/test";

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
