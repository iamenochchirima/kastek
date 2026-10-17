import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const rootAgent = "22222222-2222-4222-8222-222222222222";
const specialistAgent = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
const rootVersion = "55555555-5555-4555-8555-555555555555";
const specialistVersion = "66666666-6666-4666-8666-666666666666";
const secondAgent = "77777777-7777-4777-8777-777777777777";
const secondVersion = "88888888-8888-4888-8888-888888888888";
const draft = () => ({ executionKind: "business", instructions: "Research the selected sources and analyze the results.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, knowledgeIds: [sourceId], tools: [] as string[], capabilities: { delegation: { enabled: false, bindings: [] as { id: string; versionId: string; knowledgeIds: string[]; tools: string[]; maxTokens: number; maxActiveMs: number }[], maxChildren: 2, maxDepth: 1 }, sandbox: { enabled: false, profileId: "" }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } });

async function executionFixture(page: Page) {
  let configuration = draft(), admissions = 0, cancels = 0, gets = 0;
  let task: { id: string; state: string; input: string; output: string | null; conversationId: string; requestKey: string; turnSequence: number } | null = null;
  let complete = false, cleaned = false, cleanupUnknown = false;
  const agent = () => ({ id: rootAgent, name: "Research coordinator", draft: configuration, draftRevision: 1 });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : {};
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith(`/agents/${rootAgent}`)) { if (method === "PUT") configuration = body.configuration; data = { agent: agent(), versions: [{ id: rootVersion, number: 1, configuration }], deployments: [] }; }
    else if (path.endsWith("/agents")) data = { agents: [agent(), { id: specialistAgent, name: "Source researcher" }, { id: secondAgent, name: "Evidence reviewer" }] };
    else if (path.endsWith(`/agents/${specialistAgent}`)) data = { versions: [{ id: specialistVersion, number: 3, configuration: draft() }] };
    else if (path.endsWith(`/agents/${secondAgent}`)) data = { versions: [{ id: secondVersion, number: 2, configuration: draft() }] };
    else if (path.endsWith("/knowledge")) data = { knowledge: [{ id: sourceId, title: "Approved report", content: "Evidence for research.", visibility: "private" }] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else if (path.endsWith("/tasks") && method === "POST") { admissions++; task = { id: "root-task", state: "running", input: body.input, output: null, conversationId: "research-conversation", requestKey: body.requestKey, turnSequence: 1 }; data = { task }; }
    else if (path.endsWith("/root-task/cancel")) { cancels++; task = { ...task!, state: "cancel_requested" }; data = { task }; }
    else if (path.includes("/conversations/")) data = { tasks: task ? [task] : [] };
    else if (path.endsWith("/tasks/root-task")) {
      gets++;
      task = { ...task!, state: complete ? cancels ? "cancelled" : "completed" : cancels ? "cancel_requested" : "running", output: complete && !cancels ? "The report compares both specialists and includes the analysis." : null };
      data = { task, events: [], operations: [], children: [{ id: "child-one", agentName: "Source researcher", versionId: specialistVersion, versionNumber: 3, bindingId: "source", state: complete ? cancels ? "cancelled" : "completed" : "running", output: complete && !cancels ? "Approved sources agree." : null, errorCode: null, rootTaskId: "root-task", parentTaskId: "root-task" }, { id: "child-two", agentName: "Evidence reviewer", versionId: secondVersion, versionNumber: 2, bindingId: "review", state: complete ? cancels ? "cancelled" : "completed" : "accepted", output: null, errorCode: null, rootTaskId: "root-task", parentTaskId: "root-task" }], resources: [{ id: "analysis-one", taskId: "root-task", profile: "python-analysis-v1", state: complete ? "completed" : "running", cleanupState: cleaned ? "completed" : cleanupUnknown ? "uncertain" : "pending", errorCode: null, expiresAt: "2026-10-17T23:00:00Z" }], artifacts: complete && !cancels ? [{ id: "report-one", taskId: "root-task", name: "analysis.txt", contentType: "text/plain", bytes: 35, downloadPath: `/api/organizations/${org}/tasks/root-task/artifacts/report-one` }] : [] };
    } else if (path.endsWith("/artifacts/report-one")) { await route.fulfill({ contentType: "text/plain", headers: { "content-disposition": "attachment; filename=analysis.txt" }, body: "The approved analysis report." }); return; }
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  return { configuration: () => configuration, admissions: () => admissions, cancels: () => cancels, gets: () => gets, finish: () => { complete = true; }, clean: () => { cleaned = true; }, cleanupUncertain: () => { cleanupUnknown = true; } };
}

test("mock execution: pinned specialist scope, no-network analysis, related progress, cleanup and downloads", async ({ page }) => {
  const fixture = await executionFixture(page);
  await page.goto(`/app/agents/${rootAgent}`);
  await page.getByRole("checkbox", { name: "Delegate to specialists" }).check();
  await page.getByRole("combobox", { name: "Specialist 1", exact: true }).selectOption(specialistVersion);
  await page.getByRole("checkbox", { name: "Approved report", exact: true }).last().check();
  await page.getByRole("checkbox", { name: "Allow knowledge search and reading" }).check();
  await page.getByRole("button", { name: "Add specialist" }).click();
  await expect(page.getByRole("combobox", { name: "Specialist 2", exact: true })).toHaveValue(secondVersion);
  await page.getByRole("checkbox", { name: "Run Python analysis" }).check();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  expect(fixture.configuration().capabilities.delegation.bindings.map(binding => binding.versionId)).toEqual([specialistVersion, secondVersion]);
  expect(fixture.configuration().capabilities.delegation.bindings[0].knowledgeIds).toEqual([sourceId]);
  expect(fixture.configuration().capabilities.delegation.bindings[1].knowledgeIds).toEqual([]);
  expect(fixture.configuration().tools).toEqual(["agents.delegate", "sandbox.analyze"]);
  expect(fixture.configuration().capabilities.sandbox.profileId).toBe("python-analysis-v1");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`execution-config-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Research and analyze this report.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "Specialist tasks" })).toContainText("Source researcher");
  await expect(page.getByRole("region", { name: "Analysis resources" })).toContainText("Cleanup pending");
  await page.reload();
  await expect(page.getByRole("region", { name: "Specialist tasks" })).toContainText("Evidence reviewer");
  expect(fixture.admissions()).toBe(1);
  fixture.finish();
  await expect(page.getByText("The report compares both specialists and includes the analysis.", { exact: true })).toBeVisible();
  const beforeCleanup = fixture.gets();
  await expect.poll(fixture.gets).toBeGreaterThan(beforeCleanup);
  fixture.clean();
  await expect(page.getByText("Resources cleaned", { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "analysis.txt", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("analysis.txt");
  expect(await download.failure()).toBeNull();
  expect(await readFile((await download.path())!, "utf8")).toBe("The approved analysis report.");
  await page.getByText("Source researcher", { exact: true }).click();
  await expect(page.getByText("Approved sources agree.", { exact: true })).toBeVisible();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`execution-results-${width}.png`), fullPage: true });
  }
});

test("mock execution: cancellation addresses the accepted root and follows child and resource cleanup", async ({ page }) => {
  const fixture = await executionFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/agents/${rootAgent}?section=test`);
  await page.getByRole("textbox", { name: "Message" }).fill("Research with specialists.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "Specialist tasks" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel task", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Cancel task", exact: true })).toBeDisabled();
  fixture.finish();
  await expect(page.getByRole("region", { name: "Specialist tasks" })).toContainText("cancelled");
  fixture.clean();
  await expect(page.getByText("Resources cleaned", { exact: true })).toBeVisible();
  expect(fixture.admissions()).toBe(1); expect(fixture.cancels()).toBe(1);
  await expect(page.getByRole("button", { name: "Cancel task", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test("mock execution: uncertain cleanup remains visible and refresh follows the original task", async ({ page }) => {
  const fixture = await executionFixture(page);
  await page.goto(`/app/agents/${rootAgent}?section=test`);
  await page.getByRole("textbox", { name: "Message" }).fill("Analyze the approved data.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "Analysis resources" })).toBeVisible();
  fixture.finish(); fixture.cleanupUncertain();
  await expect(page.getByText("Cleanup outcome unknown", { exact: true })).toBeVisible();
  await expect(page.getByText("Resources cleaned", { exact: true })).toHaveCount(0);
  const before = fixture.gets();
  fixture.clean();
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText("Resources cleaned", { exact: true })).toBeVisible();
  expect(fixture.gets()).toBeGreaterThan(before);
  expect(fixture.admissions()).toBe(1);
});
