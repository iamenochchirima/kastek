import {dropClosedTestDatabase} from "./support/database-cleanup";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlGrowthExecution, growthControlInputSchema } from "../src/product/integrations/growth-control";
import { GrowthExecutionService } from "../src/product/integrations/growth-execution";
import { GrowthProductRuntime } from "../src/execution/products/growth-runtime";
import type { GrowthActionClient } from "../src/adapters/products/growth-action-client";
import { provisionGrowthModel } from "../src/product/integrations/growth-model-provisioning";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { ConnectionVault } from "../src/infrastructure/vault";
import { setupPlatformSchema } from "../src/composition/setup";
import {beginOperation} from "../src/execution/lifecycle/execution";
import {growthFeatureConfiguration} from "../src/product/integrations/growth-features";
import { requestDigest } from "../src/contracts/contracts";
import type { GrowthAgentAction, GrowthAgentCommandOutputs } from "@kasitek-labs/contracts";

it("requires an explicit tenant and a supported operator lifecycle action", () => {
  for (const value of [{}, { tenantId: "x", action: "delete" }, { tenantId: "", action: "tenant.disable" },
    { tenantId: "x", action: "tenant.enable", organizationId: randomUUID() }]) expect(() => growthControlInputSchema.parse(value)).toThrow();
});
const adminUrl = process.env.AGENTS_TEST_ADMIN_URL;
(adminUrl ? describe : describe.skip)("Growth lifecycle control in a disposable database", () => {
  const database = `agents_growth_control_${randomUUID().replaceAll("-", "")}`;
  const issuer = "https://growth.control.test";
  let admin: Pool, pool: Pool, execution: GrowthExecutionService, runtime: GrowthProductRuntime;
  const vault = new ModelCredentialVault(new ConnectionVault("fixture", { fixture: randomBytes(32).toString("base64") }));
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(adminUrl!); url.pathname = "/" + database;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
    const client = { call: async (action: GrowthAgentAction) => {
      if (action.operation === "authorization.check") return { authorized: true };
      const context = action.context ?? { kind: "workspace", resourceId: action.tenantId }, data = { name: "Fixture business" }, revision = requestDigest(data);
      return { context, data, revision, sources: [{ id: "workspace:" + action.tenantId, title: "Business", revision }] };
    } } as GrowthActionClient;
    runtime = new GrowthProductRuntime(pool, client);
    execution = new GrowthExecutionService(pool, { issuer, actorIssuer: issuer + "/identity", keys: { fixture: "unused by this class fixture" } }, runtime);
  }, 20000);
  afterAll(async () => {
    await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); }
  });
  async function configureModel(tenantId:string,modelId="lab/fixture") {
    return provisionGrowthModel(pool, vault, { tenantId, providerId: "openrouter", modelId, apiKey: "synthetic-model-key" }, {
      discoveryFetch: async () => ({ status: 200, body: JSON.stringify({ data: [{ id: modelId, name: "Fixture model", context_length: 131072,
        top_provider: { max_completion_tokens: 16384 }, supported_parameters: ["tools", "max_tokens", "temperature"],
        architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } }] }) }),
    });
  }
  async function fixture() {
    const tenantId = randomUUID(), actor = { issuer: issuer + "/identity", subject: randomUUID() };
    const tenant = await execution.ensureTenant({ tenantId });
    await configureModel(tenantId);
    const command = { version: "1" as const, requestId: randomUUID(), tenantId, actor };
    const conversation = await execution.execute({ ...command, operation: "conversations.create", input: { featureId: "assistant" } }) as GrowthAgentCommandOutputs["conversations.create"];
    const turn = await execution.execute({ ...command, requestId: randomUUID(), operation: "turns.submit", input: { conversationId: conversation.conversation.id, text: "Fixture request" } }) as GrowthAgentCommandOutputs["turns.submit"];
    return { tenantId, organizationId: tenant.organization_id, command, taskId: turn.task.id };
  }
  it("enforces the shared root budget and refuses uninstalled specialist authority",async()=>{
    const f=await fixture();
    const root=(await pool.query("SELECT root_token_limit FROM agents_platform.tasks WHERE id=$1",[f.taskId])).rows[0];
    await expect(beginOperation(pool,f.taskId,{id:"model:"+f.taskId+":0",kind:"model",name:"model.reply",request:{},reservedTokens:root.root_token_limit+1,reservedMs:1000})).rejects.toMatchObject({code:"ROOT_LIMIT"});
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.operations WHERE task_id=$1",[f.taskId])).rows[0].n).toBe(0);
    const configuration=growthFeatureConfiguration("assistant");
    configuration.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"unexpected",versionId:randomUUID(),sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:2048,maxActiveMs:1000}]};
    await expect(execution.execute({...f.command,requestId:randomUUID(),operation:"features.configure",input:{featureId:"assistant",configuration}})).rejects.toMatchObject({code:"PRODUCT_CAPABILITY_UNAVAILABLE"});
  });
  it("fences existing reads and authority, cancels admitted roots, and enables future use without resurrecting old grants", async () => {
    const first = await fixture(), other = await fixture();
    const disabled = await controlGrowthExecution(pool, { tenantId: first.tenantId, action: "tenant.disable" });
    expect(disabled).toMatchObject({ enabled: false, revokedExecutionGrants: 1, requestedTaskTrees: 1, pendingTaskTrees: 0 });
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [first.taskId])).rows[0].state).toBe("cancel_requested");
    await expect(runtime.authorizeTask(first.taskId)).rejects.toMatchObject({ code: "PRODUCT_AUTHORITY_INACTIVE" });
    await expect(execution.execute({ ...first.command, requestId: randomUUID(), operation: "tasks.get", input: { taskId: first.taskId } })).rejects.toMatchObject({ code: "PRODUCT_TENANT_UNAVAILABLE" });
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [other.taskId])).rows[0].state).toBe("accepted");
    const restored = await controlGrowthExecution(pool, { tenantId: first.tenantId, action: "tenant.enable" });
    expect(restored.enabled).toBe(true);
    expect((await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE organization_id=$1", [first.organizationId])).rows[0].revoked_at).not.toBeNull();
    expect((await execution.features({ ...first.command, operation: "features.list", input: {} })).features[0]!.ready).toBe(true);
  });
  it("revokes actual model credentials, grants and defaults for one business, including former rotated connections", async () => {
    const first = await fixture(), other = await fixture();
    await configureModel(first.tenantId,"lab/fixture-next"); // Rotate the default; the admitted task still references the former connection.
    const revoked = await controlGrowthExecution(pool, { tenantId: first.tenantId, action: "model.revoke" });
    expect(revoked).toMatchObject({ enabled: true, revokedModelConnections: 2, revokedModelCredentials: 2, revokedModelUseGrants: 2, removedModelDefaults: 1, requestedTaskTrees: 1, pendingTaskTrees: 0 });
    expect((await pool.query("SELECT state,envelope FROM agents_platform.model_provider_credentials WHERE organization_id=$1", [first.organizationId])).rows).toEqual([{ state: "revoked", envelope: null }, { state: "revoked", envelope: null }]);
    expect((await pool.query("SELECT state FROM agents_platform.model_provider_use_grants WHERE organization_id=$1", [first.organizationId])).rows[0].state).toBe("revoked");
    expect((await pool.query("SELECT state FROM agents_platform.model_provider_connections WHERE organization_id=$1", [other.organizationId])).rows[0].state).toBe("active");
    expect((await execution.features({ ...first.command, operation: "features.list", input: {} })).features[0]!.ready).toBe(false);
    expect((await controlGrowthExecution(pool, { tenantId: first.tenantId, action: "model.revoke" })).revokedModelCredentials).toBe(0);
    await configureModel(first.tenantId);
    expect((await execution.features({ ...first.command, operation: "features.list", input: {} })).features[0]!.ready).toBe(true);
    await expect(controlGrowthExecution(pool, { tenantId: "missing", action: "tenant.disable" })).rejects.toMatchObject({ code: "PRODUCT_TENANT_UNAVAILABLE" });
  });
});
