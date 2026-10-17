import { test, expect, type Page } from "@playwright/test";

const cookie = process.env.AGENTS_BROWSER_SESSION_COOKIE;
const mockOrg = "11111111-1111-4111-8111-111111111111";
const mockAgent = "22222222-2222-4222-8222-222222222222";
const mockKnowledge = "33333333-3333-4333-8333-333333333333";
const mockVersion = "44444444-4444-4444-8444-444444444444";
const mockDeployment = "55555555-5555-4555-8555-555555555555";
const instructions = "Answer questions using approved knowledge.";
const configuration = {
  executionKind: "business", instructions,
  model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 },
  knowledgeIds: [] as string[],
  capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])),
};

async function createAgent(page: Page, name: string) {
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}
async function addKnowledge(page: Page, title: string, content: string) {
  await page.getByRole("link", { name: "Knowledge", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Content", exact: true }).fill(content);
  await page.getByRole("button", { name: "Approve source" }).click();
  await expect(page.getByText("Knowledge approved", { exact: true })).toBeVisible();
}
async function openAgent(page: Page, name: string) {
  await page.getByRole("link", { name: "Agents", exact: true }).last().click();
  await page.getByRole("link", { name: `${name} Open →` }).click();
}
async function attachKnowledge(page: Page, title: string) {
  await page.getByRole("checkbox", { name: new RegExp(title) }).check();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByText("Configuration saved", { exact: true })).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

// This validates browser behavior with simulated responses. It is not backend acceptance.
test("mock transport: draft isolation, immutable versions, task reconnect, explicit publication, mobile public chat", async ({ page }) => {
  let agent: { id: string; name: string; draft: typeof configuration; draftRevision: number; updatedAt: string } | null = null;
  const knowledge: { id: string; title: string; content: string; visibility: string }[] = [];
  const versions: { id: string; number: number; configuration: typeof configuration }[] = [];
  const deployments: { id: string; versionId: string; allowedOrigins: string[] }[] = [];
  let task: { id: string; state: string; output: string | null; errorCode: null; conversationId: string; input: string; requestKey: string } | null = null;
  let privatePosts = 0, publicPosts = 0, visitorSessions = 0, taskGets = 0;
  let complete = false;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = ["POST", "PUT"].includes(method) ? request.postDataJSON() : {};
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "test-owner", email: "owner@example.com", displayName: "Owner" }, organizations: [{ id: mockOrg, name: "Acme", role: "owner" }] };
    else if (path.endsWith("/knowledge")) { if (method === "POST") { const source = { id: mockKnowledge, ...body }; knowledge.push(source); data = { knowledge: source }; } else data = { knowledge }; }
    else if (path === `/api/organizations/${mockOrg}/agents`) { if (method === "POST") { agent = { id: mockAgent, name: body.name, draft: structuredClone(configuration), draftRevision: 1, updatedAt: new Date().toISOString() }; data = { agent }; } else data = { agents: agent ? [agent] : [] }; }
    else if (path.endsWith(`/agents/${mockAgent}`)) { if (method === "PUT") { expect(body.expectedRevision).toBe(agent!.draftRevision); agent = { ...agent!, name: body.name, draft: body.configuration, draftRevision: agent!.draftRevision + 1 }; } data = { agent, versions, deployments }; }
    else if (path.endsWith("/versions")) { const version = { id: mockVersion, number: 1, configuration: structuredClone(agent!.draft) }; versions.push(version); data = { version }; }
    else if (path.endsWith("/deployments")) { const deployment = { id: mockDeployment, ...body }; deployments.push(deployment); data = { deployment }; }
    else if (path === `/api/website/${mockDeployment}`) data = { name: agent!.name };
    else if (path.endsWith("/session")) { visitorSessions++; data = { token: "visitor-token" }; }
    else if (path.endsWith("/tasks") && method === "POST") { if (path.includes("/website/")) publicPosts++; else privatePosts++; task = { id: path.includes("/website/") ? "public-task" : "private-task", state: "accepted", output: null, errorCode: null, conversationId: "conversation", input: body.input, requestKey: body.requestKey }; data = { task }; }
    else if (path.includes("/conversations/")) data = { tasks: task ? [task] : [] };
    else if (path.includes("/tasks/")) { taskGets++; task = { ...task!, state: complete || path.includes("/website/") ? "completed" : "running", output: complete || path.includes("/website/") ? "Returns are accepted within 30 days." : null }; data = { task, events: [] }; }
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto("/app/agents");
  await createAgent(page, "Acme Support");
  await addKnowledge(page, "Returns", "Returns are accepted within 30 days.");
  await openAgent(page, "Acme Support");
  await attachKnowledge(page, "Returns");
  expect(deployments).toHaveLength(0);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: "Create test version" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("What is the return policy?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/^running/)).toBeVisible();
  expect(privatePosts).toBe(1); expect(deployments).toHaveLength(0);
  await page.reload();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText("What is the return policy?", { exact: true })).toBeVisible();
  complete = true;
  await expect(page.getByText("Returns are accepted within 30 days.", { exact: true })).toBeVisible();
  expect(privatePosts).toBe(1); expect(taskGets).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish website", exact: true }).click();
  await page.getByRole("textbox", { name: "Allowed website origins" }).fill("https://example.com");
  await page.getByRole("button", { name: "Publish version", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open website chat" })).toBeVisible();
  expect(deployments).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Configuration", exact: true })).toHaveAttribute("aria-current", "page");
  await noOverflow(page);
  await page.goto(`/chat/${mockDeployment}`);
  await page.getByRole("textbox", { name: "Message" }).fill("Returns?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Returns are accepted within 30 days.", { exact: true })).toBeVisible();
  expect(publicPosts).toBe(1); expect(visitorSessions).toBe(1);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("live platform: authenticated knowledge, private reply, task recovery and published website reply", async ({ page, context, baseURL }) => {
  test.skip(!cookie, "Set AGENTS_BROWSER_SESSION_COOKIE for a private local fixture account; this test uses real services.");
  const separator = cookie!.indexOf("=");
  const name = separator > 0 ? cookie!.slice(0, separator) : new URL(baseURL!).protocol === "https:" ? "__Host-agents_session" : "agents_session";
  const value = separator > 0 ? cookie!.slice(separator + 1) : cookie!;
  await context.addCookies([{ name, value, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/app/agents");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  if (await page.getByRole("combobox", { name: "Workspace" }).count()) await page.getByRole("combobox", { name: "Workspace" }).selectOption("new");
  else await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const suffix = Date.now().toString(36);
  await page.getByRole("textbox", { name: "Workspace name" }).fill(`Browser verification ${suffix}`);
  await page.getByRole("dialog").getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  const agentName = `FAQ ${suffix}`;
  await createAgent(page, agentName);
  const editorUrl = page.url();
  await addKnowledge(page, `Returns ${suffix}`, "Acme accepts returns within 30 days with a receipt.");
  await openAgent(page, agentName);
  await attachKnowledge(page, `Returns ${suffix}`);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: "Create test version" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("How many days do I have to return an item?");
  let taskId = "";
  const admitted = page.waitForResponse(response => /\/tasks$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const admittedResponse = await admitted; expect(admittedResponse.ok()).toBe(true); taskId = (await admittedResponse.json()).task.id;
  let resubmitted = false;
  const listener = (request: import("@playwright/test").Request) => { if (request.method() === "POST" && /\/tasks$/.test(new URL(request.url()).pathname)) resubmitted = true; };
  page.on("request", listener);
  await page.reload();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText(/30\s+days|thirty\s+days/i)).toBeVisible({ timeout: 120_000 });
  await page.getByText("Task details", { exact: true }).click();
  await expect(page.getByText(taskId, { exact: true })).toBeVisible();
  expect(resubmitted).toBe(false); page.off("request", listener);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish website", exact: true }).click();
  await page.getByRole("textbox", { name: "Allowed website origins" }).fill(process.env.AGENTS_BROWSER_WIDGET_ORIGIN ?? "http://127.0.0.1:4398");
  await page.getByRole("button", { name: "Publish version", exact: true }).click();
  const link = page.getByRole("link", { name: "Open website chat" });
  await expect(link).toBeVisible();
  const publicPath = await link.getAttribute("href");
  await page.getByText("Embed code", { exact: true }).click();
  await expect(page.locator("code").filter({ hasText: "/widget.js" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("publication.png"), fullPage: true });
  await page.goto(publicPath!);
  await page.getByRole("textbox", { name: "Message" }).fill("What is the return window?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/30\s+days|thirty\s+days/i)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
  await page.screenshot({ path: test.info().outputPath("public-mobile.png"), fullPage: true });
  if (process.env.AGENTS_BROWSER_WIDGET_ORIGIN) {
    const deploymentId = publicPath!.split("/").at(-1)!;
    const denied = await page.request.post(`/api/website/${deploymentId}/session`, { data: {}, headers: { origin: "https://unapproved.example" } });
    expect(denied.status()).toBe(403);
    await page.goto(`${process.env.AGENTS_BROWSER_WIDGET_ORIGIN}/?deployment=${deploymentId}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("How long do returns take?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(/30\s+days|thirty\s+days/i)).toBeVisible({ timeout: 120_000 });
    await noOverflow(page);
    await page.screenshot({ path: test.info().outputPath("external-widget-mobile.png"), fullPage: true });
    const recoveredTaskIds: string[] = [];
    const requestKeys: string[] = [];
    const taskEndpoint = `**/api/website/${deploymentId}/tasks`;
    await page.route(taskEndpoint, async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      requestKeys.push(route.request().postDataJSON().requestKey);
      const accepted = await route.fetch();
      expect(accepted.ok()).toBe(true);
      recoveredTaskIds.push((await accepted.json()).task.id);
      if (recoveredTaskIds.length === 1) await route.abort("failed");
      else await route.fulfill({ response: accepted });
    });
    await page.getByRole("textbox", { name: "Message" }).fill("Do I need a receipt?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry request", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    expect(recoveredTaskIds).toHaveLength(1);
    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry request", exact: true })).toBeVisible();
    expect(recoveredTaskIds).toHaveLength(1);
    await page.getByRole("button", { name: "Retry request", exact: true }).click();
    await expect(page.getByText(/30\s+days|thirty\s+days/i)).toBeVisible({ timeout: 120_000 });
    expect(recoveredTaskIds).toHaveLength(2);
    expect(recoveredTaskIds[1]).toBe(recoveredTaskIds[0]);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    await page.unroute(taskEndpoint);
    await page.screenshot({ path: test.info().outputPath("external-widget-recovered-mobile.png"), fullPage: true });
    console.log(`Lost widget response recovered original task ${recoveredTaskIds[0]} after reload and explicit retry`);
  }
  console.log(`Verified editor ${editorUrl}; private task ${taskId}; published ${publicPath}`);
});
