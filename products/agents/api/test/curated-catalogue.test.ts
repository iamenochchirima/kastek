import { defaultConnectorRegistry, loadConnectorRegistry } from "../src/adapters/providers/connector-registry";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { defaultBusinessConfiguration, PlatformError } from "../src/contracts/contracts";
import type { CapabilityBinding } from "../src/contracts/capability-catalog";
import type { ConnectionDTO } from "../src/contracts/connections";
import { queryCatalogue, type CatalogueContext, type CatalogueConnection } from "../src/product/catalogue/catalogue";
import { registerCatalogueRoutes } from "../src/product/catalogue/catalogue-routes";

const organizationId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
function context(): CatalogueContext {
  return { agentId, configuration: defaultBusinessConfiguration(), purpose: "faq", product: "agents",
    permissions: ["agent.configure","calendar.configure"], connections: [], bindings: [], now: new Date("2026-10-20") };
}
const connection = { id: "connection", profileId: "github-public-read-v1", name: "Private account label", state: "active",
  policyRevision: 2, expiresAt: "2026-11-01T00:00:00Z" } as ConnectionDTO;
const binding = { id: "binding", connection: { id: "connection", profileId: "github-public-read-v1", policyRevision: 2 } } as CapabilityBinding;
const find = (ctx: CatalogueContext, id: string) => queryCatalogue("tools", {}, ctx).entries.find(entry => entry.id === id)!;

describe("curated catalogue", () => {
  it("adds a compatible MCP integration entirely through a validated connector record",()=>{
    const registry=loadConnectorRegistry({schemaVersion:1,connectors:[...defaultConnectorRegistry.connectors,{id:"project-docs",revision:2,name:"Project documentation",description:"Search reviewed project documentation.",profileId:"remote-mcp-v1",adapterKey:"remote-mcp",kind:"mcp",publisher:{id:"kasitek",name:"KasiTek",verified:true},auth:{kind:"none"},connectionDefaults:{endpoint:"https://docs.example.com/mcp",authentication:"none"},catalogue:{purposes:["faq"],products:["agents"],executionKinds:["business"],permissions:["agent.configure"],selection:{kind:"bindings"}}}]});
    const ctx=context();ctx.connectorRecords=registry.connectors;
    expect(find(ctx,"project-docs")).toMatchObject({name:"Project documentation",revision:2,recommended:true,connectorId:"project-docs",readiness:{state:"needs_connection"},action:{kind:"connect",connectionProfileId:"remote-mcp-v1"}});
    const other={...connection,id:"other",profileId:"remote-mcp-v1",resource:"https://other.example.com/mcp"};ctx.connections=[other];ctx.bindings=[{...binding,catalog:{revision:1},connection:{id:"other",profileId:"remote-mcp-v1",policyRevision:2}} as CapabilityBinding];
    ctx.configuration!.connectedToolBindingIds=[binding.id];expect(find(ctx,"project-docs")).toMatchObject({added:false,readiness:{state:"needs_connection"}});
    ctx.connections=[{...other,resource:"https://docs.example.com/mcp"}];expect(find(ctx,"project-docs")).toMatchObject({added:true,configuration:{connectedToolBindingIds:[binding.id]}});
    expect(defaultConnectorRegistry.connectors.some(record=>record.id==="project-docs")).toBe(false);
  });

  it("keeps a configured native API record separate from another provider's account",()=>{
    const source=defaultConnectorRegistry.connectors.find(record=>record.id==="github")!;
    const registry=loadConnectorRegistry({schemaVersion:1,connectors:[{...source,id:"project-api",profileId:"custom-api-v1",adapterKey:"native-api",apiBaseUrl:"https://api.example.com/v1"}]});
    const ctx=context();ctx.connectorRecords=registry.connectors;ctx.connections=[{...connection,id:"api-connection",profileId:"custom-api-v1",resource:"https://other.example.com/v1"}];
    ctx.bindings=[{...binding,catalog:{revision:1},connection:{id:"api-connection",profileId:"custom-api-v1",policyRevision:2}} as CapabilityBinding];ctx.configuration!.connectedToolBindingIds=[binding.id];
    expect(find(ctx,"project-api")).toMatchObject({added:false,readiness:{state:"needs_connection"},configuration:{connectedToolBindingIds:[]}});
    ctx.connections[0]={...ctx.connections[0]!,resource:"https://api.example.com/v1"};expect(find(ctx,"project-api")).toMatchObject({added:true,configuration:{connectedToolBindingIds:[binding.id]}});
  });
  it("keeps FAQ optional services outside recommendations and does not invent providers", () => {
    const result = queryCatalogue("tools", { view: "recommended" }, context());
    expect(result.entries.map(entry => entry.id)).toEqual(["knowledge-search", "knowledge-read", "human-handoff"]);
    expect(find(context(), "knowledge-search").readiness.reasons[0]?.code).toBe("KNOWLEDGE_REQUIRED");
    expect(find(context(), "human-handoff").readiness.state).toBe("ready");
    expect(queryCatalogue("tools", { q: "gmail" }, context()).entries).toEqual([]);
    expect(queryCatalogue("tools", { q: "calendar" }, context()).entries).toMatchObject([{id:"google-calendar",readiness:{state:"unavailable"}},{id:"microsoft-calendar",readiness:{state:"unavailable"}}]);
  });
  it("keeps Google availability honest and routes selected calendars to appointment rules", () => {
    const ctx=context();ctx.purpose="customer-service";
    expect(find(ctx,"google-calendar")).toMatchObject({kind:"native_api",publisher:{id:"kasitek",verified:true},readiness:{state:"unavailable",reasons:[{code:"GOOGLE_OAUTH_NOT_CONFIGURED"}]},action:{kind:"none"}});
    ctx.connectorReadiness={"google-calendar":{available:true}};
    expect(find(ctx,"google-calendar")).toMatchObject({readiness:{state:"needs_connection"},action:{kind:"connect",connectionProfileId:"google-calendar-v1"},recommended:true,added:false});
    ctx.connections=[{...connection,id:"calendar-connection",profileId:"google-calendar-v1"}];
    expect(find(ctx,"google-calendar")).toMatchObject({readiness:{state:"needs_configuration",reasons:[{code:"BOOKING_POLICY_REQUIRED"}]},action:{kind:"configure",configurationSection:"configuration",connectionProfileId:"google-calendar-v1",connectionId:"calendar-connection"},configuration:{tools:[],connectedToolBindingIds:[],skillIds:[]}});
    ctx.calendarProviderId="google-calendar";ctx.configuration!.capabilities.businessActions={enabled:true,profileId:"calendar-booking-v1",permittedOperations:["calendar.availability","calendar.book"],policyId:agentId,policyDigest:"a".repeat(64)};
    expect(find(ctx,"google-calendar")).toMatchObject({added:true,action:{kind:"configure",configurationSection:"configuration"}});
    expect(queryCatalogue("tools",{view:"added"},ctx).entries.map(entry=>entry.id)).toEqual(["google-calendar"]);
  });
  it("marks only the provider pinned by the selected calendar policy as added",()=>{
    const ctx=context();ctx.purpose="customer-service";ctx.connectorReadiness={"google-calendar":{available:true},"microsoft-calendar":{available:true}};
    ctx.connections=[{...connection,id:"google-account",profileId:"google-calendar-v1"},{...connection,id:"microsoft-account",profileId:"microsoft-calendar-v1"}];
    ctx.configuration!.capabilities.businessActions={enabled:true,profileId:"calendar-booking-v1",permittedOperations:["calendar.availability"],policyId:agentId,policyDigest:"a".repeat(64)};
    expect(queryCatalogue("tools",{view:"added"},ctx).entries).toEqual([]);
    ctx.calendarProviderId="google-calendar";expect(queryCatalogue("tools",{view:"added"},ctx).entries.map(entry=>entry.id)).toEqual(["google-calendar"]);
    ctx.calendarProviderId="microsoft-calendar";expect(queryCatalogue("tools",{view:"added"},ctx).entries.map(entry=>entry.id)).toEqual(["microsoft-calendar"]);
  });
  it("requires calendar configuration permission even for an otherwise eligible agent", () => {
    const ctx=context();ctx.purpose="customer-service";ctx.connectorReadiness={"google-calendar":{available:true}};ctx.permissions=["agent.configure"];
    expect(find(ctx,"google-calendar")).toMatchObject({readiness:{state:"unavailable",reasons:[{code:"PERMISSION_REQUIRED"}]},action:{kind:"none"}});
  });
  it("does not turn Google calendars into generic bindings or choose among accounts", () => {
    const ctx=context();ctx.connectorReadiness={"google-calendar":{available:true}};
    const selected:CatalogueConnection={...connection,id:"calendar-one",profileId:"google-calendar-v1"};
    ctx.connections=[selected,{...selected,id:"calendar-two"}];
    ctx.bindings=[{...binding,connection:{id:selected.id,profileId:"google-calendar-v1",policyRevision:selected.policyRevision}} as unknown as CapabilityBinding];
    ctx.configuration!.connectedToolBindingIds=[binding.id];
    const entry=find(ctx,"google-calendar");expect(entry.added).toBe(false);expect(entry.configuration.connectedToolBindingIds).toEqual([]);expect(entry.action.connectionId).toBeUndefined();expect(entry.action.configurationSection).toBe("configuration");
    expect(queryCatalogue("tools",{},ctx).entries.some(entry=>entry.id.startsWith("connection:"))).toBe(false);
    ctx.connections=[{...selected,state:"revoked"}];expect(find(ctx,"google-calendar").readiness.state).toBe("needs_connection");
    ctx.connections=[{...selected,expiresAt:"2026-10-19T00:00:00Z"}];expect(find(ctx,"google-calendar").readiness.state).toBe("needs_connection");
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
  it("keeps a selected revoked connection visible and does not count it as a skill requirement", () => {
    const ctx=context();ctx.connections=[connection];ctx.bindings=[binding];
    ctx.configuration!.connectedToolBindingIds=[binding.id];ctx.configuration!.skillIds=["revision"];
    ctx.skills=[{id:"revision",name:"Research",description:"Research a repository.",revision:1,digest:"d".repeat(64),
      publisher:{id:"organization",name:"Organization",verified:false},state:"available",
      runtimeRequirements:{connectionProfiles:[connection.profileId],permissions:["connected.read"],runtimes:["business"]}}];
    expect(queryCatalogue("skills",{},ctx).entries[0]!.readiness.state).toBe("ready");
    ctx.connections=[{...connection,state:"revoked"}];
    expect(find(ctx,"github")).toMatchObject({added:true,configuration:{connectedToolBindingIds:[binding.id]},
      readiness:{state:"needs_connection",reasons:[{code:"CONNECTION_REVOKED"}]},action:{kind:"connect",connectionId:connection.id}});
    expect(queryCatalogue("skills",{},ctx).entries[0]).toMatchObject({added:true,readiness:{state:"unavailable",reasons:[{code:"SKILL_REQUIREMENTS_UNAVAILABLE"}]}});
    ctx.connections=[{...connection,expiresAt:"2026-10-19T00:00:00Z"}];
    expect(find(ctx,"github").readiness.reasons[0]?.code).toBe("CONNECTION_EXPIRED");
    ctx.connections=[{...connection,policyRevision:3}];
    expect(find(ctx,"github").readiness.reasons[0]?.code).toBe("BINDING_CHANGED");
    expect(queryCatalogue("skills",{},ctx).entries[0]!.readiness.state).toBe("unavailable");
    ctx.connections=[connection];
    expect(queryCatalogue("skills",{},ctx).entries[0]!.readiness.state).toBe("ready");
  });
  it("keeps custom servers distinct and attaches only the selected account's operations", () => {
    const ctx=context();
    const first={...connection,id:"first",name:"Support system",profileId:"remote-mcp-v1" as const};
    const second={...first,id:"second",name:"Other system"};ctx.connections=[first,second];
    const one={...binding,id:"first-tool",catalog:{revision:1},connection:{id:"first",profileId:"remote-mcp-v1",policyRevision:2}} as CapabilityBinding;
    const newer={...one,id:"new-first-tool",catalog:{revision:2}} as CapabilityBinding;
    const other={...one,id:"other-tool",connection:{...one.connection!,id:"second"}};
    ctx.bindings=[one,newer,other];
    expect(find(ctx,"connection:first").configuration.connectedToolBindingIds).toEqual(["new-first-tool"]);
    expect(find(ctx,"connection:second").configuration.connectedToolBindingIds).toEqual(["other-tool"]);
    expect(find(ctx,"connection:first").publisher.verified).toBe(false);
    ctx.configuration!.connectedToolBindingIds=["first-tool"];
    expect(find(ctx,"connection:first").configuration.connectedToolBindingIds).toEqual(["first-tool"]);
    expect(find(ctx,"connection:second").added).toBe(false);
    ctx.connections=[second];
    expect(queryCatalogue("tools",{},ctx).entries.some(entry=>entry.id==="connection:first")).toBe(false);
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
  it("serves safe connector records through the same authenticated organization boundary",async()=>{
    const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof PlatformError?error.statusCode:400).send({error:"denied"}));
    registerCatalogueRoutes(app,{resolveScope:async()=>({accountId:"account",organizationId}),getAgent:async()=>({id:agentId,offering:"faq",draft:defaultBusinessConfiguration()}),listConnections:async()=>[],listBindings:async()=>[],permissions:async()=>["agent.configure"],connectorReadiness:{"google-calendar":{available:true,reasons:[]}}});
    const response=await app.inject({url:`/api/organizations/${organizationId}/connectors`});expect(response.statusCode).toBe(200);const calendar=response.json().connectors.find((record:{id:string})=>record.id==="google-calendar");expect(calendar).toMatchObject({name:"Google Calendar",setup:{kind:"calendar_service"},readiness:{available:true}});expect(calendar).not.toHaveProperty("auth");expect(JSON.stringify(calendar)).not.toContain("GOOGLE_CALENDAR_CLIENT_SECRET");
    expect((await app.inject({url:`/api/organizations/${agentId}/connectors`})).statusCode).toBe(403);await app.close();
  });

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
  it("uses server provider readiness and the scoped customer-service offering",async()=>{
    const app=Fastify();registerCatalogueRoutes(app,{resolveScope:async()=>({accountId:"account",organizationId}),getAgent:async()=>({id:agentId,offering:"customer-service",draft:defaultBusinessConfiguration()}),listConnections:async()=>[{...connection,profileId:"google-calendar-v1",expiresAt:new Date(Date.now()+86400000).toISOString()}],listBindings:async()=>[],permissions:async()=>["agent.configure","calendar.configure"],connectorReadiness:{"google-calendar":{available:true}}});
    const response=await app.inject({url:`/api/organizations/${organizationId}/catalogue/tools?agentId=${agentId}&purpose=faq&view=recommended`});expect(response.statusCode).toBe(200);expect(response.json().entries.find((entry:{id:string})=>entry.id==="google-calendar")).toMatchObject({recommended:true,action:{kind:"configure",configurationSection:"configuration"}});await app.close();
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
