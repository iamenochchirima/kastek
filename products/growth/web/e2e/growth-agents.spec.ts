import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "kasitek_active_org", value: "growth-fixture-one", domain: "127.0.0.1", path: "/" }]);
});

test("uses one conversation from quick access, full page and history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your agents" })).toBeVisible();
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
  await page.screenshot({ path: `../../../.audit/growth-agents-assistant-${width}.png`, fullPage: true, animations: "disabled" });
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
  await expect(page.getByRole("heading", { name: "Your agents", exact: true })).toBeVisible();
});

test("keeps the Agents workspace readable in dark theme", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("kasitek-theme", "dark"));
  await page.goto("/agents");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Your agents", exact: true })).toBeVisible();
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
