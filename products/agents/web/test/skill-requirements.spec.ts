import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { agentSummary } from "./workspace-fixtures";
import { toolCatalogue, catalogueItem } from "./catalogue-fixtures";
import type { Configuration, RemoteConnection } from "../src/platform/api";

async function fixture(page: Page, grounded = false) {
  let draft: Configuration = { executionKind: "business", ...(grounded ? { program: { id: "grounded-conversation" as const, version: "1" as const } } : { program: { id: "tool-directed" as const, version: "1" as const } }), instructions: "Use explicitly approved tools.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, tools: [], skillIds: [], connectedToolBindingIds: [], capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
  let revision = 1, connection: RemoteConnection | null = null, selected = false;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const binding = { id: "binding1", alias: "records_lookup", digest: "digest", transport: "mcp_http", definition: { providerOperation: "records_lookup", description: "Read the selected records." }, connection: { id: "remote1", profileId: "remote-mcp-v1", policyRevision: 1 }, resources: [{ kind: "mcp.endpoint", id: "https://records.fixture.test/mcp" }] };
  const skill = { id: "skill1", name: "reviewed-analysis", description: "Use approved records in isolated Python.", familyId: "family1", revision: 1, contentDigest: "digest", reviewState: "reviewed", compatibility: null, createdAt: "2026-10-20T00:00:00Z", requires: { connectionProfiles: ["remote-mcp-v1"], permissions: ["sandbox.execute"], runtimes: ["python-analysis-v1", "unavailable-runtime"] }, files: [{ path: "SKILL.md", size: 20, contentDigest: "digest" }] };
  const candidate = { id: "catalog1", connectionId: "remote1", credentialRevision: 1, policyRevision: 1, createdAt: "2026-10-20T00:00:00Z", selectableOperations: ["records_lookup"], catalog: { revision: 1, protocolVersion: "2025-11-25", transport: "mcp_http", tools: [binding.definition] } };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname; let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", displayName: "Owner", email: "owner@example.test" }, organizations: [{ id: "org", name: "Requirements", role: "owner" }] };
    else if (path.endsWith("/agents/root")) { if (request.method() === "PUT") { expect(request.postDataJSON().expectedRevision).toBe(revision); draft = request.postDataJSON().configuration; revision++; } data = { agent: { id: "root", name: "Requirements", offering: "faq", draft, draftRevision: revision }, versions: [{ id: "snapshot-initial", number: 1, configuration: structuredClone(draft) }], deployments: [] }; }
    else if (path.endsWith("/agents/root/configuration")) { expect(request.postDataJSON().expectedRevision).toBe(revision); draft = request.postDataJSON().configuration; revision++; data = { agent: { id: "root", name: "Requirements", offering: "faq", draft, draftRevision: revision }, snapshot: { id: `snapshot-${revision}`, number: revision, configuration: structuredClone(draft) }, deployments: [] }; }
    else if (path.endsWith("/agents/summaries")) data = { agents: [agentSummary({ id: "root", name: "Requirements", draftRevision: revision })], nextCursor: null };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/catalogue/tools")) data = { ...toolCatalogue, entries: [] };
    else if (path.endsWith("/catalogue/skills")) data = { ...toolCatalogue, entries: [{ ...catalogueItem("skill:skill1", skill.name), kind: "skill", configuration: { tools: [], connectedToolBindingIds: [], skillIds: ["skill1"] }, readiness: { state: "unavailable", reasons: [{ code: "SKILL_REQUIREMENTS_UNAVAILABLE", message: "Configure required access." }] }, action: { kind: "none" } }] };
    else if (path.endsWith("/skills/packages/skill1")) data = { package: skill, body: "Reviewed package instructions." };
    else if (path.endsWith("/skills/packages")) data = { packages: [skill] };
    else if (path.endsWith("/connectors")) data = { connectors: [{ id: "records-fixture", name: "Records", description: "Approved records", profileId: "remote-mcp-v1", connectionDefaults: { endpoint: "https://records.fixture.test/mcp", authentication: "none" }, readiness: { available: true, reasons: [] } }] };
    else if (path.endsWith("/remote-connections")) { if (request.method() === "POST") connection = { id: "remote1", name: "Records", endpoint: "https://records.fixture.test/mcp", authentication: "none", status: "draft", generation: 1, revision: 1, lastError: null, identity: null, createdAt: "2026-10-20T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" }; data = request.method() === "POST" ? { connection } : { connections: connection ? [connection] : [] }; }
    else if (path.endsWith("/remote1/discover")) { connection = { ...connection!, status: "selection_required" }; data = { connection, candidate, catalog: { protocolVersion: "2025-11-25", tools: [{ name: "records_lookup", description: "Read the selected records.", inputSchema: { type: "object", properties: {} }, schemaDigest: "digest" }] } }; }
    else if (path.endsWith("/catalogs/catalog1/select")) { selected = true; data = { bindings: [binding] }; }
    else if (path.endsWith("/connections/remote1/catalogs")) data = { catalogs: [candidate] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: selected ? [binding] : [] };
    else if (path.endsWith("/connections")) data = { connections: connection ? [{ ...connection, state: "active", profileId: "remote-mcp-v1", policyRevision: 1 }] : [], profiles: [], targets: [] };
    else if (path.endsWith("/api-connections")) data = { connections: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected requirements mock route ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { errors, draft: () => draft };
}

test("mock transport: repair a skill's connection through shared setup, explicitly adopt tools, then configure analysis", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/agents/root?section=skills&skill=skill1");
  let dialog = page.getByRole("dialog");
  await dialog.getByText("Requirements", { exact: true }).click();
  await expect(dialog.getByText("This runtime is unavailable.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Connect Records", exact: true }).click();
  await expect(page).toHaveURL(/connector=records-fixture/);
  const params = new URL(page.url()).searchParams;
  expect(params.get("returnTo")).toBe("/app/agents/root?section=skills&skill=skill1");
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Server URL", { exact: true })).toHaveValue("https://records.fixture.test/mcp");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /records lookup/ }).check();
  await dialog.getByRole("button", { name: "Add tools", exact: true }).click();
  expect(state.draft().connectedToolBindingIds).toEqual([]);
  await page.getByRole("link", { name: "Back to agent", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "reviewed-analysis", exact: true })).toBeVisible();
  await dialog.getByText("Requirements", { exact: true }).click();
  await dialog.getByRole("checkbox", { name: /records lookup/ }).check();
  await dialog.getByRole("button", { name: "Use selected tools", exact: true }).click();
  expect(state.draft().connectedToolBindingIds).toEqual([]);
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog.getByText("Connected tools selected", { exact: true })).toBeVisible();
  expect(state.draft().connectedToolBindingIds).toEqual(["binding1"]); expect(state.draft().skillIds).toEqual([]);
  for (const width of [1440, 768, 390]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-skill-requirements-${width}.png`), fullPage: true, animations: "disabled" }); }
  await dialog.getByRole("button", { name: "Configure analysis", exact: true }).click();
  await expect(page).toHaveURL(/section=configuration&setup=analysis&skill=skill1/);
  const analysis = page.getByRole("region", { name: "Analysis configuration", exact: true });
  await analysis.getByRole("checkbox", { name: /Python analysis/ }).check();
  expect(state.draft().capabilities.sandbox.enabled).toBe(false);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft().capabilities.sandbox.enabled).toBe(true); expect(state.draft().tools).toContain("sandbox.analyze");
  await page.getByRole("button", { name: "Back to skill", exact: true }).click();
  await page.getByRole("dialog").getByText("Requirements", { exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Configured", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Add skill", exact: true })).toHaveCount(0);
  expect(state.draft().skillIds).toEqual([]); expect(state.errors).toEqual([]);
});


test("mock transport: a grounded agent cannot silently gain analysis or switch its trusted program", async ({ page }) => {
  const state = await fixture(page, true);
  await page.goto("/app/agents/root?section=configuration&setup=analysis&skill=skill1");
  const analysis = page.getByRole("region", { name: "Analysis configuration", exact: true });
  await expect(analysis.getByRole("checkbox", { name: /Python analysis/ })).toBeDisabled();
  await expect(analysis.getByText("This agent's program does not support analysis.", { exact: true })).toBeVisible();
  expect(state.draft().program?.id).toBe("grounded-conversation");
  expect(state.draft().capabilities.sandbox.enabled).toBe(false);
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]);
});
