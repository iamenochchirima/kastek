import { agentSummary } from "./workspace-fixtures";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";

for (const width of [1440, 768, 390]) {
  test(`mock transport: specialist tool authority stays separate from coordinator tools at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const org = "org", root = "root", child = "child", child2 = "second-child", revision1 = "revision1", revision2 = "revision2";
    const sources = [{ id: "source1", title: "Returns", state: "active", visibility: "private", revisions: [1, 2].map(revision => ({ id: revision === 1 ? revision1 : revision2, revision, state: "approved", embeddingRelease: "local-embedding-v1" })) },
      { id: "source2", title: "Unindexed", state: "active", visibility: "private", revisions: [{ id: "revision3", revision: 1, state: "approved", embeddingRelease: null }] }];
    const base = { executionKind: "business", instructions: "Answer from approved evidence", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, sourceRevisionIds: [], connectedToolBindingIds: [], retrievalProfile: { kind: "lexical-v1" }, tools: ["knowledge.search", "knowledge.read"], capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
    let draft = structuredClone(base), saved: Record<string, unknown> | undefined;
    const bindings = [{ id: "shared-tool", definition: { providerOperation: "get_repository", description: "Read details" }, connection: { id: "connection", policyRevision: 1 }, resources: [{ kind: "github.repository", id: "approved/public-repo" }] },
      { id: "unavailable-tool", definition: { providerOperation: "read_file", description: "Read file" }, connection: { id: "revoked-connection", policyRevision: 1 }, resources: [{ kind: "github.repository", id: "approved/public-repo" }] },
      { id: "root-only", definition: { providerOperation: "list_releases", description: "Read release observations" }, connection: { id: "connection", policyRevision: 1 }, resources: [{ kind: "github.repository", id: "approved/public-repo" }] }];
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      let data: unknown;
      if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Research", role: "owner" }] };
      else if (path.endsWith("/knowledge/sources")) data = { sources, imports: [] };
      else if (path.endsWith("/tool-bindings")) data = { bindings };
      else if (path.endsWith("/connections")) data = { connections: [{ id: "connection", name: "GitHub", profileId: "github-public-read-v1", state: "active", policyRevision: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() }, { id: "revoked-connection", name: "Revoked repository", state: "revoked", policyRevision: 2, expiresAt: new Date(Date.now() + 86400000).toISOString() }], targets: [] };
      else if (path.endsWith("/skills")) data = { skills: [] };
      else if (path.endsWith(`/agents/${root}`)) {
        if (request.method() === "PUT") { saved = request.postDataJSON().configuration; draft = saved as typeof draft; }
        data = { agent: { id: root, name: "Researcher", draft, draftRevision: saved ? 2 : 1 }, versions: [], deployments: [] };
      } else if (path.endsWith("/agents/summaries")) data = {agents:[agentSummary({id:root,name:"Researcher"})],nextCursor:null};
      else if (path.endsWith("/conversations")) data = {conversations:[],nextCursor:null};
      else if (path.endsWith("/agents")) data = { agents: [{ id: root, name: "Researcher" }, { id: child, name: "Shared specialist" }, { id: child2, name: "Isolated specialist" }] };
      else if (path.endsWith(`/agents/${child}`)) data = { versions: [{ id: "child-version", number: 1, configuration: { ...base, sourceRevisionIds: [revision1], connectedToolBindingIds: ["shared-tool", "unavailable-tool"] } }] };
      else if (path.endsWith(`/agents/${child2}`)) data = { versions: [{ id: "second-version", number: 1, configuration: base }] };
      else { await route.fulfill({ status: 404, json: { error: { message: "Missing fixture endpoint" } } }); return; }
      await route.fulfill({ json: data });
    });
    await page.goto(`/app/agents/${root}?section=configuration`);
    const knowledge = page.getByRole("group", { name: "Knowledge", exact: true });
    await knowledge.getByRole("checkbox", { name: /Returns/ }).check();
    await expect(page.getByRole("combobox", { name: "Returns revision", exact: true })).toHaveValue(revision2);
    await page.getByRole("combobox", { name: "Returns revision", exact: true }).selectOption(revision1);
    await page.getByText("Search options", { exact: true }).click();
    await page.getByRole("combobox", { name: "Search method", exact: true }).selectOption("hybrid-v1");
    await knowledge.getByRole("checkbox", { name: /Unindexed/ }).check();
    await expect(page.getByRole("alert")).toContainText("Selected sources do not support");
    await expect(page.getByRole("combobox", { name: "Search method", exact: true })).toHaveValue("hybrid-v1");
    await knowledge.getByRole("checkbox", { name: /Unindexed/ }).uncheck();
    const connected = page.getByRole("group", { name: "Connected tools", exact: true });
    await page.getByRole("checkbox", { name: "Delegate to specialists", exact: true }).check();
    await page.getByRole("combobox", { name: "Specialist 1", exact: true }).selectOption("child-version");
    const first = page.getByRole("group", { name: "Specialist 1 configuration", exact: true });
    await expect(first.getByRole("checkbox", { name: /Returns/ })).not.toBeChecked();
    await expect(first.getByRole("checkbox", { name: /get repository/ })).not.toBeChecked();
    await expect(first.getByRole("checkbox", { name: /list releases/ })).toHaveCount(0);
    await expect(first.getByRole("checkbox", { name: /read file/ })).toBeDisabled();
    await first.getByRole("checkbox", { name: /Returns/ }).check();
    const specialistTool = first.getByRole("checkbox", { name: /get repository/ });
    await specialistTool.focus();
    await expect(specialistTool).toBeFocused();
    await page.keyboard.press("Space");
    await expect(specialistTool).toBeChecked();
    await expect(connected.getByRole("checkbox", { name: /get repository/ })).not.toBeChecked();
    await page.getByRole("button", { name: "Add specialist", exact: true }).click();
    const second = page.getByRole("group", { name: "Specialist 2 configuration", exact: true });
    await expect(second.getByText("No shared sources selected.")).toBeVisible();
    await expect(second.getByText("No shared tools selected.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/connected-agent-config-${width}.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(page.getByText("Configuration saved", { exact: true }).last()).toBeVisible();
    expect(saved).toMatchObject({ sourceRevisionIds: [revision1], connectedToolBindingIds: [], retrievalProfile: { kind: "hybrid-v1", embeddingRelease: "local-embedding-v1" },
      capabilities: { delegation: { bindings: [{ sourceRevisionIds: [revision1], connectedToolBindingIds: ["shared-tool"] }, { sourceRevisionIds: [], connectedToolBindingIds: [] }] } } });
    await connected.getByRole("checkbox", { name: /get repository/ }).check();
    await connected.getByRole("checkbox", { name: /get repository/ }).uncheck();
    await expect(specialistTool).toBeChecked();
    await knowledge.getByRole("checkbox", { name: /Returns/ }).uncheck();
    await page.getByRole("combobox", { name: "Search method", exact: true }).selectOption("lexical-v1");
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(page.getByText("Configuration saved", { exact: true }).last()).toBeVisible();
    await expect.poll(() => saved).toMatchObject({ sourceRevisionIds: [], connectedToolBindingIds: [], capabilities: { delegation: { bindings: [{ sourceRevisionIds: [], connectedToolBindingIds: ["shared-tool"] }, { sourceRevisionIds: [], connectedToolBindingIds: [] }] } } });
  });
}
