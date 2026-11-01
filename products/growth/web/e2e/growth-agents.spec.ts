import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "kasitek_active_org", value: "growth-fixture-one", domain: "127.0.0.1", path: "/" }]);
});

test("uses one conversation from quick access, full page and history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your agents", exact: true }).getByRole("article")).toHaveCount(4);
  await expect(page.getByText("Approved sources required")).toBeVisible();
  await page.screenshot({ path: "../../../.audit/growth-agents-overview-desktop.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
  const chat = page.getByRole("region", { name: "Agent conversation" });
  await expect(chat.getByText("What should we work on?", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../../../.audit/growth-agents-assistant-desktop.png", fullPage: true, animations: "disabled" });
  await chat.getByRole("textbox", { name: "Message agent" }).fill("Help me prioritize this week");
  await chat.getByRole("button", { name: "Send message" }).click();
  await expect(chat.getByText("I reviewed the business context. Here is the next step for your work.", { exact: true })).toBeVisible();
  await chat.getByRole("link", { name: "Expand conversation" }).click();
  await expect(page).toHaveURL(/\/agents\/conversations\//);
  await page.reload();
  await expect(page.getByRole("paragraph").filter({ hasText: /^Help me prioritize this week$/ })).toBeVisible();
  await page.getByRole("link", { name: "Agents", exact: true }).last().click();
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  await page.getByRole("textbox", { name: "Search conversations" }).fill("prioritize");
  await expect(page.getByRole("link", { name: /Help me prioritize this week/ })).toBeVisible();
});

test("retries a lost acknowledgement with the same request identity", async ({ page, request }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  await page.getByRole("textbox", { name: "Message agent" }).fill("lost response for safe retry");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Retry message" })).toBeVisible();
  await page.getByRole("button", { name: "Retry message" }).click();
  await expect(page.getByRole("button", { name: "Retry message" })).toHaveCount(0);
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const attempts = state.attempts.filter((attempt: { text: string }) => attempt.text === "lost response for safe retry");
  expect(attempts).toHaveLength(2);
  expect(attempts[0].requestId).toBe(attempts[1].requestId);
});

test("shows the saved-record receipt after editing the exact proposal", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Content Draft and improve/ }).click();
  await page.getByRole("textbox", { name: "Message agent" }).fill("Prepare a draft for review");
  await page.getByRole("button", { name: "Send message" }).click();
  const review = page.getByRole("region", { name: "Draft review" });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Edit", exact: true }).click();
  await review.getByRole("textbox", { name: "Content", exact: true }).fill("Updated weekend offer for our customers.");
  await expect(review.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
  await review.getByRole("button", { name: "Update proposal" }).click();
  await review.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(review.getByRole("link", { name: "Open draft", exact: true })).toHaveAttribute("href", "/content/posts/saved-fixture-draft");
});

for (const width of [768, 390]) test(`supports keyboard and full-screen chat at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/agents");
  await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Growth assistant", exact: true });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `../../../.audit/growth-agents-assistant-${width}.png`, fullPage: false, animations: "disabled" });
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(width);
  await page.setViewportSize({ width, height: 500 });
  await expect.poll(async () => { const composer = await dialog.getByRole("textbox", { name: "Message agent" }).boundingBox(); return composer ? composer.y + composer.height : Infinity; }).toBeLessThanOrEqual(500);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Open Growth assistant", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("clears previous business content before loading another business", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agents");
  await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Luma Studio", exact: false }).first().click();
  await page.getByRole("menuitem", { name: "Another business", exact: false }).click();
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByText("Second business conversation", { exact: true })).toBeVisible();
  await expect(page.getByText("What should we work on?", { exact: true })).toHaveCount(0);
});

test("rejects foreign and forwarded origins when switching business", async ({ request }) => {
  const response = await request.post("/api/orgs/set-active", { headers: { origin: "https://untrusted.example", "x-forwarded-host": "untrusted.example", "x-forwarded-proto": "https" }, data: { orgId: "growth-fixture-two" } });
  expect(response.status()).toBe(403);
  const spoofed = await request.post("/api/orgs/set-active", { headers: { origin: "http://127.0.0.1:3310", host: "untrusted.example" }, data: { orgId: "growth-fixture-two" } });
  expect(spoofed.status()).toBe(403);
});

test("starts campaign work with explicit context and preserves it when the user changes pages", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/campaigns/fixture-campaign");
  await page.getByRole("button", { name: "Ask agent", exact: true }).click();
  const chat = page.getByRole("region", { name: "Agent conversation" });
  await expect(chat.getByText("Weekend campaign", { exact: true })).toBeVisible();
  const expand = chat.getByRole("link", { name: "Expand conversation" });
  const destination = await expand.getAttribute("href");
  expect(destination).toMatch(/^\/agents\/conversations\//);
  const original = new URL(destination!, page.url()).href;
  await expand.click();
  await expect(page).toHaveURL(original);
  await page.getByRole("button", { name: "Change context" }).click();
  await page.getByRole("button", { name: "Use Luma Studio", exact: true }).click();
  await expect(page).not.toHaveURL(original);
  await expect(page.getByRole("region", { name: "Agent conversation" }).getByText("Current business", { exact: true })).toBeVisible();
  await page.goto(original);
  await expect(page.getByRole("region", { name: "Agent conversation" }).getByText("Weekend campaign", { exact: true })).toBeVisible();
});

test("opens the Content agent from an actual post page", async ({ page }) => {
  await page.goto("/content/posts/fixture-post");
  await page.getByRole("button", { name: "Improve draft", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent conversation" }).getByText("Summer post", { exact: true })).toBeVisible();
});

test("attaches the selected report range when analysing results", async ({ page, request }) => {
  await request.post("http://127.0.0.1:4310/__fixture/research", { data: { ready: true } });
  try {
    await page.goto("/analytics");
    await page.getByRole("button", { name: "Analyse results", exact: true }).click();
    await expect(page.getByRole("region", { name: "Agent conversation" }).getByText("Overview report", { exact: true })).toBeVisible();
    const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
    const conversation = state.conversations.findLast((item: { featureId: string }) => item.featureId === "research");
    expect(conversation.context).toMatchObject({ kind: "analytics_report", resourceId: "overview.summary@1", range: { timezone: "UTC" } });
    expect(conversation.context.range.from).toBeTruthy();
    expect(conversation.context.range.to).toBeTruthy();
  } finally { await request.post("http://127.0.0.1:4310/__fixture/research", { data: { ready: false } }); }
});

test("cancels accepted work explicitly and keeps the task visible", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  await page.getByRole("textbox", { name: "Message agent" }).fill("keep working until I cancel");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent conversation" }).getByText("Cancelled", { exact: true })).toBeVisible();
});

test("shows unavailable separately from an empty list and recovers", async ({ page }) => {
  await page.route("**/api/agents/bootstrap", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) }));
  await page.goto("/agents");
  await expect(page.getByRole("alert").filter({ hasText: "Agents are unavailable" })).toBeVisible();
  await expect(page.getByText("No conversations yet", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/agents/bootstrap");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your agents", exact: true })).toBeVisible();
});

test("keeps the Agents workspace readable in dark theme", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("kasitek-theme", "dark"));
  await page.goto("/agents");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("region", { name: "Your agents", exact: true })).toBeVisible();
  await page.screenshot({ path: "../../../.audit/growth-agents-overview-dark.png", animations: "disabled", fullPage: true });
});

test("discards a delayed response from the previous business", async ({ page }) => {
  let started!: () => void;
  let released!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const responseReleased = new Promise<void>((resolve) => { released = resolve; });
  await page.route("**/api/agents/conversations?**", async (route) => {
    if ((route.request().headers().cookie || "").includes("growth-fixture-one")) {
      const response = await route.fetch();
      started();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fulfill({ response }).catch(() => undefined);
      released();
    } else await route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agents");
  await requestStarted;
  await page.getByRole("button", { name: "Luma Studio", exact: false }).first().click();
  await page.getByRole("menuitem", { name: "Another business", exact: false }).click();
  await expect(page.getByText("Second business conversation", { exact: true })).toBeVisible();
  await responseReleased;
  await expect(page.getByText("Second business conversation", { exact: true })).toBeVisible();
  await expect(page.getByText("Plan this week's work", { exact: true })).toHaveCount(0);
});

test("paginates conversations without replacing the current search results", async ({ page }) => {
  await page.route("**/api/agents/conversations?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("limit") !== "30") return route.continue();
    const older = url.searchParams.get("cursor") === "older";
    const id = older ? "older-conversation" : "recent-conversation";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [{ id, featureId: "assistant", title: older ? "Earlier planning" : "Recent planning", context: null, createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z" }], nextCursor: older ? null : "older" }) });
  });
  await page.goto("/agents");
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  await expect(page.getByText("Recent planning", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText("Earlier planning", { exact: true })).toBeVisible();
  await expect(page.getByText("Recent planning", { exact: true })).toBeVisible();
});

test("recovers task observation with a cursor without submitting another turn", async ({ page, request }) => {
  let interrupted = false;
  const cursors: Array<string | null> = [];
  await page.route("**/api/agents/tasks/*/events**", async (route) => {
    cursors.push(new URL(route.request().url()).searchParams.get("cursor"));
    if (!interrupted) { interrupted = true; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Transient event failure" }) }); }
    return route.continue();
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  await page.getByRole("textbox", { name: "Message agent" }).fill("keep working through reconnect");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Reconnecting. Your task continues in the background.", { exact: true })).toBeVisible();
  await expect.poll(() => cursors.includes("working"), { timeout: 12000 }).toBe(true);
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  expect(state.attempts.filter((attempt: { text: string }) => attempt.text === "keep working through reconnect")).toHaveLength(1);
});

test("chooses business context before creating a conversation", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("combobox", { name: "Context", exact: true }).click();
  await page.getByRole("option", { name: "Luma Studio", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  await expect(page.getByRole("region", { name: "Agent conversation" }).getByText("Current business", { exact: true })).toBeVisible();
});

test("organisation defaults show setup progress and become usable without a reload", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/agents/bootstrap", async route => {
    const response = await route.fetch();
    const bootstrap = await response.json();
    reads += 1;
    if (reads === 1) {
      bootstrap.setup = { state: "pending", code: null, updatedAt: new Date().toISOString() };
      bootstrap.features = bootstrap.features.map((feature: Record<string, unknown>) => ({ ...feature, ready: false, reasons: [{ code: "agent_setup_pending", message: "Setting up" }] }));
    } else bootstrap.setup = { state: "ready", code: null, updatedAt: new Date().toISOString() };
    await route.fulfill({ response, json: bootstrap });
  });
  await page.goto("/agents");
  await expect(page.getByText("Setting up", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Chat", exact: true }).first()).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Chat", exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Message agent" })).toBeVisible();
});

test("blocked organisation setup stops automatic refresh and keeps all defaults visible", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/agents/bootstrap", async route => {
    const response = await route.fetch();
    const bootstrap = await response.json();
    reads += 1;
    bootstrap.setup = { state: "blocked", code: "MODEL_PROFILE_UNAVAILABLE", updatedAt: new Date().toISOString() };
    bootstrap.features = bootstrap.features.map((feature: Record<string, unknown>) => ({ ...feature, ready: false, reasons: [{ code: "agent_setup_blocked", message: "Setup needs attention" }] }));
    await route.fulfill({ response, json: bootstrap });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agents");
  await expect(page.getByText("Setup needs attention", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await page.waitForTimeout(2600);
  expect(reads).toBe(1);
});

for (const width of [1440, 768, 390]) test(`coordinates visible specialist work and queues a safe active follow-up at ${width}px`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  if (width === 390) await page.addInitScript(() => localStorage.setItem("kasitek-theme", "dark"));
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  const initial = `keep working for orchestration ${width}`;
  await chat.getByRole("textbox", { name: "Message agent" }).fill(initial);
  await chat.getByRole("button", { name: "Send message" }).click();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((task: { input: string }) => task.input === initial);
  expect(task).toBeTruthy();
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, loseInstructionAcknowledgement: true } });
  const progress = chat.getByRole("region", { name: "Work progress", exact: true });
  await expect(progress.getByText("Compare specialist drafts", { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(progress.getByRole("region", { name: "Specialist work", exact: true }).getByText("Research", { exact: true })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
  await chat.getByRole("button", { name: "View Research result", exact: true }).click();
  const result = page.getByRole("dialog", { name: "Research result", exact: true });
  await expect(result.getByText(/Verified specialist findings/)).toBeVisible();
  await result.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(result.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
  await expect(result.getByRole("heading", { name: "Research result", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`specialist-result-${width}.png`), animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(result).toHaveCount(0);
  await chat.getByRole("textbox", { name: "Message agent" }).fill("Focus on existing customers.");
  await chat.getByRole("button", { name: "Send instructions", exact: true }).click();
  await expect(chat.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toHaveValue("Focus on existing customers.");
  await chat.getByRole("button", { name: "Retry message", exact: true }).click();
  await expect(page.getByText("Instructions queued", { exact: true })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toHaveValue("");
  const accepted = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const attempts = accepted.instructionAttempts.filter((attempt: { taskId: string }) => attempt.taskId === task.id);
  expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
  expect(accepted.tasks.filter((item: { conversationId: string }) => item.conversationId === task.conversationId)).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath(`specialist-progress-${width}.png`), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "waiting_authority", canContinue: true, canSteer: false } });
  await expect(chat.getByRole("button", { name: "Continue", exact: true })).toBeVisible({ timeout: 12000 });
  await chat.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
  await chat.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Stop task", exact: true }).click();
  await expect(chat.getByText("Cancelled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close assistant", exact: true }).click();
  await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
  await expect(chat.getByText("Cancelled", { exact: true })).toBeVisible();
});


test("model interruption keeps the conversation usable without implying an external action or unsupported resume", async ({ page, request }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  await chat.getByRole("textbox", { name: "Message agent" }).fill("keep working before interruption");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((item: {input: string}) => item.input === "keep working before interruption");
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "uncertain", errorCode: "MODEL_REQUEST_FAILED", canSteer: false, canContinue: false } });
  await expect(chat.getByText("The model response was interrupted. Review completed work before continuing.", { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(chat.getByText(/An action may have completed/)).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
  await chat.getByRole("textbox", { name: "Message agent" }).fill("Use the available findings to finish the answer.");
  await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const older = chat.locator(`[data-task-id="${task.id}"]`);
  await expect(older.getByText("The model response was interrupted. Review completed work before continuing.", { exact: true })).toBeVisible();
  const lastMessage = chat.locator('[data-role="user"]').last();
  expect(await lastMessage.evaluate((element, oldId) => Boolean(document.querySelector(`[data-task-id="${oldId}"]`)?.compareDocumentPosition(element)! & Node.DOCUMENT_POSITION_FOLLOWING), task.id)).toBe(true);
});

test("new conversation retries creation instead of reopening the saved conversation", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  await chat.getByRole("textbox", { name: "Message agent" }).fill("An existing conversation");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(chat.locator('[data-role="user"]').getByText("An existing conversation", { exact: true })).toBeVisible();
  await chat.getByRole("link", { name: "Expand conversation", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/conversations\//);
  await expect(chat.locator('[data-role="user"]').getByText("An existing conversation", { exact: true })).toBeVisible();
  let fail = true;
  const identities: string[] = [];
  await page.route("**/api/agents/conversations", async route => {
    if (route.request().method() !== "POST") return route.continue();
    identities.push(route.request().postDataJSON().requestId);
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: "Unavailable" } }); }
    return route.continue();
  });
  await chat.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(chat.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
  await expect(chat.getByText("An existing conversation", { exact: true })).toHaveCount(0);
  expect(identities).toHaveLength(2); expect(identities[0]).toBe(identities[1]);
});


test("expanded new conversation adopts the first prompt title without clearing a subsequent draft", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  await chat.getByRole("link", { name: "Expand conversation", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/conversations\//);
  await expect(chat.getByRole("heading", { name: "New conversation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Growth assistant", exact: true })).toHaveCount(0);
  await chat.getByRole("textbox", { name: "Message agent" }).fill("Plan an autumn campaign");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(chat.getByRole("heading", { name: "Plan an autumn campaign", exact: true })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
  await chat.getByRole("textbox", { name: "Message agent" }).fill("Keep this unsent follow-up");
  await page.waitForTimeout(3500);
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toHaveValue("Keep this unsent follow-up");
  await page.screenshot({ path: test.info().outputPath("conversation-title-and-draft.png"), animations: "disabled" });
});


for (const failure of [
  { state: "failed", code: "CAPACITY_WAIT_EXPIRED", label: "The task waited too long to start. Try a new message." },
  { state: "uncertain", code: "CHILD_OUTCOME_UNCERTAIN", label: "A specialist outcome could not be confirmed. Review its result before repeating work." },
]) test(`shows actionable ${failure.code} feedback`, async ({ page, request }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  const prompt = `keep working for ${failure.code}`;
  await chat.getByRole("textbox", { name: "Message agent" }).fill(prompt);
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === prompt);
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: failure.state, errorCode: failure.code, canSteer: false, canContinue: false } });
  await expect(chat.getByText(failure.label, { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(chat.getByText(/An action may have completed/)).toHaveCount(0);
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
  await expect(chat.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
});

for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"]) test(`continues preserved work at ${width}px in ${theme} theme`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  const prompt = `keep working on a launch ${width} ${theme}`;
  await chat.getByRole("textbox", { name: "Message agent" }).fill(prompt);
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === prompt);
  expect(task).toBeTruthy();
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "incomplete", errorCode: "ORCHESTRATION_STALLED", canSteer: false, canContinue: true } });
  await page.evaluate(value => { document.documentElement.classList.toggle("dark", value === "dark"); document.documentElement.style.colorScheme = value; }, theme);
  const original = chat.locator(`[data-task-id="${task.id}"]`);
  await expect(original.getByText("Progress paused after repeated unsuccessful attempts.", { exact: true })).toBeVisible({ timeout: 12000 });
  const resume = original.getByRole("button", { name: "Continue", exact: true });
  await expect(resume).toBeVisible();
  await resume.scrollIntoViewIfNeeded();
  await resume.focus();
  await expect(resume).toBeFocused();
  const bounds = await resume.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  expect(bounds!.height).toBeGreaterThanOrEqual(width < 640 ? 44 : 32);
  await page.screenshot({ path: `../../../.audit/growth-agent-continuation-${width}-${theme}.png`, animations: "disabled" });
  await page.keyboard.press("Enter");
  await expect(original.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  const after = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const successor = after.tasks.find((item: { priorTaskId?: string }) => item.priorTaskId === task.id);
  expect(successor.id).not.toBe(task.id);
  expect(after.tasks.find((item: { id: string }) => item.id === task.id).state).toBe("incomplete");
  await expect(chat.locator(`[data-task-id="${successor.id}"]`)).toBeVisible();
  await chat.getByRole("link", { name: "Expand conversation", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/conversations\//);
  await page.reload();
  await expect(chat.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(original.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("retries continuation with one request identity", async ({ page, request }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  await chat.getByRole("textbox", { name: "Message agent" }).fill("keep working for continuation retry");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === "keep working for continuation retry");
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "incomplete", errorCode: "ORCHESTRATION_STALLED", canSteer: false, canContinue: true } });
  const original = chat.locator(`[data-task-id="${task.id}"]`);
  await expect(original.getByText("Progress paused after repeated unsuccessful attempts.", { exact: true })).toBeVisible({ timeout: 12000 });
  const identities: string[] = [];
  await page.route(`**/api/agents/tasks/${task.id}/continue`, async route => {
    identities.push(route.request().postDataJSON().requestId);
    if (identities.length === 1) return route.fulfill({ status: 503, json: { error: "Temporary interruption" } });
    return route.continue();
  });
  await original.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(chat.getByRole("alert")).toBeVisible();
  await original.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(chat.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  expect(identities).toHaveLength(2);
  expect(identities[0]).toBe(identities[1]);
  const after = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  expect(after.tasks.filter((item: { priorTaskId?: string }) => item.priorTaskId === task.id)).toHaveLength(1);
});

test("shows a binding call limit without offering unsupported continuation", async ({ page, request }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  await chat.getByRole("textbox", { name: "Message agent" }).fill("keep working to a configured limit");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === "keep working to a configured limit");
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "incomplete", errorCode: "ROOT_MODEL_CALL_LIMIT", canSteer: false, canContinue: false } });
  const original = chat.locator(`[data-task-id="${task.id}"]`);
  await expect(original.getByText("This work reached its shared model request limit.", { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(chat.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
});

for (const width of [1440, 390]) test(`keeps a loading specialist result open when the root completes at ${width}px`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  const input = `keep working result transition ${width}`;
  await chat.getByRole("textbox", { name: "Message agent" }).fill(input);
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === input);
  expect(task).toBeTruthy();
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id } });
  const trigger = chat.getByRole("button", { name: "View Research result", exact: true });
  await expect(trigger).toBeVisible({ timeout: 12000 });
  await page.evaluate(() => { document.body.style.minHeight = "4000px"; });
  const outerScroll = await page.evaluate(() => window.scrollY);
  const completedOutput = "The root finished while its specialist result was opening." + "\n\nCompleted draft detail.".repeat(100);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/agents/tasks/${task.id}/specialists/research-child/result?offset=0`, async route => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await trigger.click();
    const result = page.getByRole("dialog", { name: "Research result", exact: true });
    await expect(result.getByRole("status")).toHaveText("Loading result…");
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScroll);
    await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "completed", output: completedOutput } });
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: "The root finished while its specialist result was opening." })).toHaveCount(1, { timeout: 12000 });
    await expect(result).toBeVisible();
    await expect(result.getByRole("status")).toHaveText("Loading result…");
    release();
    await expect(result.getByText(/Verified specialist findings/)).toBeVisible();
    await result.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(result.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    await expect(result.getByText(/Verified specialist findings/)).toHaveText("Verified specialist findings. ".repeat(180));
    await page.locator("[data-agent-message-scroll]").evaluate(element => { element.scrollTop = 0; });
    await page.keyboard.press("Escape");
    await expect(result).toHaveCount(0);
    await expect(chat.getByRole("button", { name: "View Research result", exact: true })).toBeFocused();
    await expect(chat.getByRole("button", { name: "View Research result", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScroll);
  } finally { release(); }
});
