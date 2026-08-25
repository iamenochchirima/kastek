import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { analyticsCatalogFixture, analyticsReportFixture } from "./analytics-fixtures";

const storageStatePath = resolve(
  process.cwd(),
  process.env.ANALYTICS_PLAYWRIGHT_STORAGE_STATE ?? ".playwright/.auth/user.json",
);
const canRun = Boolean(
  (process.env.ANALYTICS_PLAYWRIGHT_EMAIL && process.env.ANALYTICS_PLAYWRIGHT_PASSWORD) ||
    existsSync(storageStatePath),
);

async function installReportingFixtures(page: Page) {
  const queryBodies: Array<Record<string, unknown>> = [];
  const catalog = analyticsCatalogFixture();
  const report = analyticsReportFixture();

  await page.route("**/api/analytics/catalog", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(catalog),
  }));
  await page.route("**/api/analytics/query", async (route) => {
    const postData = route.request().postData();
    if (postData) queryBodies.push(JSON.parse(postData) as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(report),
    });
  });

  return queryBodies;
}

test.describe("authenticated customer analytics", () => {
  test.beforeEach(() => {
    test.skip(!canRun, "Set analytics credentials or ANALYTICS_PLAYWRIGHT_STORAGE_STATE");
  });

  test("renders the reporting overview with representative data", async ({ page }) => {
    const queryBodies = await installReportingFixtures(page);
    await page.goto("/analytics", { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Workspace analytics", exact: true })).toBeVisible();
    await expect(page.getByText("Reporting data", { exact: true })).toBeVisible();
    const messagesCard = page.getByRole("link", { name: /Messages received/ });
    await expect(messagesCard).toBeVisible();
    await expect(messagesCard).toContainText("43");

    expect(queryBodies.length).toBeGreaterThan(0);
    expect(queryBodies.every((body) => body.include_descendants === false)).toBe(true);
    expect(queryBodies.every((body) => !("scope" in body))).toBe(true);
  });

  test("keeps the overview usable at mobile width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installReportingFixtures(page);
    await page.goto("/analytics", { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth, "analytics should not overflow horizontally on mobile").toBeLessThanOrEqual(dimensions.clientWidth + 1);
  });

  test("renders the protected local playground with empty source data", async ({ page }) => {
    await installReportingFixtures(page);
    await page.route("**/api/whatsapp/connections", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connections: [] }),
    }));
    const response = await page.goto("/analytics/playground", { waitUntil: "networkidle" });

    if (await page.getByRole("heading", { name: "Analytics playground", exact: true }).count()) {
      await expect(page.getByRole("heading", { name: "Analytics playground", exact: true })).toBeVisible();
      await expect(page.getByText("No WhatsApp connections", { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
      expect(response?.status()).toBeLessThan(400);
    }
  });
});
