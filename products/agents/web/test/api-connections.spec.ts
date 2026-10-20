import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { ApiConnection, ApiOperation, ApiPreview } from "../src/platform/api";

const document = "openapi: 3.1.0\ninfo:\n  title: Customer API\n  version: '1'\npaths: {}";
const serverUrl = "https://api.example.com/v1";
const operation = (id: string, summary: string, method = "GET"): ApiOperation => ({ id, operationId: id, method, path: method === "GET" ? "/customers" : "/customers/{id}", summary, compatible: true, diagnostics: [], security: { schemeId: "apiKey", type: "api_key", name: "X-API-Key", in: "header", scopes: [] }, credentialState: "required", effect: "unknown", reviewRequired: true, parameters: method === "GET" ? [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }] : [], requestBody: method === "POST" ? { required: true, contentType: "application/json", schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } } : null, responseSchemas: [{ status: "200", contentType: "application/json", schema: { type: "array" } }] });

async function fixture(page: Page, mode: "normal" | "empty" | "error" | "alternative" | "selection_error" | "request" = "normal") {
  let connection: ApiConnection | null = null, selected: string[] = [], previewCalls = 0, createCalls = 0, selectionCalls = 0;
  const requests: { path: string; body: Record<string, unknown> }[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, body = request.method() === "GET" ? null : request.postDataJSON();
    if (body) requests.push({ path, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Customer API tests", role: "owner" }] };
    else if (path.endsWith("/connectors")) data = {connectors:[]};
    else if (path.endsWith("/connections")) data = { connections: [], targets: [], profiles: [] };
    else if (path.endsWith("/remote-connections")) data = { connections: [] };
    else if (path.endsWith("/api-connections/preview")) {
      previewCalls++;
      if (mode === "error" && previewCalls === 1) { await route.fulfill({ status: 400, json: { error: { message: "Invalid OpenAPI JSON or YAML" } } }); return; }
      expect(body.serverUrl).toBe(serverUrl); if(mode === "request") { expect(body.document).toBeUndefined(); expect(body.requestTemplate).toMatchObject({title:"Find a customer",method:"GET",path:"/customers/{id}",parameters:[{name:"id",in:"path",required:true,schema:{type:"string"}}],securityScheme:{type:"apiKey",in:"header",name:"X-API-Key"}}); } else expect(body.document).toBe(document);
      const base = operation("listCustomers", "List customers");
      const alternative = { ...base, compatible: Boolean(body.securitySelections), security: body.securitySelections ? { schemeId: "none", type: "none", scopes: [] } : null, securityChoices: [{ index: 0, security: base.security, diagnostics: [] }, { index: 1, security: { schemeId: "none", type: "none", scopes: [] }, diagnostics: [] }, { index: 2, security: { schemeId: "oauth", type: "oauth2", scopes: [] }, diagnostics: [] }], credentialState: body.securitySelections ? "none" : "unsupported", diagnostics: body.securitySelections ? [] : [{ code: "OPENAPI_SECURITY_ALTERNATIVES_UNSUPPORTED", message: "Select one security alternative before activation" }] };
      const oauth = { ...operation("oauthWrite", "Update customer account", "PATCH"), compatible: false, credentialState: "unsupported", security: { schemeId: "oauth", type: "oauth2", scopes: ["customers:write"] }, diagnostics: [{ code: "API_OAUTH_CLIENT_REQUIRED", message: "OAuth client configuration is required." }] };
      data = { preview: { importDigest: body.securitySelections ? "digest-alternative" : "digest", title: "Customer API", server: { url: serverUrl, origin: "https://api.example.com" }, operations: mode === "empty" ? [] : mode === "alternative" ? [alternative] : [base, operation("createCustomer", "Create customer", "POST"), oauth], diagnostics: mode === "empty" ? [{ code: "OPENAPI_NO_OPERATIONS", message: "No supported HTTP operation definitions were found." }] : [] } as ApiPreview };
    } else if (path.endsWith("/api-connections")) {
      if (request.method() === "POST") {
        createCalls++; expect(body.expectedImportDigest).toBe(mode === "alternative" ? "digest-alternative" : "digest");
        if (mode !== "alternative") expect(body.credentials).toEqual({ apiKey: { type: "api_key", value: "fixture_api_key" } });
        else { expect(body.securitySelections).toEqual({ listCustomers: 1 }); expect(body.credentials).toEqual({}); }
        connection = { id: "api1", name: body.name, title: "Customer API", serverUrl, origin: "https://api.example.com", importDigest: body.expectedImportDigest, status: "selection_required", revision: 1, policyRevision: 1, generation: 1, selectedOperationIds: [], credentialSchemes: [{ schemeId: "apiKey", type: "api_key", configured: mode !== "alternative" }], lastError: null, createdAt: "2026-10-20T00:00:00Z", expiresAt: "2035-01-01T00:00:00Z" }; data = { connection };
      } else data = { connections: connection ? [connection] : [] };
    } else if (path.endsWith("/api1/operations")) {
      if (request.method() === "POST") {
        selectionCalls++;
        if (mode === "selection_error" && selectionCalls === 1) { await route.fulfill({ status: 409, json: { error: { message: "Operation selection could not be saved. Retry." } } }); return; }
        expect(body.expectedGeneration).toBe(connection!.generation);
        const selections = body.selections as { operationId: string; effectPolicy: string }[];
        expect(selections.every(selection => selection.effectPolicy === "exact_review")).toBe(true);
        selected = selections.map(selection => selection.operationId); connection = { ...connection!, status: "ready", generation: connection!.generation + 1, selectedOperationIds: selected }; data = { connection, bindings: [] };
      } else data = { operations: [operation("listCustomers", "List customers"), operation("createCustomer", "Create customer", "POST")].map((item, index) => ({ ...item, id: `operation${index + 1}`, alias: item.id, selected: selected.includes(`operation${index + 1}`) })) };
    } else if (path.endsWith("/api1/credentials")) { expect(body.expectedGeneration).toBe(connection!.generation); expect(body.credentials).toEqual({ apiKey: { type: "api_key", value: "replacement_key" } }); selected = []; connection = { ...connection!, status: "selection_required", selectedOperationIds: [], generation: connection!.generation + 1 }; data = { connection }; }
    else if (path.endsWith("/api1/disconnect")) { expect(body.expectedGeneration).toBe(connection!.generation); connection = { ...connection!, status: "disconnected", generation: connection!.generation + 1 }; data = { connection }; }
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected native API fixture ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { requests, errors, createCalls: () => createCalls };
}

async function openPreview(page: Page) {
  await page.goto("/app/connections?profile=custom-api");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill(serverUrl);
  await dialog.getByLabel("OpenAPI file", { exact: true }).setInputFiles({ name: "customers.yaml", mimeType: "application/yaml", buffer: Buffer.from(document) });
  await expect(dialog.getByLabel("OpenAPI document", { exact: true })).toHaveValue(document);
  await dialog.getByRole("button", { name: "Preview operations", exact: true }).click();
  return dialog;
}
for (const width of [1440, 768, 390]) {
  test(`mock transport: OpenAPI preview, masked keys and exact operation selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixture(page);
    const dialog = await openPreview(page);
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Customer API");
    await expect(dialog.getByRole("checkbox", { name: /Update customer account/ })).toBeDisabled();
    await expect(dialog.getByText("OAuth client configuration is required.", { exact: true })).toBeVisible();
    await dialog.getByRole("checkbox", { name: /List customers/ }).check();
    await dialog.getByRole("checkbox", { name: /Create customer/ }).check();
    await dialog.getByText("Parameters and responses", { exact: true }).first().click();
    await expect(dialog.getByText("limit · query", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("X-API-Key", { exact: true })).toHaveAttribute("type", "password");
    await dialog.getByLabel("X-API-Key", { exact: true }).fill("fixture_api_key");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-api-preview-${width}.png`), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "Customer API", exact: true })).toBeVisible();
    await expect(page.getByText("Operations selected · 2 selected", { exact: true })).toBeVisible();
    expect(state.createCalls()).toBe(1);
    expect(state.requests.filter(request => request.path.endsWith("/api1/operations")).at(-1)?.body.selections).toEqual([{ operationId: "operation1", effectPolicy: "exact_review" }, { operationId: "operation2", effectPolicy: "exact_review" }]);
    expect(state.requests.some(request => request.path.endsWith("/probe"))).toBe(false);
    expect(await page.evaluate(() => Object.values(sessionStorage).some(value => value.includes("fixture_api_key")))).toBe(false);
    expect(state.errors).toEqual([]);
  });
}

test("mock transport: document errors preserve the source and explicit server", async ({ page }) => {
  await fixture(page, "error");
  const dialog = await openPreview(page);
  await expect(dialog.getByRole("alert")).toContainText("Invalid OpenAPI JSON or YAML");
  await expect(dialog.getByLabel("Server URL", { exact: true })).toHaveValue(serverUrl);
  await expect(dialog.getByLabel("OpenAPI document", { exact: true })).toHaveValue(document);
  await dialog.getByRole("button", { name: "Preview operations", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: /List customers/ })).toBeVisible();
});

test("mock transport: no compatible operations cannot be saved", async ({ page }) => {
  const state = await fixture(page, "empty");
  const dialog = await openPreview(page);
  await expect(dialog.getByText("No compatible operations. Review the document's diagnostics before importing.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save connection", exact: true })).toBeDisabled();
  expect(state.createCalls()).toBe(0);
});

test("mock transport: authentication alternatives require a fresh server preview", async ({ page }) => {
  const state = await fixture(page, "alternative");
  const dialog = await openPreview(page);
  await expect(dialog.getByRole("checkbox", { name: /List customers/ })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Authentication for List customers", exact: true }).selectOption("1");
  await dialog.getByRole("button", { name: "Update preview", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /List customers/ }).check();
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.createCalls()).toBe(1);
});

test("mock transport: selection retry reuses the imported connection", async ({ page }) => {
  const state = await fixture(page, "selection_error");
  const dialog = await openPreview(page);
  await dialog.getByRole("checkbox", { name: /List customers/ }).check();
  await dialog.getByLabel("X-API-Key", { exact: true }).fill("fixture_api_key");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Operation selection could not be saved");
  await expect(dialog.getByRole("checkbox", { name: /List customers/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toBeHidden(); expect(state.createCalls()).toBe(1);
});

test("mock transport: saved operations and credential rotation use current generations", async ({ page }) => {
  await fixture(page);
  let dialog = await openPreview(page);
  await dialog.getByRole("checkbox", { name: /List customers/ }).check();
  await dialog.getByLabel("X-API-Key", { exact: true }).fill("fixture_api_key");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Manage operations", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox", { name: /List customers/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(dialog.getByLabel("X-API-Key", { exact: true })).toHaveValue("");
  await dialog.getByLabel("X-API-Key", { exact: true }).fill("replacement_key");
  await dialog.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: /List customers/ })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: /List customers/ }).check();
  await dialog.getByRole("button", { name: "Save operations", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("region", { name: "Custom API connections" }).getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Disconnected · 1 selected", { exact: true })).toBeVisible();
});

for (const width of [1440, 768, 390]) {
  test(`mock transport: authored request preview and save without manual JSON at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixture(page, "request");
    await page.goto("/app/connections?profile=custom-api");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Server URL", { exact: true }).fill(serverUrl);
    await dialog.getByLabel("Definition source", { exact: true }).selectOption("request");
    await expect(dialog.getByLabel("OpenAPI document", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Action name", { exact: true }).fill("Find a customer");
    await dialog.getByLabel("Request path", { exact: true }).fill("/customers/{id}");
    await dialog.getByLabel("Authentication", { exact: true }).selectOption("header");
    await dialog.getByLabel("API key parameter name", { exact: true }).fill("X-API-Key");
    await dialog.getByRole("button", { name: "Add parameter", exact: true }).click();
    await dialog.getByLabel("Parameter name", { exact: true }).fill("id");
    await dialog.getByLabel("Location", { exact: true }).selectOption("path");
    await expect(dialog.getByLabel("Required", { exact: true })).toBeChecked();
    await expect(dialog.getByLabel("Required", { exact: true })).toBeDisabled();
    await page.screenshot({path:resolve(process.cwd(),`../../../.audit/api-request-definition-${width}.png`),fullPage:true});
    await dialog.getByRole("button", { name: "Preview operations", exact: true }).click();
    await dialog.getByRole("checkbox", { name: /List customers/ }).check();
    const key = dialog.getByLabel("X-API-Key", { exact: true });
    await expect(key).toHaveAttribute("type", "password"); await key.fill("fixture_api_key");
    await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(dialog).toBeHidden();
    const saved = state.requests.find(item => item.path.endsWith("/api-connections") && item.body.requestTemplate);
    expect(saved?.body.requestTemplate).toMatchObject({title:"Find a customer",path:"/customers/{id}"});
    expect(saved?.body.document).toBeUndefined(); expect(state.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path:resolve(process.cwd(),`../../../.audit/api-request-editor-${width}.png`),fullPage:true});
  });
}
