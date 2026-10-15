import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { analyticsCatalogFixture, analyticsReportFixture, type AnalyticsReportFixtureVariant } from "./analytics-fixtures";

const storageStatePath = resolve(
  process.cwd(),
  process.env.ANALYTICS_PLAYWRIGHT_STORAGE_STATE ?? ".playwright/.auth/user.json",
);
const canRun = Boolean(
  (process.env.ANALYTICS_PLAYWRIGHT_EMAIL && process.env.ANALYTICS_PLAYWRIGHT_PASSWORD) ||
    existsSync(storageStatePath),
);

async function installReportingFixtures(page: Page, variant: AnalyticsReportFixtureVariant = "populated") {
  const queryBodies: Array<Record<string, unknown>> = [];
  const catalog = analyticsCatalogFixture();
  const report = analyticsReportFixture(variant);

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
    await expect(messagesCard).toContainText("71");

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

  test("renders one empty state when the report has no observed values", async ({ page }) => {
    await installReportingFixtures(page, "empty");
    await page.goto("/analytics", { waitUntil: "networkidle" });

    const overview = page.locator('section[aria-labelledby="workspace-analytics-title"]');
    await expect(overview.getByText("No activity yet", { exact: true })).toBeVisible();
    await expect(overview.getByText("Messages received", { exact: true })).toHaveCount(0);
    await expect(overview.getByText("Not Instrumented", { exact: true })).toHaveCount(0);
    await expect(overview.getByText(/0\/\d+ points/)).toHaveCount(0);
    await expect(overview.locator('[role="img"]')).toHaveCount(0);
  });

  test("keeps observed zero values visible", async ({ page }) => {
    await installReportingFixtures(page, "zero");
    await page.goto("/analytics", { waitUntil: "networkidle" });

    const messagesCard = page.getByRole("link", { name: /Messages received/ });
    await expect(messagesCard).toBeVisible();
    await expect(messagesCard).toContainText("0");
    await expect(page.getByText("No activity yet", { exact: true })).toHaveCount(0);
  });

  test("renders only populated metrics when a report is partial", async ({ page }) => {
    await installReportingFixtures(page, "partial");
    await page.goto("/analytics", { waitUntil: "networkidle" });

    const overview = page.locator('section[aria-labelledby="workspace-analytics-title"]');
    await expect(overview.getByRole("link", { name: /Messages received/ })).toBeVisible();
    await expect(overview.getByRole("link", { name: /Campaign deliveries/ })).toHaveCount(0);
    await expect(overview.getByText("No activity yet", { exact: true })).toHaveCount(0);
  });

  test("keeps report failures distinct from empty reports", async ({ page }) => {
    const catalog = analyticsCatalogFixture();
    await page.route("**/api/analytics/catalog", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog),
    }));
    await page.route("**/api/analytics/query", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Reporting service unavailable" }),
    }));
    await page.goto("/analytics", { waitUntil: "networkidle" });

    const overview = page.locator('section[aria-labelledby="workspace-analytics-title"]');
    await expect(overview.getByText("Analytics unavailable", { exact: true })).toBeVisible();
    await expect(overview.getByText("No activity yet", { exact: true })).toHaveCount(0);
  });

  test("keeps feature analytics empty states free of instrumentation noise", async ({ page }) => {
    await installReportingFixtures(page, "empty");
    await page.goto("/connections", { waitUntil: "networkidle" });

    const panel = page.locator('[data-slot="card"]').filter({ has: page.getByText("Connection analytics", { exact: true }) }).first();
    await expect(panel.getByText("No activity yet", { exact: true })).toBeVisible();
    await expect(panel.getByText("Not Instrumented", { exact: true })).toHaveCount(0);
    await expect(panel.getByText(/0\/\d+ points/)).toHaveCount(0);
    await expect(panel.locator('[role="img"]')).toHaveCount(0);
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
