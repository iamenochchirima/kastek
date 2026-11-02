import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const firstId = "22222222-2222-4222-8222-222222222222";
const secondId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const agents = [
  { id: firstId, name: "Support agent", offering: "customer-service", responsibilities: ["answer-questions"], activeChannels: ["website"], lastCustomerConversationAt: "2026-10-22T12:00:00Z", draftRevision: 1, updatedAt: "2026-10-22T12:00:00Z", latestVersion: { id: versionId, number: 1, draftRevision: 1, executionKind: "business" }, hasUnpublishedChanges: false },
  { id: secondId, name: "Sales assistant", offering: null, responsibilities: [], activeChannels: [], lastCustomerConversationAt: null, draftRevision: 1, updatedAt: "2026-10-21T12:00:00Z", latestVersion: null, hasUnpublishedChanges: true },
];
const configuration = { executionKind: "business", instructions: "Help customers.", model: { provider: "openrouter", model: "test/model", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) };

async function fixture(page: Page) {
  const requestedStatuses: string[] = [];
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const status = url.searchParams.get("status") ?? "all";
      requestedStatuses.push(status);
      data = { agents: agents.filter(agent => agent.name.toLowerCase().includes(q) && (status === "all" || (status === "setup" && !agent.latestVersion) || (status === "configured" && !!agent.latestVersion && !agent.hasUnpublishedChanges) || (status === "changes-pending" && !!agent.latestVersion && agent.hasUnpublishedChanges))), nextCursor: null };
    } else if (path.endsWith(`/agents/${firstId}`) || path.endsWith(`/agents/${secondId}`)) {
      const agent = agents.find(item => path.endsWith(item.id))!;
      data = { agent: { id: agent.id, name: agent.name, draft: configuration, draftRevision: 1 }, versions: agent.latestVersion ? [{ id: versionId, number: 1, configuration }] : [], deployments: [] };
    } else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  return requestedStatuses;
}

test("directory search, selection and actions use the selected real agent", async ({ page }) => {
  const requestedStatuses = await fixture(page);
  await page.goto("/app/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Support agent/ })).toBeVisible();
  await page.getByLabel("Search agents").fill("Sales");
  await expect(page.getByRole("button", { name: /Sales assistant/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Support agent/ })).toHaveCount(0);
  await page.getByLabel("Search agents").clear();
  await page.getByLabel("Filter agents").selectOption("setup");
  await expect(page.getByRole("button", { name: /Sales assistant/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Support agent/ })).toHaveCount(0);
  await page.getByLabel("Filter agents").selectOption("changes-pending");
  await expect(page.getByText("No matching agents")).toBeVisible();
  expect(requestedStatuses).toContain("setup");
  expect(requestedStatuses).toContain("changes-pending");
  await page.getByLabel("Filter agents").selectOption("all");
  await page.getByRole("button", { name: /Support agent/ }).click();
  await expect(page.getByRole("link", { name: "Open chat", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Configure" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/agents/${firstId}\\?section=configuration`));
  await page.goto("/app/agents");
  await page.getByRole("button", { name: /Sales assistant/ }).click();
  await page.getByRole("link", { name: "Open chat", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/agents/${secondId}$`));
  await page.goto("/app/agents");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Create agent" })).toBeVisible();
});

test("directory supports light and dark layouts at desktop, tablet and mobile sizes", async ({ page }) => {
  await fixture(page);
  for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/agents");
    await expect(page.getByRole("button", { name: /Support agent/ })).toBeVisible();
    await page.getByRole("button", { name: /Support agent/ }).click();
    await expect(page.getByRole("link", { name: "Open chat", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`agents-directory-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
  }
});
