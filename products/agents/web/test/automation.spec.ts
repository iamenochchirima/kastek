import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", account = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333", connectionId = "44444444-4444-4444-8444-444444444444";
async function fixture(page: Page) {
  const connection = { id: connectionId, name: "Report destination", targetId: "reports", targetLabel: "Reports", resource: "daily-reports", revision: 1, state: "active", expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), createdAt: new Date().toISOString() };
  let connections = [connection], automation: Record<string, unknown> | null = null;
  let action = { id: "review-one", reviewId: "review-one", taskId: "scheduled-task", rootTaskId: "scheduled-task", connectionId, connectionRevision: 1, destination: { label: "Reports", resource: "daily-reports" }, artifactId: "report", title: "Daily report", payloadDigest: "payload-digest", reviewDigest: "exact-review-digest", state: "pending_review", expiresAt: new Date(Date.now() + 3600_000).toISOString(), preview: { name: "report.md", contentType: "text/markdown", content: "# Approved report\nTotal: 60\n<script>unsafe()</script>" }, receipt: undefined as undefined | { id: string; payloadDigest: string; acceptedAt: string } };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let loseDecision = false, staleRevision = false;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (body) requests.push({ path, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: account, email: "reviewer@example.test", displayName: "Reviewer" }, organizations: [{ id: org, name: "Research", role: "owner" }] };
    else if (path.endsWith("/connections") && method === "GET") data = { connections, targets: [{ id: "reports", label: "Reports", resource: "daily-reports" }] };
    else if (path.endsWith("/connections") && method === "POST") { connections = [...connections, { ...connection, id: "new-connection", name: String(body!.name) }]; data = { connection: connections[1] }; }
    else if (path.includes("/connections/") && method === "POST") {
      if (staleRevision) { staleRevision = false; await route.fulfill({ status: 409, json: { error: { message: "Connection revision changed. Refresh before retrying." } } }); return; }
      connections = connections.map(item => item.id === connectionId ? { ...item, revision: item.revision + 1, state: path.endsWith("/revoke") ? "revoked" : "active" } : item); data = { connection: connections[0] };
    } else if (path.endsWith("/agents")) data = { agents: [{ id: "report-agent", name: "Research report" }] };
    else if (path.endsWith("/agents/report-agent")) data = { versions: [{ id: versionId, number: 4, configuration: { executionKind: "business", capabilities: { workflows: { enabled: true, profileId: "report-delivery-v1", connectionId, reportArtifactName: "report.md" } } } }] };
    else if (path.endsWith("/automations") && method === "GET") data = { automations: automation ? [automation] : [] };
    else if (path.endsWith("/automations") && method === "POST") { automation = { ...body, id: "daily", ownerAccountId: account, revision: 1, state: "active" }; data = { automation }; }
    else if (path.endsWith("/automations/daily") && method === "PATCH") { automation = { ...automation, ...body, revision: Number(automation!.revision) + 1 }; data = { automation }; }
    else if (/\/automations\/daily\/(pause|resume|revoke)$/.test(path)) { automation = { ...automation, revision: Number(automation!.revision) + 1, state: path.endsWith("/pause") ? "paused" : path.endsWith("/resume") ? "active" : "revoked" }; data = { automation }; }
    else if (path.endsWith("/event-key")) data = { key: null, eventUrl: "/api/automation-events/daily", rotated: true };
    else if (path.endsWith("/occurrences")) data = { occurrences: [{ id: "occurrence-one", automationId: "daily", revision: 1, status: "accepted", taskId: "scheduled-task", scheduledAt: new Date().toISOString(), errorCode: null, createdAt: new Date().toISOString() }, { id: "occurrence-two", automationId: "daily", revision: 1, status: "skipped_overlap", taskId: null, scheduledAt: new Date().toISOString(), errorCode: null, createdAt: new Date().toISOString() }] };
    else if (path.endsWith("/decision")) {
      if (loseDecision) { loseDecision = false; await route.abort("failed"); return; }
      action = { ...action, state: body!.decision === "approve" ? "delivered" : "rejected", receipt: body!.decision === "approve" ? { id: "receipt-one", payloadDigest: action.payloadDigest, acceptedAt: new Date().toISOString() } : undefined }; data = { action };
    } else if (path.endsWith("/tasks/scheduled-task")) data = { task: { id: "scheduled-task", state: action.state === "delivered" || action.state === "rejected" ? "completed" : "waiting_review", output: null, conversationId: "scheduled-conversation", errorCode: null }, actions: [action], resources: [], children: [], artifacts: [{ id: "report", taskId: "scheduled-task", name: "report.md", contentType: "text/markdown", bytes: 15, downloadPath: `/api/organizations/${org}/tasks/scheduled-task/artifacts/report` }] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  return { requests, loseDecision: () => { loseDecision = true; }, staleRevision: () => { staleRevision = true; }, uncertain: () => { action = { ...action, state: "uncertain" }; }, automation: () => automation };
}

test("mock connections: keys stay write-only, stale revisions preserve input, revoke is explicit", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/app/connections");
  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Monthly reports");
  await page.getByLabel("API key", { exact: true }).fill("test-secret-value");
  await page.getByRole("dialog").getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByRole("heading", { name: "Monthly reports" })).toBeVisible();
  await expect(page.getByText("test-secret-value")).toHaveCount(0);
  await page.getByRole("button", { name: "Replace key" }).first().click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByLabel("API key", { exact: true }).fill("replacement-value");
  data.staleRevision();
  await page.getByRole("dialog").getByRole("button", { name: "Replace key" }).click();
  await expect(page.getByRole("alert")).toContainText("revision changed");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("replacement-value");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toContainText("already claimed may still finish");
  await page.getByRole("button", { name: "Revoke connection", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  expect(data.requests.find(request => request.path.endsWith("/revoke"))?.body.expectedRevision).toBe(1);
});

test("mock automation: pinned schedule, future edit, pause/resume, occurrence review and receipt", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/app/automations");
  await page.getByRole("button", { name: "Create automation", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Agent version", exact: true })).toBeFocused();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`automation-form-${width}.png`), fullPage: true });
  }
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Daily research");
  await page.getByRole("textbox", { name: "Task", exact: true }).fill("Generate the approved report.");
  await page.getByRole("combobox", { name: "Trigger", exact: true }).selectOption("interval");
  await page.getByRole("spinbutton", { name: "Interval in seconds" }).fill("3600");
  await page.getByRole("dialog").getByRole("button", { name: "Create automation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Daily research" })).toBeVisible();
  expect(data.automation()?.versionId).toBe(versionId);
  expect(data.automation()?.reviewerAccountId).toBe(account);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Accepted tasks can finish");
  await page.getByRole("button", { name: "Pause automation", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Resume automation", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Accepted tasks keep their original version");
  await page.getByRole("combobox", { name: "Trigger", exact: true }).selectOption("event");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Issue event key" }).click();
  await page.getByRole("button", { name: "Issue key", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("response was lost");
  await expect(page.getByLabel("Bearer key")).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Occurrences", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("skipped overlap");
  await page.getByRole("link", { name: "Open task", exact: true }).click();
  await expect(page.getByRole("region", { name: "Report delivery" })).toContainText("Total: 60");
  await expect(page.locator("pre")).toContainText("<script>unsafe()</script>");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`review-${width}.png`), fullPage: true });
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "Approve delivery", exact: true })).toBeVisible();
  data.loseDecision();
  await page.getByRole("button", { name: "Approve delivery", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Approve delivery", exact: true }).click();
  await expect(page.getByText("Receipt receipt-one", { exact: true })).toBeVisible();
  const decisions = data.requests.filter(request => request.path.endsWith("/decision"));
  expect(decisions).toHaveLength(2);
  expect(decisions[0].body.operationId).toBe(decisions[1].body.operationId);
  expect(decisions[1].body.expectedDigest).toBe("exact-review-digest");
});

test("mock review: reject and uncertain delivery are factual", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/app/tasks/scheduled-task");
  await page.getByRole("button", { name: "Reject delivery", exact: true }).click();
  await expect(page.getByRole("region", { name: "Report delivery" })).toContainText("rejected");
  await expect(page.getByRole("button", { name: "Approve delivery" })).toHaveCount(0);
  data.uncertain();
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("region", { name: "Report delivery" })).toContainText("Delivery outcome is unknown");
  await expect(page.getByText("Delivery confirmed", { exact: false })).toHaveCount(0);
});
