import { test, expect, type Page } from "@playwright/test";
import type { ModelProviderConnection } from "../src/platform/model-provider-api";

const base = "/api/organizations/org/model-providers";
async function fixture(page: Page, failSave = false) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  let connections: ModelProviderConnection[] = [], revision = 0;
  let selection: { kind: string; connectionId: string; modelId: string } | null = null;
  let failures = failSave ? 1 : 0;
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
    } else if (path.endsWith("/models/refresh")) data = { kind: "discovered", models: [{ id: "fixture-model", name: "Fixture model", contextTokens: { value: 32000 }, maxOutputTokens: { value: null }, capabilities: { tools: { value: true, evidence: "declared" }, reasoning: { value: null, evidence: "unknown" }, structuredOutput: { value: null, evidence: "unknown" } }, lifecycle: "active", pricing: null }], observedAt: "2026-10-21T12:00:00Z", visibility: "public_catalog", complete: true };
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
  await row.getByRole("button", { name: "Revoke", exact: true }).click(); await confirmation.getByRole("button", { name: "Revoke key", exact: true }).click();
  await expect(row.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await row.getByRole("button", { name: "Remove", exact: true }).click(); await confirmation.getByRole("button", { name: "Cancel" }).click(); await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Remove", exact: true }).click(); await confirmation.getByRole("button", { name: "Remove", exact: true }).click(); await expect(row).toHaveCount(0);
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
