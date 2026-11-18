import { expect, test } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

test("create an application and show its key once", async ({ page }, testInfo) => {
  test.setTimeout(20_000);
  let created: Record<string, unknown> | null = null;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner", permissions: ["credentials.manage"] }] } });
    if (path.endsWith("/inbox-alerts")) return route.fulfill({ json: { unread: 0, alerts: [] } });
    if (path.endsWith("/applications") && route.request().method() === "POST") {
      created = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { credential: { secret: "kat_fixture_secret" } } });
    }
    if (path.endsWith("/applications")) return route.fulfill({ json: { applications: [] } });
    if (path.endsWith("/agents")) return route.fulfill({ json: { agents: [{ id: agentId, name: "Research" }] } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/app/settings?section=applications");
  await page.getByRole("button", { name: "Create application" }).click();
  const dialog = page.getByRole("dialog", { name: "Create application" });
  await dialog.screenshot({ path: testInfo.outputPath("create-desktop.png") });
  await dialog.getByLabel("Name").fill("My product");
  await dialog.getByLabel("Research").check();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Application key" }).getByLabel("Application key")).toHaveValue("kat_fixture_secret");
  expect(created).toEqual({ name: "My product", agentIds: [agentId], scopes: ["agents:read"] });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Application key")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Create application" }).click();
  await expect(page.getByRole("dialog", { name: "Create application" })).toBeVisible();
  await page.getByRole("dialog", { name: "Create application" }).screenshot({ path: testInfo.outputPath("create-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("change which agents an application can use", async ({ page }) => {
  const appId = "33333333-3333-4333-8333-333333333333";
  const otherId = "44444444-4444-4444-8444-444444444444";
  let assigned = [agentId];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner", permissions: ["credentials.manage"] }] } });
    if (path.endsWith("/inbox-alerts")) return route.fulfill({ json: { unread: 0, alerts: [] } });
    if (path.endsWith(`/applications/${appId}/agents`) && route.request().method() === "PUT") {
      assigned = (route.request().postDataJSON() as { agentIds: string[] }).agentIds;
      return route.fulfill({ json: { id: appId, agentIds: assigned } });
    }
    if (path.endsWith("/applications")) return route.fulfill({ json: { applications: [{ id: appId, name: "Client", agentIds: assigned, revokedAt: null, credentials: [] }] } });
    if (path.endsWith("/agents")) return route.fulfill({ json: { agents: [{ id: agentId, name: "Research" }, { id: otherId, name: "Support" }] } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/app/settings?section=applications");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Application agents" });
  await dialog.getByLabel("Research").uncheck();
  await dialog.getByLabel("Support").check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Remove access" }).click();
  await expect(dialog).toBeHidden();
  expect(assigned).toEqual([otherId]);
});
