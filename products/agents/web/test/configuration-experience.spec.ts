import { test, expect, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222";
const configuration = () => ({ executionKind: "business", instructions: "Answer customer questions.", context: { maxInputTokens:8192, compactAtTokens:6144 }, model: { selection: { kind:"organization_default" }, maxCostMicros:null, maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, sourceRevisionIds: [], connectedToolBindingIds: [], skillIds: [], tools: [], capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) });
async function fixture(page: Page, impact = false, tools = false, missingSelection = false) {
  let draft = configuration(), revision = 1;
  if (tools) Object.assign(draft, { tools: ["knowledge_search"] });
  if (missingSelection) Reflect.deleteProperty(draft.model, "selection");
  const snapshots = [{ id: "snapshot-initial", number: 1, configuration: structuredClone(draft), createdAt: "2026-10-20T10:00:00Z" }];
  const policies: Record<string, unknown>[] = [];
  const saves: Record<string, unknown>[] = [], posts: Record<string, unknown>[] = [], deployments: Record<string, unknown>[] = [], tasks: Record<string, unknown>[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method(), body = route.request().postData() ? route.request().postDataJSON() : {};
    const agent = () => ({ id: agentId, name: "Support", offering: "faq", draft, draftRevision: revision });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/model-providers/default")) data = {selection:{kind:"connection",connectionId:"provider-a",modelId:"model-a"},revision:1};
    else if (path.endsWith("/model-providers")) data = {connections:[{id:"provider-a",providerId:"openai",name:"OpenAI account",state:"active"},{id:"provider-b",providerId:"anthropic",name:"Anthropic account",state:"active"}]};
    else if (/model-providers\/provider-[ab]\/models$/.test(path)) data = {stale:false,result:{kind:"discovered",models:[{id:path.includes("provider-b")?"model-b":"model-a",name:path.includes("provider-b")?"Claude fixture":"GPT fixture",lifecycle:"active",inputModalities:["text"],outputModalities:["text"],contextTokens:{value:128000},maxOutputTokens:{value:32768},capabilities:{tools:{value:true,evidence:"discovered"}}}]}};
    else if (path.endsWith("/model-policy")) {
      policies.push(body); const cfg = body.configuration, selected = cfg.model.selection?.kind === "connection" ? cfg.model.selection.modelId : "model-a";
      data = { modelId: selected, modelRevision: "fixture-model-1", limits: { contextTokens: 128000, maxInputTokens: 65536,
        maxOutputTokens: 16384, maxCallDurationMs: 180000, maxRootTokens: 32000, safetyTokens: 1024 },
        effectivePolicy: { contextTokens: 128000, maxOutputTokens: cfg.model.maxOutputTokens, maxRootTokens: 32000 }, errors: [],
        controls: { temperature: selected === "model-a" ? { min: 0, max: 2, source: "fixture" } : null,
          reasoning: selected === "model-b" ? { kind: "budget", minTokens: 1024, maxTokens: 8192, source: "fixture" }
            : { kind: "effort", values: ["low", "medium", "high"], source: "fixture" } } };
    }
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
  return { saves, posts, tasks, snapshots, deployments, policies };
}

test("configuration without an explicit model selection renders while policy loads", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await fixture(page, false, false, true);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/model-policy", async route => { await pending; await route.fallback(); });
  await page.goto(`/app/agents/${agentId}?section=configuration`);
  await expect(page.getByRole("combobox", { name: "Agent model", exact: true })).toHaveValue(JSON.stringify({ kind: "organization_default" }));
  await page.getByText("Model limits", { exact: true }).click();
  await expect(page.getByText("Checking model settings…", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  release();
  await expect(page.getByLabel("Effective model limits", { exact: true })).toContainText("Task 32,000 tokens");
  expect(errors).toEqual([]);
});

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
  await expect(page.getByLabel("Effective model limits",{exact:true})).toContainText("Task 32,000 tokens");
  await expect(page.getByLabel("Maximum reply tokens",{exact:true})).toHaveAttribute("max", "16384");
  await expect(page.getByLabel("Input context tokens",{exact:true})).toHaveAttribute("max", "65536");
  await expect(page.getByLabel("Call timeout in seconds",{exact:true})).toHaveAttribute("max", "180");
  await page.getByLabel("Maximum reply tokens",{exact:true}).fill("8192");
  await page.getByRole("combobox", { name: "Reasoning", exact: true }).selectOption("budget");
  await page.getByRole("spinbutton", { name: "Reasoning tokens", exact: true }).fill("2048");
  await expect(page.getByRole("spinbutton", { name: "Reasoning tokens", exact: true })).toHaveAttribute("max", "8192");
  await expect(page.getByRole("spinbutton", { name: "Temperature", exact: true })).toHaveCount(0);
  await page.getByRole("button",{name:"Save changes",exact:true}).click();
  await expect(page.getByRole("alertdialog")).toBeVisible(); await page.getByRole("button",{name:"Apply changes",exact:true}).click();
  await expect(page.getByRole("button",{name:"Save changes",exact:true})).toBeDisabled();
  expect(state.snapshots).toHaveLength(2);
  expect((state.saves.at(-1)!.configuration as ReturnType<typeof configuration>).model).toMatchObject({selection,maxOutputTokens:8192,generation:{reasoning:{kind:"budget",tokens:2048}}});
  expect(JSON.stringify(state.saves)).not.toMatch(/apiKey|provider.*openrouter|nemotron/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath(`model-picker-${width}.png`),fullPage:true});
  await page.route(/\/model-providers\/[^/]+\/models(?:\?.*)?$/,route=>route.fulfill({status:503,json:{error:{message:"Unavailable"}}}));
  await page.reload(); await expect(page.getByRole("combobox",{name:"Agent model",exact:true})).toHaveValue(JSON.stringify(selection));
  await expect(page.getByText("Some model lists are unavailable.")).toBeVisible();
  expect(state.snapshots).toHaveLength(2);
});


test("preserves unsupported saved generation until an explicit reset; preview failures preserve edits", async ({ page }) => {
  const state = await fixture(page); await page.goto(`/app/agents/${agentId}?section=configuration`);
  await page.getByText("Model limits", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "Temperature", exact: true }).fill("0.7");
  await page.getByRole("combobox", { name: "Reasoning", exact: true }).selectOption("high");
  await page.getByRole("combobox", { name: "Agent model", exact: true }).selectOption(JSON.stringify({ kind: "connection", connectionId: "provider-b", modelId: "model-b" }));
  await expect(page.getByText("Saved generation settings are unavailable for this model.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Reasoning", exact: true })).toHaveValue("high");
  expect((state.policies.at(-1)!.configuration as { model: { generation: unknown } }).model.generation).toEqual({ temperature: 0.7, reasoning: { kind: "effort", value: "high" } });
  await page.getByRole("button", { name: "Reset provider defaults", exact: true }).click();
  await expect(page.getByText("Saved generation settings are unavailable for this model.")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Reasoning", exact: true })).toHaveValue("provider_default");
  await page.route("**/model-policy", route => route.fulfill({ status: 503, json: { error: { message: "Model policy unavailable" } } }));
  await page.getByLabel("Maximum reply tokens", { exact: true }).fill("4096");
  await expect(page.getByText("Model policy unavailable", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Maximum reply tokens", { exact: true })).toHaveValue("4096");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect((state.saves.at(-1)!.configuration as { model: { generation?: unknown } }).model).not.toHaveProperty("generation");
});

test("shows server policy errors and ignores obsolete previews after changing model", async ({ page }) => {
  await fixture(page); let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let delayed = false;
  await page.route("**/model-policy", async route => {
    const cfg = route.request().postDataJSON().configuration;
    const isOld = cfg.model.maxOutputTokens === 9000 && cfg.model.selection.kind === "organization_default";
    if (isOld) { delayed = true; await held; }
    await route.fulfill({ json: { modelId: isOld ? "model-a" : "model-b", modelRevision: "fixture", limits: { contextTokens: 32000,
      maxInputTokens: 12000, maxOutputTokens: isOld ? 9000 : 6000, maxCallDurationMs: 90000, maxRootTokens: 20000, safetyTokens: 1024 },
      effectivePolicy: null, errors: isOld ? [{ field: "model.maxOutputTokens", message: "Old reply error" }] : [{ field: "context.maxInputTokens", message: "Input exceeds the effective allowance" }],
      controls: { temperature: null, reasoning: null } } });
  });
  await page.goto(`/app/agents/${agentId}?section=configuration`); await page.getByText("Model limits", { exact: true }).click();
  await expect(page.getByText("Input exceeds the effective allowance")).toBeVisible();
  await expect(page.getByLabel("Input context tokens", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Maximum reply tokens", { exact: true }).fill("9000");
  await expect.poll(() => delayed).toBe(true);
  await page.getByRole("combobox", { name: "Agent model", exact: true }).selectOption(JSON.stringify({ kind: "connection", connectionId: "provider-b", modelId: "model-b" }));
  await expect(page.getByLabel("Maximum reply tokens", { exact: true })).toHaveAttribute("max", "6000");
  release!();
  await expect(page.getByText("Old reply error", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Maximum reply tokens", { exact: true })).toHaveAttribute("max", "6000");
});

for (const width of [1440, 768, 390]) test(`tool model compatibility preserves the saved selection at ${width}px`, async ({ page }) => {
  const state = await fixture(page, false, true); await page.setViewportSize({ width, height: 1000 });
  const descriptor = (id: string, tools: boolean | null, modalities = ["text"]) => ({ id, name: id, lifecycle: "active", inputModalities: modalities, outputModalities: ["text"], capabilities: { tools: { value: tools, evidence: "declared", source: { kind: "operator" } } } });
  await page.route(/model-providers\/provider-[ab]\/models(?:\?.*)?$/, route => route.fulfill({ json: { stale: false, modelVerifications: { verified: "tools_verified" }, toolSupport: { verified: "supported", vendor: "supported" }, result: { kind: "discovered", models: [descriptor("unknown", null), descriptor("declared", true), descriptor("unsupported", false), descriptor("image-only", true, ["image"]), descriptor("verified", true), descriptor("vendor", true)] } } }));
  await page.goto(`/app/agents/${agentId}?section=configuration`);
  const picker = page.getByRole("combobox", { name: "Agent model", exact: true }); await expect(picker).toBeEnabled();
  for (const id of ["unknown", "declared", "unsupported", "image-only"]) await expect(picker.locator("option").filter({ hasText: ` · ${id} · ${id}` }).first()).toHaveAttribute("disabled", "");
  await expect(picker.locator("option").filter({ hasText: "Tool test required" }).first()).toBeAttached();
  await expect(picker.locator("option").filter({ hasText: " · vendor · vendor" }).first()).not.toHaveAttribute("disabled");
  await picker.selectOption(JSON.stringify({ kind: "connection", connectionId: "provider-a", modelId: "verified" }));
  await page.getByText("Model details", { exact: true }).click(); await expect(page.getByText("openai · OpenAI account · verified", { exact: true })).toBeVisible();
  await expect(page.getByText("Input: text · Output: text", { exact: true })).toBeVisible();
  await page.route(/model-providers\/provider-[ab]\/models(?:\?.*)?$/, route => route.fulfill({ status: 503, json: { error: { message: "Unavailable" } } }));
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.reload(); await expect(picker).toHaveValue(JSON.stringify({ kind: "connection", connectionId: "provider-a", modelId: "verified" }));
  expect(state.saves).toHaveLength(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`tool-model-${width}.png`), fullPage: true });
});

for (const width of [1440, 390]) test(`chat model picker saves only the selected model at ${width}px`, async ({ page }) => {
  const state = await fixture(page, true); await page.setViewportSize({ width, height: 1000 });
  await page.goto(`/app/agents/${agentId}`);
  const current = page.getByRole("button", { name: "Chat model: OpenAI account · GPT fixture", exact: true, includeHidden: true }); await expect(current).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this draft while changing models");
  await current.click(); const picker = page.getByRole("dialog", { name: "Choose model", exact: true });
  await picker.getByRole("textbox", { name: "Search chat models", exact: true }).fill("Anthropic");
  await picker.getByRole("button", { name: /Claude fixture/ }).click(); await picker.getByRole("button", { name: "Use model", exact: true }).click();
  const confirmation = page.getByRole("alertdialog"); await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(picker).toBeVisible(); await expect(current).toBeAttached();
  expect(state.snapshots).toHaveLength(1);
  await picker.getByRole("button", { name: "Use model", exact: true }).click(); await confirmation.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(picker).toHaveCount(0); await expect(page.getByRole("button", { name: "Chat model: Anthropic account · Claude fixture", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep this draft while changing models");
  expect(state.snapshots).toHaveLength(2);
  expect((state.saves.at(-1)!.configuration as ReturnType<typeof configuration>)).toMatchObject({ instructions: "Answer customer questions.", model: { selection: { kind: "connection", connectionId: "provider-b", modelId: "model-b" } } });
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await expect(page.getByText("Answer customer questions.", { exact: true })).toBeVisible();
  expect(state.tasks.at(-1)?.versionId).toBe("snapshot-2"); expect(state.posts.at(-1)).not.toHaveProperty("model");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`chat-model-${width}.png`), fullPage: true });
});

test("chat model picker preserves unsaved configuration and recovers after save failure", async ({ page }) => {
  const state = await fixture(page); await page.goto(`/app/agents/${agentId}?section=configuration`);
  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("Unsaved instructions stay here");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const current = page.getByRole("button", { name: "Chat model: OpenAI account · GPT fixture", exact: true, includeHidden: true }); await current.click();
  const picker = page.getByRole("dialog", { name: "Choose model", exact: true }); await expect(picker).toContainText("Save configuration changes in Configure");
  await picker.getByRole("button", { name: /Claude fixture/ }).click(); await expect(picker.getByRole("button", { name: "Use model", exact: true })).toBeDisabled();
  await picker.getByRole("button", { name: "Cancel", exact: true }).click(); expect(state.saves).toHaveLength(0);
  await page.getByRole("button", { name: "Configure", exact: true }).click(); await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue("Unsaved instructions stay here");
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.route("**/configuration", route => route.fulfill({ status: 503, json: { error: { message: "Save temporarily unavailable" } } }));
  await current.click(); await picker.getByRole("button", { name: /Claude fixture/ }).click(); await picker.getByRole("button", { name: "Use model", exact: true }).click();
  await expect(picker.getByRole("alert")).toContainText("Save temporarily unavailable"); await expect(current).toBeAttached(); expect(state.snapshots).toHaveLength(2);
  await page.unroute("**/configuration"); await picker.getByRole("button", { name: "Use model", exact: true }).click();
  await expect(picker).toHaveCount(0); await expect(page.getByRole("button", { name: "Chat model: Anthropic account · Claude fixture", exact: true })).toBeVisible();
  expect((state.saves.at(-1)!.configuration as ReturnType<typeof configuration>).instructions).toBe("Unsaved instructions stay here");
});
