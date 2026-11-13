import { test, expect, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222";
const configuration = () => ({ executionKind: "business", instructions: "Answer customer questions.", context: { maxInputTokens: 8192, compactAtTokens: 6144 },
  model: { selection: { kind: "organization_default" }, maxCostMicros: null, maxInputBytes: 16384, maxOutputTokens: 4096, maxDurationSeconds: 120 },
  sourceRevisionIds: [], connectedToolBindingIds: [], skillIds: [], tools: [],
  capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) });

async function fixture(page: Page) {
  let draft = configuration(), revision = 1;
  const snapshots = [{ id: "snapshot-initial", number: 1, configuration: structuredClone(draft), createdAt: "2026-10-20T10:00:00Z" }];
  const saves: Record<string, unknown>[] = [], policies: Record<string, unknown>[] = [];
  await page.route(`${new URL(test.info().project.use.baseURL!).origin}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method(), body = route.request().postData() ? route.request().postDataJSON() : {};
    const agent = () => ({ id: agentId, name: "Support", offering: "faq", draft, draftRevision: revision });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.com" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/setup-readiness")) data = { readiness: { readyToTest: false, setupStep: "complete", requirements: { model: { state: "ready", code: null }, knowledge: { state: "deferred", code: null }, bookings: { state: "blocked", code: "BOOKING_POLICY_REQUIRED" }, handoff: { state: "ready", code: null } }, channels: [{ kind: "website", state: "needs_connection" }, { kind: "facebook", state: "needs_connection" }] } };
    else if (path.endsWith("/channels/growth/organizations")) data = { organizations: [] };
    else if (path.endsWith("/channels")) data = { connections: [], deployments: [], websites: [] };
    else if (path.endsWith("/procedures")) data = { entries: [] };
    else if (path.endsWith("/identity-defaults")) data = { defaults: { identity: { purpose: "Answer customer questions from approved information.", voice: "Brief and friendly.", values: "Be accurate.", boundaries: "Do not invent policies.", refusal: "Say when information is missing.", escalation: "Hand off when asked for a person.", examples: [] }, guidance: { topicScope: "Stay within approved business information.", avoid: ["Inventing policies"], refusalStyle: "brief", redirectTo: "Offer support." } } };
    else if (path.endsWith("/effective-settings") && method === "POST") data = { composed: "Identity\n\nGuidance", sources: 0, tools: 0, connectedTools: 0, skills: 0 };
    else if (path.endsWith("/booking-policies")) data = { policies: [] };
    else if (path.endsWith("/provider-calendars/connections")) data = { connections: [] };
    else if (path.endsWith("/model-providers/default")) data = { selection: { kind: "connection", connectionId: "provider-a", modelId: "model-a" }, revision: 1 };
    else if (path.endsWith("/model-providers")) data = { connections: [{ id: "provider-a", providerId: "openai", name: "OpenAI account", state: "active" }, { id: "provider-b", providerId: "anthropic", name: "Anthropic account", state: "active" }] };
    else if (/model-providers\/provider-[ab]\/models$/.test(path)) data = { stale: false, result: { kind: "discovered", models: [{ id: path.includes("provider-b") ? "model-b" : "model-a", name: path.includes("provider-b") ? "Claude fixture" : "GPT fixture", lifecycle: "active", inputModalities: ["text"], outputModalities: ["text"], contextTokens: { value: 128000 }, maxOutputTokens: { value: 32768 }, capabilities: { tools: { value: true, evidence: "discovered" } }, pricing: null }] } };
    else if (path.endsWith("/model-policy")) {
      policies.push(body);
      const cfg = body.configuration, selected = cfg.model.selection?.kind === "connection" ? cfg.model.selection.modelId : "model-a";
      data = { modelId: selected, modelRevision: "fixture-model-1", limits: { contextTokens: 128000, maxInputTokens: 65536, maxOutputTokens: 16384, maxCallDurationMs: 180000, maxRootTokens: 32000, safetyTokens: 1024 },
        effectivePolicy: { contextTokens: 128000, maxOutputTokens: cfg.model.maxOutputTokens, maxRootTokens: 32000, maxInputTokens: 30976, compactAtTokens: 20650 }, errors: [],
        controls: { temperature: null, reasoning: selected === "model-b"
          ? { kind: "effort", values: ["low", "high", "max"], default: "high", defaultEnabled: true, mandatory: false, source: "fixture" }
          : { kind: "effort", values: ["low", "medium", "high"], default: "medium", defaultEnabled: true, mandatory: false, source: "fixture" } } };
    }
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ ...agent(), latestVersion: snapshots[0], hasUnpublishedChanges: false }], nextCursor: null };
    else if (path.endsWith(`/agents/${agentId}`)) data = { agent: agent(), versions: snapshots, deployments: [] };
    else if (path.endsWith("/configuration") && method === "POST") {
      saves.push(body);
      if (!body.confirmImpact) { await route.fulfill({ status: 409, json: { error: { code: "CONFIGURATION_CONFIRMATION_REQUIRED", message: "Confirm changes affecting channels." } } }); return; }
      expect(body.expectedRevision).toBe(revision); draft = body.configuration; revision++;
      const snapshot = { id: `snapshot-${revision}`, number: revision, configuration: structuredClone(draft), createdAt: "2026-10-21T10:00:00Z" }; snapshots.unshift(snapshot);
      data = { agent: agent(), snapshot, deployments: [] };
    }
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected ${method} ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { saves, snapshots, policies };
}

test("models without published effort levels show no reasoning control", async ({ page }) => {
  await fixture(page);
  await page.route("**/model-policy", route => route.fulfill({ json: {
    modelId: "model-a", modelRevision: "fixture-model-1",
    limits: { contextTokens: 128000, maxInputTokens: 65536, maxOutputTokens: 16384, maxCallDurationMs: 180000, maxRootTokens: 32000, safetyTokens: 1024 },
    effectivePolicy: null, errors: [], controls: { temperature: null, reasoning: null },
  } }));
  await page.goto(`/app/agents/${agentId}?section=configuration`);
  await expect(page.getByRole("button", { name: /Agent model: GPT fixture/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Reasoning", exact: true })).toHaveCount(0);
});

test("model publishing leaves unsaved instructions in the editor", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/app/agents/${agentId}?section=configuration`);
  await page.getByRole("button", { name: "Edit instructions", exact: true }).click();
  const instructionsDialog = page.getByRole("dialog", { name: "Instructions", exact: true });
  await instructionsDialog.getByRole("textbox").fill("Unsaved instructions stay here");
  await instructionsDialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: /Agent model: GPT fixture/ }).click();
  const picker = page.getByRole("dialog", { name: "Choose model", exact: true });
  await picker.getByRole("radio", { name: /Claude fixture/ }).click();
  await picker.getByRole("button", { name: "Save model", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible(); await confirmation.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect.poll(() => state.snapshots.length).toBe(2);
  expect((state.saves.at(-1)!.configuration as ReturnType<typeof configuration>).instructions).toBe("Answer customer questions.");
  await expect(page.getByRole("button", { name: "Edit instructions", exact: true })).toContainText("Unsaved instructions stay here");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
});

test("model and reasoning publish immediately from the saved draft", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/app/agents/${agentId}?section=configuration`);
  const trigger = page.getByRole("button", { name: /Agent model: GPT fixture/ });
  await expect(trigger).toBeVisible();

  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Choose model", exact: true });
  await picker.getByRole("radio", { name: /Claude fixture/ }).click();
  await picker.getByRole("button", { name: "Save model", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible(); await confirmation.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(() => state.snapshots.length).toBe(2);
  expect((state.saves.at(-1)!.configuration as ReturnType<typeof configuration>).model).toMatchObject({ selection: { kind: "connection", connectionId: "provider-b", modelId: "model-b" } });
  expect((state.saves.at(-1)!.configuration as { model: { generation?: unknown } }).model).not.toHaveProperty("generation");

  const reasoning = page.getByRole("combobox", { name: "Reasoning", exact: true });
  await expect(reasoning).toBeVisible();
  await expect(reasoning.locator("option")).toHaveText(["Provider default (High)", "Low", "High", "Maximum"]);
  await reasoning.selectOption("low");
  const reasonConfirmation = page.getByRole("alertdialog");
  await expect(reasonConfirmation).toBeVisible(); await reasonConfirmation.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect.poll(() => state.snapshots.length).toBe(3);
  expect((state.saves.at(-1)!.configuration as ReturnType<typeof configuration>).model).toMatchObject({ selection: { kind: "connection", connectionId: "provider-b", modelId: "model-b" }, generation: { reasoning: { kind: "effort", value: "low" } } });
  await expect.poll(() => state.policies.at(-1)?.configuration).toMatchObject({ model: { selection: { kind: "connection", connectionId: "provider-b", modelId: "model-b" }, generation: { reasoning: { kind: "effort", value: "low" } } } });
});
