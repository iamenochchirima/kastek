import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import type { ProductCapabilityInvocation, ProductCapabilityResult } from "@kasitek-labs/contracts";
import { analyticsFixture } from "./analytics-fixture.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { registerProductCapabilityRoutes } from "../src/controllers/product-capabilities.js";
import { agencyCapabilityManifest, capabilityDigest, workspaceAgentMetadataDescriptor } from "../src/capabilities/manifest.js";
const url = process.env.TENANT_TEST_DATABASE_URL;

test("Agency product metadata API enforces explicit destination mappings, exact grants, current roles and source access", { skip: !url }, async () => {
  const f = await analyticsFixture();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const context = { pool: f.pool, config: readConfig({ TENANT_DATABASE_URL: url, LOG_LEVEL: "silent",
    AGENTS_PRODUCT_ACTION_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    AGENTS_PRODUCT_ACTION_ISSUER: "https://agents.test" }) };
  const app = await buildApp(context, [registerProductCapabilityRoutes]);
  const call: ProductCapabilityInvocation = {
    version: "1", requestId: "request-1", operationId: "op-1", taskId: "task-1", conversationId: "conversation-1",
    actor: { issuer: "https://growth.test/identity", subject: "growth-user" },
    authority: { kind: "product", originProduct: "growth", destinationProduct: "agencies", originTenantId: "growth-org",
      tenantId: "w", mappingRef: "mapping-1", policyRevision: "policy-1", manifestDigest: agencyCapabilityManifest.digest,
      descriptorDigest: capabilityDigest(workspaceAgentMetadataDescriptor), handlerRef: workspaceAgentMetadataDescriptor.handlerRef },
    bindingId: "binding-1", bindingDigest: "binding-digest", operation: workspaceAgentMetadataDescriptor.operation, input: { limit: 1 }, control: "invoke",
  };
  const token = async (body: unknown, audience = "product-capability-actions", subject = "agents-worker", issuer = "https://agents.test") => new SignJWT({ requestDigest: capabilityDigest(body) })
    .setProtectedHeader({ alg: "RS256", kid: "agents-v1" }).setIssuer(issuer).setAudience(audience).setSubject(subject)
    .setIssuedAt().setExpirationTime("60s").setJti(randomUUID()).sign(privateKey);
  const invoke = async (body = call, auth?: string) => app.inject({ method: "POST", url: "/internal/agents/capabilities", payload: body,
    headers: { authorization: `Bearer ${auth ?? await token(body)}` } });
  try {
    await f.pool.query(`INSERT INTO tenant_users(id,workspace_id,email,password_hash) VALUES('agency-user','w','agency@example.test','unused');
      INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES('agency-user','automation_manager');
      INSERT INTO workspace_agents(id,workspace_id,name,status,config) VALUES
      ('agent-a','w','First','active','{"secret":"never-return-me"}'),('agent-b','w','Second','draft','{}'),('foreign-agent','foreign','Foreign','active','{}');
      INSERT INTO product_capability_mappings(id,origin_product,origin_tenant_id,actor_issuer,actor_subject,workspace_id,tenant_user_id,expires_at)
      VALUES('mapping-1','growth','growth-org','https://growth.test/identity','growth-user','w','agency-user',NOW()+INTERVAL '1 hour')`);
    await f.pool.query(`INSERT INTO product_capability_grants(mapping_id,operation,manifest_digest,descriptor_digest,handler_ref,policy_revision,binding_id,binding_digest,agent_ids,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()+INTERVAL '1 hour')`, [call.authority.mappingRef, call.operation, call.authority.manifestDigest,
      call.authority.descriptorDigest, call.authority.handlerRef, call.authority.policyRevision, call.bindingId, call.bindingDigest,
      JSON.stringify(["agent-a", "agent-b", "foreign-agent"])]);
    const ok = await invoke();
    assert.equal(ok.statusCode, 200, ok.body);
    const result = ok.json<ProductCapabilityResult>();
    assert.deepEqual((result.value as {agents: {id:string}[]}).agents.map(a=>a.id), ["agent-a"]);
    assert.equal((result.value as {next:string}).next, "agent-a");
    assert.ok(!ok.body.includes("never-return-me") && !ok.body.includes('"config"'));
    const next = await invoke({ ...call, input: { after: "agent-a", limit: 50 } });
    assert.equal(next.statusCode, 200);
    assert.deepEqual(next.json().value.agents.map((a: {id:string})=>a.id), ["agent-b"]);
    assert.deepEqual((await invoke({ ...call, control: "authorize" })).json(), { value: { authorized: true } });
    const evidenceCall = { ...call, control: "evidence" as const, input: { source: result.sources![0] } };
    assert.equal((await invoke(evidenceCall)).statusCode, 200);
    for (const changes of [
      { originProduct: "agency" }, { originTenantId: "w" }, { tenantId: "foreign" }, { mappingRef: "unknown" },
      { policyRevision: "new" }, { manifestDigest: "changed" }, { descriptorDigest: "changed" }, { handlerRef: "different" },
    ]) assert.equal((await invoke({ ...call, authority: { ...call.authority, ...changes } })).statusCode, 403, JSON.stringify(changes));
    assert.equal((await invoke({ ...call, actor: { ...call.actor, subject: "other-user" } })).statusCode, 403);
    assert.equal((await invoke({ ...call, bindingDigest: "changed" })).statusCode, 403);
    assert.equal((await invoke({ ...call, input: { agentId: "ungranted" } })).statusCode, 403);
    assert.equal((await invoke({ ...call, input: { limit: 51 } })).statusCode, 400);
    assert.equal((await invoke({ ...call, input: { arbitraryUrl: "https://other" } })).statusCode, 400);
    for (const args of [["wrong-audience", "agents-worker", "https://agents.test"], ["product-capability-actions", "growth-api", "https://agents.test"], ["product-capability-actions", "agents-worker", "https://other.test"]])
      assert.equal((await invoke(call, await token(call, ...args as [string,string,string]))).statusCode, 401);
    assert.equal((await invoke({ ...call, input: { agentId: "agent-b" } }, await token(call))).statusCode, 401);
    await f.pool.query("UPDATE workspace_agents SET updated_at=NOW()+INTERVAL '1 minute' WHERE id='agent-a'");
    assert.equal((await invoke(evidenceCall)).statusCode, 403);
    await f.pool.query("UPDATE product_capability_grants SET revoked_at=NOW()");
    assert.equal((await invoke()).statusCode, 403);
    assert.equal((await invoke(evidenceCall)).statusCode, 403);
    await f.pool.query("UPDATE product_capability_grants SET revoked_at=NULL; DELETE FROM tenant_user_roles WHERE tenant_user_id='agency-user'");
    assert.equal((await invoke()).statusCode, 403);
    await f.pool.query("INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES('agency-user','viewer')");
    assert.equal((await invoke()).statusCode, 403);
    await f.pool.query("UPDATE tenant_user_roles SET role='support'; UPDATE workspaces SET status='disabled' WHERE id='w'");
    assert.equal((await invoke()).statusCode, 403);
    await f.pool.query("UPDATE workspaces SET status='active'; UPDATE product_capability_mappings SET revoked_at=NOW()");
    assert.equal((await invoke()).statusCode, 403);
    await f.pool.query("UPDATE product_capability_mappings SET revoked_at=NULL,expires_at=NOW()-INTERVAL '1 minute'");
    assert.equal((await invoke()).statusCode, 403);
    delete context.config.env.AGENTS_PRODUCT_ACTION_PUBLIC_KEY;
    assert.equal((await invoke()).statusCode, 503);
  } finally { await app.close(); await f.close(); }
});
