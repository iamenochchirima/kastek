import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "kasitek_active_org", value: "growth-fixture-one", domain: "127.0.0.1", path: "/" }]);
});

test("reviews capability-only updates with explicit conflicts and stable apply retries", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.route("**/api/agents/bootstrap",async route=>{
    const response=await route.fetch(),value=await response.json();value.scope.canConfigureAgents=true;
    await route.fulfill({response,json:value});
  });
  const preview={featureId:"content",targetPublicationRevision:"12",targetPublicationDigest:"a".repeat(64),diffDigest:"b".repeat(64),expectedRevisions:{content:7,assistant:9},
    features:[{featureId:"content",name:"Content",revision:7,enabled:true,preserved:["Instructions","Model","Context","Memory","Sources and skills","Enabled state"],changes:[
      {id:"content:posts",kind:"operation",action:"add",label:"Find posts",conflict:false},
      {id:"content:restricted",kind:"operation",action:"change",label:"Update published post",before:"read",after:"reviewed_write",conflict:true},
    ]},{featureId:"assistant",name:"Growth assistant",revision:9,enabled:true,preserved:["Instructions","Model"],changes:[{id:"assistant:content",kind:"specialist",action:"change",label:"Content specialist version",before:"private-version-id",after:"replacement-version-id",conflict:true}]}],
    conflicts:[{id:"content:restricted",featureId:"content",label:"Update published post"},{id:"assistant:content",featureId:"assistant",label:"Content specialist version"}],unavailable:[],canApply:true};
  await page.route("**/api/agents/features/content/upgrade/preview",route=>route.fulfill({json:preview}));
  const attempts:Record<string,unknown>[]=[];
  await page.route("**/api/agents/features/content/upgrade/apply",async route=>{
    attempts.push(route.request().postDataJSON());
    await route.fulfill(attempts.length===1?{status:503,json:{error:"Temporary failure"}}:{json:{revisions:{content:8,assistant:10}}});
  });
  await page.goto("/agents");
  const card=page.getByRole("article").filter({has:page.getByRole("heading",{name:"Content",exact:true})});
  await card.getByRole("button",{name:"Review update",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Review capability update",exact:true});
  await expect(dialog.getByText("Find posts",{exact:true})).toBeVisible();
  await expect(dialog.getByText("private-version-id → replacement-version-id",{exact:true})).not.toBeVisible();
  await expect(dialog.getByRole("button",{name:"Apply update",exact:true})).toBeDisabled();
  await dialog.getByRole("combobox",{name:"Content: Update published post",exact:true}).click();
  await page.getByRole("option",{name:"Keep current",exact:true}).click();
  await dialog.getByRole("combobox",{name:"Growth assistant: Content specialist version",exact:true}).click();
  await page.getByRole("option",{name:"Use update",exact:true}).click();
  await page.screenshot({path:test.info().outputPath("capability-upgrade-mobile.png"),animations:"disabled"});
  await dialog.getByRole("button",{name:"Apply update",exact:true}).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button",{name:"Apply update",exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0]).toMatchObject({targetPublicationDigest:preview.targetPublicationDigest,diffDigest:preview.diffDigest,expectedRevisions:preview.expectedRevisions,
    resolutions:{"content:restricted":"keep_current","assistant:content":"use_update"}});
});

test("shows configured specialist status without blocking assistant chat", async ({ page }) => {
  await page.route("**/api/agents/bootstrap",async route=>{
    const response=await route.fetch(),bootstrap=await response.json();
    bootstrap.scope.canConfigureAgents=true;
    bootstrap.features=bootstrap.features.map((feature:{id:string})=>feature.id==="assistant"?{...feature,specialists:[
      {id:"research",name:"Research",state:"configured",memory:{enabled:true,availableToAssistant:false}},{id:"campaigns",name:"Campaigns",state:"disabled",memory:{enabled:false,availableToAssistant:false}},
    ]}:feature);
    await route.fulfill({response,json:bootstrap});
  });
  for(const width of [1440,768,390]){
    await page.setViewportSize({width,height:900});await page.goto("/agents");
    const card=page.getByRole("article").filter({has:page.getByRole("heading",{name:"Growth assistant",exact:true})});
    await card.getByText("Specialists · 2").click();
    await expect(card.getByText("Research",{exact:true})).toBeVisible();await expect(card.getByText("Configured",{exact:true})).toBeVisible();
    await expect(card.getByText("Memory · Assistant memory off",{exact:true})).toBeVisible();
    await expect(card.getByText("Campaigns",{exact:true})).toBeVisible();await expect(card.getByText("Disabled",{exact:true})).toBeVisible();
    await expect(card.getByText("Memory · Off",{exact:true})).toBeVisible();
    await expect(card.getByRole("button",{name:"Chat",exact:true})).toBeEnabled();
  }
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
  await page.getByRole("link", {name:"Expand conversation"}).click();
  await expect(page).toHaveURL(/\/agents\/conversations\//);
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry message" })).toBeVisible();
  await expect(page.getByRole("textbox", {name:"Message agent"})).toHaveValue("lost response for safe retry");
  await page.getByRole("button", { name: "Retry message" }).click();
  await expect(page.getByRole("button", { name: "Retry message" })).toHaveCount(0);
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const conversationId=new URL(page.url()).pathname.split("/").at(-1);
  const attempts = state.attempts.filter((attempt: { text: string;conversationId:string }) => attempt.text === "lost response for safe retry"&&attempt.conversationId===conversationId);
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
  const progress = chat.getByRole("region", { name: "Agent work", exact: true });
  await progress.getByText("Approach", {exact:true}).click();
  await expect(progress.getByText("Compare specialist drafts", { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(progress.getByRole("button", { name: "Open Research activity", exact: true })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Message agent" })).toBeEnabled();
  await chat.getByRole("button", { name: "Open Research activity", exact: true }).click();
  const result = page.getByRole("dialog", { name: "Research", exact: true });
  await expect(result.getByText(/Verified specialist findings/)).toBeVisible();
  await expect(result.getByRole("heading", { name: "Research", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`specialist-result-${width}.png`), animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(result).toHaveCount(0);
  await chat.getByRole("button", {name:"Open Content activity",exact:true}).click();
  const runningChild = page.getByRole("dialog",{name:"Content",exact:true});
  await expect(runningChild.getByText("I’ve read the brief and am preparing the findings.",{exact:true})).toBeVisible();
  await expect(runningChild.getByText("Read launch brief",{exact:true})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chat.getByRole("button", {name:"Open Content activity",exact:true})).toBeFocused();
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
  expect(await lastMessage.evaluate((element, oldId) => Boolean((document.querySelector(`[data-task-id="${oldId}"]`)?.compareDocumentPosition(element) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING), task.id)).toBe(true);
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
  const trigger = chat.getByRole("button", { name: "Open Research activity", exact: true });
  await expect(trigger).toBeVisible({ timeout: 12000 });
  await page.evaluate(() => { document.body.style.minHeight = "4000px"; });
  const outerScroll = await page.evaluate(() => window.scrollY);
  const completedOutput = "The root finished while its specialist result was opening." + "\n\nCompleted draft detail.".repeat(100);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/agents/tasks/${task.id}/activity?childTaskId=research-child`, async route => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await trigger.click();
    const result = page.getByRole("dialog", { name: "Research", exact: true });
    await expect(result.getByRole("status", {name:"Loading agent activity"})).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScroll);
    await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "completed", output: completedOutput } });
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: "The root finished while its specialist result was opening." })).toHaveCount(1, { timeout: 12000 });
    await expect(result).toBeVisible();
    await expect(result.getByRole("status", {name:"Loading agent activity"})).toBeVisible();
    release();
    await expect(result.getByText(/Verified specialist findings/)).toBeVisible();
    await expect(result.getByText(/Verified specialist findings/)).toHaveText("Verified specialist findings. ".repeat(180));
    await page.locator('[aria-label="Agent conversation"] [data-agent-message-scroll]').evaluate(element => { element.scrollTop = 0; });
    await page.keyboard.press("Escape");
    await expect(result).toHaveCount(0);
    await expect(chat.getByRole("button", { name: "Open Research activity", exact: true })).toBeFocused();
    await expect(chat.getByRole("button", { name: "Open Research activity", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScroll);
  } finally { release(); }
});

test("daily allowance rejection preserves editable input without an uncertain-delivery retry", async ({ page }) => {
  const attempts: { requestId: string; text: string }[] = [];
  await page.route("**/api/agents/conversations/*/messages", async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) return route.fulfill({ status: 429, json: { code: "QUOTA_EXCEEDED", error: "Daily token allowance exceeded" } });
    return route.continue();
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  const composer = chat.getByRole("textbox", { name: "Message agent", exact: true });
  await composer.fill("Draft a normal launch post");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(chat.getByRole("alert")).toContainText("Daily agent allowance reached.");
  await expect(chat.getByRole("button", { name: "Retry message", exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("Draft a normal launch post");
  await expect(composer).toBeEditable();
  await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  const destination = await chat.getByRole("link", { name: "Expand conversation", exact: true }).getAttribute("href");
  expect(destination).toBeTruthy();
  await page.goto(destination!);
  await expect(composer).toHaveValue("Draft a normal launch post");
  await expect(composer).toBeEditable();
  await expect(chat.getByRole("button", { name: "Retry message", exact: true })).toHaveCount(0);
  await composer.fill("Draft a shorter launch post");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(chat.getByText("I reviewed the business context. Here is the next step for your work.", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1].requestId).not.toBe(attempts[0].requestId);
  expect(attempts[1].text).toBe("Draft a shorter launch post");
});

for (const [code, description] of [
  ["MODEL_ACCESS_DENIED", "The model provider denied access to this model."],
  ["MODEL_REQUEST_INVALID", "The model provider rejected this request."],
  ["MODEL_AUTHENTICATION_FAILED", "The model provider rejected authentication."],
  ["MODEL_USE_DENIED", "This agent is not authorized to use the model connection."],
]) test(`explains failed model access ${code} without changing continuation controls`, async ({ page, request }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  const input = `keep working before ${code}`;
  await chat.getByRole("textbox", { name: "Message agent", exact: true }).fill(input);
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === input);
  expect(task).toBeTruthy();
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "failed", errorCode: code, canSteer: false, canContinue: true } });
  const detail = chat.locator(`[data-task-id="${task.id}"]`);
  await expect(detail.getByRole("status").filter({ hasText: description })).toHaveText(description, { timeout: 12000 });
  await expect(detail.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  await expect(chat.getByRole("textbox", { name: "Message agent", exact: true })).toBeEnabled();
});

for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"]) test(`reports native runtime and streamed completion at ${width}px in ${theme}`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(value => localStorage.setItem("kasitek-theme", value), theme);
  let phase: "working" | "completed" = "working";
  let releaseStream: () => void = () => {};
  const ready = new Promise<void>(resolve => { releaseStream = resolve; });
  const observedAt = () => new Date().toISOString();
  const runtime = (task: { id: string }) => ({
    version: 1, observedAt: observedAt(), elapsedMs: phase === "working" ? 2400 : 3900,
    model: { id: "fixture/free-model", provider: "fixture", latencyMs: phase === "working" ? null : 1400, firstTokenMs: phase === "working" ? null : 600, outputTokensPerSecond: phase === "working" ? null : 30 },
    context: { estimatedInputTokens: 1200, inputLimitTokens: 8000, windowTokens: 16000, reservedOutputTokens: 2000, safetyTokens: 500, utilizationPercent: 7.5, compactionCount: 1, lastCompactedAt: observedAt(), historyGroups: 2, sourceCount: 1 },
    usage: { accountedTokens: 1600, inputTokens: 1200, outputTokens: phase === "working" ? null : 400, modelCalls: 1, toolCalls: 1, observedModelCalls: phase === "working" ? 0 : 1 },
    operations: [{ id: "read", taskId: task.id, agentName: "Growth assistant", kind: "tool", label: "Reading business records", state: phase === "working" ? "started" : "completed", startedAt: observedAt(), completedAt: phase === "working" ? null : observedAt(), durationMs: 900, errorCode: null }], operationsTruncated: false,
  });
  await page.route("**/api/agents/tasks?**", async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, tasks: body.tasks.map((task: { id: string }) => ({ ...task, runtime: runtime(task) })) } });
  });
  await page.route("**/api/agents/tasks/*/live*", async route => {
    await ready;
    const url = new URL(route.request().url());
    const taskId = url.pathname.split("/").at(-2);
    const result = await (await request.get(`http://127.0.0.1:4310/api/agents/tasks/${taskId}`, { headers: { cookie: "kasitek_active_org=growth-fixture-one" } })).json();
    const task = { ...result.task, runtime: runtime(result.task) };
    const event = { id: "native-completion", taskId, type: "completed", createdAt: observedAt() };
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: task\ndata: ${JSON.stringify({ task })}\n\nevent: events\ndata: ${JSON.stringify({ events: [event], nextCursor: "native-completion" })}\n\nevent: end\ndata: {"terminal":true}\n\n` });
  });
  try {
    await page.goto("/agents");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
    const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
    await chat.getByRole("textbox", { name: "Message agent", exact: true }).fill(`keep working on a runtime report ${width} ${theme}`);
    await chat.getByRole("button", { name: "Send message", exact: true }).click();
    const native = chat.locator("[data-agent-context]");
    await expect(native.getByText("Context · 8%", {exact:true})).toBeVisible();
    await native.getByText("Context · 8%", {exact:true}).click();
    await expect(native.getByText("1,200", {exact:true})).toBeVisible();
    await expect(native.getByText("16,000", {exact:true})).toBeVisible();
    await native.getByText("Execution details", {exact:true}).click();
    await expect(native.getByText("Unavailable", {exact:true}).first()).toBeVisible();
    phase = "completed";
    const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
    const task = state.tasks.find((value: {input:string}) => value.input === `keep working on a runtime report ${width} ${theme}`);
    await request.post("http://127.0.0.1:4310/__fixture/orchestration", {data:{taskId:task.id,state:"completed",output:"The native report is complete."}});
    releaseStream();
    await expect(native.getByText("1.4 s",{exact:true})).toBeVisible();
    await expect(chat.getByText("The native report is complete.",{exact:true})).toBeVisible();
    await expect(native.getByText("1,200",{exact:true})).toBeVisible();
    const destination = await chat.getByRole("link", {name:"Expand conversation",exact:true}).getAttribute("href");
    await page.goto(destination!);
    const restored = page.getByRole("region",{name:"Agent conversation",exact:true});
    await restored.getByText("Context · 8%",{exact:true}).click();
    await expect(restored.locator("[data-agent-context]").getByText("1,200",{exact:true})).toBeVisible();
    await restored.getByRole("button",{name:/Activity/}).click();
    await expect(restored.getByText("Reading business records",{exact:true})).toBeVisible();
    await page.screenshot({ path: `../../../.audit/live-reporting-${width}-${theme}.png`, fullPage: false, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { releaseStream(); }
});


test("falls back to polling when live transport is unavailable", async ({ page, request }) => {
  await page.route("**/api/agents/tasks/*/live*", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  const input = "keep working through a live transport interruption";
  await chat.getByRole("textbox", { name: "Message agent", exact: true }).fill(input);
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(chat.getByText("Live stream unavailable. Checking updates.", { exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === input);
  await request.post("http://127.0.0.1:4310/__fixture/orchestration", { data: { taskId: task.id, state: "completed", output: "Finished through the ordinary polling path." } });
  await expect(chat.getByText("Finished through the ordinary polling path.", { exact: true })).toBeVisible();
  await expect(chat.getByText("Live stream unavailable. Checking updates.", { exact: true })).toHaveCount(0);
});

test("clears execution content when live observation authority is rejected", async ({ page }) => {
  await page.route("**/api/agents/tasks/*/live*", route => route.fulfill({ status: 403, json: { error: "Forbidden" } }));
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  await chat.getByRole("textbox", { name: "Message agent", exact: true }).fill("keep working before observation authority changes");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(chat.getByRole("alert")).toContainText("Live updates unavailable.");
  await expect(chat.locator("[data-role=user]")).toHaveCount(0);
  await expect(chat.locator("[data-task-id]")).toHaveCount(0);
});

test("withdrawn evidence stays redacted across an older live snapshot and can be restored by a fresh observation", async ({ page, request }) => {
  let source: "authorized" | "redacted" | "restored" = "authorized";
  const clock = Date.now();
  const observedAt = (offset: number) => new Date(clock + offset).toISOString();
  let release: () => void = () => {};
  const released = new Promise<void>(resolve => { release = resolve; });
  const nativeRuntime = {
    version: 1, observedAt: observedAt(0), elapsedMs: 1000,
    model: { id: "fixture/private-source-model", provider: "fixture", latencyMs: null, firstTokenMs: null, outputTokensPerSecond: null },
    context: { estimatedInputTokens: 1200, inputLimitTokens: 8000, windowTokens: 16000, reservedOutputTokens: 2000, safetyTokens: 500, utilizationPercent: 7.5, compactionCount: 0, lastCompactedAt: null, historyGroups: 0, sourceCount: 1 },
    usage: { accountedTokens: 1200, inputTokens: null, outputTokens: null, modelCalls: 1, toolCalls: 0, observedModelCalls: 0 },
    operations: [], operationsTruncated: false,
  };
  const project = (task: Record<string, unknown>, observation = source) => observation === "redacted"
    ? { ...task, observedAt: observedAt(1000), errorCode: "EVIDENCE_UNAVAILABLE", output: null, sources: [], results: [], runtime: undefined }
    : { ...task, observedAt: observedAt(observation === "restored" ? 2000 : 0), errorCode: null, output: "Private source-backed report.", runtime: { ...nativeRuntime, observedAt: observedAt(observation === "restored" ? 2000 : 0) } };
  await page.route("**/api/agents/tasks?**", async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, tasks: body.tasks.map((task: Record<string, unknown>) => project(task)) } });
  });
  await page.route("**/api/agents/tasks/*/live*", async route => {
    const taskId = new URL(route.request().url()).pathname.split("/").at(-2);
    const result = await (await request.get(`http://127.0.0.1:4310/api/agents/tasks/${taskId}`, { headers: { cookie: "kasitek_active_org=growth-fixture-one" } })).json();
    const old = project(result.task, "authorized");
    await released;
    const olderRedaction = { ...project(result.task, "redacted"), observedAt: observedAt(500) };
    const intermediate = { ...old, observedAt: observedAt(750), runtime: { ...nativeRuntime, observedAt: observedAt(750) } };
    const frames = [old, olderRedaction, intermediate].map(task => `event: task\ndata: ${JSON.stringify({ task })}\n\n`).join("");
    await route.fulfill({ contentType: "text/event-stream", body: frames + 'event: end\ndata: {"terminal":true}\n\n' });
  });
  try {
    await page.goto("/agents");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
    const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
    await chat.getByRole("textbox", { name: "Message agent", exact: true }).fill("keep working on the authorized source report");
    await chat.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(chat.getByText("Private source-backed report.", { exact: true })).toBeVisible();
    await expect(chat.locator("[data-agent-context]")).toBeVisible();
    source = "redacted";
    await expect(chat.getByText("Private source-backed report.", { exact: true })).toHaveCount(0);
    await expect(chat.locator("[data-agent-context]")).toHaveCount(0);
    await expect(chat.getByText("Sources unavailable", { exact: true })).toBeVisible();
    const oldFrame = page.waitForResponse(response => response.url().includes("/live") && response.status() === 200);
    release(); await oldFrame;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(chat.getByText("Private source-backed report.", { exact: true })).toHaveCount(0);
    await expect(chat.locator("[data-agent-context]")).toHaveCount(0);
    source = "restored";
    await expect(chat.getByText("Private source-backed report.", { exact: true })).toBeVisible();
    await expect(chat.locator("[data-agent-context]")).toBeVisible();
  } finally { release(); }
});

test("fixture live transport preserves task scope while reporting unavailable streaming", async ({ request }) => {
  const origin = "http://127.0.0.1:4310";
  const headers = { cookie: "kasitek_active_org=growth-fixture-one" };
  const created = await (await request.post(`${origin}/api/agents/conversations`, { headers, data: { requestId: crypto.randomUUID(), featureId: "assistant" } })).json();
  const accepted = await (await request.post(`${origin}/api/agents/conversations/${created.conversation.id}/messages`, { headers, data: { requestId: crypto.randomUUID(), text: "keep working on the fixture scope check" } })).json();
  expect((await request.get(`${origin}/api/agents/tasks/${accepted.task.id}/live`, { headers })).status()).toBe(503);
  expect((await request.get(`${origin}/api/agents/tasks/${accepted.task.id}/live`, { headers: { cookie: "kasitek_active_org=growth-fixture-two" } })).status()).toBe(404);
  expect((await request.get(`${origin}/api/agents/tasks/${crypto.randomUUID()}/live`, { headers })).status()).toBe(404);
});

test("root operation history pages once per cursor and withdraws retained conversation content immediately", async ({ page }) => {
  await page.setViewportSize({width:1440,height:1100});
  const clock=Date.now(),at=(offset=0)=>new Date(clock+offset).toISOString();
  const brief="keep working while I inspect earlier root activity";
  let rootId="",conversationId="",historyReads=0,hideNextPage=false;
  const operation=(id:string,taskId:string,index:number,label=id)=>({id,taskId,agentName:"Growth assistant",kind:"tool",label,state:"completed",startedAt:at(index),completedAt:at(index+1),durationMs:1,errorCode:null});
  const project=(task:Record<string,unknown>)=>({...task,observedAt:at(100),reviewIds:["protected-review"],output:"Retained protected result",sources:[{id:"private-source",title:"Protected source",route:"/analytics"}],results:[{id:"private-result",kind:"report",title:"Protected report result",route:"/analytics"}],
    runtime:{version:1,observedAt:at(100),elapsedMs:1000,model:{id:"fixture/history",provider:"fixture",latencyMs:null,firstTokenMs:null,outputTokensPerSecond:null},context:{estimatedInputTokens:1000,windowTokens:10000,utilizationPercent:10},usage:{accountedTokens:1000,inputTokens:null,outputTokens:null,modelCalls:1,toolCalls:70,observedModelCalls:0},
      operations:Array.from({length:60},(_,index)=>operation(`recent-${index}`,String(task.id),index+10)),operationsTruncated:true}});
  await page.route("**/api/agents/tasks?**",async route=>{
    const response=await route.fetch(),body=await response.json();
    const task=body.tasks.find((item:{input:string})=>item.input===brief);
    if(task){rootId=task.id;conversationId=task.conversationId;}
    await route.fulfill({response,json:{...body,tasks:body.tasks.map((item:Record<string,unknown>)=>item.input===brief?project(item):item)}});
  });
  await page.route("**/api/agents/conversations/*",async route=>{
    const response=await route.fetch(),body=await response.json();
    if(route.request().method()==="GET"&&Array.isArray(body.messages)) {
      const input=body.messages.find((item:{text:string})=>item.text===brief);
      if(input&&!body.messages.some((item:{role:string;taskId:string})=>item.role==="assistant"&&item.taskId===input.taskId))body.messages.push({id:`${input.taskId}:assistant`,role:"assistant",taskId:input.taskId,text:"Retained protected result",createdAt:at(100)});
    }
    await route.fulfill({response,json:body});
  });
  await page.route("**/api/agents/tasks/*/reviews",async route=>{
    const response=await route.fetch(),body=await response.json();
    const taskId=new URL(route.request().url()).pathname.split("/").at(-2);
    await route.fulfill({response,json:taskId===rootId?{reviews:[{id:"protected-review",taskId,conversationId,featureId:"assistant",kind:"content_draft",payloadDigest:"a".repeat(64),state:"proposed",draft:{title:"Protected draft",content:"Protected review content",channels:["FACEBOOK"],channelSelections:{FACEBOOK:"fixture-account"}},createdAt:at(100),expiresAt:new Date(clock+3600000).toISOString(),result:null}]}:body});
  });
  await page.route("**/api/agents/tasks/*/activity?**",async route=>{
    historyReads++;const cursor=new URL(route.request().url()).searchParams.get("operationCursor");
    const response=await route.fetch({url:route.request().url().replace(/\/activity\?.*$/,"")}),body=await response.json();
    const task=project(body.task);
    if(hideNextPage){await route.fulfill({status:200,json:{task:{...task,observedAt:at(2000),input:brief,output:null,errorCode:"EVIDENCE_UNAVAILABLE",runtime:undefined,sources:[],results:[],children:[]},rootTaskId:rootId,parentTaskId:null,agentName:"Growth assistant",operations:[],nextOperationCursor:null,updates:[],updatesTruncated:false,events:[],nextCursor:null}});return;}
    const operations=cursor?[operation("earlier-unique",rootId,0,"Earlier protected tool"),operation("recent-0",rootId,10)]:task.runtime.operations;
    await route.fulfill({status:200,json:{task,rootTaskId:rootId,parentTaskId:null,agentName:"Growth assistant",operations,nextOperationCursor:cursor?"final-page":"older-page",updates:[],updatesTruncated:false,events:[],nextCursor:null}});
  });
  await page.goto("/agents");
  await page.getByRole("button",{name:"New conversation",exact:true}).click();
  await page.getByRole("button",{name:/Growth assistant Guidance/}).click();
  const chat=page.getByRole("region",{name:"Agent conversation",exact:true});
  await chat.getByRole("textbox",{name:"Message agent",exact:true}).fill(brief);
  await chat.getByRole("button",{name:"Send message",exact:true}).click();
  await expect(chat.getByText("Retained protected result",{exact:true})).toBeVisible();
  await expect(chat.getByRole("region",{name:"Draft review",exact:true})).toBeVisible();
  await expect(chat.locator("[data-agent-context]")).toBeVisible();
  const earlier=chat.getByRole("button",{name:"Load earlier activity",exact:true});
  await earlier.click();await expect.poll(()=>historyReads).toBe(1);
  await earlier.click();await expect(chat.getByText("Earlier protected tool",{exact:true})).toBeVisible();
  await expect(chat.locator('[data-operation-id="recent-0"]')).toHaveCount(1);
  expect(historyReads).toBe(2);
  hideNextPage=true;
  await earlier.click();
  await expect(chat.getByText("Earlier protected tool",{exact:true})).toHaveCount(0);
  await expect(chat.getByText("Retained protected result",{exact:true})).toHaveCount(0);
  await expect(chat.getByRole("region",{name:"Draft review",exact:true})).toHaveCount(0);
  await expect(chat.getByRole("link",{name:"Protected report result",exact:true})).toHaveCount(0);
  await expect(chat.locator("[data-agent-context]")).toHaveCount(0);
  await expect(earlier).toHaveCount(0);
});

test("edits an agent name and avatar on desktop and mobile", async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    let name = "Content", avatar = "muse";
    await page.route("**/api/agents/bootstrap", async route => {
      const response = await route.fetch(), bootstrap = await response.json();
      bootstrap.scope.canConfigureAgents = true;
      bootstrap.features = bootstrap.features.map((feature: { id: string }) => feature.id === "content" ? { ...feature, name, avatar } : feature);
      await route.fulfill({ response, json: bootstrap });
    });
    await page.route("**/api/agents/features/content/profile", async route => {
      expect(route.request().method()).toBe("PATCH");
      ({ name, avatar } = route.request().postDataJSON());
      await route.fulfill({ json: { name, avatar } });
    });
    await page.goto("/agents");
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Content", exact: true }) });
    await card.getByRole("button", { name: "Actions for Content" }).click();
    await page.getByRole("menuitem", { name: "Edit agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit agent" });
    await dialog.getByLabel("Name", { exact: true }).fill("Studio");
    await dialog.getByRole("button", { name: "scout", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "scout", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: test.info().outputPath(`agent-profile-${width}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Studio", exact: true })).toBeVisible();
    expect(avatar).toBe("scout");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.unrouteAll();
  }
});
