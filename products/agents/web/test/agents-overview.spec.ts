import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const session = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
const dashboard = {
  period: { days: 7 },
  counts: { conversations: 21, needsAttention: 3, enquiries: 8, activeAgents: 2 },
  conversationActivity: [{ date: "2026-10-21", count: 9 }, { date: "2026-10-22", count: 12 }],
  needsAttention: [{ id: "attention-1", agentName: "Support agent", channel: "website", updatedAt: "2026-10-22T12:00:00Z" }],
  recentActivity: [{ id: "activity-1", agentName: "Support agent", channel: "whatsapp", state: "resolved", updatedAt: "2026-10-22T12:00:00Z" }],
  channels: [{ channel: "website", count: 9 }, { channel: "whatsapp", count: 12 }],
};

async function mockWorkspace(page: Page, overview: (route: import("@playwright/test").Route) => Promise<void>) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: session });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    if (path.endsWith("/overview")) return overview(route);
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
}

test("overview displays workspace data across themes and screen sizes", async ({ page }) => {
  await mockWorkspace(page, async route => { await route.fulfill({ json: dashboard }); });
  for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/overview");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Conversation activity", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent activity", exact: true })).toBeVisible();
    await expect(page.getByText("21", { exact: true })).toBeVisible();
    await expect(page.getByText("8", { exact: true })).toBeVisible();
    await expect(page.getByText("Support agent").first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`overview-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
  }
});

test("overview reports failures and retries without presenting fabricated counts", async ({ page }) => {
  let requests = 0, available = false;
  await mockWorkspace(page, async route => {
    requests++;
    if (!available) await route.fulfill({ status: 503, json: { error: { message: "Overview unavailable" } } });
    else await route.fulfill({ json: dashboard });
  });
  await page.goto("/app/overview");
  await expect(page.getByText("Overview unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("21", { exact: true })).toHaveCount(0);
  available = true;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("21", { exact: true })).toBeVisible();
  expect(requests).toBeGreaterThanOrEqual(2);
});

test("overview shows loading and updates the requested period", async ({ page }) => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const requested: string[] = [];
  await mockWorkspace(page, async route => {
    const days = new URL(route.request().url()).searchParams.get("days") ?? "";
    requested.push(days);
    if (days === "7") await waiting;
    await route.fulfill({ json: { ...dashboard, period: { days: Number(days) }, counts: { ...dashboard.counts, conversations: days === "30" ? 34 : 21 } } });
  });
  await page.goto("/app/overview");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByLabel("Loading", { exact: true })).toBeVisible();
  await expect(page.getByText("21", { exact: true })).toHaveCount(0);
  release?.();
  await expect(page.getByText("21", { exact: true })).toBeVisible();
  await page.getByLabel("Time period").selectOption("30");
  await expect(page.getByText("34", { exact: true })).toBeVisible();
  expect(requested[0]).toBe("7");
  expect(requested.at(-1)).toBe("30");
});

test("sidebar collapse persists while navigation and mobile menu remain usable", async ({ page }) => {
  await mockWorkspace(page, async route => { await route.fulfill({ json: dashboard }); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/overview");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("link", { name: "Customers", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Customers", exact: true })).toBeVisible();
});
