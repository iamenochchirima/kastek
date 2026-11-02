import { test, expect } from "@playwright/test";

for (const width of [1440, 768, 390]) test(`public landing and identity entry at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/api/session", route => route.fulfill({ status: 401, json: { error: { code: "SIGN_IN_REQUIRED", message: "Sign in to continue" } } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Make roomfor better work.");
  const start = page.getByRole("link", { name: "Get started", exact: true });
  await expect(start).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "kasitek/ agents" })).toBeFocused();
  await page.screenshot({ path: `.artifacts/public-entry/public-landing-${width}.png`, fullPage: true });
  await start.click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole("link", { name: "Create account", exact: true })).toHaveAttribute("href", "/api/auth/signup?returnTo=%2Fapp");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Already have an account? Sign in" }).click();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/api/auth/login?returnTo=%2Fapp");
  await page.goto("/login?error=expired&returnTo=%2Fapp%2Ftasks");
  await expect(page.getByRole("alert")).toContainText("expired");
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/api/auth/login?returnTo=%2Fapp%2Ftasks");
  await page.screenshot({ path: `.artifacts/public-entry/public-login-${width}.png`, fullPage: true });
});

test("signed-in landing offers the current workspace without redirecting the public root", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { account: { id: "fixture", email: "fixture@example.test", displayName: "Fixture" }, organizations: [] } }));
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Open workspace", exact: true }).first()).toHaveAttribute("href", "/app/agents");
  await expect(page).toHaveURL(/\/$/);
});
