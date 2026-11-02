import { activateNativeConfiguration, nativeAgent, nativeJson, prepareNativeSpecialists } from "./native-harness-fixture";
import type { Connection } from "../src/platform/api";
import { configure } from "./workspace-fixtures";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", account = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333", connectionId = "44444444-4444-4444-8444-444444444444";
async function fixture(page: Page, separateActions = false) {
  const connection = { id: connectionId, name: "Report destination", targetId: "reports", targetLabel: "Reports", resource: "daily-reports", revision: 1, state: "active", expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), createdAt: new Date().toISOString() };
  let connections = [connection], automation: Record<string, unknown> | null = null;
  let action = { id: "review-one", reviewId: "review-one", taskId: "scheduled-task", rootTaskId: "scheduled-task", reviewerAccountId: account, connectionId, connectionRevision: 1, destination: { label: "Reports", resource: "daily-reports" }, artifactId: "report", title: "Daily report", payloadDigest: "payload-digest", reviewDigest: "exact-review-digest", state: "pending_review", expiresAt: new Date(Date.now() + 3600_000).toISOString(), preview: { name: "report.md", contentType: "text/markdown", content: "# Approved report\nTotal: 60\n<script>unsafe()</script>" }, receipt: undefined as undefined | { id: string; payloadDigest: string; acceptedAt: string } };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let loseDecision = false, staleRevision = false, canControl = true, canDownloadArtifacts = true, failOccurrence = false;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (body) requests.push({ path, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: account, email: "reviewer@example.test", displayName: "Reviewer" }, organizations: [{ id: org, name: "Research", role: "owner" }] };
    else if (path.endsWith("/connectors")) data = { connectors: [] };
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
    else if (path.endsWith("/occurrences") && failOccurrence) { failOccurrence = false; await route.fulfill({ status: 503, json: { error: { message: "Occurrences unavailable" } } }); return; }
    else if (path.endsWith("/occurrences")) data = { occurrences: [{ id: "occurrence-one", automationId: "daily", revision: 1, status: "accepted", taskId: "scheduled-task", scheduledAt: new Date().toISOString(), errorCode: null, createdAt: new Date().toISOString() }, { id: "occurrence-two", automationId: "daily", revision: 1, status: "skipped_overlap", taskId: null, scheduledAt: new Date().toISOString(), errorCode: null, createdAt: new Date().toISOString() }] };
    else if (path.endsWith("/tool-reviews")) data = { reviews: [] };
    else if (path.endsWith("/api-connections")) data = { connections: [] };
    else if (path.endsWith("/remote-connections")) data = { connections: [] };
    else if (path.endsWith("/actions")) data = { actions: [action] };
    else if (path.endsWith("/decision")) {
      if (loseDecision) { loseDecision = false; await route.abort("failed"); return; }
      action = { ...action, state: body!.decision === "approve" ? "delivered" : "rejected", receipt: body!.decision === "approve" ? { id: "receipt-one", payloadDigest: action.payloadDigest, acceptedAt: new Date().toISOString() } : undefined }; data = { action };
    } else if (path.endsWith("/tasks/scheduled-task")) data = { canControl, canDownloadArtifacts, task: { id: "scheduled-task", state: action.state === "delivered" || action.state === "rejected" ? "completed" : "waiting_review", output: null, conversationId: "scheduled-conversation", errorCode: null }, operations: [{ name: "report.prepare", state: "completed" }], ...(separateActions ? {} : { actions: [action] }), resources: [], children: [], artifacts: [{ id: "report", taskId: "scheduled-task", name: "report.md", contentType: "text/markdown", bytes: 15, downloadPath: `/api/organizations/${org}/tasks/scheduled-task/artifacts/report` }] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  return { requests, failNextOccurrence: () => { failOccurrence = true; }, loseDecision: () => { loseDecision = true; }, staleRevision: () => { staleRevision = true; }, uncertain: () => { action = { ...action, state: "uncertain" }; }, automation: () => automation, reviewer: (id: string) => { action = { ...action, reviewerAccountId: id }; canControl = false; canDownloadArtifacts = false; }, expire: () => { action = { ...action, expiresAt: new Date(Date.now() - 60_000).toISOString() }; } };
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
  await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toBeFocused();
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
  await expect(page.getByRole("dialog")).toContainText("Accepted tasks keep their original configuration");
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
  const data = await fixture(page, true);
  await page.goto("/app/tasks/scheduled-task");
  await page.getByRole("button", { name: "Reject delivery", exact: true }).click();
  await expect(page.getByRole("region", { name: "Report delivery" })).toContainText("rejected");
  await expect(page.getByRole("button", { name: "Approve delivery" })).toHaveCount(0);
  data.uncertain();
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("region", { name: "Report delivery" })).toContainText("Delivery outcome is unknown");
  await expect(page.getByText("Delivery confirmed", { exact: false })).toHaveCount(0);
});

test("mock review: only the assigned reviewer can decide before expiry", async ({ page }) => {
  const data = await fixture(page);
  data.reviewer("another-reviewer");
  await page.goto("/app/tasks/scheduled-task");
  await expect(page.getByRole("button", { name: "Approve delivery", exact: true })).toBeDisabled();
  await expect(page.getByText("Awaiting the assigned reviewer.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel task", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "report.md", exact: true })).toHaveCount(0);
  data.reviewer(account); data.expire();
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText("This review has expired.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve delivery", exact: true })).toBeDisabled();
  expect(data.requests.filter(request => request.path.endsWith("/decision"))).toHaveLength(0);
});

test("live automation: scheduled report survives review and delivery interruptions", async ({ page, context, baseURL }) => {
  test.skip(process.env.AGENTS_AUTOMATION_LIVE !== "1", "Requires isolated actual service fixture");
  const github=process.env.AGENTS_GITHUB_JOURNEY==="1",stash=process.env.AGENTS_STASH_JOURNEY==="1",publicRepository=process.env.AGENTS_PUBLIC_REPOSITORY_JOURNEY==="1",connected=github||stash||publicRepository;
  test.setTimeout(connected?600_000:360_000);
  const cookie = process.env.AGENTS_BROWSER_SESSION_COOKIE!, key = process.env.AGENTS_DELIVERY_FIXTURE_KEY!;
  await context.addCookies([{ name: "agents_session", value: cookie, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
  await page.goto(process.env.AGENTS_ADVANCED_AGENT_PATH!);
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Add connection", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Local acceptance receiver");
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("report-delivery-v1");
  await page.getByLabel("API key", { exact: true }).fill(key);
  await page.getByRole("dialog").getByRole("button", { name: "Add connection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local acceptance receiver" })).toBeVisible();
  await page.goto(process.env.AGENTS_ADVANCED_AGENT_PATH!);
  const versions = process.env.AGENTS_ADVANCED_SPECIALIST_VERSIONS!.split(",");
  const sourceTitles: string[] = JSON.parse(process.env.AGENTS_ADVANCED_SOURCE_TITLES ?? JSON.stringify([process.env.AGENTS_ADVANCED_SOURCE_TITLE, process.env.AGENTS_ADVANCED_SOURCE_TITLE]));
  const operations: string[][] = JSON.parse(process.env.AGENTS_ADVANCED_CONNECTED_OPERATIONS ?? "[]");
  const selected = await nativeAgent(page), available = await nativeJson<{ connections: Connection[] }>(page, `${selected.base}/connections`);
  const destination = available.connections.find(item => item.name === "Local acceptance receiver" && item.state === "active");
  expect(destination, "The fixture must use its actual approved report receiver").toBeDefined();
  await prepareNativeSpecialists(page, { versionIds: versions, sourceTitles, operations, knowledge: !publicRepository, maxTokens: connected ? publicRepository ? 12000 : 10000 : 8000,
    workflow: { enabled: true, profileId: "report-delivery-v1", connectionId: destination!.id, reportArtifactName: "report.json", title: "Verified dataset report" } });
  await page.reload(); await configure(page);
  const pinned = (await activateNativeConfiguration(page)).snapshot.id;
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await page.getByRole("button", { name: "Create automation", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Scheduled dataset report");
  await page.getByRole("combobox", { name: "Agent", exact: true }).selectOption(pinned);
  await page.getByRole("textbox", { name: "Task", exact: true }).fill(process.env.AGENTS_ADVANCED_PROMPT!);
  const scheduled = new Date(Date.now() + 5000);
  await page.getByLabel(/^Run at/).fill(new Date(scheduled.getTime() - scheduled.getTimezoneOffset() * 60_000).toISOString().slice(0, 19));
  const createdResponse = page.waitForResponse(response => /\/automations$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "Create automation", exact: true }).click();
  const created = await createdResponse;
  expect(created.ok(), await created.text()).toBe(true);
  await expect(page.getByRole("heading", { name: "Scheduled dataset report", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Occurrences", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open task", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: "Open task", exact: true }).click();
  const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
  if (connected) {
    const taskUrl = page.url();
    const activeSession = await (await page.request.get("/api/session")).json();
    const activeTaskPath = `/api/organizations/${activeSession.organizations[0].id}/tasks/${taskId}`;
    const activeTask = await (await page.request.get(activeTaskPath)).json();
    expect(activeTask.task.id).toBe(taskId);
    expect(["completed", "incomplete", "refused", "failed", "cancelled", "uncertain"]).not.toContain(activeTask.task.state);
    let navigationAdmissions = 0;
    const countAdmission = (request: { method(): string; url(): string }) => { if (request.method() === "POST" && /\/tasks$/u.test(new URL(request.url()).pathname)) navigationAdmissions++; };
    page.on("request", countAdmission);
    const checkpoint = page.request.post(`${process.env.AGENTS_BROWSER_WIDGET_ORIGIN}/fixture/restart-connected`, { timeout: 240_000 });
    await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Agents", exact: true }).click();
    await page.getByRole("navigation", { name: "Agent directory", exact: true }).getByRole("link").filter({ hasText: "Dataset researcher" }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Tasks", exact: true }).click();
    await page.locator(`.task-list-row a[href="/app/tasks/${taskId}"]`).first().click();
    await expect(page).toHaveURL(taskUrl);
    expect((await checkpoint).ok()).toBe(true);
    const returnedTask = await (await page.request.get(activeTaskPath)).json();
    expect(returnedTask.task.id).toBe(taskId);
    expect(navigationAdmissions).toBe(0);
    page.off("request", countAdmission);
    await writeFile(test.info().outputPath("active-navigation-proof.json"), JSON.stringify({ rootTaskId: taskId, originalState: activeTask.task.state, otherAgentOpened: true, returnedThroughTasks: true, additionalAdmissions: navigationAdmissions }, null, 2));
  }
  await expect(page.getByRole("button", { name: "Approve delivery", exact: true })).toBeVisible({ timeout: 180_000 });
  const review = page.getByRole("region", { name: "Report delivery" });
  await expect(review).toContainText("Verified dataset report");
  await expect(review).toContainText("Browser report receiver · browser-report");
  const reviewedBytes = await review.locator("pre").textContent();
  const report = JSON.parse(reviewedBytes!);
  expect(report.values).toEqual([10, 20, 30]); expect(report.sum).toBe(60); expect(report.count).toBe(3);
  expect(report.citations).toEqual(expect.arrayContaining([expect.stringMatching(/^\[E[a-f0-9]{32}\]$/)]));
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "report.json", exact: true }).click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  const downloadedBytes = await readFile((await download.path())!);
  expect(downloadedBytes.toString("utf8")).toBe(reviewedBytes);
  await writeFile(test.info().outputPath("verified-scheduled-report.json"), downloadedBytes);
  await expect(page.getByRole("region", { name: "Analysis resources" })).toContainText("Resources cleaned", { timeout: 60_000 });
  const before = await (await page.request.get(`/api/session`)).json() as { organizations: { id: string }[] };
  const taskPath = `/api/organizations/${before.organizations[0].id}/tasks/${taskId}`;
  const originalDetail = await (await page.request.get(taskPath)).json();
  originalDetail.actions ??= (await (await page.request.get(`${taskPath}/actions`)).json()).actions;
  expect(originalDetail.children).toHaveLength(2);
  expect(originalDetail.children.every((child: { state: string }) => child.state === "completed")).toBe(true);
  expect((await page.request.post(`${process.env.AGENTS_BROWSER_WIDGET_ORIGIN}/fixture/restart-review`)).ok()).toBe(true);
  await page.reload();
  await expect(review.locator("pre")).toHaveText(reviewedBytes!);
  await expect(page.getByRole("button", { name: "Approve delivery", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Approve delivery", exact: true }).click();
  expect((await page.request.post(`${process.env.AGENTS_BROWSER_WIDGET_ORIGIN}/fixture/interrupt-delivery`, { timeout: 90_000 })).ok()).toBe(true);
  await page.reload();
  await expect(review.getByText(/^Receipt /)).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('section.management-page > div.space-y-2 > span.task-state[data-state="completed"]')).toBeVisible({ timeout: 90_000 });
  const finalDetail = await (await page.request.get(taskPath)).json();
  finalDetail.actions ??= (await (await page.request.get(`${taskPath}/actions`)).json()).actions;
  expect(finalDetail.task.state).toBe("completed");
  expect(finalDetail.actions).toHaveLength(1);
  expect(finalDetail.actions[0].state).toBe("delivered");
  expect(finalDetail.actions[0].reviewDigest).toBe(originalDetail.actions[0].reviewDigest);
  expect(finalDetail.actions[0].artifactId).toBe(originalDetail.actions[0].artifactId);
  expect(finalDetail.actions[0].citedPassages.length).toBeGreaterThan(0);
  if(stash){
    const generatedAt=Date.parse(report.generatedAt);
    expect(Number.isFinite(generatedAt)).toBe(true);expect(report.generatedAt).toMatch(/(?:Z|\+00:00)$/);
    expect(generatedAt).toBeGreaterThanOrEqual(Date.parse(originalDetail.task.createdAt));expect(generatedAt).toBeLessThanOrEqual(Date.now()+5000);
    expect(report.gaps).toEqual([]);expect(report.provider_findings).toHaveLength(2);
    for(const operation of ["get_item","read_project_document"]){
      const finding=report.provider_findings.find((item:{operation:string})=>item.operation===operation);
      expect(finding).toBeDefined();expect(finding.itemId).toBe(process.env.AGENTS_STASH_JOURNEY_ITEM_ID);
      expect(finding.observedFact.length).toBeGreaterThanOrEqual(16);expect(finding.observedFact.length).toBeLessThanOrEqual(200);
      expect(finding.observedFact).toContain(process.env.AGENTS_STASH_JOURNEY_EXPECT!);expect(report.citations).toContain(finding.sourceLabel);
      for(const action of [originalDetail.actions[0],finalDetail.actions[0]]){
        const passage=action.citedPassages.find((item:{label:string})=>`[${item.label}]`===finding.sourceLabel);
        expect(passage).toBeDefined();expect(passage.text).toContain(finding.observedFact);
      }
    }
  }
  if(github||publicRepository){
    const generatedAt=Date.parse(report.generatedAt);
    expect(Number.isFinite(generatedAt)).toBe(true);expect(report.generatedAt).toMatch(/(?:Z|\+00:00)$/);
    expect(generatedAt).toBeGreaterThanOrEqual(Date.parse(originalDetail.task.createdAt));expect(generatedAt).toBeLessThanOrEqual(Date.now()+5000);
    expect(report.gaps).toEqual([]);
    expect(report.provider_findings).toHaveLength(2);
    for(const transport of ["native_http","mcp_http"]){
      const finding=report.provider_findings.find((item:{transport:string})=>item.transport===transport);
      expect(finding.repository).toBe(publicRepository?process.env.AGENTS_PUBLIC_JOURNEY_REPOSITORY:process.env.AGENTS_GITHUB_JOURNEY_REPOSITORY);
      expect(finding.observedFact.length).toBeGreaterThanOrEqual(16);expect(finding.observedFact.length).toBeLessThanOrEqual(200);
      if(publicRepository)expect(finding.observedFact).toContain(transport==="native_http"?process.env.AGENTS_PUBLIC_JOURNEY_NATIVE_EXPECT!:process.env.AGENTS_PUBLIC_JOURNEY_MCP_EXPECT!);
      else expect(finding.observedFact.toLowerCase()).toContain(process.env.AGENTS_GITHUB_JOURNEY_EXPECT!.toLowerCase());
      expect(report.citations).toContain(finding.sourceLabel);
      for(const action of [originalDetail.actions[0],finalDetail.actions[0]]){
        const passage=action.citedPassages.find((item:{label:string})=>`[${item.label}]`===finding.sourceLabel);
        expect(passage).toBeDefined();expect(passage.text).toContain(finding.observedFact);
      }
    }
  }
  expect(finalDetail.children.map((child: { id: string }) => child.id).sort()).toEqual(originalDetail.children.map((child: { id: string }) => child.id).sort());
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`scheduled-delivery-${width}.png`), fullPage: true });
  }
  console.log(`Scheduled root ${taskId}; original report reviewed after worker restart; interrupted sender recovered receipt ${finalDetail.actions[0].receipt.id}`);
});


test("mock automation: new schedules use the latest saved agent configuration without version choices", async ({ page }) => {
  await fixture(page);
  const configuration = { executionKind: "business", capabilities: { workflows: { enabled: true, profileId: "report-delivery-v1", connectionId, reportArtifactName: "report.md" } } };
  await page.route("**/agents/report-agent", route => route.fulfill({ json: { versions: [{ id: versionId, number: 4, configuration }, { id: "latest-snapshot", number: 5, configuration }] } }));
  await page.goto("/app/automations"); await page.getByRole("button", { name: "Create automation", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Agent", exact: true });
  await expect(select).toHaveValue("latest-snapshot"); await expect(select.getByRole("option", { name: "Research report", exact: true })).toHaveCount(1);
  await expect(page.getByText(/Version [0-9]/)).toHaveCount(0);
});

test("mock automation: an older workflow configuration cannot silently replace a disabled current workflow", async ({ page }) => {
  await fixture(page);
  await page.route("**/agents/report-agent", route => route.fulfill({ json: { versions: [{ id: versionId, number: 4, configuration: { executionKind: "business", capabilities: { workflows: { enabled: true } } } }, { id: "latest-snapshot", number: 5, configuration: { executionKind: "business", capabilities: { workflows: { enabled: false } } } }] } }));
  await page.goto("/app/automations"); await expect(page.getByRole("button", { name: "Create automation", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Configure agent", exact: true })).toBeVisible();
});

test("automation form shows field errors inline and keeps input", async ({ page }) => {
  const data = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/automations");
  await page.getByRole("button", { name: "Create automation", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  const task = dialog.getByRole("textbox", { name: "Task", exact: true });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await task.fill("Keep this request");
  await dialog.getByRole("button", { name: "Create automation", exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAttribute("aria-describedby", "automation-error-name");
  await expect(dialog.locator("#automation-error-name")).toBeVisible();
  await expect(task).toHaveValue("Keep this request");
  expect(data.requests.filter(request => request.path.endsWith("/automations"))).toHaveLength(0);
  await name.fill("Daily report");
  await expect(dialog.locator("#automation-error-name")).toHaveCount(0);
  await expect(task).toHaveValue("Keep this request");
});

test("automation dialog visual states in light and dark", async ({ page }) => {
  await fixture(page);
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/automations");
    await page.getByRole("button", { name: "Create automation", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Create automation", exact: true }).click();
    await expect(dialog.locator("#automation-error-name")).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`automation-error-${theme}-${width}.png`), animations: "disabled" });
  }
});


test("automation occurrence load errors stay in the dialog and can retry", async ({ page }) => {
  const data = await fixture(page);
  await page.goto("/app/automations");
  await page.getByRole("button", { name: "Create automation", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Daily report");
  await form.getByRole("textbox", { name: "Task", exact: true }).fill("Prepare report");
  await form.getByRole("button", { name: "Create automation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Daily report" })).toBeVisible();
  data.failNextOccurrence();
  await page.getByRole("button", { name: "Occurrences", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Occurrences unavailable");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByText("skipped overlap")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("tablet automation list and occurrence recovery in both themes", async ({ page }) => {
  const data = await fixture(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/app/automations");
  await page.getByRole("button", { name: "Create automation", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Daily research");
  await form.getByRole("textbox", { name: "Task", exact: true }).fill("Prepare the daily report");
  await form.getByRole("button", { name: "Create automation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Daily research" })).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`automation-list-${theme}-768.png`), animations: "disabled" });
    data.failNextOccurrence();
    await page.getByRole("button", { name: "Occurrences", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("Occurrences unavailable");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`automation-error-${theme}-768.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(dialog.getByText("skipped overlap")).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`automation-occurrences-${theme}-768.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
  }
});
