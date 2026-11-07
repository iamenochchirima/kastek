import { expect, test, type Page } from "@playwright/test";
import { agentConfigurationSchema } from "../../api/src/contracts/contracts";

const org = "11111111-1111-4111-8111-111111111111";
const account = { id: "member", email: "member@example.test", displayName: "Member" };
async function specialistWorkspace(page: Page, options: { taskTools?: boolean; customer?: boolean; productBound?: boolean; programThree?: boolean; adaptive?: boolean; validIds?: boolean; context?: { maxInputTokens: number; compactAtTokens: number }; maxOutputTokens?: number } = {}) {
  const configuration = { executionKind: "business", program: { id: "tool-directed", version: options.adaptive ? "4" : options.programThree ? "3" : options.taskTools ? "2" : "1" }, productBindings: options.productBound ? [{ id: "product-binding", alias: "product.read", authority: { kind: "product" } }] : [], instructions: "Help this member.", context: options.context ?? { maxInputTokens: 8192, compactAtTokens: 6144 }, model: { selection: { kind: "organization_default" }, maxInputBytes: 16384, maxOutputTokens: options.maxOutputTokens ?? 4096, maxDurationSeconds: 120 }, sourceRevisionIds: [], connectedToolBindingIds: [], tools: options.taskTools ? ["tasks.inspect", "tasks.cancel", "knowledge.search"] : [], memory: { enabled: false }, capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
  const specialist = { agentId: "content", name: "Content", skillCount: 2, description: "Write private drafts from the supplied brief.", versionId: options.validIds ? "22222222-2222-4222-8222-222222222222" : "content-v1", versionNumber: 1, ready: true, reasons: [], sourceRevisionIds: [], connectedToolBindingIds: [], tools: [] };
  const agent = { id: "assistant-1", name: "Business assistant", offering: options.customer ? "faq" : null, draft: configuration, draftRevision: 1 };
  const saved: unknown[] = [], created: unknown[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account, organizations: [{ id: org, name: "Office", role: "owner" }] };
    else if (path.endsWith("/inbox-alerts")) data = { unread: 0, alerts: [] };
    else if (path.endsWith("/model-providers")) data = { connections: [] };
    else if (path.endsWith("/model-providers/default")) data = { selection: null, revision: 1 };
    else if (path.endsWith("/model-policy")) data = { modelId: null, modelRevision: null, limits: { contextTokens: null, maxInputTokens: null, maxOutputTokens: null, maxCallDurationMs: null, maxRootTokens: null, safetyTokens: null }, effectivePolicy: null, errors: [], controls: { temperature: null, reasoning: null } };
    else if (path.endsWith("/setup-readiness")) data = { readiness: { readyToTest: false, setupStep: null, requirements: {}, channels: [] } };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/catalogue/tools")) data = { schemaVersion: 1, revision: "fixture", agentId: agent.id, entries: [] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ ...agent, latestVersion: { id: "version-1", number: 1, executionKind: "business" } }], nextCursor: null };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/specialists")) data = { specialists: [specialist, { ...specialist, agentId: "analyst", name: "Analyst", versionId: "analyst-v2", versionNumber: 2, ready: false, reasons: ["Model unavailable"] }, { ...specialist, agentId: "editor", name: "Editor", versionId: "editor-v1" }, { ...specialist, agentId: "reviewer", name: "Reviewer", versionId: "reviewer-v1" }] };
    else if (path.endsWith("/agents/assistant-1/configuration")) { saved.push(request.postDataJSON()); agent.draft = request.postDataJSON().configuration; agent.draftRevision++; data = { agent, snapshot: { id: "version-2", number: 2, configuration: request.postDataJSON().configuration }, deployments: [] }; }
    else if (path.endsWith("/agents") && request.method() === "POST") { created.push(request.postDataJSON()); data = { agent: { ...agent, id: "new-content" } }; }
    else if (path.endsWith("/agents/assistant-1") || path.endsWith("/agents/new-content")) data = { agent, versions: [{ id: "version-1", number: 1, configuration }], deployments: [] };
    else return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
    return route.fulfill({ json: data });
  });
  return { saved, created };
}

test("normal configuration pins only ready specialists, enforces two bindings and saves delegation", async ({ page }) => {
  const fixture = await specialistWorkspace(page);
  await page.goto("/app/agents/assistant-1?section=configuration");
  const section = page.getByRole("region", { name: "Specialists", exact: true });
  await expect(section.getByText("Model unavailable", { exact: true })).toBeVisible();
  await expect(section.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Content · v1", exact: true }) }).getByText("2 skills", { exact: true })).toBeVisible();
  const analyst = section.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Analyst · v2" }) });
  await expect(analyst.getByRole("button", { name: "Add specialist" })).toBeDisabled();
  for (const name of ["Content · v1", "Editor · v1"]) await section.getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) }).getByRole("button", { name: "Add specialist" }).click();
  await expect(section.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Reviewer · v1" }) }).getByRole("button", { name: "Add specialist" })).toBeDisabled();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(1);
  expect(fixture.saved[0]).toMatchObject({ configuration: { tools: ["agents.delegate"], capabilities: { delegation: { enabled: true, maxChildren: 2, maxDepth: 1, bindings: [{ versionId: "content-v1", label: "Content", maxTokens: 8000 }, { versionId: "editor-v1", label: "Editor", maxActiveMs: 120000 }] } } } });
});

test("content specialist creation uses normal business configuration and private drafting instructions", async ({ page }) => {
  const fixture = await specialistWorkspace(page);
  await page.goto("/app/agents/assistant-1?section=configuration");
  await page.getByRole("button", { name: "Create specialist", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create specialist", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Content");
  await dialog.getByRole("button", { name: "Create specialist", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/agents\/new-content\?section=configuration/);
  expect(fixture.created[0]).toMatchObject({ name: "Content", operationId: expect.any(String), configuration: { executionKind: "business", tools: [], sourceRevisionIds: [], capabilities: { delegation: { enabled: false }, businessActions: { enabled: false } }, instructions: expect.stringContaining("Do not publish") } });
});

test("specialist configuration and creation dialog fit supported widths and themes", async ({ page }) => {
  await specialistWorkspace(page);
  for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/agents/assistant-1?section=configuration");
    const section = page.getByRole("region", { name: "Specialists", exact: true });
    await expect(section.getByText("Model unavailable", { exact: true })).toBeVisible();
    await section.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Content · v1", exact: true }) }).getByRole("button", { name: "Add specialist" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await section.screenshot({ path: test.info().outputPath(`specialists-${theme}-${width}.png`), animations: "disabled" });
    await section.getByRole("button", { name: "Create specialist" }).click();
    const dialog = page.getByRole("dialog", { name: "Create specialist", exact: true });
    await expect(dialog.getByRole("textbox", { name: "Instructions", exact: true })).toBeVisible();
    await dialog.screenshot({ path: test.info().outputPath(`create-specialist-${theme}-${width}.png`), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});

test("business task controls preserve defaults and save optional task authority", async ({ page }) => {
  const fixture = await specialistWorkspace(page, { taskTools: true });
  await page.goto("/app/agents/assistant-1?section=tools");
  await expect(page.getByRole("checkbox", { name: "Task status", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Cancel tasks", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "Cancel tasks", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(1);
  expect(fixture.saved[0]).toMatchObject({ configuration: { program: { id: "tool-directed", version: "2" }, tools: ["tasks.inspect", "knowledge.search"] } });
  await page.getByRole("checkbox", { name: "Task status", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(2);
  expect(fixture.saved[1]).toMatchObject({ configuration: { program: { id: "tool-directed", version: "2" }, tools: ["knowledge.search"] } });
  await page.getByRole("checkbox", { name: "Cancel tasks", exact: true }).check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(3);
  expect(fixture.saved[2]).toMatchObject({ configuration: { program: { id: "tool-directed", version: "2" }, tools: ["knowledge.search", "tasks.cancel"] } });
});

test("customer offerings do not expose task controls", async ({ page }) => {
  await specialistWorkspace(page, { customer: true });
  await page.goto("/app/agents/assistant-1?section=tools");
  await expect(page.getByRole("group", { name: "Staff record tools", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Task status", exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Cancel tasks", exact: true })).toHaveCount(0);
});

test("enabling a task tool upgrades normal business program to version two", async ({ page }) => {
  const fixture = await specialistWorkspace(page);
  await page.goto("/app/agents/assistant-1?section=tools");
  await expect(page.getByRole("checkbox", { name: "Task status", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Cancel tasks", exact: true })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Task status", exact: true }).check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(1);
  expect(fixture.saved[0]).toMatchObject({ configuration: { program: { id: "tool-directed", version: "2" }, tools: ["tasks.inspect"] } });
});

for (const options of [{ productBound: true, programThree: true }, { productBound: false, programThree: true }, { productBound: true, programThree: false }]) {
  test(`product-bound task controls stay hidden and preserve program ${JSON.stringify(options)}`, async ({ page }) => {
    const fixture = await specialistWorkspace(page, options);
    await page.goto("/app/agents/assistant-1?section=tools");
    await expect(page.getByRole("group", { name: "Staff record tools", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Task status", exact: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Cancel tasks", exact: true })).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Search customer records", exact: true }).check();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => fixture.saved.length).toBe(1);
    expect(fixture.saved[0]).toMatchObject({ configuration: { program: { id: "tool-directed", version: options.programThree ? "3" : "1" }, productBindings: options.productBound ? [{ id: "product-binding", alias: "product.read", authority: { kind: "product" } }] : [], tools: ["records.search"] } });
  });
}


test("adaptive orchestration admits a third specialist and saves explicit execution policy", async ({ page }) => {
  const fixture = await specialistWorkspace(page);
  await page.goto("/app/agents/assistant-1?section=configuration");
  const section = page.getByRole("region", { name: "Specialists", exact: true });
  await section.getByRole("button", { name: "Enable adaptive orchestration" }).click();
  for (const name of ["Content · v1", "Editor · v1", "Reviewer · v1"]) await section.getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) }).getByRole("button", { name: "Add specialist" }).click();
  await section.getByRole("spinbutton", { name: "Concurrent tasks", exact: true }).fill("4");
  await section.getByRole("spinbutton", { name: "Total tasks", exact: true }).fill("24");
  await section.getByRole("spinbutton", { name: "Stall limit", exact: true }).fill("4");
  expect(fixture.saved).toHaveLength(0);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(1);
  expect(fixture.saved[0]).toMatchObject({ configuration: { program: { id: "tool-directed", version: "4" }, tools: expect.arrayContaining(["agents.discover", "agents.start", "agents.followup", "work.update", "agents.delegate"]), capabilities: { delegation: { maxChildren: 4, maxDepth: 1, policy: { maxTasks: 24, maxStalls: 4 }, bindings: [{ versionId: "content-v1" }, { versionId: "editor-v1" }, { versionId: "reviewer-v1" }] } } } });
});

test("adaptive execution policy fits supported widths and themes", async ({ page }) => {
  await specialistWorkspace(page, { adaptive: true });
  for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/app/agents/assistant-1?section=configuration");
    const section = page.getByRole("region", { name: "Specialists", exact: true });
    await expect(section.getByRole("group", { name: "Adaptive orchestration", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await section.screenshot({ path: test.info().outputPath(`adaptive-${theme}-${width}.png`), animations: "disabled" });
  }
});

test("task authority additions retain adaptive program version", async ({ page }) => {
  const fixture = await specialistWorkspace(page, { adaptive: true });
  await page.goto("/app/agents/assistant-1?section=tools");
  await page.getByRole("checkbox", { name: "Task status", exact: true }).check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(1);
  expect(fixture.saved[0]).toMatchObject({ configuration: { program: { version: "4" }, tools: ["tasks.inspect"] } });
});

test("active adaptive work shows progress and queues corrections without losing failed input", async ({ page }) => {
  await specialistWorkspace(page, { adaptive: true });
  const queued: Array<{ instruction: string; requestKey: string }> = [];
  const task = { id: "adaptive-task", state: "waiting_children", conversationId: "adaptive-conversation", input: "Draft our launch", requestKey: "initial", output: null, errorCode: null };
  await page.route("**/api/**/conversations/adaptive-conversation", route => route.fulfill({ json: { tasks: [task], nextCursor: null, conversation: { agentId: "assistant-1", versionId: "version-1", versionNumber: 1 } } }));
  await page.route("**/api/**/tasks**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/tasks") && route.request().method() === "POST") task.requestKey = route.request().postDataJSON().requestKey;
    if (path.endsWith("/instructions")) {
      queued.push(route.request().postDataJSON());
      return route.fulfill(queued.length === 1 ? { status: 503, json: { error: { message: "Temporarily unavailable" } } } : { json: { accepted: true } });
    }
    return route.fulfill({ json: { task, canSteer: true, orchestration: { revision: 2, record: { objective: "Prepare launch draft", steps: [{ id: "draft", title: "Collect specialist draft", state: "in_progress" }], questions: ["Which audience?"], evidenceTaskIds: [] } }, children: [{ id: "child", agentName: "Content", state: "waiting_review", versionId: "content-v1", output: null }] } });
  });
  await page.goto("/app/agents/assistant-1?section=chat");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Draft our launch");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const progress = page.getByRole("region", { name: "Agent work", exact: true });
  await expect(progress.getByText("Collect specialist draft", { exact: true })).toBeHidden();
  await progress.getByText("Approach", { exact: true }).click();
  await expect(progress.getByText("Collect specialist draft", { exact: true })).toBeVisible();
  await expect(progress.getByText("Which audience?", { exact: true })).toBeVisible();
  const correction = page.getByRole("textbox", { name: "Update instructions", exact: true });
  await correction.fill("Write for existing customers.");
  await page.getByRole("button", { name: "Queue instructions", exact: true }).click();
  await expect(page.getByText("Temporarily unavailable", { exact: true })).toBeVisible();
  await expect(correction).toHaveValue("Write for existing customers.");
  await page.getByRole("button", { name: "Queue instructions", exact: true }).click();
  await expect(page.getByText("Instructions queued", { exact: true })).toBeVisible();
  await expect(correction).toHaveValue("");
  expect(queued).toHaveLength(2);
  expect(queued[0]).toEqual(queued[1]);
  for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("region", { name: "Conversation", exact: true }).screenshot({ path: test.info().outputPath(`progress-${theme}-${width}.png`), animations: "disabled" });
  }
  const decisions: unknown[] = [];
  const review = { id: "child-review", taskId: "child", rootTaskId: task.id, operationId: "child-operation", operationName: "send_message", connectionName: "Workspace", destination: "https://workspace.example.test", effect: "reviewed_write", bindingId: "binding", bindingDigest: "binding-digest", requestDigest: "child-exact-digest", arguments: { message: "Launch draft" }, connectionId: "connection", reviewerAccountId: account.id, state: "pending", expiresAt: new Date(Date.now() + 600000).toISOString() };
  await page.route("**/api/**/tasks/child**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/decision")) { decisions.push(route.request().postDataJSON()); review.state = "approved"; return route.fulfill({ json: { review } }); }
    if (path.endsWith("/tool-reviews")) return route.fulfill({ json: { reviews: [review] } });
    return route.fulfill({ json: { task: { id: "child", state: "waiting_review", hasToolReviews: true, conversationId: "specialist-conversation", output: null, errorCode: null, input: "Draft launch" }, canControl: true, actions: [], children: [], operations: [], events: [] } });
  });
  await progress.getByRole("button", { name: "Open Content activity", exact: true }).click();
  const childActivity = page.getByRole("dialog", { name: "Content", exact: true });
  await childActivity.getByRole("link", { name: "Open task", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/tasks\/child$/);
  const approvals = page.getByRole("region", { name: "Tool approvals", exact: true });
  await expect(approvals.getByText("Launch draft", { exact: true })).toBeVisible();
  await approvals.getByRole("button", { name: "Approve action", exact: true }).click();
  expect(decisions).toHaveLength(0);
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve action", exact: true }).click();
  await expect.poll(() => decisions.length).toBe(1);
  expect(decisions[0]).toEqual({ decision: "approve", requestDigest: "child-exact-digest" });
});


test("adaptive empty roster saves valid configuration before and after final removal", async ({ page }) => {
  const fixture = await specialistWorkspace(page, { validIds: true });
  await page.goto("/app/agents/assistant-1?section=configuration");
  const section = page.getByRole("region", { name: "Specialists", exact: true });
  await section.getByRole("button", { name: "Enable adaptive orchestration" }).click();
  await expect(section.getByText("No specialists selected", { exact: true })).toBeVisible();
  await expect(section.getByRole("spinbutton", { name: "Concurrent tasks" })).toBeDisabled();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(1);
  const empty = agentConfigurationSchema.parse((fixture.saved[0] as {configuration: unknown}).configuration);
  expect(empty).toMatchObject({ program: { version: "4" }, context: { maxInputTokens: 24000, compactAtTokens: 22000 }, capabilities: { delegation: { enabled: false } } });
  expect(empty.tools).not.toContain("agents.start");
  await section.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Content · v1", exact: true }) }).getByRole("button", { name: "Add specialist" }).click();
  await section.getByRole("spinbutton", { name: "Concurrent tasks" }).fill("4");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(2);
  await section.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(3);
  expect(agentConfigurationSchema.parse((fixture.saved[2] as {configuration: unknown}).configuration).capabilities.delegation).toEqual({ enabled: false });
  await section.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Content · v1", exact: true }) }).getByRole("button", { name: "Add specialist" }).click();
  await expect(section.getByRole("spinbutton", { name: "Concurrent tasks" })).toHaveValue("4");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => fixture.saved.length).toBe(4);
  expect(agentConfigurationSchema.parse((fixture.saved[3] as {configuration: unknown}).configuration)).toMatchObject({ capabilities: { delegation: { enabled: true, maxChildren: 4, policy: { maxTasks: 16, maxStalls: 3 } } }, tools: expect.arrayContaining(["agents.start", "agents.followup"]) });
});


for (const input of [{ context: { maxInputTokens: 26000, compactAtTokens: 24000 }, maxOutputTokens: 4096 }, { context: { maxInputTokens: 8192, compactAtTokens: 6144 }, maxOutputTokens: 12000 }]) {
  test(`adaptive upgrade respects configured reply and context budgets ${input.maxOutputTokens}`, async ({ page }) => {
    const fixture = await specialistWorkspace(page, input);
    await page.goto("/app/agents/assistant-1?section=configuration");
    const section = page.getByRole("region", { name: "Specialists", exact: true });
    await section.getByRole("button", { name: "Enable adaptive orchestration" }).click();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => fixture.saved.length).toBe(1);
    const saved = agentConfigurationSchema.parse((fixture.saved[0] as {configuration: unknown}).configuration);
    expect(saved.model.maxOutputTokens).toBe(input.maxOutputTokens);
    expect(saved.context).toEqual(input.context);
  });
}
