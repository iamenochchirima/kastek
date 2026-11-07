import { randomUUID } from "node:crypto";
import { nativeAgent, nativeJson, saveNativeProgram } from "./native-harness-fixture";
import type { Memory, Skill } from "../src/platform/api";
import { agentSummary, conversationSummaries, configure, chooseConversation, newChat } from "./workspace-fixtures";
import { test, expect } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const versionId = "44444444-4444-4444-8444-444444444444";

test("mock transport: shared harness tool observations and contextual conversation recovery", async ({ page }) => {
  const configuration = { executionKind: "business", program: { id: "tool-directed", version: "1" }, instructions: "Help the user.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, memory: { enabled: true }, context: { maxInputTokens: 8192, compactAtTokens: 6144 }, tools: ["memory.search", "memory.propose"], skillIds: ["skill-1"], capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) };
  let agent = { id: agentId, name: "Assistant", draft: configuration, draftRevision: 1 };
  const tasks: { id: string; state: string; input: string; output: string; conversationId: string; requestKey: string; turnSequence: number; versionId: string }[] = [];
  const posts: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : {};
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith(`/agents/${agentId}`)) { if (method === "PUT") agent = { ...agent, draft: body.configuration, draftRevision: agent.draftRevision + 1 }; data = { agent, versions: [{ id: versionId, number: 1, configuration: agent.draft }], deployments: [] }; }
    else if (path.endsWith("/agents/summaries")) data = {agents:[agentSummary(agent,{id:versionId,number:1})],nextCursor:null};
    else if (path.endsWith("/conversations")) data = {conversations:conversationSummaries(tasks,agent,{id:versionId,number:1}),nextCursor:null};
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/tasks") && method === "POST") { posts.push(body); const conversationId = body.conversationId ?? `conversation-${tasks.length + 1}`; const task = { id: `task-${tasks.length + 1}`, state: "completed", input: body.input, output: tasks.length === 1 ? "You said your name is Ada." : "Hello Ada.", conversationId, requestKey: body.requestKey, turnSequence: tasks.filter(t => t.conversationId === conversationId).length + 1, versionId }; tasks.push(task); data = { task }; }
    else if (path.includes("/conversations/")) data = { tasks: tasks.filter(task => path.endsWith(task.conversationId)),nextCursor:null,conversation:{versionId,versionNumber:1} };
    else if (path.includes("/tasks/")) data = { task: tasks.find(task => path.endsWith(task.id)), events: [{ sequence: 1, kind: "context_prepared" }, { sequence: 2, kind: "completed" }], operations: [{ operationId: "op-1", kind: "tool", name: "memory.search", state: "completed" }] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto(`/app/agents/${agentId}?section=chat`);
  await expect(page.getByRole("heading", { name: "Assistant", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("My name is Ada.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Hello Ada.", { exact: true })).toBeVisible();
  await page.getByText("Execution details", { exact: true }).click();
  await expect(page.getByText("memory.search", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("What is my name?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("You said your name is Ada.", { exact: true })).toBeVisible();
  expect(posts[1].conversationId).toBe("conversation-1");
  await page.reload();
  await expect(page.getByText("You said your name is Ada.", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
  await newChat(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await chooseConversation(page, "My name is Ada.");
  await expect(page.getByRole("paragraph").filter({ hasText: /^My name is Ada\.$/ })).toBeVisible();
  for (const width of [768, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`harness-${width}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test("live harness: scoped memory, tool rounds, contextual follow-up and new conversation", async ({ page, context, baseURL }) => {
  const cookie = process.env.AGENTS_BROWSER_SESSION_COOKIE;
  test.skip(!cookie || process.env.AGENTS_HARNESS_LIVE !== "1", "Enable only against the approved real-model harness fixture.");
  const separator = cookie!.indexOf("=");
  const name = separator > 0 ? cookie!.slice(0, separator) : new URL(baseURL!).protocol === "https:" ? "__Host-agents_session" : "agents_session";
  await context.addCookies([{ name, value: separator > 0 ? cookie!.slice(separator + 1) : cookie!, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/app/agents");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  if (await page.getByRole("combobox", { name: "Workspace" }).count()) await page.getByRole("combobox", { name: "Workspace" }).selectOption("new");
  else await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const suffix = Date.now().toString(36);
  await page.getByRole("textbox", { name: "Workspace name" }).fill(`Harness verification ${suffix}`);
  await page.getByRole("dialog").getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your agents", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(`Assistant ${suffix}`);
  await page.getByRole("dialog").getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toBeVisible();
  const agentUrl = page.url();
  const native = await nativeAgent(page);
  await saveNativeProgram(page, { ...native.agent.draft, program: { id: "tool-directed", version: "1" }, memory: { enabled: true }, tools: ["memory.search", "memory.propose"] });
  const candidate = await nativeJson<Memory>(page, `${native.path}/memory`, "POST", { operationId: randomUUID(), kind: "semantic", content: "My favorite color is cobalt blue." });
  const acceptedMemory = await nativeJson<Memory>(page, `${native.path}/memory/candidates/${candidate.id}/accept`, "POST", { operationId: randomUUID(), expectedRevision: candidate.revision });
  const { skill } = await nativeJson<{ skill: Skill }>(page, `${native.path}/skills`, "POST", { operationId: randomUUID(), name: `brief-replies-${suffix}`, description: "Keep replies brief.", body: "Answer in one short sentence. Report uncertainty when facts are unavailable." });
  await saveNativeProgram(page, { ...native.agent.draft, program: { id: "tool-directed", version: "1" }, instructions: "Help the user. Use memory.search for relevant saved preferences when needed. Use authorized earlier conversation for follow-up questions. Answer in one short sentence. Do not invent facts or claim that a suggestion is saved memory.", memory: { enabled: true }, tools: ["memory.search", "memory.propose"], skillIds: [skill.id] });
  await page.reload(); await configure(page);
  await page.getByRole("button", { name: "Create version", exact: true }).click();
  await page.goto(`/app/agents/${agentId}?section=chat`);
  const originalVersionId = await page.getByRole("combobox", { name: "Version", exact: true }).inputValue();
  const acceptedTasks: string[] = [];
  let taskEndpoint = "";
  async function send(input: string) {
    await page.getByRole("textbox", { name: "Message" }).fill(input);
    const response = page.waitForResponse(result => /\/tasks$/.test(new URL(result.url()).pathname) && result.request().method() === "POST");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const admitted = await response; expect(admitted.ok()).toBe(true);
    acceptedTasks.push((await admitted.json()).task.id);
    taskEndpoint = new URL(admitted.url()).pathname;
    await expect.poll(async () => { const response = await page.request.get(`${taskEndpoint}/${encodeURIComponent(acceptedTasks.at(-1)!)}`); expect(response.ok()).toBe(true); return (await response.json()).task.state; }, { timeout: 150_000 }).toMatch(/^(completed|incomplete|refused|failed|cancelled|uncertain)$/);
  }
  await send("My project code is ORCHID-17. Acknowledge it.");
  await page.reload();
  await expect(page.getByRole("article").getByText("My project code is ORCHID-17. Acknowledge it.", { exact: true })).toBeVisible();
  await send("What is my project code? Use our earlier conversation.");
  await expect(page.getByRole("article", { name: "Turn 2", exact: true }).getByRole("paragraph").filter({ hasText: /ORCHID-17/ })).toBeVisible();
  await newChat(page);
  await configure(page);
  const instructions = page.getByRole("textbox", { name: "Instructions", exact: true });
  await instructions.fill(`${await instructions.inputValue()} Preserve the exact preferred-color wording.`);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Create version", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Version", exact: true })).not.toHaveValue(originalVersionId);
  const latestVersionId = await page.getByRole("combobox", { name: "Version", exact: true }).inputValue();
  await page.goto(`/app/agents/${agentId}?section=chat`);
  await send("Call memory.search to look up my favorite color, then tell me the color.");
  await expect(page.getByRole("paragraph").filter({ hasText: /cobalt/i })).toBeVisible();
  const records = await Promise.all(acceptedTasks.map(async taskId => {
    const response = await page.request.get(`${taskEndpoint}/${encodeURIComponent(taskId)}`);
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ task: { id: string; input: string; conversationId: string; turnSequence: number; versionId: string }; operations: { kind: string; name: string; state: string }[] }>;
  }));
  expect(records[0]!.task.versionId).toBe(originalVersionId);
  expect(records[1]!.task.versionId).toBe(originalVersionId);
  expect(records[2]!.task.versionId).toBe(latestVersionId);
  expect(records[0]!.task.conversationId).toBe(records[1]!.task.conversationId);
  expect(records[2]!.task.conversationId).not.toBe(records[0]!.task.conversationId);
  const oldConversation = await page.request.get(`${taskEndpoint.replace(/\/tasks$/u, "")}/conversations/${records[0]!.task.conversationId}`);
  expect(oldConversation.ok()).toBe(true);
  expect((await oldConversation.json()).conversation.versionId).toBe(originalVersionId);
  const toolTask = records.find(record => record.operations.some(operation => operation.kind === "tool" && operation.name === "memory.search" && operation.state === "completed"));
  expect(toolTask, "The real model must complete at least one factual memory.search operation across the accepted tasks").toBeDefined();
  if (toolTask!.task.conversationId !== records.at(-1)!.task.conversationId) {
    await chooseConversation(page, toolTask!.task.input);
  }
  const toolTurn = page.getByRole("article", { name: `Turn ${toolTask!.task.turnSequence}`, exact: true });
  if (!(await toolTurn.locator("details").evaluate(element => (element as HTMLDetailsElement).open))) await toolTurn.getByText("Execution details", { exact: true }).click();
  await expect(toolTurn.getByRole("list", { name: "Task operations" }).getByText("memory.search", { exact: true }).first()).toBeVisible();
  console.log(`Verified real memory.search receipt in ${toolTask!.task.id}`);
  const corrected = await nativeJson<Memory>(page, `${native.path}/memory/${acceptedMemory.id}`, "PATCH", { operationId: randomUUID(), expectedRevision: acceptedMemory.revision, content: "My favorite color is forest green." });
  const afterCorrection = await nativeJson<{ items: Memory[] }>(page, `${native.path}/memory`);
  expect(afterCorrection.items.find(item => item.id === corrected.id)?.content).toBe("My favorite color is forest green.");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`live-harness-inspection-${width}.png`), fullPage: true });
  }
  await nativeJson<Memory>(page, `${native.path}/memory/${corrected.id}/forget`, "POST", { operationId: randomUUID(), expectedRevision: corrected.revision });
  const afterForget = await nativeJson<{ items: Memory[] }>(page, `${native.path}/memory`);
  expect(afterForget.items.some(item => item.id === corrected.id)).toBe(false);
  console.log(`Real harness browser journey ${agentUrl}; accepted tasks ${acceptedTasks.join(", ")}`);
});

test("mock transport: waiting task continues with current access and preserves its identity on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const configuration = { executionKind: "business", instructions: "Answer briefly.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) };
  let task: { id: string; state: string; input: string; requestKey: string; conversationId: string; turnSequence: number; output: string | null } | null = null;
  let admissions = 0, continuations = 0;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith(`/agents/${agentId}`)) data = { agent: { id: agentId, name: "Assistant", draft: configuration, draftRevision: 1 }, versions: [{ id: versionId, number: 1, configuration }], deployments: [] };
    else if (path.endsWith("/agents/summaries")) data = {agents:[agentSummary({id:agentId,name:"Assistant"},{id:versionId,number:1})],nextCursor:null};
    else if (path.endsWith("/conversations")) data = {conversations:task?conversationSummaries([task],{id:agentId,name:"Assistant"},{id:versionId,number:1}):[],nextCursor:null};
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else if (path.endsWith("/tasks") && method === "POST") { admissions++; const body = request.postDataJSON(); task = { id: "waiting-task", state: "waiting_authority", input: body.input, requestKey: body.requestKey, conversationId: "waiting-conversation", turnSequence: 1, output: null }; data = { task }; }
    else if (path.endsWith("/waiting-task/continue") && method === "POST") { continuations++; task = { ...task!, state: "completed", output: "The original task continued." }; data = { task }; }
    else if (path.includes("/conversations/")) data = { tasks: task ? [{...task,versionId}] : [],nextCursor:null,conversation:{versionId,versionNumber:1} };
    else if (path.endsWith("/tasks/waiting-task")) data = { task, operations: [], events: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto(`/app/agents/${agentId}?section=test`);
  await page.getByRole("textbox", { name: "Message" }).fill("Continue my research.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue task", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Continue task", exact: true })).toBeVisible();
  expect(admissions).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("waiting-authority-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Continue task", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("The original task continued.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue task", exact: true })).toHaveCount(0);
  expect(continuations).toBe(1);
  expect(admissions).toBe(1);
  await page.getByText("Execution details", { exact: true }).click();
  await expect(page.getByText("waiting-task", { exact: true })).toBeVisible();
});
