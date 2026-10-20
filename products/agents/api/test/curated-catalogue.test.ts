import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { defaultBusinessConfiguration, PlatformError } from "../src/contracts/contracts";
import type { CapabilityBinding } from "../src/contracts/capability-catalog";
import type { ConnectionDTO } from "../src/contracts/connections";
import { queryCatalogue, type CatalogueContext } from "../src/product/catalogue/catalogue";
import { registerCatalogueRoutes } from "../src/product/catalogue/catalogue-routes";

const organizationId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
function context(): CatalogueContext {
  return { agentId, configuration: defaultBusinessConfiguration(), purpose: "faq", product: "agents",
    permissions: ["agent.configure"], connections: [], bindings: [], now: new Date("2026-10-20") };
}
const connection = { id: "connection", profileId: "github-public-read-v1", name: "Private account label", state: "active",
  policyRevision: 2, expiresAt: "2026-11-01T00:00:00Z" } as ConnectionDTO;
const binding = { id: "binding", connection: { id: "connection", profileId: "github-public-read-v1", policyRevision: 2 } } as CapabilityBinding;
const find = (ctx: CatalogueContext, id: string) => queryCatalogue("tools", {}, ctx).entries.find(entry => entry.id === id)!;

describe("curated catalogue", () => {
  it("keeps FAQ optional services outside recommendations and does not invent providers", () => {
    const result = queryCatalogue("tools", { view: "recommended" }, context());
    expect(result.entries.map(entry => entry.id)).toEqual(["knowledge-search", "knowledge-read", "human-handoff"]);
    expect(find(context(), "knowledge-search").readiness.reasons[0]?.code).toBe("KNOWLEDGE_REQUIRED");
    expect(find(context(), "human-handoff").readiness.state).toBe("ready");
    expect(queryCatalogue("tools", { q: "gmail" }, context()).entries).toEqual([]);
    expect(queryCatalogue("tools", { q: "calendar" }, context()).entries).toEqual([]);
  });
  it("resolves active account reuse, resources and agent-specific selections", () => {
    const ctx = context();
    expect(find(ctx, "github").action.kind).toBe("connect");
    ctx.connections = [connection];
    expect(find(ctx, "github").readiness.state).toBe("needs_configuration");
    ctx.bindings = [binding];
    expect(find(ctx, "github").configuration.connectedToolBindingIds).toEqual(["binding"]);
    expect(find(ctx, "github").action.kind).toBe("add");
    ctx.configuration!.connectedToolBindingIds = ["binding"];
    expect(queryCatalogue("tools", { view: "added" }, ctx).entries.map(entry => entry.id)).toEqual(["github"]);
    expect(queryCatalogue("tools", { view: "added" }, context()).entries).toEqual([]);
    ctx.connections = [{ ...connection, policyRevision: 3 }];
    expect(find(ctx, "github").added).toBe(true);
    expect(find(ctx, "github").readiness.state).toBe("needs_configuration");
  });
  it("reports expired accounts and permission/runtime/product denial", () => {
    const ctx = context(); ctx.connections = [{ ...connection, expiresAt: "2026-10-19T00:00:00Z" }]; ctx.bindings = [binding];
    expect(find(ctx, "github").readiness.state).toBe("needs_connection");
    ctx.permissions = [];
    expect(queryCatalogue("tools", { view: "available" }, ctx).entries).toEqual([]);
    expect(find(ctx, "github").readiness.reasons[0]?.code).toBe("PERMISSION_REQUIRED");
    ctx.permissions = ["agent.configure"]; ctx.configuration!.executionKind = "workspace";
    expect(find(ctx, "human-handoff").readiness.reasons[0]?.code).toBe("RUNTIME_UNSUPPORTED");
    ctx.configuration!.executionKind = "business"; ctx.product = "growth";
    expect(find(ctx, "human-handoff").readiness.reasons[0]?.code).toBe("PRODUCT_UNSUPPORTED");
  });
  it("requires account selection instead of adding permissions from several accounts", () => {
    const ctx = context(); ctx.connections = [connection, { ...connection, id: "other" }];
    ctx.bindings = [binding, { ...binding, id: "other-binding", connection: { ...binding.connection!, id: "other" } }];
    expect(find(ctx, "github").readiness.reasons[0]?.code).toBe("ACCOUNT_SELECTION_REQUIRED");
    expect(find(ctx, "github").configuration.connectedToolBindingIds).toEqual([]);
  });
  it("does not substitute a new binding for an agent's stale selection", () => {
    const ctx = context(); ctx.connections = [connection];
    ctx.bindings = [{ ...binding, connection: { ...binding.connection!, policyRevision: 1 } }, { ...binding, id: "replacement" }];
    ctx.configuration!.connectedToolBindingIds = ["binding"];
    expect(find(ctx, "github").readiness.reasons[0]?.code).toBe("BINDING_CHANGED");
    expect(find(ctx, "github").configuration.connectedToolBindingIds).toEqual(["binding"]);
  });
  it("keeps reviewed publisher identity immutable and excludes account labels", () => {
    const ctx = context(); ctx.connections = [connection]; ctx.bindings = [binding];
    const entry = find(ctx, "github"), digest = entry.digest;
    entry.publisher.name = "Injected publisher"; entry.requires.connectionProfiles.push("injected");
    expect(find(ctx, "github").publisher).toEqual({ id: "kasitek", name: "KasiTek", verified: true });
    expect(find(ctx, "github").digest).toBe(digest);
    expect(JSON.stringify(queryCatalogue("tools", {}, ctx))).not.toContain("Private account label");
  });
  it("preserves immutable skill revision identity separately from enablement", () => {
    const ctx = context(); ctx.skills = [{ id: "revision", name: "Support policy", description: "Use the reviewed support policy.", revision: 2,
      digest: "d".repeat(64), publisher: { id: "organization", name: "Organization", verified: false }, state: "available" }];
    let entry = queryCatalogue("skills", {}, ctx).entries[0]!;
    expect(entry.configuration.skillIds).toEqual(["revision"]); expect(entry.added).toBe(false);
    ctx.configuration!.skillIds = ["revision"];
    entry = queryCatalogue("skills", { view: "added", q: "support" }, ctx).entries[0]!;
    expect(entry.digest).toBe("d".repeat(64)); expect(entry.added).toBe(true);
    ctx.skills[0]!.state = "disabled";
    expect(queryCatalogue("skills", {}, ctx).entries[0]!.readiness.state).toBe("unavailable");
  });
});

describe("catalogue routes", () => {
  it("authorizes scope and scoped agent before reading account catalogues", async () => {
    const app = Fastify(); let reads = 0;
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof PlatformError ? error.statusCode : 400).send({ error: "denied" }));
    registerCatalogueRoutes(app, { resolveScope: async () => ({ accountId: "account", organizationId }),
      getAgent: async () => { throw new PlatformError("NOT_FOUND", 404, "Record not found"); },
      listConnections: async () => { reads++; return []; }, listBindings: async () => [], permissions: async () => ["agent.configure"] });
    const response = await app.inject({ url: `/api/organizations/${organizationId}/catalogue/tools?agentId=${agentId}` });
    expect(response.statusCode).toBe(404); expect(reads).toBe(0);
    const crossTenant = await app.inject({ url: `/api/organizations/${agentId}/catalogue/tools` });
    expect(crossTenant.statusCode).toBe(403); expect(reads).toBe(0);
    await app.close();
  });
  it("derives recommendations from the actual agent rather than query override", async () => {
    const app = Fastify();
    registerCatalogueRoutes(app, { resolveScope: async () => ({ accountId: "account", organizationId }),
      getAgent: async () => ({ id: agentId, offering: "faq", draft: defaultBusinessConfiguration() }),
      listConnections: async () => [], listBindings: async () => [], permissions: async () => ["agent.configure"] });
    const response = await app.inject({ url: `/api/organizations/${organizationId}/catalogue/tools?agentId=${agentId}&purpose=research&view=recommended` });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries.map((entry: { id: string }) => entry.id)).toEqual(["knowledge-search", "knowledge-read", "human-handoff"]);
    await app.close();
  });
});
