import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { RemoteConnection, CatalogCandidate, CapabilityBinding } from "../src/platform/api";

async function fixture(page: Page, mode: "tools" | "empty" | "oauth" | "failure" = "tools") {
  let connection: RemoteConnection | null = null, creates = 0, discoveries = 0, disconnects = 0;
  let candidate: CatalogCandidate | null = null;
  let bindings: CapabilityBinding[] = [];
  const toolSelections: unknown[] = [], credentialUpdates: unknown[] = [];
  const errors: string[] = [], submitted: Record<string, unknown>[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Research", role: "owner" }] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [], profiles: [{ id: "github-public-read-v1", label: "GitHub", allowedTransports: ["native_http"] }] };
    else if (path.endsWith("/api-connections")) data = { connections: [] };
    else if (path.endsWith("/remote-connections")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON(); submitted.push(body); creates++;
        if (mode === "failure" && creates === 1) { await route.fulfill({ status: 400, json: { error: { message: "Server address is unavailable" } } }); return; }
        connection = { id: "remote1", name: body.name ?? "MCP server", endpoint: body.endpoint, authentication: body.authentication, status: "draft", revision: 1, generation: 4, identity: null, lastError: null, createdAt: "2026-10-20T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z" };
        data = { connection };
      } else data = { connections: connection ? [connection] : [] };
    } else if (path.endsWith("/remote1/credentials")) {
      const body = request.postDataJSON(); credentialUpdates.push(body);
      expect(body.generation).toBe(connection!.generation);
      expect(body).not.toHaveProperty("endpoint"); expect(body).not.toHaveProperty("name");
      connection = { ...connection!, authentication: body.authentication, status: "draft", generation: connection!.generation + 1, revision: connection!.revision + 1 }; bindings = []; candidate = null; data = { connection };
    } else if (path.endsWith("/remote1/discover")) {
      expect(request.postDataJSON()).toEqual({ generation: connection!.generation }); discoveries++;
      connection = { ...connection!, status: mode === "oauth" && discoveries === 1 ? "authorization_required" : "selection_required", lastError: mode === "oauth" && discoveries === 1 ? "AUTHENTICATION" : null };
      const tools = mode === "empty" ? [] : [{ name: "search_documents", description: "Search documents approved for this connection.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, schemaDigest: "digest" }];
      candidate = { id: "catalog1", connectionId: "remote1", credentialRevision: connection.revision, policyRevision: 1, createdAt: "2026-10-20T00:00:00Z", selectableOperations: tools.map(tool => tool.name), catalog: { revision: 1, transport: "mcp_http", protocolVersion: "2025-11-25", tools: tools.map(tool => ({ providerOperation: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } };
      data = { connection, ...(connection.status === "selection_required" ? { catalog: { protocolVersion: "2025-11-25", tools }, candidate } : {}) };
    } else if (path.endsWith("/connections/remote1/catalogs")) data = { catalogs: candidate ? [candidate] : [] };
    else if (path.endsWith("/tool-bindings")) data = { bindings };
    else if (path.endsWith("/catalogs/catalog1/select")) {
      const body = request.postDataJSON(); toolSelections.push(body);
      expect(body.expectedRevision).toBe(connection!.revision); expect(body.selections).toEqual([{ providerOperation: "search_documents", resources: [{ kind: "mcp.endpoint", id: connection!.endpoint }] }]);
      bindings = [{ id: "binding1", alias: "search_documents", digest: "binding-digest", transport: "mcp_http", definition: { providerOperation: "search_documents", description: "Search documents" }, connection: { id: "remote1", profileId: "remote-mcp-v1", policyRevision: 1 }, resources: [{ kind: "mcp.endpoint", id: connection!.endpoint }] }]; data = { bindings };
    } else if (path.endsWith("/remote1/disconnect")) { expect(request.postDataJSON()).toEqual({ generation: 4 }); disconnects++; connection = { ...connection!, status: "disconnected", generation: 5 }; data = { disconnected: true, upstreamRevocation: "not_attempted" }; }
    else if (path.endsWith("/remote1/authorize")) { expect(request.postDataJSON()).toEqual({ generation: 4 }); data = { connection: { ...connection!, status: "authenticating" }, authorizationUrl: "https://provider.example.test/authorize?state=opaque" }; }
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected remote mock route ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { submitted, toolSelections, credentialUpdates, errors, discoveries: () => discoveries, disconnects: () => disconnects };
}

for (const width of [1440, 768, 390]) {
  test(`mock transport: URL-first MCP discovery and local disconnect at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixture(page);
    await page.goto("/app/connections");
    await page.getByRole("button", { name: "Custom MCP", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Server URL", exact: true })).toBeFocused();
    await expect(dialog.getByLabel("Authentication", { exact: true })).not.toBeVisible();
    await dialog.getByLabel("Server URL", { exact: true }).fill("https://mcp.example.test/mcp");
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-mcp-url-${width}.png`), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Tools · 1", exact: true })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /search documents/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add tools", exact: true })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Search server tools", exact: true }).fill("missing tool");
    await expect(dialog.getByText("No matching tools.", { exact: true })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Search server tools", exact: true }).fill("");
    await dialog.getByRole("checkbox", { name: /search documents/ }).check();
    await expect(dialog.getByText("Requests require approval of the exact action and data.", { exact: true })).toBeVisible();
    expect(state.submitted[0]).toMatchObject({ endpoint: "https://mcp.example.test/mcp", authentication: "auto" });
    expect(state.submitted[0]).not.toHaveProperty("secret");
    expect(state.discoveries()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-mcp-tools-${width}.png`), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "Add tools", exact: true }).click();
    await expect(dialog).toBeHidden(); expect(state.toolSelections).toHaveLength(1);
    await page.getByRole("region", { name: "Custom MCP connections" }).getByRole("button", { name: "Details", exact: true }).click();
    await expect(dialog.getByText("Added tools · 1", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    expect(state.disconnects()).toBe(0);
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.disconnects()).toBe(0);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Disconnected", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Provider access may remain active.", { exact: true })).toBeVisible();
    expect(state.disconnects()).toBe(1); expect(state.errors).toEqual([]);
  });
}

test("mock transport: MCP credential errors preserve URL and masked secret for retry", async ({ page }) => {
  const state = await fixture(page, "failure");
  await page.goto("/app/connections");
  await page.getByRole("button", { name: "Custom MCP", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill("https://mcp.example.test/mcp");
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByLabel("Authentication", { exact: true }).selectOption("header");
  await dialog.getByLabel("Header name", { exact: true }).fill("X-API-Key");
  await dialog.getByLabel("API key", { exact: true }).fill("fixture_secret");
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Server address is unavailable");
  await expect(dialog.getByLabel("Server URL", { exact: true })).toHaveValue("https://mcp.example.test/mcp");
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("fixture_secret");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Tools · 1", exact: true })).toBeVisible();
  expect(state.submitted[1]).toEqual(state.submitted[0]);
  expect(await page.evaluate(() => Object.values(sessionStorage).some(value => value.includes("fixture_secret")))).toBe(false);
});

test("mock transport: zero tools is explicit", async ({ page }) => {
  await fixture(page, "empty");
  await page.goto("/app/connections?profile=custom-mcp");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill("https://mcp.example.test/mcp");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByText("This server returned no tools.", { exact: true })).toBeVisible();
});

test("mock transport: OAuth requires user sign in and sends the current generation", async ({ page }) => {
  await fixture(page, "oauth");
  await page.route("https://provider.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Mock provider sign in</h1>" }));
  await page.goto("/app/connections?profile=custom-mcp");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill("https://mcp.example.test/mcp");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/connections/);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("https://provider.example.test/authorize?state=opaque");
});

test("mock transport: provider deep link retains return to agent and selected profile", async ({ page }) => {
  await fixture(page);
  const returnTo = "/app/agents/root?section=tools";
  await page.goto(`/app/connections?profile=github-public-read-v1&returnTo=${encodeURIComponent(returnTo)}`);
  await expect(page.getByRole("dialog").getByLabel("Provider", { exact: true })).toHaveValue("github-public-read-v1");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "Back to agent", exact: true })).toHaveAttribute("href", returnTo);
});


test("mock transport: an explicit OAuth client stays masked and is submitted only with setup", async ({ page }) => {
  const state = await fixture(page, "oauth");
  await page.goto("/app/connections?profile=custom-mcp");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill("https://mcp.example.test/mcp");
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByText("OAuth client", { exact: true }).click();
  await dialog.getByLabel("Issuer URL", { exact: true }).fill("https://identity.example.com");
  await dialog.getByLabel("Client ID", { exact: true }).fill("registered-client");
  await dialog.getByRole("combobox", { name: "Client authentication", exact: true }).selectOption("client_secret_basic");
  await dialog.getByLabel("Client secret", { exact: true }).fill("fixture_client_secret");
  await expect(dialog.getByLabel("Client secret", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(state.submitted[0].oauthClient).toEqual({ issuer: "https://identity.example.com", clientId: "registered-client", authMethod: "client_secret_basic", clientSecret: "fixture_client_secret" });
  expect(await page.evaluate(() => Object.values(sessionStorage).some(value => value.includes("fixture_client_secret")))).toBe(false);
});


test("mock transport: reconnect fences old tools and requires an explicit new key", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/connections?profile=custom-mcp");
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill("https://mcp.example.test/mcp");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /search documents/ }).check();
  await dialog.getByRole("button", { name: "Add tools", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("region", { name: "Custom MCP connections" }).getByRole("button", { name: "Details", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByText("Connection settings", { exact: true }).click();
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Reconnect server", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Server URL", { exact: true })).toBeDisabled();
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByRole("combobox", { name: "Authentication", exact: true }).selectOption("header");
  await dialog.getByLabel("Header name", { exact: true }).fill("X-API-Key");
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("");
  await dialog.getByLabel("API key", { exact: true }).fill("replacement_remote_secret");
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  expect(state.credentialUpdates).toEqual([]);
  await expect(page.getByRole("alertdialog")).toContainText("Published agents will need their tool access reviewed");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("replacement_remote_secret");
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Tools · 1", exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /search documents/ })).not.toBeChecked();
  await expect(dialog.getByText("Added tools · 1", { exact: true })).toHaveCount(0);
  expect(state.credentialUpdates).toHaveLength(1);
  expect(state.credentialUpdates[0]).toMatchObject({ generation: 4, authentication: "header", headerName: "X-API-Key", secret: "replacement_remote_secret" });
});
