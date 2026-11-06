import { test, expect, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222", versionId = "44444444-4444-4444-8444-444444444444";
const configuration = { executionKind: "business", instructions: "Help briefly.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) };
const specialistAssignment = "Find commuter audience insights using the launch brief.\nFocus on commuters who cycle to work.";
type Task = { id: string; versionId: string; input: string; output: string | null; requestKey: string; conversationId: string; turnSequence: number; state: string; errorCode: string | null };
async function fixture(page: Page, options: { unknown?: boolean; versions?: boolean; errorCode?: string; child?: boolean; steer?: boolean; memory?: boolean } = {}) {
  const tasks: Task[] = [], posts: Record<string, unknown>[] = [];
  const fixtureConfiguration = options.memory ? { ...configuration, memory: { enabled: true } } : configuration;
  let unknown = options.unknown;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method(), body = request.postData() ? request.postDataJSON() : {};
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ id: agentId, name: "Research assistant", latestVersion: { id: versionId, number: 1 }, hasUnpublishedChanges: false }], nextCursor: null };
    else if (path.endsWith(`/agents/${agentId}`)) data = { agent: { id: agentId, name: "Research assistant", draft: fixtureConfiguration, draftRevision: 1 }, versions: [{ id: versionId, number: 1, configuration: fixtureConfiguration }, ...(options.versions ? [{ id: "version-2", number: 2, configuration: fixtureConfiguration }] : [])], deployments: [] };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [...new Set(tasks.map(t => t.conversationId))].map(id => ({ id, agentId, agentName: "Research assistant", versionId, versionNumber: 1, title: tasks.find(t => t.conversationId === id)!.input, updatedAt: "2026-10-18T12:00:00Z", state: "completed" })), nextCursor: null };
    else if (path.includes("/conversations/")) { const id = path.split("/").at(-1); data = { tasks: tasks.filter(t => t.conversationId === id), conversation: { id, versionId: tasks.find(t => t.conversationId === id)?.versionId ?? versionId, versionNumber: 1 }, nextCursor: null }; }
    else if (path.endsWith("/tasks") && method === "POST") {
      posts.push(body);
      const existing = tasks.find(t => t.requestKey === body.requestKey);
      const task = existing ?? { id: `task-${tasks.length + 1}`, input: body.input, output: options.errorCode || options.child ? null : tasks.length ? "Your project is ORCHID-17." : "**Hello.** [Unsafe](javascript:alert(1))\n\n```text\n<script>window.injected=true</script>\n```", requestKey: body.requestKey, conversationId: body.conversationId ?? `conversation-${tasks.length + 1}`, versionId, turnSequence: tasks.length + 1, state: options.errorCode ? "failed" : options.child ? "running" : "completed", errorCode: options.errorCode ?? null };
      if (!existing) tasks.push(task);
      if (unknown) { unknown = false; await route.abort("failed"); return; }
      data = { task };
    }
    else if (path.endsWith("/tasks")) data = { tasks: tasks.map(t => ({ ...t, agentId, agentName: "Research assistant", versionNumber: 1, createdAt: "2026-10-18T12:00:00Z", updatedAt: "2026-10-18T12:00:00Z", canControl: true, reviewOnly: false })), nextCursor: null };
    else if (options.child && path.endsWith("/tasks/child-1")) data = { task: { id: "child-1", input: specialistAssignment, state: tasks[0]?.state === "completed" ? "completed" : "running", output: tasks[0]?.state === "completed" ? "Audience findings ready." : null, errorCode: null, conversationId: "child-conversation", versionId }, updates: [{ id: "update-1", text: "I have read the launch brief and am checking the audience.", createdAt: "2026-11-02T10:00:00Z" }], events: [], operations: url.searchParams.has("operationsCursor") ? [{ operationId: "child-older", name: "Discover audience sources", state: "completed" }] : [{ operationId: "child-read", name: "Read launch brief", state: "completed" }], operationsNextCursor: url.searchParams.has("operationsCursor") ? null : "older", actions: [], children: [], resources: [], artifacts: [] };
    else if (/\/tasks\/[^/]+$/.test(path)) data = { task: tasks.find(t => path.endsWith(t.id)), canSteer: options.steer === true, events: [], operations: [], actions: [], children: options.child ? [{ id: "child-1", agentName: "Research", state: tasks[0]?.state === "completed" ? "completed" : "running", output: null, parentTaskId: tasks[0]?.id, rootTaskId: tasks[0]?.id, versionId }] : [], resources: [], artifacts: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  return { tasks, posts };
}

test("mock transport: default chat, server history after storage clear, pinned continuation and safe content", async ({ page }) => {
  const { posts } = await fixture(page);
  await page.goto(`/app/agents/${agentId}`);
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("My project is ORCHID-17.");
  await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/conversations\/conversation-1$/);
  await expect(page.getByText("Hello.", { exact: true })).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
  expect(await page.evaluate(() => Object.entries(sessionStorage).some(([k,v]) => k.startsWith("agents.chat") && v.includes("Hello.")))).toBe(false);
  await page.evaluate(() => sessionStorage.clear()); await page.goto("/app/agents");
  await page.getByRole("link", { name: "Open Research assistant", exact: true }).click();
  await page.getByRole("navigation", { name: "Conversation history" }).getByRole("link").click();
  await expect(page.getByText("Hello.", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("What is my project?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Your project is ORCHID-17.", { exact: true })).toBeVisible();
  expect(posts[1].conversationId).toBe("conversation-1"); expect(posts[1].agentId).toBe(agentId); expect(posts[1].versionId).toBeUndefined();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "How can I help?" })).toBeVisible();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeInViewport();
    if (width === 390) { await page.getByRole("button", { name: "Agents & history" }).click(); await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Agents & history" })).toBeFocused(); }
    await page.screenshot({ path: test.info().outputPath(`workspace-${width}.png`) });
    if (width === 390) {
      await page.evaluate(() => { Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 520 }); window.visualViewport!.dispatchEvent(new Event("resize")); });
      expect(await page.locator(".chat-composer").evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(520);
      await page.evaluate(() => { Reflect.deleteProperty(window.visualViewport!, "height"); window.visualViewport!.dispatchEvent(new Event("resize")); });
    }

  }
});

test("mock transport: uncertain admission retries same key after reload and creates one task", async ({ page }) => {
  const { tasks, posts } = await fixture(page, { unknown: true });
  await page.goto(`/app/agents/${agentId}`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Recover me."); await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Retry request" })).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: "Retry request" }).click();
  await expect(page).toHaveURL(/\/conversations\/conversation-1$/);
  expect(tasks).toHaveLength(1); expect(posts).toHaveLength(2); expect(posts[0]).toEqual(posts[1]); expect(posts[0].agentId).toBe(agentId);
});

test("mock transport: standalone shared memory review, correction and Forget redact an open edit after authority loss", async ({ page }) => {
  await fixture(page, { memory: true });
  const memoryId = "55555555-5555-4555-8555-555555555555", path = `/api/organizations/${org}/agents/${agentId}/memory`;
  let denied = false, current = { id: memoryId, revision: 1, content: "Use British spelling in my drafts.", status: "candidate", origin: "model_candidate",
    assertion: { context: "unspecified", conflict: "not_assessed" }, updatedAt: "2026-11-02T10:00:00Z" };
  const changes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  await page.route("**/memory**", async route => {
    const request = route.request(), url = new URL(request.url());
    expect(url.pathname.startsWith(path)).toBe(true);
    if (denied) { await route.fulfill({ status: 403, json: { error: { message: "Memory access withdrawn" } } }); return; }
    if (request.method() === "GET") {
      expect(url.searchParams.get("limit")).toBe("30");
      await route.fulfill({ json: { generation: current.revision, items: current.status === "accepted" ? [current] : [], candidates: current.status === "candidate" ? [current] : [], nextOffset: null } });
      return;
    }
    const body = request.postDataJSON(); changes.push({ method: request.method(), path: url.pathname, body });
    expect(body.expectedRevision).toBe(current.revision); expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/);
    if (url.pathname === `${path}/candidates/${memoryId}/accept`) current = { ...current, status: "accepted", revision: current.revision + 1, assertion: body.assertion };
    else if (request.method() === "PATCH" && url.pathname === `${path}/${memoryId}`) current = { ...current, content: body.content, revision: current.revision + 1, assertion: body.assertion };
    else if (url.pathname === `${path}/${memoryId}/forget`) current = { ...current, status: "forgotten", content: "", revision: current.revision + 1 };
    else throw Error("Unexpected memory mutation");
    await route.fulfill({ json: current });
  });
  await page.goto(`/app/agents/${agentId}`);
  const trigger = page.getByRole("button", { name: "Memory", exact: true });
  await trigger.click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByText(current.content, { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Review", exact: true }).click();
  await modal.getByRole("combobox", { name: "Applies to", exact: true }).click();
  await page.getByRole("option", { name: "Hypothetical scenario", exact: true }).click();
  await modal.getByRole("combobox", { name: "Conflicts", exact: true }).click();
  await page.getByRole("option", { name: "Conflict reported", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("memory-review-desktop.png"), animations: "disabled" });
  await modal.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(modal.getByText("Memory accepted", { exact: true })).toBeVisible();
  expect(changes[0].body).toEqual({ operationId: expect.any(String), expectedRevision: 1, assertion: { context: "hypothetical", conflict: "reported" } });
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("memory-accepted-tablet.png"), animations: "disabled" });
  await modal.getByRole("button", { name: "Correct", exact: true }).click();
  const content = modal.getByRole("textbox", { name: "Memory", exact: true });
  await content.fill("Use British spelling and short paragraphs in my drafts.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.classList.add("dark"); document.documentElement.dataset.theme = "dark"; });
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("memory-correction-mobile.png"), animations: "disabled" });
  denied = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(modal.getByText("Memory access withdrawn", { exact: true })).toBeVisible();
  await expect(content).toHaveCount(0);
  await expect(modal.getByText("Use British spelling in my drafts.", { exact: true })).toHaveCount(0);
  denied = false;
  await modal.getByRole("button", { name: "Retry", exact: true }).click();
  await modal.getByRole("button", { name: "Correct", exact: true }).click();
  await content.fill("Use British spelling and short paragraphs in my drafts.");
  await modal.getByRole("button", { name: "Save correction", exact: true }).click();
  await expect(modal.getByText("Memory corrected", { exact: true })).toBeVisible();
  expect(changes[1]).toMatchObject({ method: "PATCH", path: `${path}/${memoryId}`, body: { expectedRevision: 2, content: "Use British spelling and short paragraphs in my drafts.", assertion: { context: "hypothetical", conflict: "reported" } } });
  await modal.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(modal.getByRole("heading", { name: "Forget memory?", exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(modal.getByText("No memories yet", { exact: true })).toBeVisible();
  expect(changes[2].body).toEqual({ operationId: expect.any(String), expectedRevision: 3 });
  expect(changes).toHaveLength(3);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(trigger).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("mock transport: draft changes require custom discard confirmation before navigation", async ({ page }) => {
  await fixture(page); await page.goto(`/app/agents/${agentId}?section=configuration`);
  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("Unsaved instructions");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible(); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue("Unsaved instructions");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes" }).click(); await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
});

test("mock transport: inline activity loads cursor-paged task events", async ({ page }) => {
  const { tasks } = await fixture(page);
  await page.route(`**/api/organizations/${org}/tasks/task-1`, route => route.fulfill({ json: { task: tasks[0], events: [{ sequence: 30, kind: "model_started" }], eventsNextCursor: "next-events", actions: [], children: [], resources: [], artifacts: [], operations: [] } }));
  await page.route(`**/api/organizations/${org}/tasks/task-1/events?*`, route => route.fulfill({ json: { events: [{ sequence: 31, kind: "event_page_loaded" }], nextCursor: null } }));
  await page.goto(`/app/agents/${agentId}`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Inspect activity."); await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/conversations\/conversation-1$/);
  await page.getByText("Event history", { exact: true }).click();
  await page.getByRole("button", { name: "Load more events" }).click();
  await expect(page.getByText("event page loaded", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Load more events" })).toHaveCount(0);
});


for (const [code, label] of [
  ["MODEL_UNAVAILABLE", "Model unavailable. Choose another model in Configure."],
  ["MODEL_AUTHENTICATION_FAILED", "Model authentication failed. Ask your administrator to check provider credentials."],
  ["MODEL_BILLING_REQUIRED", "Model provider credits required. Contact your administrator."],
  ["MODEL_ACCESS_DENIED", "Model access denied. Choose another model or contact your administrator."],
  ["MODEL_REQUEST_REJECTED", "Model request rejected. Check the model configuration."],
  ["MODEL_RATE_LIMITED", "Model rate limit reached. Try again shortly."],
  ["MODEL_CREDENTIAL_UNAVAILABLE", "Model credentials unavailable. Contact your administrator."],
  ["MODEL_UNRECOGNIZED_FAILURE_with_private_provider_text", "Model call failed. Try again or contact your administrator."],
]) {
  test(`mock transport: actionable model failure ${code} in chat and task details`, async ({ page }) => {
    await fixture(page, { errorCode: code });
    await page.goto(`/app/agents/${agentId}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hi");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText(/private_provider_text/)).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (code === "MODEL_UNAVAILABLE") await page.screenshot({ path: test.info().outputPath(`model-error-${width}.png`) });
    }
    await page.goto("/app/tasks/task-1");
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  });
}


test("mock transport: running subagent uses shared modal, retains parent and updates to final output", async ({ page }) => {
  const { tasks, posts } = await fixture(page, { child: true });
  await page.goto(`/app/agents/${agentId}`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Help us launch Wheelhouse.");
  await page.getByRole("button", { name: "Send message" }).click();
  const open = page.getByRole("button", { name: "Open Research activity", exact: true });
  await expect(open).toBeVisible();
  await open.click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
  const assignment = modal.locator("details[data-agent-assignment]");
  await expect(assignment).not.toHaveAttribute("open", "");
  await expect(assignment.getByText(specialistAssignment, { exact: true })).not.toBeVisible();
  await assignment.locator("summary").click();
  await expect(assignment.getByText(specialistAssignment, { exact: true })).toBeVisible();
  await expect(modal.getByText("I have read the launch brief and am checking the audience.", { exact: true })).toBeVisible();
  await modal.getByText("Read launch brief", { exact: true }).click();
  await expect(modal.getByText("Status", { exact: true })).toBeVisible();
  await expect(modal.getByRole("textbox")).toHaveCount(0);
  await modal.getByRole("button", { name: "Earlier activity", exact: true }).click();
  await expect(modal.getByText("Discover audience sources", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(tasks[0].state).toBe("running"); expect(posts).toHaveLength(1);
  await open.click();
  const themeSurfaces = new Map<string, string>();
  for (const theme of ["light", "dark"]) for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => { document.documentElement.classList.toggle("dark", value === "dark"); document.documentElement.dataset.theme = value; document.documentElement.classList.add("v-reduce-motion"); }, theme);
    const surface = await modal.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(surface).not.toBe("rgba(0, 0, 0, 0)");
    themeSurfaces.set(theme, surface);
    await expect(modal).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(modal.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`running-subagent-${theme}-${width}.png`), animations: "disabled" });
  }
  expect(themeSurfaces.get("light")).not.toBe(themeSurfaces.get("dark"));
  tasks[0].state = "completed"; tasks[0].output = "Launch work ready.";
  await expect(modal.getByText("Audience findings ready.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Launch work ready.", { exact: true })).toBeVisible();
  await expect(open).toBeFocused();
  expect(posts).toHaveLength(1);
});

test("mock transport: nested subagent modal keeps its task identity and live duration freezes on completion", async ({ page }) => {
  const { posts }=await fixture(page,{child:true});
  let finished=false;
  const clock="2026-11-02T10:00:00Z";
  await page.route(`**/api/organizations/${org}/tasks/child-1`,route=>route.fulfill({json:{task:{id:"child-1",state:"running",input:specialistAssignment,output:null,errorCode:null,conversationId:"child-conversation",elapsedMs:65000,observedAt:clock},operations:[],events:[],children:[{id:"grandchild-1",agentName:"Content",state:finished?"completed":"running",parentTaskId:"child-1",rootTaskId:"task-1"}],resources:[],artifacts:[],actions:[]}}));
  await page.route(`**/api/organizations/${org}/tasks/grandchild-1`,route=>route.fulfill({json:{task:{id:"grandchild-1",state:finished?"completed":"running",input:"Review the launch wording",output:finished?"The launch wording is ready.":null,errorCode:null,conversationId:"grandchild-conversation",elapsedMs:finished?22000:20000,observedAt:finished?"2026-11-02T10:00:02Z":clock},operations:[],events:[],children:[],resources:[],artifacts:[],actions:[]}}));
  await page.goto(`/app/agents/${agentId}`);
  await page.getByRole("textbox",{name:"Message",exact:true}).fill("Please review our launch.");
  await page.getByRole("button",{name:"Send message",exact:true}).click();
  const open=page.getByRole("button",{name:"Open Research activity",exact:true});
  await open.click();
  const modal=page.getByRole("dialog");
  const researchTime=modal.getByLabel("Execution time");
  await expect(researchTime).toContainText("1m 5s");
  await expect(researchTime).not.toContainText("1m 5s",{timeout:3000});
  await modal.getByRole("button",{name:"Open Content activity",exact:true}).click();
  await expect(modal.getByRole("heading",{name:"Content",exact:true})).toBeVisible();
  await expect(modal.getByLabel("Execution time")).toContainText("20s");
  await modal.getByRole("button",{name:"Back to previous agent",exact:true}).click();
  await expect(modal.getByRole("heading",{name:"Research",exact:true})).toBeVisible();
  await modal.getByRole("button",{name:"Open Content activity",exact:true}).click();
  finished=true;
  await expect(modal.getByText("The launch wording is ready.",{exact:true})).toBeVisible();
  await expect(modal.getByLabel("Execution time")).toContainText("22s");
  await page.waitForTimeout(1200);
  await expect(modal.getByLabel("Execution time")).toContainText("22s");
  await page.setViewportSize({width:390,height:844});
  expect(await modal.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath("nested-agent-duration-mobile.png"),animations:"disabled"});
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await open.click();
  await expect(modal.getByRole("button",{name:"Open Content activity",exact:true})).toBeVisible();
  expect(posts).toHaveLength(1);
});

test("mock transport: subagent access withdrawal clears its visible transcript", async ({ page }) => {
  await fixture(page, { child: true });
  await page.goto(`/app/agents/${agentId}`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Help us launch Wheelhouse.");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Open Research activity", exact: true }).click();
  const modal = page.getByRole("dialog");
  const assignment = modal.locator("details[data-agent-assignment]");
  await assignment.locator("summary").click();
  await expect(assignment.getByText(specialistAssignment, { exact: true })).toBeVisible();
  await page.route("**/tasks/child-1", route => route.fulfill({ status: 403, json: { error: { message: "Access withdrawn" } } }));
  await expect(modal.getByText("Access withdrawn", { exact: true })).toBeVisible();
  await expect(modal.locator("details[data-agent-assignment]")).toHaveCount(0);
  await expect(modal.getByText(specialistAssignment, { exact: true })).toHaveCount(0);
  await expect(modal.getByText("Read launch brief", { exact: true })).toHaveCount(0);
});


test("mock transport: active instructions use the shared composer and preserve retry identity", async ({ page }) => {
  const { tasks, posts } = await fixture(page, { child: true, steer: true });
  const instructions: Array<{ instruction: string; requestKey: string }> = [];
  await page.route("**/tasks/task-1/instructions", async route => {
    instructions.push(route.request().postDataJSON());
    await route.fulfill(instructions.length === 1 ? { status: 503, json: { error: { message: "Temporary interruption" } } } : { json: { accepted: true } });
  });
  await page.goto(`/app/agents/${agentId}`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Help us launch Wheelhouse.");
  await page.getByRole("button", { name: "Send message" }).click();
  const composer = page.getByRole("textbox", { name: "Update instructions", exact: true });
  await composer.fill("Focus on commuters who travel by train.");
  await page.getByRole("button", { name: "Queue instructions", exact: true }).click();
  await expect(page.getByText("Temporary interruption", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Focus on commuters who travel by train.");
  await page.getByRole("button", { name: "Queue instructions", exact: true }).click();
  await expect(composer).toHaveValue("");
  expect(instructions).toHaveLength(2); expect(instructions[0]).toEqual(instructions[1]);
  expect(posts).toHaveLength(1); expect(tasks).toHaveLength(1);
});


test("mock transport: specialist modal stays read-only when its work needs review", async ({ page }) => {
  await fixture(page, { child: true });
  let reviewRequests = 0;
  page.on("request", request => { if (request.url().includes("/tasks/child-1/tool-reviews")) reviewRequests++; });
  await page.route("**/tasks/child-1", route => route.fulfill({ json: { task: { id: "child-1", state: "waiting_review", input: "Check the launch audience.", output: null, errorCode: null, conversationId: "child-conversation", hasToolReviews: true }, operations: [], children: [], events: [], actions: [] } }));
  await page.goto(`/app/agents/${agentId}`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Help us launch Wheelhouse.");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Open Research activity", exact: true }).click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(modal.getByRole("link", { name: "Open task", exact: true })).toHaveAttribute("href", "/app/tasks/child-1");
  await expect(modal.getByRole("button", { name: /Approve|Reject|Cancel task|Continue task/ })).toHaveCount(0);
  expect(reviewRequests).toBe(0);
});
