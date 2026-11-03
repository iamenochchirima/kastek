import { test, expect, type Page } from "@playwright/test";
import type { ModelProviderConnection } from "../src/platform/model-provider-api";

const base = "/api/organizations/org/model-providers";
async function fixture(page: Page, failSave = false, managed = false) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  let connections: ModelProviderConnection[] = managed ? [{ id: "connection-1", providerId: "openrouter", name: "Included NVIDIA model", endpoint: "https://openrouter.ai/api/v1", state: "active", revision: 1, credentialRevision: 1, custody: "platform_managed", verification: "discovered" }] : [], revision = managed ? 1 : 0;
  let selection: { kind: string; connectionId: string; modelId: string } | null = managed ? { kind: "connection", connectionId: "connection-1", modelId: "fixture-model" } : null;
  let failures = failSave ? 1 : 0, authorized = false;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    calls.push({ path, method, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Test workspace", role: "owner" }] };
    else if (path === `${base}/catalogue`) data = { providers: [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", adapter: { readiness: "installed" } }, { id: "future", name: "Future provider", adapter: { readiness: "planned" } }] };
    else if (path === `${base}/default`) { if (method === "PUT") { expect(body.expectedRevision).toBe(revision); revision++; selection = { kind: "connection", connectionId: body.connectionId, modelId: body.modelId }; } data = { selection, revision }; }
    else if (path === base) {
      if (method === "POST") {
        if (failures-- > 0) { await route.fulfill({ status: 503, json: { error: { message: "Unavailable" } } }); return; }
        const connection: ModelProviderConnection = { id: `connection-${connections.length + 1}`, providerId: body.providerId, name: body.name, endpoint: body.endpoint ?? "https://api.openai.com/v1", state: "active", revision: 1, credentialRevision: 1, verification: "saved" };
        connections.push(connection); data = { connection };
      } else data = { connections };
    } else if (path.endsWith("/dependencies")) { const current = connections.find(item => item.id === path.split("/")[5])!; data = { connectionRevision: current.revision, state: current.state, defaultModel: selection ? { modelId: selection.modelId, revision } : null, entries: [{ cursor: "agent:a", kind: "agent", id: "agent-a", name: "Support agent", revision: 2, authorized, reauthorizable: true }, { cursor: "schedule:s", kind: "schedule", id: "schedule-s", name: "Daily follow-up", revision: 1, authorized: false, reauthorizable: false }], total: 2, nextCursor: null, activeTasks: 1, uncertainTasks: 2 }; }
    else if (path.endsWith("/reauthorize")) { expect(body.agentId).toBe("agent-a"); expect(body.agentRevision).toBe(2); authorized = true; data = { authorized: true }; }
    else if (path.endsWith("/models/manual")) data = { model: { id: body.modelId, name: body.modelId, contextTokens: { value: body.metadata?.contextTokens ?? null }, maxOutputTokens: { value: body.metadata?.maxOutputTokens ?? null }, capabilities: { tools: { value: body.metadata?.tools ?? null, evidence: "declared" }, reasoning: { value: null, evidence: "unknown" }, structuredOutput: { value: null, evidence: "unknown" } }, lifecycle: "active", pricing: null } };
    else if (path.endsWith("/models/refresh")) data = { kind: "discovered", models: [{ id: "fixture-model", name: "Fixture model", contextTokens: { value: 32000 }, maxOutputTokens: { value: null }, capabilities: { tools: { value: true, evidence: "declared" }, reasoning: { value: null, evidence: "unknown" }, structuredOutput: { value: null, evidence: "unknown" } }, lifecycle: "active", pricing: null }], observedAt: "2026-10-21T12:00:00Z", visibility: "public_catalog", complete: true };
    else if (path.endsWith("/models")) data = { result: null, stale: true, fetchedAt: null, connectionRevision: 1, credentialRevision: 1 };
    else if (path.endsWith("/probe")) { expect(body.allowBillableRequest).toBe(true); expect(body.expectedRevision).toBe(1); data = { verification: body.verifyTools ? "tools_verified" : "inference_verified", modelId: body.modelId, usage: { observed: false } }; }
    else if (path.startsWith(`${base}/connection-`)) {
      const id = path.split("/")[5]; const item = connections.find(item => item.id === id)!;
      expect(body.expectedRevision).toBe(item.revision);
      const updated = { ...item, name: body.name ?? item.name, revision: item.revision + 1, state: path.endsWith("/revoke") ? "revoked" as const : method === "DELETE" ? "removed" as const : "active" as const };
      connections = connections.map(item => item.id === id ? updated : item); data = { connection: updated };
    } else { await route.fulfill({ status: 404, json: { error: { message: "Unexpected route" } } }); return; }
    await route.fulfill({ json: data });
  });
  return { calls, errors };
}
async function add(page: Page, name = "Production") {
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Search providers").fill("OpenAI");
  await dialog.getByRole("button", { name: "OpenAI", exact: true }).click();
  await dialog.getByLabel("Connection name").fill(name);
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByLabel("API key", { exact: true }).fill("fixture_secret_not_real");
  await dialog.getByRole("button", { name: "Save connection" }).click();
}
for (const width of [1440, 768, 390]) test(`provider settings CRUD, catalogue and explicit probe at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); const state = await fixture(page);
  await page.goto("/app/settings"); await expect(page.getByText("No model providers", { exact: true })).toBeVisible();
  await add(page); await expect(page.getByRole("heading", { name: "Production", exact: true })).toBeVisible();
  await add(page, "Staging"); await expect(page.getByRole("heading", { name: "Staging", exact: true })).toBeVisible();
  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Production", exact: true }) });
  await row.getByRole("button", { name: "Models", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Models", exact: true });
  await dialog.getByRole("button", { name: "Refresh models" }).click();
  await dialog.getByRole("button", { name: /Fixture model/ }).click();
  await expect(dialog.getByText("32,000 context · Tools declared")).toBeVisible();
  expect(state.calls.filter(call => call.path.endsWith("/probe"))).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`models-${width}.png`), fullPage: true, animations: "disabled" });
  await dialog.getByLabel("Test tool support").check(); await dialog.getByRole("button", { name: "Test model", exact: true }).click();
  const confirmation = page.getByRole("alertdialog"); await expect(confirmation).toContainText("may incur charges");
  expect(state.calls.filter(call => call.path.endsWith("/probe"))).toHaveLength(0);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await dialog.getByRole("button", { name: "Test model", exact: true }).click(); await confirmation.getByRole("button", { name: "Run test" }).click();
  await expect(dialog.getByRole("status")).toContainText("Tools tested · Usage unavailable");
  await dialog.getByRole("button", { name: "Set default" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByText("Production / fixture-model", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Edit key" }).click();
  const editor = page.getByRole("dialog"); await expect(editor.getByLabel("Replacement API key")).toHaveValue("");
  await editor.getByLabel("Replacement API key").fill("replacement_fixture_secret"); await editor.getByRole("button", { name: "Save connection" }).click();
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  const affected = page.getByRole("dialog", { name: "Affected agents", exact: true }); await expect(affected).toContainText("Support agent"); await expect(affected).toContainText("Daily follow-up"); await expect(affected).toContainText("1 active tasks"); await affected.getByRole("button", { name: "Revoke key", exact: true }).click(); await confirmation.getByRole("button", { name: "Revoke key", exact: true }).click();
  await expect(row.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await row.getByRole("button", { name: "Remove", exact: true }).click(); await affected.getByRole("button", { name: "Remove", exact: true }).click(); await confirmation.getByRole("button", { name: "Cancel" }).click(); await expect(affected).toBeVisible();
  await affected.getByRole("button", { name: "Remove", exact: true }).click(); await confirmation.getByRole("button", { name: "Remove", exact: true }).click(); await expect(row).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes("fixture_secret")))).toBe(false);
  expect(state.errors).toEqual([]); await expect(confirmation).toHaveCount(0); await page.screenshot({ path: test.info().outputPath(`providers-${width}.png`), fullPage: true, animations: "disabled" });
});
test("provider save errors preserve masked form and allow retry", async ({ page }) => {
  await fixture(page, true); await page.goto("/app/settings"); await expect(page.getByText("No model providers", { exact: true })).toBeVisible(); await add(page);
  const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("alert")).toContainText("unavailable"); await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("fixture_secret_not_real");
  await dialog.getByRole("button", { name: "Save connection" }).click(); await expect(dialog).toHaveCount(0);
});

test("provider setup is owner-only", async ({ page }) => {
  const state = await fixture(page);
  await page.route("**/api/session", route => route.fulfill({ json: { account: { id: "member", email: "member@example.test", displayName: "Member" }, organizations: [{ id: "org", name: "Test workspace", role: "member" }] } }));
  await page.goto("/app/settings");
  await expect(page.getByText("Workspace owner access required.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add provider", exact: true })).toHaveCount(0);
  expect(state.calls.some(call => call.path.startsWith(base))).toBe(false);
});
test("cached catalogue failure can refresh without an implicit probe", async ({ page }) => {
  const state = await fixture(page); await page.goto("/app/settings"); await expect(page.getByText("No model providers", { exact: true })).toBeVisible(); await add(page);
  await page.route("**/connection-1/models", route => route.fulfill({ status: 409, json: { error: { message: "Changed" } } }));
  await page.getByRole("button", { name: "Models", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Models", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("Reload and try again");
  await dialog.getByRole("button", { name: "Refresh models" }).click(); await expect(dialog.getByRole("button", { name: /Fixture model/ })).toBeVisible();
  expect(state.calls.filter(call => call.path.endsWith("/probe"))).toHaveLength(0);
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
});

test("owner explicitly restores configured agent access and attests private model metadata", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 }); const state = await fixture(page); await page.goto("/app/settings"); await add(page);
  await page.getByRole("button", { name: "Access", exact: true }).click(); const access = page.getByRole("dialog", { name: "Provider access" });
  await access.getByRole("button", { name: "Restore access" }).click(); const confirmation = page.getByRole("alertdialog");
  expect(state.calls.filter(call => call.path.endsWith("/reauthorize"))).toHaveLength(0);
  await confirmation.getByRole("button", { name: "Restore access" }).click(); await expect(access.getByRole("button", { name: "Restore access" })).toHaveCount(0);
  await access.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("button", { name: "Models", exact: true }).click(); const models = page.getByRole("dialog", { name: "Models", exact: true });
  await models.getByRole("button", { name: "Add model", exact: true }).click(); const manual = page.getByRole("dialog", { name: "Add model", exact: true });
  await manual.getByLabel("Model ID", { exact: true }).fill("private-deployment"); await manual.getByLabel("Specify model metadata").check();
  await manual.getByLabel("Source reference").fill("https://provider.example/docs/private-model"); await manual.getByLabel("Context tokens", { exact: true }).fill("32000"); await manual.getByLabel("Maximum output tokens").fill("8192"); await manual.getByLabel("Tool support", { exact: true }).selectOption("yes");
  await expect(manual.getByRole("button", { name: "Add model", exact: true })).toBeDisabled(); await manual.getByLabel("I verified these limits against the source.").check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath("manual-model-mobile.png"), fullPage: true });
  await manual.getByRole("button", { name: "Add model", exact: true }).click(); await expect(manual).toHaveCount(0); await expect(models.getByLabel("Model ID", { exact: true })).toHaveValue("private-deployment");
  const call = state.calls.find(call => call.path.endsWith("/models/manual"))!; expect(call.body).toMatchObject({ expectedRevision: 1, modelId: "private-deployment", confirmMetadata: true, metadata: { contextTokens: 32000, maxOutputTokens: 8192, tools: true } });
  expect(state.calls.filter(call => call.path.endsWith("/probe"))).toHaveLength(0); expect(state.errors).toEqual([]);
});

for (const [status, code, recovery] of [[401, "MODEL_AUTHENTICATION_FAILED", "Key rejected"], [402, "MODEL_BILLING_REQUIRED", "Add provider credit"], [403, "MODEL_ACCESS_DENIED", "cannot access"], [429, "MODEL_RATE_LIMITED", "rate limit reached"]] as const) test(`catalogue ${status} recovery preserves the selection`, async ({ page }) => {
  const state = await fixture(page); await page.goto("/app/settings"); await add(page);
  await page.getByRole("button", { name: "Models", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Models", exact: true });
  await dialog.getByRole("button", { name: "Refresh models" }).click(); await dialog.getByRole("button", { name: /Fixture model/ }).click();
  await page.route("**/models/refresh", route => route.fulfill({ status, json: { error: { code, message: "Provider rejected" } } }));
  await dialog.getByRole("button", { name: "Refresh models" }).click(); await expect(dialog.getByRole("alert")).toContainText(recovery);
  await expect(dialog.getByLabel("Model ID", { exact: true })).toHaveValue("fixture-model"); await expect(dialog.getByRole("button", { name: /Fixture model/ })).toBeVisible();
  await page.unroute("**/models/refresh"); await dialog.getByRole("button", { name: "Refresh models" }).click(); await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByLabel("Model ID", { exact: true })).toHaveValue("fixture-model"); expect(state.calls.filter(call => call.path.endsWith("/probe"))).toHaveLength(0);
});

test("stale catalogue preserves a retired default and recovers from empty discovery", async ({ page }) => {
  const state = await fixture(page); await page.goto("/app/settings"); await add(page);
  await page.route("**/model-providers/default", route => route.fulfill({ json: { selection: { kind: "connection", connectionId: "connection-1", modelId: "retired-model" }, revision: 1 } }));
  // Reload picks up the persisted default before opening its cached catalogue.
  await page.reload();
  await page.route("**/connection-1/models", route => route.fulfill({ json: { stale: true, status: "backoff", errorCode: "MODEL_BILLING_REQUIRED", retryAt: "2099-01-01T00:00:00Z", result: { kind: "discovered", models: [{ id: "retired-model", name: "Retired model", lifecycle: "retired", inputModalities: ["text", "image"], outputModalities: ["text"], contextTokens: { value: 32000 }, maxOutputTokens: { value: 8192 }, capabilities: { tools: { value: true, evidence: "discovered" } }, pricing: null }], complete: true } } }));
  await page.getByRole("button", { name: "Models", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Models", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("Add provider credit"); await expect(dialog.getByLabel("Model ID", { exact: true })).toHaveValue("retired-model");
  await expect(dialog.getByText("Refresh needed", { exact: true })).toBeVisible(); await expect(dialog.getByRole("button", { name: /Retired model/ })).toBeDisabled();
  await expect(dialog.getByText("Saved model unavailable. Choose another model.", { exact: true })).toBeVisible(); await expect(dialog.getByText("text, image", { exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.path.endsWith("/models/refresh"))).toHaveLength(0);
  await page.route("**/models/refresh", route => route.fulfill({ json: { kind: "discovered", models: [], complete: true } }));
  await dialog.getByRole("button", { name: "Refresh models" }).click(); await expect(dialog.getByText("No models returned", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Model ID", { exact: true })).toHaveValue("retired-model"); await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/models/refresh"); await dialog.getByRole("button", { name: "Refresh models" }).click(); await expect(dialog.getByRole("button", { name: /Fixture model/ })).toBeVisible();
  await dialog.getByLabel("Search models").fill("no-matches"); await expect(dialog.getByText("No matching models", { exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.path.endsWith("/probe"))).toHaveLength(0);
});

test("tablet provider key and revocation dialogs in both themes", async ({ page }) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/app/settings");
  await expect(page.getByText("No model providers", { exact: true })).toBeVisible();
  await add(page);
  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Production", exact: true }) });
  await expect(row).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await row.getByRole("button", { name: "Edit key" }).click();
    let dialog = page.getByRole("dialog", { name: "Edit provider" });
    await expect(dialog.getByLabel("Replacement API key")).toHaveValue("");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`provider-edit-${theme}-768.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Affected agents", exact: true });
    await expect(dialog.getByText("Support agent")).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`provider-affected-${theme}-768.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Revoke key", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    expect(await confirm.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`provider-confirm-${theme}-768.png`), animations: "disabled" });
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
  expect(state.calls.some(call => call.path.endsWith("/revoke"))).toBe(false);
});

for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"] as const) test(`included model controls at ${width}px in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: theme });
  const state = await fixture(page, false, true);
  await page.goto("/app/settings");
  const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Included NVIDIA model", exact: true }) });
  await expect(row).toContainText("Included model");
  await expect(row.getByRole("button", { name: "Edit key", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
  for (const action of ["Models", "Access", "Revoke", "Remove"]) await expect(row.getByRole("button", { name: action, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add provider", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`included-provider-${width}-${theme}.png`), fullPage: true, animations: "disabled" });
  await row.getByRole("button", { name: "Models", exact: true }).click();
  const models = page.getByRole("dialog", { name: "Models", exact: true });
  await expect(models.getByRole("button", { name: "Add model", exact: true })).toHaveCount(0);
  await expect(models.getByLabel("Model ID", { exact: true })).toHaveAttribute("readonly", "");
  await models.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(models.getByRole("button", { name: /Fixture model/ })).toBeVisible();
  await expect(models.getByRole("button", { name: "Set default", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`included-models-${width}-${theme}.png`), fullPage: true, animations: "disabled" });
  await models.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add provider", exact: true })).toBeVisible();
  expect(state.calls.some(call => call.path.endsWith("/models/manual") || call.method === "PATCH" || call.path.endsWith("/probe"))).toBe(false);
  expect(state.errors).toEqual([]);
});
