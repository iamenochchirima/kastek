import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", connectionId = "44444444-4444-4444-8444-444444444444";
for (const width of [1440, 768, 390]) {
  test(`mock transport: public repositories without credentials at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    let connection: Record<string, unknown> | null = null, catalog: Record<string, unknown> | null = null, revoked = false;
    const selected: string[] = [], discoveries: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname, body = request.method() === "GET" ? null : request.postDataJSON();
      let data: unknown;
      if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Research", role: "owner" }] };
      else if (path.endsWith("/api-connections")) data = { connections: [] };
    else if (path.endsWith("/remote-connections")) data = { connections: [] };
      else if (path.endsWith("/connectors")) data = { connectors: [] };
    else if (path.endsWith("/connections")) {
        if (request.method() === "POST") {
          expect(body.profileId).toBe("public-repository-read-v1"); expect(body.targetId).toBe("provider:public-repository");
          expect(body.selections).toEqual([{ owner: "approved", repository: "public-repo", ref: "main" }]);
          expect(body).not.toHaveProperty("apiKey"); expect(body).not.toHaveProperty("endpoint"); expect(body).not.toHaveProperty("url");
          expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
          connection = { id: connectionId, name: body.name, profileId: body.profileId, targetId: body.targetId, targetLabel: "Public repositories", authentication: "none", resource: "github:public-repositories", selections: body.selections, revision: 1, policyRevision: 1, state: "active", expiresAt: body.expiresAt, createdAt: new Date().toISOString(), resources: [{ kind: "github.repository", id: "approved/public-repo" }] };
          data = { connection };
        } else data = { connections: connection ? [connection] : [], targets: [], profiles: [{ id: "github-public-read-v1", label: "GitHub", allowedTransports: ["native_http", "mcp_http"] }, { id: "public-repository-read-v1", label: "Public repositories", allowedTransports: ["native_http", "mcp_http"] }] };
      } else if (path.endsWith("/catalogs/discover")) {
        discoveries.push(body.transport);
        const operation = body.transport === "native_http" ? "get_repository" : "read_wiki_structure";
        catalog = { id: `catalog-${body.transport}`, connectionId, credentialRevision: 1, policyRevision: 1, createdAt: new Date().toISOString(), selectableOperations: [operation], catalog: { revision: 1, transport: body.transport, tools: [{ providerOperation: operation, description: "Read an approved public repository." }, { providerOperation: "ask_question", description: "Generate an answer." }] } };
        data = { catalog };
      } else if (path.endsWith("/catalogs")) data = { catalogs: catalog ? [catalog] : [] };
      else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
      else if (path.endsWith("/select")) { expect(body.selections[0].resources).toEqual([{ kind: "github.repository", id: "approved/public-repo" }]); selected.push(body.selections[0].providerOperation); data = { bindings: [] }; }
      else if (path.endsWith("/revoke")) { expect(body.expectedRevision).toBe(1); revoked = true; connection = { ...connection, state: "revoked", revision: 2 }; data = { connection }; }
      else { await route.fulfill({ status: 404, json: { error: { message: "Missing fixture endpoint" } } }); return; }
      await route.fulfill({ json: data });
    });
    await page.goto("/app/connections");
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
    await dialog.getByLabel("Name", { exact: true }).fill("Public research");
    await dialog.getByLabel("GitHub token", { exact: true }).fill("fixture_key_must_not_be_submitted");
    await dialog.getByLabel("Provider", { exact: true }).selectOption("public-repository-read-v1");
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await expect(dialog.getByLabel("API key", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Repository 1", { exact: true }).fill("approved/public-repo");
    await expect(dialog.getByLabel("Connection expires at", { exact: true })).not.toBeEmpty();
    const proof = resolve(process.cwd(), "../../../.audit"); await mkdir(proof, { recursive: true });
    await page.screenshot({ path: resolve(proof, `public-create-${width}.png`), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Public research", exact: true })).toBeVisible();
    await expect(page.getByText("Public repositories · 1 repository", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Replace key", exact: true })).toHaveCount(0);
    for (const transport of ["native_http", "mcp_http"]) {
      await page.getByRole("button", { name: "Manage tools", exact: true }).click(); dialog = page.getByRole("dialog");
      await expect(dialog.locator("option")).toHaveText(["Public API", "DeepWiki MCP"]);
      await dialog.getByLabel("Tool source", { exact: true }).selectOption(transport);
      await dialog.getByRole("button", { name: "Find tools", exact: true }).click();
      await expect(dialog.getByRole("group", { name: "Repositories", exact: true })).toBeVisible();
      await dialog.getByRole("checkbox", { name: transport === "native_http" ? /Get repository/ : /Read wiki structure/ }).check();
      await expect(dialog.getByRole("checkbox", { name: /Ask question/ })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (transport === "mcp_http") await page.screenshot({ path: resolve(proof, `public-tools-${width}.png`), fullPage: true, animations: "disabled" });
      await dialog.getByRole("button", { name: "Save tools", exact: true }).click(); await expect(dialog).toBeHidden();
    }
    expect(discoveries).toEqual(["native_http", "mcp_http"]); expect(selected).toEqual(["get_repository", "read_wiki_structure"]);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    expect(revoked).toBe(false); await page.keyboard.press("Escape"); expect(revoked).toBe(false);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke connection", exact: true }).click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible(); expect(revoked).toBe(true); expect(errors).toEqual([]);
  });
}
