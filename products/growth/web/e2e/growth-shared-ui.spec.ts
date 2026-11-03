import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "kasitek_active_org", value: "growth-fixture-one", domain: "127.0.0.1", path: "/" }]);
});

test("rechecks visible resource previews and removes withdrawn or unauthorized cached content",async({page})=>{
  let denied=false,withdrawn=false,reads=0,revision=1;
  await page.route("**/api/agents/bootstrap",async route=>{
    const response=await route.fetch(),body=await response.json();body.scope.canConfigureAgents=true;
    await route.fulfill({response,json:body});
  });
  const sourceId="11111111-1111-4111-8111-111111111111",revisionId="22222222-2222-4222-8222-222222222222";
  await page.route("**/api/agents/features/assistant/resources",async route=>{
    reads++;
    if(denied)return route.fulfill({status:403,json:{error:"forbidden",code:"resource_denied"}});
    await route.fulfill({json:{featureId:"assistant",revision,sourceRevisionIds:[revisionId],skillIds:[],
      sources:[{id:sourceId,title:"Launch facts",generation:withdrawn?2:1,state:withdrawn?"withdrawn":"active",
        revisions:[{id:revisionId,revision:1,state:"approved",acquiredAt:new Date().toISOString()}]}],skills:[],curatedSkills:[],
      supportedFormats:{sources:["text/plain","text/markdown"],skills:["files","zip","curated"]}}});
  });
  await page.route("**/api/agents/features/assistant/resources/preview?*",async route=>{
    if(denied||withdrawn)return route.fulfill({status:403,json:{error:"forbidden",code:"resource_denied"}});
    await route.fulfill({json:{kind:"source",title:"Launch facts",content:"CURRENT_AUTHORIZED_RESOURCE_BODY",contentDigest:"a".repeat(64)}});
  });
  await page.setViewportSize({width:390,height:844});await page.goto("/agents");
  const opener=page.getByRole("article").filter({has:page.getByRole("heading",{name:"Growth assistant",exact:true})}).getByRole("button",{name:"Knowledge & skills",exact:true});await opener.click();
  const inventory=page.getByRole("dialog",{name:"Knowledge & skills",exact:true});
  const selected=inventory.getByRole("checkbox");await expect(selected).toBeChecked();await selected.uncheck();
  await expect.poll(()=>reads,{timeout:8000}).toBeGreaterThan(1);await expect(selected).not.toBeChecked();
  await inventory.getByRole("button",{name:"Review",exact:true}).click();
  const preview=page.getByRole("dialog",{name:"Launch facts",exact:true});await expect(preview.getByText("CURRENT_AUTHORIZED_RESOURCE_BODY",{exact:true})).toBeVisible();
  withdrawn=true;revision=2;
  await expect(page.getByText("CURRENT_AUTHORIZED_RESOURCE_BODY",{exact:true})).toHaveCount(0,{timeout:8000});
  await expect(preview.getByRole("alert")).toContainText("Resource unavailable");
  await page.keyboard.press("Escape");
  await expect(selected).not.toBeChecked();
  await expect(inventory.getByText("Agent settings changed. Refresh to continue.",{exact:true})).toBeVisible();
  await expect(inventory.getByRole("button",{name:"Save selection",exact:true})).toBeDisabled();
  denied=true;
  await expect(inventory.getByText("Resources unavailable",{exact:true})).toBeVisible({timeout:8000});
  await expect(inventory.getByText("Launch facts",{exact:true})).toHaveCount(0);
  await expect(inventory.getByRole("button",{name:"Save selection",exact:true})).toBeDisabled();
  await page.screenshot({path:test.info().outputPath("resources-withdrawn-mobile.png"),animations:"disabled"});
  await page.keyboard.press("Escape");await expect(opener).toBeFocused();
});

for (const theme of ["light", "dark"]) test(`keeps a running subagent modal usable inside mobile assistant during resize in ${theme}`, async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(value => localStorage.setItem("kasitek-theme", value), theme);
  await page.route("**/api/agents/tasks/*/activity?childTaskId=content-child", async route => {
    const response = await route.fetch(), body = await response.json();
    body.task.runtime = {
      version: 1, observedAt: new Date().toISOString(), elapsedMs: 1200,
      model: { id: "fixture-model", provider: "fixture", latencyMs: 300, firstTokenMs: null, outputTokensPerSecond: null },
      context: { estimatedInputTokens: 1100, inputLimitTokens: 10000, windowTokens: 10000, reservedOutputTokens: 500, safetyTokens: 100, utilizationPercent: 11, compactionCount: 0, lastCompactedAt: null, historyGroups: 1, sourceCount: 1 },
      usage: { accountedTokens: 1100, inputTokens: 1000, outputTokens: 100, modelCalls: 1, toolCalls: 1, observedModelCalls: 1 }, operations: [],
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const parent = page.getByRole("dialog", { name: "Growth assistant", exact: true });
  const input = `keep working shared modal ${theme}`;
  await parent.getByRole("textbox", { name: "Message agent" }).fill(input);
  await parent.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4412/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === input);
  expect(task).toBeTruthy();
  await request.post("http://127.0.0.1:4412/__fixture/orchestration", { data: { taskId: task.id } });
  const trigger = parent.getByRole("button", { name: "Open Content activity", exact: true });
  await expect(trigger).toBeVisible({ timeout: 12000 });
  const parentScroll = parent.locator("[data-agent-message-scroll]");
  const parentTop = await parentScroll.evaluate(element => element.scrollTop);
  await trigger.click();
  const modal = page.getByRole("dialog", { name: "Content", exact: true });
  await expect(modal.getByText("I’ve read the brief and am preparing the findings.", { exact: true })).toBeVisible();
  expect(await modal.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.setViewportSize({ width: 390, height: 500 });
  await expect.poll(async () => {
    const bounds = await modal.boundingBox();
    return bounds ? bounds.y + bounds.height : Infinity;
  }).toBeLessThanOrEqual(501);
  await expect(modal.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await modal.getByText("Read launch brief", { exact: true }).click();
  await expect(modal.getByText(/Duration:/)).toBeVisible();
  const context = modal.locator("[data-agent-context]");
  await context.locator("summary").first().click();
  await expect(context.getByText("Context capacity", { exact: true })).toBeVisible();
  const popover = await context.locator(":scope > div").boundingBox();
  expect(popover?.x).toBeGreaterThanOrEqual(0);
  expect(popover ? popover.x + popover.width : Infinity).toBeLessThanOrEqual(391);
  expect(popover ? popover.y + popover.height : Infinity).toBeLessThanOrEqual(501);
  await page.keyboard.press("Escape");
  await expect(context).not.toHaveAttribute("open", "");
  await expect(modal).toBeVisible();
  await page.screenshot({ path: test.info().outputPath(`nested-running-mobile-${theme}.png`), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(parent).toBeVisible();
  await expect(trigger).toBeFocused();
  expect(Math.abs((await parentScroll.evaluate(element => element.scrollTop)) - parentTop)).toBeLessThan(4);
  await trigger.click();
  await expect(modal.getByText("I’ve read the brief and am preparing the findings.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(parent).toBeVisible();
  const after = await (await request.get("http://127.0.0.1:4412/__fixture/attempts")).json();
  expect(after.tasks.filter((item: { conversationId: string }) => item.conversationId === task.conversationId)).toHaveLength(1);
});

test("preserves child reading position across live updates, root completion and reopening", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const longUpdate = Array.from({ length: 80 }, (_, index) => `Finding ${index + 1}: Confirmed detail from the supplied brief.`).join("\n\n");
  let generation = 1;
  await page.route("**/api/agents/tasks/*/activity?childTaskId=content-child", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.updates = [{ id: "long-update", text: longUpdate + (generation > 1 ? "\n\nAdditional confirmed detail." : "") }];
    body.task.observedAt = new Date(Date.now() + generation * 1000).toISOString();
    await route.fulfill({ response, json: body });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  const chat = page.getByRole("region", { name: "Agent conversation", exact: true });
  const input = "keep working shared reading position";
  await chat.getByRole("textbox", { name: "Message agent" }).fill(input);
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  const state = await (await request.get("http://127.0.0.1:4412/__fixture/attempts")).json();
  const task = state.tasks.find((item: { input: string }) => item.input === input);
  await request.post("http://127.0.0.1:4412/__fixture/orchestration", { data: { taskId: task.id } });
  const trigger = chat.getByRole("button", { name: "Open Content activity", exact: true });
  await expect(trigger).toBeVisible({ timeout: 12000 });
  await trigger.click();
  const modal = page.getByRole("dialog", { name: "Content", exact: true });
  const scroll = modal.locator("[data-agent-message-scroll]");
  await expect(modal.getByText(/Finding 80:/)).toBeVisible();
  await scroll.evaluate(element => { element.scrollTop = 400; });
  const readingTop = await scroll.evaluate(element => element.scrollTop);
  generation++;
  await expect(modal.getByText(/Additional confirmed detail/)).toHaveCount(1, { timeout: 12000 });
  expect(Math.abs((await scroll.evaluate(element => element.scrollTop)) - readingTop)).toBeLessThan(4);
  await expect(modal.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  await request.post("http://127.0.0.1:4412/__fixture/orchestration", { data: { taskId: task.id, state: "completed", output: "The requested drafts are ready." } });
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "The requested drafts are ready." })).toHaveCount(1, { timeout: 12000 });
  await expect(modal).toBeVisible();
  expect(Math.abs((await scroll.evaluate(element => element.scrollTop)) - readingTop)).toBeLessThan(4);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(modal.getByText(/Finding 80:/)).toHaveCount(1);
  await expect.poll(async () => Math.abs((await scroll.evaluate(element => element.scrollTop)) - readingTop)).toBeLessThan(4);
  const after = await (await request.get("http://127.0.0.1:4412/__fixture/attempts")).json();
  expect(after.tasks.filter((item: { conversationId: string }) => item.conversationId === task.conversationId)).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath("subagent-reopened-reading-position.png"), animations: "disabled" });
});
