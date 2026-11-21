import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const firstId = "22222222-2222-4222-8222-222222222222";
const secondId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const baseAgents = [
  { id: firstId, name: "Support agent", avatar: "scout", offering: "customer-service", responsibilities: ["answer-questions"], activeChannels: ["website"], lastCustomerConversationAt: "2026-10-22T12:00:00Z", draftRevision: 1, updatedAt: "2026-10-22T12:00:00Z", latestVersion: { id: versionId, number: 1, draftRevision: 1, executionKind: "business" }, hasUnpublishedChanges: false },
  { id: secondId, name: "Sales assistant", avatar: "muse", offering: null, responsibilities: [], activeChannels: [], lastCustomerConversationAt: null, draftRevision: 1, updatedAt: "2026-10-21T12:00:00Z", latestVersion: null, hasUnpublishedChanges: true },
];
const configuration = { executionKind: "business", instructions: "Help customers.", model: { provider: "openrouter", model: "test/model", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) };

async function fixture(page: Page) {
  const requestedStatuses: string[] = [];
  const profileUpdates: Array<Record<string, unknown>> = [];
  let agents = baseAgents;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const status = url.searchParams.get("status") ?? "all";
      requestedStatuses.push(status);
      data = { agents: agents.filter(agent => agent.name.toLowerCase().includes(q) && (status === "all" || (status === "setup" && !agent.latestVersion) || (status === "configured" && !!agent.latestVersion && !agent.hasUnpublishedChanges) || (status === "changes-pending" && !!agent.latestVersion && agent.hasUnpublishedChanges))), nextCursor: null };
    } else if (method === "PATCH" && (path.endsWith(`/agents/${firstId}`) || path.endsWith(`/agents/${secondId}`))) {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      profileUpdates.push(body);
      agents = agents.map(agent => path.endsWith(agent.id) ? { ...agent, name: String(body.name ?? agent.name), avatar: String(body.avatar ?? agent.avatar) } : agent);
      data = { agent: agents.find(agent => path.endsWith(agent.id)) };
    } else if (path.endsWith(`/agents/${firstId}`) || path.endsWith(`/agents/${secondId}`)) {
      const agent = agents.find(item => path.endsWith(item.id))!;
      data = { agent: { id: agent.id, name: agent.name, avatar: agent.avatar, draft: configuration, draftRevision: 1 }, versions: agent.latestVersion ? [{ id: versionId, number: 1, configuration }] : [], deployments: [] };
    } else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  return { requestedStatuses, profileUpdates };
}

test("agent cards filter, open and start setup for the selected real agent", async ({ page }) => {
  const { requestedStatuses } = await fixture(page);
  await page.goto("/app/agents");
  await expect(page.getByRole("heading", { name: "Your agents", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Support agent", exact: true })).toBeVisible();
  await page.getByLabel("Search agents").fill("Sales");
  await expect(page.getByRole("link", { name: "Open Sales assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Support agent", exact: true })).toHaveCount(0);
  await page.getByLabel("Search agents").clear();
  await page.getByLabel("Filter agents").selectOption("setup");
  await expect(page.getByRole("link", { name: "Open Sales assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Support agent", exact: true })).toHaveCount(0);
  await page.getByLabel("Filter agents").selectOption("changes-pending");
  await expect(page.getByText("No matching agents")).toBeVisible();
  expect(requestedStatuses).toContain("setup");
  expect(requestedStatuses).toContain("changes-pending");
  await page.getByLabel("Filter agents").selectOption("all");
  await page.getByRole("link", { name: "Open Support agent", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/agents/${firstId}$`));
  await page.goto("/app/agents");
  await page.getByRole("link", { name: "Set up", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/agents/${secondId}\\?section=behaviour`));
  await page.goto("/app/agents");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Create agent" })).toBeVisible();
});

test("creates a generic agent and opens its configuration", async ({ page }) => {
  await fixture(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/organizations/${org}/agents`, async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, json: { agent: { id: firstId } } });
  });
  await page.goto("/app/agents");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await dialog.getByLabel("Name", { exact: true }).fill("Research assistant");
  await dialog.getByLabel("Purpose", { exact: false }).fill("Research a topic");
  await dialog.getByLabel("Instructions", { exact: false }).fill("Summarize the evidence.");
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/agents/${firstId}\\?section=behaviour`));
  expect(submitted).toMatchObject({ name: "Research assistant", purpose: "Research a topic", instructions: "Summarize the evidence." });
  expect(submitted?.operationId).toBeTruthy();
  expect(submitted).not.toHaveProperty("offering");
});

test("shows generic capabilities and unavailable future capabilities", async ({ page }) => {
  await fixture(page);
  await page.goto(`/app/agents/${secondId}?section=capabilities`);
  await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delegation", exact: true })).toBeVisible();
  const browser = page.locator("article").filter({ has: page.getByRole("heading", { name: "Browser use" }) });
  await expect(browser.getByText("Unavailable")).toBeVisible();
  await expect(browser.getByRole("button")).toHaveCount(0);
  const knowledge = page.locator("article").filter({ has: page.getByRole("heading", { name: "Knowledge", exact: true }) });
  await knowledge.getByRole("button", { name: "Configure" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/agents/${secondId}\\?section=knowledge`));
});

test("editing an agent updates only its name and avatar", async ({ page }) => {
  const { profileUpdates } = await fixture(page);
  await page.goto("/app/agents");
  await page.getByRole("button", { name: "Edit Support agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit agent" });
  await expect(dialog.getByText("Customer service", { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Front desk");
  await dialog.getByRole("button", { name: "Shuffle", exact: true }).click();
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Agent updated", { exact: true })).toBeVisible();
  expect(profileUpdates).toHaveLength(1);
  expect(profileUpdates[0]).toMatchObject({ name: "Front desk" });
  expect(Object.keys(profileUpdates[0])).toEqual(["name", "avatar"]);
  await expect(page.getByRole("link", { name: "Open Front desk", exact: true })).toBeVisible();
});

test("agent cards support light and dark layouts at desktop, tablet and mobile sizes", async ({ page }) => {
  await fixture(page);
  for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/agents");
    await expect(page.getByRole("link", { name: "Open Support agent", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`agents-cards-${theme}-${width}.png`), fullPage: true, animations: "disabled" });
  }
});
