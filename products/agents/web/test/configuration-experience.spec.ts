import { test, expect, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222";
const configuration = () => ({ executionKind: "business", instructions: "Answer customer questions.", context: { maxInputTokens:8192, compactAtTokens:6144 }, model: { selection: { kind:"organization_default" }, maxCostMicros:null, maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, sourceRevisionIds: [], connectedToolBindingIds: [], skillIds: [], tools: [], capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) });
async function fixture(page: Page, impact = false) {
  let draft = configuration(), revision = 1;
  const snapshots = [{ id: "snapshot-initial", number: 1, configuration: structuredClone(draft), createdAt: "2026-10-20T10:00:00Z" }];
  const saves: Record<string, unknown>[] = [], posts: Record<string, unknown>[] = [], deployments: Record<string, unknown>[] = [], tasks: Record<string, unknown>[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method(), body = route.request().postData() ? route.request().postDataJSON() : {};
    const agent = () => ({ id: agentId, name: "Support", offering: "faq", draft, draftRevision: revision });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/model-providers/default")) data = {selection:{kind:"connection",connectionId:"provider-a",modelId:"model-a"},revision:1};
    else if (path.endsWith("/model-providers")) data = {connections:[{id:"provider-a",providerId:"openai",name:"OpenAI account",state:"active"},{id:"provider-b",providerId:"anthropic",name:"Anthropic account",state:"active"}]};
    else if (/model-providers\/provider-[ab]\/models$/.test(path)) data = {stale:false,result:{kind:"discovered",models:[{id:path.includes("provider-b")?"model-b":"model-a",name:path.includes("provider-b")?"Claude fixture":"GPT fixture",lifecycle:"active",inputModalities:["text"],outputModalities:["text"],contextTokens:{value:128000},maxOutputTokens:{value:32768},capabilities:{tools:{value:true,evidence:"discovered"}}}]}};
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ ...agent(), latestVersion: snapshots[0], hasUnpublishedChanges: false }], nextCursor: null };
    else if (path.endsWith(`/agents/${agentId}`)) data = { agent: agent(), versions: snapshots, deployments };
    else if (path.endsWith("/configuration") && method === "POST") {
      saves.push(body);
      if (impact && !body.confirmImpact) { await route.fulfill({ status: 409, json: { error: { code: "CONFIGURATION_CONFIRMATION_REQUIRED", message: "Confirm changes affecting channels." } } }); return; }
      expect(body.expectedRevision).toBe(revision); draft = body.configuration; revision++;
      const snapshot = { id: `snapshot-${revision}`, number: revision, configuration: structuredClone(draft), createdAt: "2026-10-21T10:00:00Z" }; snapshots.unshift(snapshot);
      data = { agent: agent(), snapshot, deployments };
    } else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/conversations")) data = { conversations: tasks.length ? [{ id: "conversation", agentId, agentName: "Support", title: "Hello", versionId: "snapshot-initial", versionNumber: 1, state: "completed", canContinue: true, updatedAt: "2026-10-21T10:00:00Z" }] : [], nextCursor: null };
    else if (path.endsWith("/conversations/conversation")) data = { tasks, conversation: { id: "conversation", agentId, versionId: "snapshot-initial", versionNumber: 1 }, nextCursor: null };
    else if (path.endsWith("/tasks") && method === "POST") {
      posts.push(body); const task = { id: `task-${tasks.length + 1}`, ...body, versionId: snapshots[0].id, conversationId: "conversation", state: "completed", output: draft.instructions, errorCode: null, turnSequence: tasks.length + 1 }; tasks.push(task); data = { task };
    } else if (/\/tasks\/task-\d+$/.test(path)) data = { task: tasks.find(item => path.endsWith(String(item.id))), events: [], actions: [], children: [], resources: [], artifacts: [], operations: [] };
    else if (path.endsWith("/deployments")) { deployments.push({ id: "website", ...body, versionId: snapshots[0].id }); data = { deployment: deployments[0] }; }
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected ${method} ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { saves, posts, tasks, snapshots, deployments };
}

test("configuration applies to the next turn in an existing chat; no ordinary version controls", async ({ page }) => {
  const state = await fixture(page); await page.goto(`/app/agents/${agentId}`);
  await expect(page.getByRole("combobox", { name: "Version", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Version \d/)).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello"); await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/conversations\/conversation$/);
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("Updated support instructions.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use the updated settings"); await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Updated support instructions.", { exact: true })).toBeVisible();
  expect(state.posts[1]).toMatchObject({ agentId, conversationId: "conversation" }); expect(state.posts[1]).not.toHaveProperty("versionId");
  expect(state.tasks[0].versionId).toBe("snapshot-initial"); expect(state.tasks[1].versionId).toBe("snapshot-2");
});

test("impact confirmation can cancel or apply the exact proposed configuration", async ({ page }) => {
  const state = await fixture(page, true); await page.goto(`/app/agents/${agentId}?section=configuration`);
  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("Update customer-facing support");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("connected customer channels"); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.snapshots).toHaveLength(1); await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.saves[2]).toEqual({ ...state.saves[1], confirmImpact: true }); expect(state.snapshots).toHaveLength(2);
});

test("history restores through save; website setup uses current configuration on mobile", async ({ page }) => {
  const state = await fixture(page); await page.setViewportSize({ width: 390, height: 900 }); await page.goto(`/app/agents/${agentId}?section=configuration`);
  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("New instructions"); await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.getByText("Configuration history", { exact: true }).click(); await page.getByRole("button", { name: "Load configuration", exact: true }).last().click();
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue("Answer customer questions."); expect(state.snapshots).toHaveLength(2);
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Website", exact: true }).click(); await page.getByRole("button", { name: "Publish website", exact: true }).click();
  await page.getByRole("textbox", { name: "Allowed website origins" }).fill("https://example.com"); await page.getByRole("dialog").getByRole("button", { name: "Publish website", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open website chat" })).toBeVisible(); expect(state.deployments[0].allowedOrigins).toEqual(["https://example.com"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("configuration-mobile.png") });
});

for (const width of [1440,768,390]) test(`model selection saves in the background at ${width}px`, async ({page}) => {
  const state = await fixture(page,true); await page.setViewportSize({width,height:1000});
  await page.goto(`/app/agents/${agentId}?section=configuration`);
  const picker = page.getByRole("combobox",{name:"Agent model",exact:true}); await expect(picker).toBeEnabled();
  await page.getByRole("textbox",{name:"Search agent models"}).fill("Anthropic");
  const selection={kind:"connection",connectionId:"provider-b",modelId:"model-b"};
  await picker.selectOption(JSON.stringify(selection));
  await page.getByText("Model limits",{exact:true}).click();
  await page.getByLabel("Maximum reply tokens",{exact:true}).fill("8192");
  await page.getByRole("button",{name:"Save changes",exact:true}).click();
  await expect(page.getByRole("alertdialog")).toBeVisible(); await page.getByRole("button",{name:"Apply changes",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save changes",exact:true})).toBeDisabled();
  expect(state.snapshots).toHaveLength(2);
  expect((state.saves.at(-1)!.configuration as ReturnType<typeof configuration>).model).toMatchObject({selection,maxOutputTokens:8192});
  expect(JSON.stringify(state.saves)).not.toMatch(/apiKey|provider.*openrouter|nemotron/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath(`model-picker-${width}.png`),fullPage:true});
  await page.route("**/model-providers/*/models",route=>route.fulfill({status:503,json:{error:{message:"Unavailable"}}}));
  await page.reload(); await expect(page.getByRole("combobox",{name:"Agent model",exact:true})).toHaveValue(JSON.stringify(selection));
  await expect(page.getByText("Some model lists are unavailable.")).toBeVisible();
  expect(state.snapshots).toHaveLength(2);
});
