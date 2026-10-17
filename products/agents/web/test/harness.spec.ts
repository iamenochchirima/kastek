import { test, expect } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const versionId = "44444444-4444-4444-8444-444444444444";

test("mock transport: reviewed memory, pinned skills, factual progress and contextual conversation recovery", async ({ page }) => {
  const configuration = { executionKind: "business", instructions: "Help the user.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, memory: { enabled: false }, context: { maxInputTokens: 8192, compactAtTokens: 6144 }, tools: [] as string[], skillIds: [] as string[], capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) };
  let agent = { id: agentId, name: "Assistant", draft: configuration, draftRevision: 1 };
  type Item = { id: string; content: string; revision: number; status: string; kind: string };
  let items: Item[] = [], candidates: Item[] = [];
  const skills: { id: string; name: string; description: string; body: string; revision: number }[] = [];
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
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/skills")) { if (method === "POST") { expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/); const skill = { ...body, id: "skill-1", revision: 1 }; skills.push(skill); data = { skill }; } else data = { skills }; }
    else if (path.endsWith("/memory")) { if (method === "POST") { candidates.push({ id: "memory-1", content: body.content, revision: 1, kind: body.kind, status: "candidate" }); data = {}; } else data = { generation: 1, items, candidates }; }
    else if (path.includes("/memory/candidates/") && path.endsWith("/accept")) { expect(body.expectedRevision).toBe(1); items = candidates.map(item => ({ ...item, status: "accepted", revision: 2 })); candidates = []; data = {}; }
    else if (path.endsWith("/memory/memory-1") && method === "PATCH") { expect(body.expectedRevision).toBe(2); items = items.map(item => ({ ...item, content: body.content, revision: 3 })); data = {}; }
    else if (path.endsWith("/memory/memory-1/forget")) { expect(body.expectedRevision).toBe(3); items = []; data = {}; }
    else if (path.endsWith("/tasks") && method === "POST") { posts.push(body); const conversationId = body.conversationId ?? `conversation-${tasks.length + 1}`; const task = { id: `task-${tasks.length + 1}`, state: "completed", input: body.input, output: tasks.length === 1 ? "You said your name is Ada." : "Hello Ada.", conversationId, requestKey: body.requestKey, turnSequence: tasks.filter(t => t.conversationId === conversationId).length + 1, versionId }; tasks.push(task); data = { task }; }
    else if (path.includes("/conversations/")) data = { tasks: tasks.filter(task => path.endsWith(task.conversationId)) };
    else if (path.includes("/tasks/")) data = { task: tasks.find(task => path.endsWith(task.id)), events: [{ sequence: 1, kind: "context_prepared" }, { sequence: 2, kind: "completed" }], operations: [{ operationId: "op-1", kind: "tool", name: "memory.search", state: "completed" }] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto(`/app/agents/${agentId}`);
  await expect(page.getByRole("heading", { name: "Assistant", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Use personal memory" }).check();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  expect(agent.draft.memory.enabled).toBe(true);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByRole("textbox", { name: "Memory", exact: true }).fill("I prefer concise replies.");
  await page.getByRole("button", { name: "Add suggestion" }).click();
  await page.getByRole("button", { name: "Remember", exact: true }).click();
  await expect(page.getByRole("button", { name: "Correct", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Correct", exact: true }).click();
  await page.getByRole("textbox", { name: "Memory", exact: true }).fill("I prefer detailed replies.");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText("I prefer detailed replies.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Forget memory", exact: true }).click();
  await expect(page.getByText(/No saved memories/)).toBeVisible();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("textbox", { name: "Skill name" }).fill("check-sources");
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Use references.");
  await page.getByRole("textbox", { name: "Procedure" }).fill("Cite approved sources when answering factual questions.");
  await expect(page.getByRole("button", { name: "Publish skill" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /I reviewed this procedure/ }).check();
  await page.getByRole("button", { name: "Publish skill" }).click();
  await expect(page.getByText("check-sources", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("checkbox", { name: /check-sources/ }).check();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  expect(agent.draft.skillIds).toEqual(["skill-1"]);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("My name is Ada.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Hello Ada.", { exact: true })).toBeVisible();
  await page.getByText("Task details", { exact: true }).click();
  await expect(page.getByText("memory.search", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("What is my name?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("You said your name is Ada.", { exact: true })).toBeVisible();
  expect(posts[1].conversationId).toBe("conversation-1");
  await page.reload();
  await expect(page.getByText("You said your name is Ada.", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await page.getByRole("combobox", { name: "Saved conversations" }).selectOption("conversation-1");
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
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(`Assistant ${suffix}`);
  await page.getByRole("dialog").getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toBeVisible();
  const agentUrl = page.url();
  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("Help the user. Use memory.search for relevant saved preferences when needed. Use authorized earlier conversation for follow-up questions. Answer in one short sentence. Do not invent facts or claim that a suggestion is saved memory.");
  await page.getByRole("checkbox", { name: "Use personal memory" }).check();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByRole("textbox", { name: "Memory", exact: true }).fill("My favorite color is cobalt blue.");
  await page.getByRole("button", { name: "Add suggestion" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Remember", exact: true }).click();
  await expect(page.getByRole("button", { name: "Correct", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("textbox", { name: "Skill name" }).fill(`brief-replies-${suffix}`);
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Keep replies brief.");
  await page.getByRole("textbox", { name: "Procedure" }).fill("Answer in one short sentence. Report uncertainty when facts are unavailable.");
  await page.getByRole("checkbox", { name: /I reviewed this procedure/ }).check();
  await page.getByRole("button", { name: "Publish skill" }).click();
  await expect(page.getByRole("textbox", { name: "Skill name" })).toHaveValue("");
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("checkbox", { name: new RegExp(`brief-replies-${suffix}`) }).check();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: "Create test version" }).click();
  const acceptedTasks: string[] = [];
  let taskEndpoint = "";
  async function send(input: string) {
    await page.getByRole("textbox", { name: "Message" }).fill(input);
    const response = page.waitForResponse(result => /\/tasks$/.test(new URL(result.url()).pathname) && result.request().method() === "POST");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const admitted = await response; expect(admitted.ok()).toBe(true);
    acceptedTasks.push((await admitted.json()).task.id);
    taskEndpoint = new URL(admitted.url()).pathname;
    await expect(page.getByRole("button", { name: "New conversation" })).toBeEnabled({ timeout: 150_000 });
  }
  await send("My project code is ORCHID-17. Acknowledge it.");
  await page.reload();
  await expect(page.getByText("My project code is ORCHID-17. Acknowledge it.", { exact: true })).toBeVisible();
  await send("What is my project code? Use our earlier conversation.");
  await expect(page.getByRole("article", { name: "Turn 2", exact: true }).getByRole("paragraph").filter({ hasText: /ORCHID-17/ })).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
  await send("Call memory.search to look up my favorite color, then tell me the color.");
  await expect(page.getByRole("paragraph").filter({ hasText: /cobalt/i })).toBeVisible();
  const records = await Promise.all(acceptedTasks.map(async taskId => {
    const response = await page.request.get(`${taskEndpoint}/${encodeURIComponent(taskId)}`);
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ task: { id: string; conversationId: string; turnSequence: number }; operations: { kind: string; name: string; state: string }[] }>;
  }));
  const toolTask = records.find(record => record.operations.some(operation => operation.kind === "tool" && operation.name === "memory.search" && operation.state === "completed"));
  expect(toolTask, "The real model must complete at least one factual memory.search operation across the accepted tasks").toBeDefined();
  if (toolTask!.task.conversationId !== records.at(-1)!.task.conversationId) {
    await page.getByRole("combobox", { name: "Saved conversations" }).selectOption(toolTask!.task.conversationId);
  }
  const toolTurn = page.getByRole("article", { name: `Turn ${toolTask!.task.turnSequence}`, exact: true });
  if (!(await toolTurn.locator("details").evaluate(element => (element as HTMLDetailsElement).open))) await toolTurn.getByText("Task details", { exact: true }).click();
  await expect(toolTurn.getByRole("list", { name: "Task operations" }).getByText("memory.search", { exact: true }).first()).toBeVisible();
  console.log(`Verified real memory.search receipt in ${toolTask!.task.id}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("button", { name: "Correct", exact: true }).click();
  await page.getByRole("textbox", { name: "Memory", exact: true }).fill("My favorite color is forest green.");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText("My favorite color is forest green.", { exact: true })).toBeVisible();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`live-memory-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Forget memory", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Forget memory", exact: true }).click();
  await expect(page.getByText(/No saved memories/)).toBeVisible();
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
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else if (path.endsWith("/tasks") && method === "POST") { admissions++; const body = request.postDataJSON(); task = { id: "waiting-task", state: "waiting_authority", input: body.input, requestKey: body.requestKey, conversationId: "waiting-conversation", turnSequence: 1, output: null }; data = { task }; }
    else if (path.endsWith("/waiting-task/continue") && method === "POST") { continuations++; task = { ...task!, state: "completed", output: "The original task continued." }; data = { task }; }
    else if (path.includes("/conversations/")) data = { tasks: task ? [task] : [] };
    else if (path.endsWith("/tasks/waiting-task")) data = { task, operations: [], events: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto(`/app/agents/${agentId}?section=test`);
  await page.getByRole("textbox", { name: "Message" }).fill("Continue my research.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue task", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
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
  await page.getByText("Task details", { exact: true }).click();
  await expect(page.getByText("waiting-task", { exact: true })).toBeVisible();
});
