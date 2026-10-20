import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", connectionId = "44444444-4444-4444-8444-444444444444";
const itemIds = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
for (const width of [1440, 768, 390]) {
  test(`mock transport: scoped Stash connection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    let connection: Record<string, unknown> | null = null, catalog: Record<string, unknown> | null = null, creates = 0, selected = false;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname, body = request.method() === "GET" ? null : request.postDataJSON();
      let data: unknown;
      if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Research", role: "owner" }] };
      else if (path.endsWith("/api-connections")) data = { connections: [] };
    else if (path.endsWith("/remote-connections")) data = { connections: [] };
      else if (path.endsWith("/connections")) {
        if (request.method() === "POST") {
          creates++;
          expect(body.profileId).toBe("stash-read-v1"); expect(body.targetId).toBe("provider:stash");
          expect(body.stashItemIds).toEqual(itemIds); expect(body.selections ?? []).toEqual([]);
          expect(body.endpoint).toBeUndefined(); expect(body.url).toBeUndefined();
          expect(body.apiKey).toBe("fixture_stash_key_write_only"); expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
          connection = { id: connectionId, name: body.name, profileId: body.profileId, targetId: body.targetId, targetLabel: "Stash", resource: "stash:items", revision: 1, policyRevision: 1, state: "active", expiresAt: body.expiresAt, createdAt: new Date().toISOString(), stashItemIds: body.stashItemIds, resources: itemIds.map(id => ({ kind: "stash.item", id })) };
          data = { connection };
        } else data = { connections: connection ? [connection] : [], targets: [], profiles: [{ id: "github-public-read-v1", label: "GitHub", allowedTransports: ["native_http", "mcp_http"] }, { id: "stash-read-v1", label: "Stash", allowedTransports: ["mcp_http"] }] };
      } else if (path.endsWith("/catalogs/discover")) {
        expect(body.transport).toBe("mcp_http");
        catalog = { id: "catalog-1", connectionId, credentialRevision: 1, policyRevision: 1, createdAt: new Date().toISOString(), selectableOperations: ["get_item", "read_project_document"], catalog: { revision: 1, transport: "mcp_http", tools: [{ providerOperation: "get_item", description: "Read an approved item." }, { providerOperation: "read_project_document", description: "Read an approved project document." }, { providerOperation: "delete_item", description: "Delete an item." }] } };
        data = { catalog };
      } else if (path.endsWith("/catalogs")) data = { catalogs: catalog ? [catalog] : [] };
      else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
      else if (path.endsWith("/select")) {
        expect(body.selections).toEqual([{ providerOperation: "get_item", resources: [{ kind: "stash.item", id: itemIds[0] }] }]); selected = true; data = { bindings: [] };
      } else { await route.fulfill({ status: 404, json: { error: { message: "Missing fixture endpoint" } } }); return; }
      await route.fulfill({ json: data });
    });
    await page.goto("/app/connections");
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
    await dialog.getByLabel("Name", { exact: true }).fill("Stash research");
    await dialog.getByLabel("Provider", { exact: true }).selectOption("stash-read-v1");
    await expect(dialog.getByLabel("Provider", { exact: true })).toHaveValue("stash-read-v1");
    await expect(dialog.getByText(/Repository|Destination|Endpoint/)).toHaveCount(0);
    await dialog.getByLabel("Item ID 1", { exact: true }).fill(itemIds[0]);
    await dialog.getByRole("button", { name: "Add item", exact: true }).click();
    await dialog.getByLabel("Item ID 2", { exact: true }).fill(itemIds[0]);
    await dialog.getByLabel("API key", { exact: true }).fill("fixture_stash_key_write_only");
    await expect(dialog.getByLabel("Connection expires at", { exact: true })).not.toBeEmpty();
    await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
    await expect(dialog.getByText("Enter distinct, valid item IDs.", { exact: true })).toBeVisible(); expect(creates).toBe(0);
    await dialog.getByLabel("Item ID 2", { exact: true }).fill("invalid");
    await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
    expect(creates).toBe(0);
    await dialog.getByLabel("Item ID 2", { exact: true }).fill(itemIds[1]);
    const proof = resolve(process.cwd(), "../../../.audit"); await mkdir(proof, { recursive: true });
    await page.screenshot({ path: resolve(proof, `stash-create-${width}.png`), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Stash research", exact: true })).toBeVisible();
    await expect(page.getByText("Stash · 2 items", { exact: true })).toBeVisible(); expect(creates).toBe(1);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText("fixture_stash_key_write_only", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Manage tools", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Tool source", { exact: true })).toHaveValue("mcp_http");
    await expect(dialog.locator("option")).toHaveText(["Stash MCP"]);
    await dialog.getByRole("button", { name: "Find tools", exact: true }).click();
    await expect(dialog.getByRole("group", { name: "Items", exact: true })).toBeVisible();
    await dialog.getByRole("checkbox", { name: itemIds[1], exact: true }).uncheck();
    await dialog.getByRole("checkbox", { name: /Get item/ }).check();
    await expect(dialog.getByRole("checkbox", { name: /Delete item/ })).toHaveCount(0);
    await expect(dialog.getByText(/GitHub|Repositories/)).toHaveCount(0);
    await page.screenshot({ path: resolve(proof, `stash-tools-${width}.png`), fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole("button", { name: "Save tools", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden(); expect(selected).toBe(true);
    await page.getByRole("button", { name: "Replace key", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("API key", { exact: true })).toBeEmpty();
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeHidden();
    expect(errors).toEqual([]);
  });
}
