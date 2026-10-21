import { activateNativeConfiguration, nativeAgent, prepareNativeSpecialists } from "./native-harness-fixture";
import { agentSummary, conversationSummaries } from "./workspace-fixtures";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const rootAgent = "22222222-2222-4222-8222-222222222222";
const specialistAgent = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
const rootVersion = "55555555-5555-4555-8555-555555555555";
const specialistVersion = "66666666-6666-4666-8666-666666666666";
const secondAgent = "77777777-7777-4777-8777-777777777777";
const secondVersion = "88888888-8888-4888-8888-888888888888";
const draft = () => ({ executionKind: "business", instructions: "Research the selected sources and analyze the results.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, sourceRevisionIds: [sourceId], connectedToolBindingIds: [], retrievalProfile: { kind: "lexical-v1" }, tools: [] as string[], capabilities: { delegation: { enabled: false, bindings: [] as { id: string; versionId: string; sourceRevisionIds: string[]; connectedToolBindingIds: string[]; tools: string[]; maxTokens: number; maxActiveMs: number }[], maxChildren: 2, maxDepth: 1 }, sandbox: { enabled: false, profileId: "" }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } });

async function executionFixture(page: Page) {
  let configuration = { ...draft(), program: { id: "tool-directed", version: "1" }, tools: ["agents.delegate", "sandbox.analyze"], capabilities: { ...draft().capabilities, delegation: { enabled: true, bindings: [specialistVersion, secondVersion].map((versionId, index) => ({ id: `specialist-${index}`, versionId, sourceRevisionIds: index === 0 ? [sourceId] : [], connectedToolBindingIds: [], tools: ["knowledge.search", "knowledge.read"], maxTokens: 8000, maxActiveMs: 240000 })), maxChildren: 2, maxDepth: 1 }, sandbox: { enabled: true, profileId: "python-analysis-v1" } } }, admissions = 0, cancels = 0, gets = 0, continuations = 0;
  let task: { id: string; state: string; input: string; output: string | null; conversationId: string; requestKey: string; turnSequence: number } | null = null;
  let complete = false, cleaned = false, cleanupUnknown = false, childAuthorityExpired = false;
  const agent = () => ({ id: rootAgent, name: "Research coordinator", draft: configuration, draftRevision: 1 });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : {};
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith(`/agents/${rootAgent}`)) { if (method === "PUT") configuration = body.configuration; data = { agent: agent(), versions: [{ id: rootVersion, number: 1, configuration }], deployments: [] }; }
    else if (path.endsWith("/agents/summaries")) data = {agents:[agentSummary(agent(),{id:rootVersion,number:1})],nextCursor:null};
    else if (path.endsWith("/conversations")) data = {conversations:task?conversationSummaries([task],agent(),{id:rootVersion,number:1}):[],nextCursor:null};
    else if (path.endsWith("/agents")) data = { agents: [agent(), { id: specialistAgent, name: "Source researcher" }, { id: secondAgent, name: "Evidence reviewer" }] };
    else if (path.endsWith(`/agents/${specialistAgent}`)) data = { versions: [{ id: specialistVersion, number: 3, configuration: { ...draft(), tools: ["knowledge.search", "knowledge.read"] } }] };
    else if (path.endsWith(`/agents/${secondAgent}`)) data = { versions: [{ id: secondVersion, number: 2, configuration: { ...draft(), tools: ["knowledge.search", "knowledge.read"] } }] };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [{ id: sourceId, title: "Approved report", state: "active", visibility: "private", revisions: [{ id: sourceId, revision: 1, state: "approved" }] }], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else if (path.endsWith("/tasks") && method === "POST") { admissions++; task = { id: "root-task", state: "running", input: body.input, output: null, conversationId: "research-conversation", requestKey: body.requestKey, turnSequence: 1 }; data = { task }; }
    else if (path.endsWith("/root-task/continue")) { continuations++; childAuthorityExpired = false; data = { task }; }
    else if (path.endsWith("/root-task/cancel")) { cancels++; task = { ...task!, state: "cancel_requested" }; data = { task }; }
    else if (path.includes("/conversations/")) data = { tasks: task ? [{...task,versionId:rootVersion}] : [],nextCursor:null,conversation:{versionId:rootVersion,versionNumber:1} };
    else if (path.endsWith("/tasks/root-task")) {
      gets++;
      task = { ...task!, state: complete ? cancels ? "cancelled" : "completed" : cancels ? "cancel_requested" : childAuthorityExpired ? "waiting_children" : "running", output: complete && !cancels ? "The report compares both specialists and includes the analysis." : null };
      data = { task, events: [], operations: [], children: [{ id: "child-one", agentName: "Source researcher", versionId: specialistVersion, versionNumber: 3, bindingId: "source", state: complete ? cancels ? "cancelled" : "completed" : "running", output: complete && !cancels ? "Approved sources agree." : null, errorCode: null, rootTaskId: "root-task", parentTaskId: "root-task" }, { id: "child-two", agentName: "Evidence reviewer", versionId: secondVersion, versionNumber: 2, bindingId: "review", state: complete ? cancels ? "cancelled" : "completed" : childAuthorityExpired ? "waiting_authority" : "accepted", output: null, errorCode: null, rootTaskId: "root-task", parentTaskId: "root-task" }], resources: [{ id: "analysis-one", taskId: "root-task", profile: "python-analysis-v1", state: complete ? "completed" : "running", cleanupState: cleaned ? "completed" : cleanupUnknown ? "uncertain" : "pending", errorCode: null, expiresAt: "2026-10-17T23:00:00Z" }], artifacts: complete && !cancels ? [{ id: "report-one", taskId: "root-task", name: "analysis.txt", contentType: "text/plain", bytes: 35, downloadPath: `/api/organizations/${org}/tasks/root-task/artifacts/report-one` }] : [] };
    } else if (path.endsWith("/artifacts/report-one")) { await route.fulfill({ contentType: "text/plain", headers: { "content-disposition": "attachment; filename=analysis.txt" }, body: "The approved analysis report." }); return; }
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  return { configuration: () => configuration, admissions: () => admissions, cancels: () => cancels, gets: () => gets, finish: () => { complete = true; }, clean: () => { cleaned = true; }, cleanupUncertain: () => { cleanupUnknown = true; }, expireChildAuthority: () => { childAuthorityExpired = true; }, continuations: () => continuations };
}

test("mock execution: pinned specialist scope, no-network analysis, related progress, cleanup and downloads", async ({ page }) => {
  const fixture = await executionFixture(page);
  await page.goto(`/app/agents/${rootAgent}`);
  expect(fixture.configuration().capabilities.delegation.bindings.map(binding => binding.versionId)).toEqual([specialistVersion, secondVersion]);
  expect(fixture.configuration().capabilities.delegation.bindings[0].sourceRevisionIds).toEqual([sourceId]);
  expect(fixture.configuration().capabilities.delegation.bindings[1].sourceRevisionIds).toEqual([]);
  expect(fixture.configuration().tools).toEqual(["agents.delegate", "sandbox.analyze"]);
  await page.getByRole("textbox", { name: "Message" }).fill("Research and analyze this report.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
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
  await page.getByRole("button", { name: "Send message", exact: true }).click();
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
  await page.getByRole("button", { name: "Send message", exact: true }).click();
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

test("live execution: accepted root reconnects to specialists, isolated analysis, cleaned resources and real artifacts", async ({ page, context, baseURL }) => {
  const cookie = process.env.AGENTS_BROWSER_SESSION_COOKIE;
  const agentPath = process.env.AGENTS_ADVANCED_AGENT_PATH;
  const prompt = process.env.AGENTS_ADVANCED_PROMPT;
  test.skip(process.env.AGENTS_ADVANCED_LIVE !== "1" || !cookie || !agentPath || !prompt, "Requires the approved integrated specialist/analysis fixture and its explicit task prompt.");
  test.setTimeout(360_000);
  const separator = cookie!.indexOf("=");
  await context.addCookies([{ name: separator > 0 ? cookie!.slice(0, separator) : new URL(baseURL!).protocol === "https:" ? "__Host-agents_session" : "agents_session", value: separator > 0 ? cookie!.slice(separator + 1) : cookie!, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
  await page.goto(agentPath!);
  const pinnedVersions = process.env.AGENTS_ADVANCED_SPECIALIST_VERSIONS?.split(",");
  if (pinnedVersions?.length === 2) {
    await prepareNativeSpecialists(page, { versionIds: pinnedVersions, sourceTitles: process.env.AGENTS_ADVANCED_SOURCE_TITLE ? [process.env.AGENTS_ADVANCED_SOURCE_TITLE, process.env.AGENTS_ADVANCED_SOURCE_TITLE] : undefined });
    await page.reload();
  }
  const configured = await nativeAgent(page);
  expect(configured.agent.draft.capabilities.delegation.enabled).toBe(true);
  expect(configured.agent.draft.capabilities.sandbox.enabled).toBe(true);
  if (configured.agent.draft.capabilities.delegation.enabled) expect(configured.agent.draft.capabilities.delegation.bindings).toHaveLength(2);
  if (pinnedVersions?.length === 2) { await activateNativeConfiguration(page); }
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Message" }).fill(prompt!);
  const acceptedResponse = page.waitForResponse(response => /\/tasks$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const response = await acceptedResponse;
  expect(response.ok()).toBe(true);
  const accepted = (await response.json()).task as { id: string };
  const taskPath = `${new URL(response.url()).pathname}/${encodeURIComponent(accepted.id)}`;
  let repeatedAdmission = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/tasks$/.test(new URL(request.url()).pathname)) repeatedAdmission++; });
  await page.reload();
  await expect(page.getByRole("region", { name: "Specialist tasks" })).toBeVisible({ timeout: 180_000 });
  await expect.poll(async () => { const response = await page.request.get(taskPath); expect(response.ok()).toBe(true); return (await response.json()).task.state; }, { timeout: 180_000 }).toMatch(/^(completed|incomplete|refused|failed|cancelled|uncertain)$/);
  type Detail = { task: { id: string; state: string; output: string | null; errorCode?: string | null }; children: { id: string; state: string; rootTaskId: string }[]; resources: { id: string; cleanupState: string; profile: string }[]; artifacts: { id: string; name: string; bytes: number; downloadPath: string }[] };
  const settledResponse = await page.request.get(taskPath);
  expect(settledResponse.ok()).toBe(true);
  let detail = await settledResponse.json() as Detail;
  expect(detail.task.state, `Root outcome ${detail.task.errorCode ?? detail.task.state}; child outcomes ${detail.children.map(child => child.state).join(", ")}`).toBe("completed");
  await expect.poll(async () => {
    const current = await page.request.get(taskPath); expect(current.ok()).toBe(true); detail = await current.json() as Detail;
    return detail.resources.length > 0 && detail.resources.every(resource => resource.cleanupState === "completed");
  }, { timeout: 120_000, intervals: [1000, 2000, 5000] }).toBe(true);
  expect(detail!.task.id).toBe(accepted.id);
  expect(detail!.task.state).toBe("completed");
  expect(detail!.children).toHaveLength(2);
  expect(detail!.children.every(child => child.state === "completed" && child.rootTaskId === accepted.id)).toBe(true);
  expect(detail!.resources.every(resource => resource.profile === "python-analysis-v1")).toBe(true);
  expect(detail!.artifacts.length).toBeGreaterThan(0);
  if (process.env.AGENTS_ADVANCED_EXPECT) expect(detail!.task.output).toMatch(new RegExp(process.env.AGENTS_ADVANCED_EXPECT, "i"));
  await expect(page.getByRole("region", { name: "Analysis resources" })).toContainText("Resources cleaned", { timeout: 10_000 });
  const artifact = process.env.AGENTS_ADVANCED_DATASET_CHECK === "1" ? detail!.artifacts.find(item => item.name === "report.json")! : detail!.artifacts[0];
  expect(artifact, "Analysis must export the requested report").toBeDefined();
  expect(artifact.downloadPath).toMatch(/^\/api\/organizations\//);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: artifact.name, exact: true }).first().click();
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  const bytes = await readFile((await download.path())!);
  expect(bytes.byteLength).toBe(artifact.bytes);
  if (process.env.AGENTS_ADVANCED_FILE_CONTAINS) expect(bytes.toString("utf8")).toContain(process.env.AGENTS_ADVANCED_FILE_CONTAINS);
  if (process.env.AGENTS_ADVANCED_DATASET_CHECK === "1") {
    const report = JSON.parse(bytes.toString("utf8")) as { values: number[]; sum: number; count: number };
    const expected = [10, 20, 30];
    expect(report.values).toEqual(expected);
    expect(report.sum).toBe(expected.reduce((sum, value) => sum + value, 0));
    expect(report.count).toBe(expected.length);
    await writeFile(test.info().outputPath("verified-report.json"), bytes);
  }
  expect(repeatedAdmission).toBe(0);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`live-execution-${width}.png`), fullPage: true });
  }
  console.log(`Accepted root ${accepted.id}; verified ${detail!.children.length} actual children, isolated resource cleanup and ${bytes.byteLength}-byte artifact`);
});


test("mock execution: parent continues a specialist awaiting current access without new admissions", async ({ page }) => {
  const fixture = await executionFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/agents/${rootAgent}?section=test`);
  await page.getByRole("textbox", { name: "Message" }).fill("Research with the approved specialists.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("region", { name: "Specialist tasks" })).toBeVisible();
  fixture.expireChildAuthority();
  await expect(page.getByRole("button", { name: "Continue task", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Specialist tasks" })).toContainText("waiting authority");
  await page.getByRole("button", { name: "Continue task", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue task", exact: true })).toHaveCount(0);
  fixture.finish(); fixture.clean();
  await expect(page.getByText("Resources cleaned", { exact: true })).toBeVisible();
  expect(fixture.continuations()).toBe(1);
  expect(fixture.admissions()).toBe(1);
});
