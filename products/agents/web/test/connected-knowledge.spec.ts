import { navigateWorkspace } from "./workspace-fixtures";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333", connectionId = "44444444-4444-4444-8444-444444444444";
const catalogId = "55555555-5555-4555-8555-555555555555";
for (const width of [1440, 768, 390]) {
  test(`mock transport: source approval and scoped GitHub setup at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [], consoleErrors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", event => { if (event.type() === "error") consoleErrors.push(event.text()); });
    let source: Record<string, unknown> | null = null, connection: Record<string, unknown> | null = null;
    let imported = false, approved = false, published = false, selected = false, revoked = false;
    const candidates: unknown[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, body = request.method() === "GET" ? null : request.postDataJSON();
      let data: unknown;
      if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Research", role: "owner" }] };
      else if (path.endsWith("/knowledge/sources")) data = { sources: source ? [source] : [], imports: imported ? [{ id: "import-1", sourceId, revisionId, revision: 1, state: "ready", acceptedGeneration: 1, contentType: "text/plain", parserRelease: "text-v1", deadline: new Date(Date.now() + 10000).toISOString(), errorCode: null, createdAt: new Date().toISOString() }] : [] };
      else if (path.endsWith("/knowledge/imports")) {
        expect(body.kind).toBe("upload"); expect(body.contentType).toBe("text/plain"); expect(body.visibility).toBeUndefined();
        expect(Buffer.from(body.contentBase64, "base64").toString()).toBe("Returns accepted within 30 days.");
        imported = true; source = { id: sourceId, organizationId: org, importerAccountId: "owner", title: body.title, kind: "upload", generation: 1, state: "active", visibility: "private", createdAt: new Date().toISOString(), canApprove: true,
          revisions: [{ id: revisionId, revision: 1, state: "candidate", acquiredAt: new Date().toISOString() }] }; data = { job: { id: "import-1", state: "queued" } };
      } else if (path.endsWith("/preview")) data = { text: "Returns accepted within 30 days.", chunks: [{ id: "chunk1", text: "Returns accepted within 30 days.", start: 0, end: 32, page: null }], acquiredAt: new Date().toISOString(), revisionId, revision: 1 };
      else if (path.endsWith("/policy")) {
        expect(body.expectedGeneration).toBe(source!.generation);
        if (body.action === "approve") { approved = true; source = { ...source, generation: 2, revisions: [{ id: revisionId, revision: 1, state: "approved", acquiredAt: new Date().toISOString() }] }; }
        else if (body.action === "visibility") { expect(approved).toBe(true); published = true; source = { ...source, generation: 3, visibility: body.visibility }; }
        else if (body.action === "withdraw") source = { ...source, generation: 4, state: "withdrawn" };
        data = { source };
      } else if (path.endsWith("/remote-connections")) data = { connections: [] };
      else if (path.endsWith("/connections")) {
        if (request.method() === "POST") {
          expect(body.profileId).toBe("github-public-read-v1"); expect(body.targetId).toBe("provider:github");
          expect(body.selections).toEqual([{ owner: "approved", repository: "public-repo", ref: "main" }]);
          connection = { id: connectionId, name: body.name, targetId: body.targetId, profileId: body.profileId, policyRevision: 1, resource: "github:public-repositories", revision: 1, state: "active", expiresAt: body.expiresAt, createdAt: new Date().toISOString(),
            targetLabel: "GitHub", resources: [{ kind: "github.repository", id: "approved/public-repo" }], selections: body.selections }; data = { connection };
        } else data = { connections: connection ? [connection] : [], targets: [], profiles: [{ id: "github-public-read-v1", label: "GitHub", allowedTransports: ["native_http", "mcp_http"] }] };
      } else if (path.endsWith("/catalogs/discover")) {
        const catalog = { id: catalogId, connectionId, credentialRevision: 1, policyRevision: 1, createdAt: new Date().toISOString(), selectableOperations: ["get_repository"], catalog: { revision: 1, transport: body.transport, tools: [{ providerOperation: "get_repository", description: "Read approved public repository details." }, { providerOperation: "delete_repository", description: "Remote write description must not advertise a usable tool." }] } };
        candidates.push(catalog); data = { catalog };
      } else if (path.endsWith("/catalogs")) data = { catalogs: candidates };
      else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
      else if (path.endsWith("/select")) {
        expect(body.selections).toEqual([{ providerOperation: "get_repository", resources: [{ kind: "github.repository", id: "approved/public-repo" }] }]);
        selected = true; data = { bindings: [] };
      } else if (path.endsWith("/revoke")) { revoked = true; connection = { ...connection, state: "revoked", revision: 2 }; data = { connection }; }
      else { await route.fulfill({ status: 404, json: { error: { message: "Missing fixture endpoint" } } }); return; }
      await route.fulfill({ json: data });
    });
    await page.goto("/app/knowledge");
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Title", exact: true })).toBeFocused();
    await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Returns");
    await dialog.getByRole("textbox", { name: "Content", exact: true }).fill("Returns accepted within 30 days.");
    await dialog.getByRole("button", { name: "Import source", exact: true }).click();
    await expect(page.getByText("Awaiting approval · Private · Revision 1")).toBeVisible();
    expect(approved).toBe(false); expect(published).toBe(false);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("Returns accepted within 30 days.")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Approve source", exact: true }).click();
    await expect(page.getByText("Ready · Private · Revision 1")).toBeVisible();
    await page.getByRole("button", { name: "Make public", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Make public", exact: true }).click();
    await expect(page.getByText("Ready · Public · Revision 1")).toBeVisible();
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Ready · Public · Revision 1")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
    const evidence = resolve(process.cwd(), "../../../.audit"); await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, `connected-knowledge-${width}.png`), fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await navigateWorkspace(page, "Connections");
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("GitHub research");
    await dialog.getByRole("textbox", { name: "Repository 1", exact: true }).fill("approved/public-repo");
    await dialog.getByLabel("GitHub token", { exact: true }).fill("github_pat_fixture_scoped_public_token");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(evidence, `connected-create-${width}.png`), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "Add connection", exact: true }).click();
    await expect(page.getByRole("heading", { name: "GitHub research", exact: true })).toBeVisible();
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    await page.getByRole("button", { name: "Manage tools", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Find tools", exact: true }).click();
    await page.getByRole("checkbox", { name: /Get repository/ }).check();
    await expect(page.getByRole("checkbox", { name: /Delete repository/ })).toHaveCount(0);
    await expect(page.getByRole("dialog").getByRole("button", { name: "Save tools", exact: true })).toBeEnabled();
    await page.screenshot({ path: resolve(evidence, `connected-tools-${width}.png`), fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("dialog").getByRole("button", { name: "Save tools", exact: true }).click();
    await expect(page.getByText("Tools available for agents", { exact: true })).toBeVisible(); expect(selected).toBe(true);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke connection", exact: true }).click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible(); expect(revoked).toBe(true);
    expect(errors).toEqual([]); expect(consoleErrors).toEqual([]);
  });
}
