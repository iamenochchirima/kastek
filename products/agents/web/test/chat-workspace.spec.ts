import { test, expect, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222", versionId = "44444444-4444-4444-8444-444444444444";
const configuration = { executionKind: "business", instructions: "Help briefly.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) };
type Task = { id: string; versionId: string; input: string; output: string | null; requestKey: string; conversationId: string; turnSequence: number; state: string; errorCode: string | null };
async function fixture(page: Page, options: { unknown?: boolean; versions?: boolean; errorCode?: string } = {}) {
  const tasks: Task[] = [], posts: Record<string, unknown>[] = [];
  let unknown = options.unknown;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method(), body = request.postData() ? request.postDataJSON() : {};
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ id: agentId, name: "Research assistant", latestVersion: { id: versionId, number: 1 }, hasUnpublishedChanges: false }], nextCursor: null };
    else if (path.endsWith(`/agents/${agentId}`)) data = { agent: { id: agentId, name: "Research assistant", draft: configuration, draftRevision: 1 }, versions: [{ id: versionId, number: 1, configuration }, ...(options.versions ? [{ id: "version-2", number: 2, configuration }] : [])], deployments: [] };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [...new Set(tasks.map(t => t.conversationId))].map(id => ({ id, agentId, agentName: "Research assistant", versionId, versionNumber: 1, title: tasks.find(t => t.conversationId === id)!.input, updatedAt: "2026-10-18T12:00:00Z", state: "completed" })), nextCursor: null };
    else if (path.includes("/conversations/")) { const id = path.split("/").at(-1); data = { tasks: tasks.filter(t => t.conversationId === id), conversation: { id, versionId: tasks.find(t => t.conversationId === id)?.versionId ?? versionId, versionNumber: 1 }, nextCursor: null }; }
    else if (path.endsWith("/tasks") && method === "POST") {
      posts.push(body);
      const existing = tasks.find(t => t.requestKey === body.requestKey);
      const task = existing ?? { id: `task-${tasks.length + 1}`, input: body.input, output: options.errorCode ? null : tasks.length ? "Your project is ORCHID-17." : "**Hello.** [Unsafe](javascript:alert(1))\n\n```text\n<script>window.injected=true</script>\n```", requestKey: body.requestKey, conversationId: body.conversationId ?? `conversation-${tasks.length + 1}`, versionId, turnSequence: tasks.length + 1, state: options.errorCode ? "failed" : "completed", errorCode: options.errorCode ?? null };
      if (!existing) tasks.push(task);
      if (unknown) { unknown = false; await route.abort("failed"); return; }
      data = { task };
    }
    else if (path.endsWith("/tasks")) data = { tasks: tasks.map(t => ({ ...t, agentId, agentName: "Research assistant", versionNumber: 1, createdAt: "2026-10-18T12:00:00Z", updatedAt: "2026-10-18T12:00:00Z", canControl: true, reviewOnly: false })), nextCursor: null };
    else if (/\/tasks\/[^/]+$/.test(path)) data = { task: tasks.find(t => path.endsWith(t.id)), events: [], operations: [], actions: [], children: [], resources: [], artifacts: [] };
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
  await page.getByRole("link", { name: /Research assistant/ }).click();
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
  await page.getByText("Task details", { exact: true }).click(); await page.getByText("Event history", { exact: true }).click();
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
    await expect(page.getByText(`failed · ${label}`, { exact: true })).toBeVisible();
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
