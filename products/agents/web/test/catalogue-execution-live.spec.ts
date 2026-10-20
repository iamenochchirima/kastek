import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";

type Fixture = { url: string; organizationId: string; cookie: string; controlledProvider?: string; oauthProvider?: string };
const path = process.env.AGENTS_CATALOGUE_BROWSER_STATE;
test.use({ actionTimeout: 15_000 });
test.skip(!path || process.env.AGENTS_CATALOGUE_EXECUTION !== "1", "Requires the owned actual API + Restate + private S3 fixture");

async function calls(page: Page, f: Fixture, kind: string) {
  const response = await page.request.get(`${f.controlledProvider}/fixture/status`);
  return (await response.json()).calls.filter((call: { kind: string }) => call.kind === kind).length as number;
}
async function createAgent(page: Page, f: Fixture, name: string) {
  const response = await page.request.post(`${f.url}/api/organizations/${f.organizationId}/agents`, { headers: { Origin: f.url }, data: { name } });
  expect(response.status(), await response.text()).toBe(201); return (await response.json()).agent.id as string;
}
async function attachAndPublish(page: Page, f: Fixture, agent: string, name: string) {
  await page.goto(`${f.url}/app/agents/${agent}?section=tools`);
  const tools = page.getByRole("region", { name: "Tools catalogue", exact: true });
  await tools.getByRole("button", { name: "Available", exact: true }).click();
  const remove = tools.getByRole("button", { name: `Remove ${name}`, exact: true });
  if (await remove.count()) {
    await remove.click(); await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
    await page.reload(); await tools.getByRole("button", { name: "Available", exact: true }).click();
  }
  await tools.getByRole("button", { name: `Add ${name}`, exact: true }).click();
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Create version", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Version", exact: true })).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
}
async function runAndApprove(page: Page, f: Fixture, kind: string) {
  const before = await calls(page, f, kind);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use the selected connected tool once.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const approvals = page.getByRole("region", { name: "Tool approvals", exact: true });
  await expect(approvals.getByRole("button", { name: "Approve action", exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await calls(page, f, kind)).toBe(before);
  await approvals.getByRole("button", { name: "Approve action", exact: true }).click();
  expect(await calls(page, f, kind)).toBe(before);
  const decision = page.waitForResponse(response => response.url().endsWith("/decision") && response.request().method() === "POST");
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve action", exact: true }).click();
  const result = await decision; expect(result.status()).toBe(200); expect(result.request().postDataJSON().requestDigest).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.getByText("Controlled tool execution finished.", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await calls(page, f, kind)).toBe(before + 1);
}

test("actual controlled MCP: URL discovery → immutable agent version → exact review → send → reconnect → revoke", async ({ page, context }) => {
  test.setTimeout(120_000);
  const f: Fixture = JSON.parse(await readFile(path!, "utf8")); expect(f.controlledProvider).toBeTruthy();
  await context.addCookies([{ name: "agents_session", value: f.cookie, url: f.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const agent = await createAgent(page, f, "Published controlled MCP");
  await page.goto(`${f.url}/app/connections?profile=remote-mcp-v1`);
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill(`${f.controlledProvider}/mcp`);
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Controlled MCP execution");
  await dialog.getByLabel("Authentication", { exact: true }).selectOption("bearer");
  await dialog.getByLabel("Token", { exact: true }).fill("catalogue-initial-key");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /greet/ }).check();
  await dialog.getByRole("button", { name: "Add tools", exact: true }).click();
  await expect(dialog).toBeHidden();
  await attachAndPublish(page, f, agent, "Controlled MCP execution");
  await runAndApprove(page, f, "mcp");
  await page.request.post(`${f.controlledProvider}/fixture/rotate`);
  await page.goto(`${f.url}/app/connections`);
  const row = page.getByRole("region", { name: "Custom MCP connections", exact: true }).locator(".management-row").filter({ hasText: "Controlled MCP execution" });
  await row.getByRole("button", { name: "Details", exact: true }).click(); dialog = page.getByRole("dialog");
  await dialog.getByText("Connection settings", { exact: true }).click(); await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByLabel("Token", { exact: true }).fill("catalogue-replacement-key");
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Reconnect", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /greet/ }).check(); await dialog.getByRole("button", { name: "Add tools", exact: true }).click();
  await attachAndPublish(page, f, agent, "Controlled MCP execution"); await runAndApprove(page, f, "mcp");
  await page.goto(`${f.url}/app/connections`); const before = await calls(page, f, "mcp");
  await row.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(row.getByText("Disconnected", { exact: true })).toBeVisible();
  await page.goto(`${f.url}/app/agents/${agent}?section=chat`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use the revoked tool.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText(/^incomplete(?: ·|$)/).first()).toBeVisible({ timeout: 30_000 });
  expect(await calls(page, f, "mcp")).toBe(before); expect(errors).toEqual([]);
});

test("actual controlled native API: import → version → exact execution → provider expiry → credential repair → new version", async ({ page, context }) => {
  test.setTimeout(120_000);
  const f: Fixture = JSON.parse(await readFile(path!, "utf8")); expect(f.controlledProvider).toBeTruthy();
  await context.addCookies([{ name: "agents_session", value: f.cookie, url: f.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.request.post(`${f.controlledProvider}/fixture/reset`);
  const agent = await createAgent(page, f, "Published controlled API");
  const document = { openapi: "3.1.0", info: { title: "Controlled API execution", version: "1" }, servers: [{ url: f.controlledProvider }], security: [{ fixtureBearer: [] }],
    components: { securitySchemes: { fixtureBearer: { type: "http", scheme: "bearer" } } }, paths: { "/greeting": { get: { operationId: "greeting", summary: "Read controlled greeting", responses: { "200": { description: "Greeting", content: { "application/json": { schema: { type: "object", properties: { greeting: { type: "string" } }, required: ["greeting"], additionalProperties: false } } } } } } } } };
  await page.goto(`${f.url}/app/connections?profile=custom-api-v1`);
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill(f.controlledProvider!);
  await dialog.getByLabel("OpenAPI document", { exact: true }).fill(JSON.stringify(document));
  await dialog.getByRole("button", { name: "Preview operations", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /Read controlled greeting/ }).check();
  await dialog.getByLabel("Token", { exact: true }).fill("catalogue-initial-key");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toBeHidden();
  await attachAndPublish(page, f, agent, "Controlled API execution"); await runAndApprove(page, f, "api");
  const before = await calls(page, f, "api");
  await page.request.post(`${f.controlledProvider}/fixture/expire`);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Use the connected API after provider expiry.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const approvals = page.getByRole("region", { name: "Tool approvals", exact: true });
  await expect(approvals.getByRole("button", { name: "Approve action", exact: true })).toBeVisible({ timeout: 30_000 });
  await approvals.getByRole("button", { name: "Approve action", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve action", exact: true }).click();
  await expect(page.getByText(/^uncertain(?: ·|$)/).first()).toBeVisible({ timeout: 30_000 });
  expect(await calls(page, f, "api")).toBe(before);
  await page.request.post(`${f.controlledProvider}/fixture/rotate`);
  await page.goto(`${f.url}/app/connections`);
  const row = page.getByRole("region", { name: "Custom API connections", exact: true }).locator(".management-row").filter({ hasText: "Controlled API execution" });
  await row.getByRole("button", { name: "Manage operations", exact: true }).click(); dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await dialog.getByLabel("Token", { exact: true }).fill("catalogue-replacement-key");
  await dialog.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: /Read controlled greeting/ })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: /Read controlled greeting/ }).check();
  await dialog.getByRole("button", { name: "Save operations", exact: true }).click();
  await expect(dialog).toBeHidden();
  await attachAndPublish(page, f, agent, "Controlled API execution"); await runAndApprove(page, f, "api");
  expect(errors).toEqual([]);
});

test("actual controlled OAuth: full page sign-in, cancellation and one-use callback across tabs", async ({ page, context }) => {
  const f: Fixture = JSON.parse(await readFile(path!, "utf8")); expect(f.oauthProvider).toBeTruthy();
  await context.addCookies([{ name: "agents_session", value: f.cookie, url: f.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${f.url}/app/connections?profile=remote-mcp-v1`);
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill(`${f.oauthProvider}/mcp`);
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Controlled OAuth consent");
  await dialog.getByLabel("Authentication", { exact: true }).selectOption("oauth");
  const creation = page.waitForResponse(response => response.url().endsWith("/remote-connections") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  const connection = (await (await creation).json()).connection;
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`^${f.oauthProvider!.replaceAll(".", "\\.")}/authorize`));
  expect(context.pages()).toHaveLength(1);
  await page.getByRole("link", { name: "Cancel authorization", exact: true }).click();
  await expect(page).toHaveURL(/\/api\/connections\/oauth\/callback/);
  expect((await (await page.request.get(`${f.oauthProvider}/fixture/status`)).json()).exchanges).toBe(0);
  const cancelledCallback = page.url();
  const replay = await page.request.get(cancelledCallback); expect(replay.status()).toBe(400);
  await page.goto(`${f.url}/app/connections?setup=${connection.id}`); dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Controlled provider consent", exact: true })).toBeVisible();
  const consent = page.url(), original = page;
  const otherTab = await context.newPage();
  await otherTab.goto(consent);
  await otherTab.getByRole("link", { name: "Authorize acceptance tool", exact: true }).click();
  await expect(otherTab).toHaveURL(`${f.url}/app/connections?setup=${connection.id}`);
  expect((await (await otherTab.request.get(`${f.oauthProvider}/fixture/status`)).json()).exchanges).toBe(1);
  await original.goto(`${f.url}/app/connections?setup=${connection.id}`);
  await original.getByRole("dialog").getByRole("button", { name: "Check tools", exact: true }).click();
  await expect(original.getByRole("dialog").getByRole("checkbox", { name: /approved lookup/ })).toBeVisible();
  expect(errors).toEqual([]); await otherTab.close();
});
