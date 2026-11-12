import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { KnowledgeStore } from "../src/capabilities/knowledge/knowledge";
import { PostgresKnowledgeObjectStore } from "../src/capabilities/knowledge/postgres-object-store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const parent = process.env.AGENTS_TEST_DATABASE_URL;
const database = `agents_transfer_${randomUUID().replaceAll("-", "")}`;
const origin = "http://localhost:3100";
const issuer = "https://identity.transfer.test";

describe.skipIf(!parent)("agent transfer", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, app: Awaited<ReturnType<typeof buildPlatformApp>>;
  const messages: Array<{ to: string; subject: string; text: string; idempotencyKey: string }> = [];
  const sender = {
    async send(input: { to: string; subject: string; text: string; idempotencyKey: string }) {
      messages.push(input);
      return { state: "accepted" as const, providerId: "transfer-test" };
    },
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: parent });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(parent!);
    target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href, max: 8 });
    await setupPlatformSchema(pool);
    store = new PlatformStore(pool);
    app = await buildPlatformApp({
      pool,
      logging: false,
      config: loadPlatformConfig({
        NODE_ENV: "test",
        AGENTS_DATABASE_URL: target.href,
        AGENTS_PUBLIC_URL: origin,
        AGENTS_OIDC_ISSUER_URL: issuer,
        AGENTS_OIDC_CLIENT_SECRET: "transfer-fixture-secret-000000000000",
        OPENROUTER_API_KEY: "not-used",
      }),
      testInvitationSender: sender,
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await dropClosedTestDatabase(admin, database);
      await admin.end();
    }
  });

  async function account(email: string, displayName = "Member") {
    return store.ensureAccount({ issuer, subject: randomUUID(), email, displayName });
  }
  async function organization(ownerId: string, name: string) {
    return store.createOrganization(ownerId, name);
  }
  async function session(accountId: string) {
    return store.createSession({ accountId, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  }
  async function request(token: string | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
    const response = await app.inject({
      method, url,
      headers: { origin, ...(token ? { cookie: `agents_session=${token}` } : {}), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  }
  function transferToken(message: { text: string }): string {
    const match = message.text.match(/\/transfer\/([A-Za-z0-9_-]{43})/);
    if (!match) throw new Error("Transfer link missing");
    return match[1]!;
  }

  it("copies the published agent and its knowledge into the accepting workspace", async () => {
    const owner = await account(`owner-${randomUUID()}@example.test`, "Owner");
    const sourceOrg = await organization(owner.id, "Source workspace");
    const sourceSession = await session(owner.id);
    const recipient = await account(`recipient-${randomUUID()}@example.test`, "Recipient");
    const destinationOrg = await organization(recipient.id, "Destination workspace");
    const recipientSession = await session(recipient.id);
    const scope = { accountId: owner.id, organizationId: sourceOrg.id };
    const knowledge = new KnowledgeStore(pool, new PostgresKnowledgeObjectStore(pool));
    const admitted = await knowledge.admitText(scope, {
      operationId: randomUUID(), title: "Menu",
      text: "# Menu\n\nCoffee R20\n\n## Extras\n\nMilk R5",
    });
    const chunk = (await pool.query("SELECT id FROM agents_platform.source_chunks WHERE organization_id=$1 AND revision_id=$2 ORDER BY ordinal LIMIT 1", [sourceOrg.id, admitted.revisionId])).rows[0]!;
    await pool.query("INSERT INTO agents_platform.chunk_embeddings(organization_id,chunk_id,embedding_release,embedding) SELECT $1,$2,'transfer-test',array_fill(0.0::real,ARRAY[384])::public.vector", [sourceOrg.id, chunk.id]);
    const listed = (await knowledge.list(scope)).find(source => source.revisions.some(revision => revision.id === admitted.revisionId));
    await knowledge.setPolicy(scope, listed!.id, { operationId: randomUUID(), expectedGeneration: listed!.generation, action: "approve", revisionId: admitted.revisionId });
    const agent = await store.createAgent({ accountId: owner.id, organizationId: sourceOrg.id, name: "Client agent" });
    const configuration = defaultBusinessConfiguration();
    configuration.sourceRevisionIds = [admitted.revisionId];
    configuration.tools = ["knowledge.search", "knowledge.read"];
    configuration.knowledge = { mode: "pinned" };
    await store.saveConfiguration({ accountId: owner.id, organizationId: sourceOrg.id, agentId: agent.id, configuration, expectedRevision: agent.draft_revision });

    messages.length = 0;
    const initiated = await request(sourceSession.token, "POST", `/api/organizations/${sourceOrg.id}/agents/${agent.id}/transfers`, { email: recipient.email });
    expect(initiated.status).toBe(201);
    expect(initiated.body.transfer).toMatchObject({ agentId: agent.id, targetEmail: recipient.email, state: "pending" });
    expect(messages).toHaveLength(1);
    const token = transferToken(messages[0]!);

    const frozen = await request(sourceSession.token, "PATCH", `/api/organizations/${sourceOrg.id}/agents/${agent.id}`, { name: "Renamed" });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe("AGENT_TRANSFER_PENDING");

    const preview = await request(null, "GET", `/api/agent-transfers/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.transfer).toMatchObject({ agentName: "Client agent", organizationName: "Source workspace", state: "pending" });
    expect(preview.body.transfer.sources).toHaveLength(1);

    const wrongEmail = await request(sourceSession.token, "POST", `/api/agent-transfers/${token}/accept`, { organizationId: destinationOrg.id });
    expect(wrongEmail.status).toBe(403);
    expect(wrongEmail.body.error.code).toBe("TRANSFER_EMAIL_MISMATCH");

    const accepted = await request(recipientSession.token, "POST", `/api/agent-transfers/${token}/accept`, { organizationId: destinationOrg.id });
    expect(accepted.status).toBe(200);
    expect(accepted.body.organizationId).toBe(destinationOrg.id);
    const newAgentId = accepted.body.agentId as string;

    const copiedAgent = (await pool.query("SELECT * FROM agents_platform.agents WHERE id=$1", [newAgentId])).rows[0]!;
    expect(copiedAgent.organization_id).toBe(destinationOrg.id);
    expect(copiedAgent.draft.sourceRevisionIds).toHaveLength(1);
    expect(copiedAgent.draft.sourceRevisionIds[0]).not.toBe(admitted.revisionId);
    expect(copiedAgent.draft.model.selection).toEqual({ kind: "organization_default" });
    expect(copiedAgent.draft.connectedToolBindingIds).toEqual([]);
    expect(copiedAgent.draft.skillIds).toEqual([]);
    expect(copiedAgent.draft.capabilities.delegation).toEqual({ enabled: false });
    expect(copiedAgent.draft.capabilities.businessActions).toEqual({ enabled: false });
    expect(copiedAgent.draft.capabilities.workflows).toEqual({ enabled: false });

    const version = (await pool.query("SELECT * FROM agents_platform.agent_versions WHERE agent_id=$1", [newAgentId])).rows[0]!;
    expect(version.number).toBe(1);
    expect(version.configuration.sourceRevisionIds).toEqual(copiedAgent.draft.sourceRevisionIds);
    const versionSources = (await pool.query("SELECT * FROM agents_platform.version_sources WHERE version_id=$1", [version.id])).rows;
    expect(versionSources).toHaveLength(1);
    expect(versionSources[0]!.revision_id).toBe(copiedAgent.draft.sourceRevisionIds[0]);

    const originalCounts = (await pool.query(`SELECT
      (SELECT count(*) FROM agents_platform.source_sections WHERE organization_id=$1 AND revision_id=$2)::int AS sections,
      (SELECT count(*) FROM agents_platform.source_chunks WHERE organization_id=$1 AND revision_id=$2)::int AS chunks,
      (SELECT count(*) FROM agents_platform.chunk_embeddings e JOIN agents_platform.source_chunks c ON c.id=e.chunk_id WHERE c.revision_id=$2)::int AS embeddings`, [sourceOrg.id, admitted.revisionId])).rows[0]!;
    const copiedCounts = (await pool.query(`SELECT
      (SELECT count(*) FROM agents_platform.source_sections WHERE organization_id=$1 AND revision_id=$2)::int AS sections,
      (SELECT count(*) FROM agents_platform.source_chunks WHERE organization_id=$1 AND revision_id=$2)::int AS chunks,
      (SELECT count(*) FROM agents_platform.chunk_embeddings e JOIN agents_platform.source_chunks c ON c.id=e.chunk_id WHERE c.revision_id=$2)::int AS embeddings`, [destinationOrg.id, copiedAgent.draft.sourceRevisionIds[0]])).rows[0]!;
    expect(copiedCounts).toEqual(originalCounts);
    const copiedSource = (await pool.query("SELECT * FROM agents_platform.sources WHERE organization_id=$1 AND state='active'", [destinationOrg.id])).rows[0]!;
    expect(copiedSource.title).toBe("Menu");
    expect((await pool.query("SELECT * FROM agents_platform.source_revision_policy WHERE revision_id=$1 AND state='approved'", [copiedAgent.draft.sourceRevisionIds[0]])).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM agents_platform.knowledge_object_contents WHERE object_key LIKE $1", [`knowledge/${destinationOrg.id}/%`])).rowCount).toBe(2);

    const originalSource = (await pool.query("SELECT state FROM agents_platform.sources WHERE id=$1", [listed!.id])).rows[0]!;
    expect(originalSource.state).toBe("active");
    expect((await pool.query("SELECT * FROM agents_platform.version_sources WHERE version_id=(SELECT id FROM agents_platform.agent_versions WHERE agent_id=$1)", [agent.id])).rowCount).toBe(1);
    const settled = (await pool.query("SELECT state,target_account_id,target_organization_id,created_agent_id FROM agents_platform.agent_transfers WHERE created_agent_id=$1", [newAgentId])).rows[0]!;
    expect(settled).toMatchObject({ state: "accepted", target_account_id: recipient.id, target_organization_id: destinationOrg.id });

    const replay = await request(recipientSession.token, "POST", `/api/agent-transfers/${token}/accept`, { organizationId: destinationOrg.id });
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyAccepted).toBe(true);
    expect(replay.body.agentId).toBe(newAgentId);
  });

  it("expires without leaving copies", async () => {
    const owner = await account(`expire-${randomUUID()}@example.test`, "Owner");
    const sourceOrg = await organization(owner.id, "Expire source");
    const sourceSession = await session(owner.id);
    const recipient = await account(`expire-recipient-${randomUUID()}@example.test`, "Recipient");
    const destinationOrg = await organization(recipient.id, "Expire destination");
    const recipientSession = await session(recipient.id);
    const agent = await store.createAgent({ accountId: owner.id, organizationId: sourceOrg.id, name: "Expiring agent" });
    const configuration = defaultBusinessConfiguration();
    await store.saveConfiguration({ accountId: owner.id, organizationId: sourceOrg.id, agentId: agent.id, configuration, expectedRevision: agent.draft_revision });

    messages.length = 0;
    const initiated = await request(sourceSession.token, "POST", `/api/organizations/${sourceOrg.id}/agents/${agent.id}/transfers`, { email: recipient.email });
    expect(initiated.status).toBe(201);
    const token = transferToken(messages[0]!);
    await pool.query("UPDATE agents_platform.agent_transfers SET created_at=now()-interval '8 days',expires_at=now()-interval '1 minute' WHERE id=$1", [initiated.body.transfer.id]);
    const preview = await request(null, "GET", `/api/agent-transfers/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.transfer.state).toBe("expired");
    const accepted = await request(recipientSession.token, "POST", `/api/agent-transfers/${token}/accept`, { organizationId: destinationOrg.id });
    expect(accepted.status).toBe(409);
    expect(accepted.body.error.code).toBe("TRANSFER_NOT_PENDING");
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.sources WHERE organization_id=$1", [destinationOrg.id])).rows[0]!.count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.agents WHERE organization_id=$1 AND name='Expiring agent'", [destinationOrg.id])).rows[0]!.count).toBe(0);
  });

  it("declines without leaving copies and unfreezes the source agent", async () => {
    const owner = await account(`decline-${randomUUID()}@example.test`, "Owner");
    const sourceOrg = await organization(owner.id, "Decline source");
    const sourceSession = await session(owner.id);
    const recipient = await account(`decline-recipient-${randomUUID()}@example.test`, "Recipient");
    const destinationOrg = await organization(recipient.id, "Decline destination");
    const recipientSession = await session(recipient.id);
    const agent = await store.createAgent({ accountId: owner.id, organizationId: sourceOrg.id, name: "Declined agent" });
    const configuration = defaultBusinessConfiguration();
    await store.saveConfiguration({ accountId: owner.id, organizationId: sourceOrg.id, agentId: agent.id, configuration, expectedRevision: agent.draft_revision });

    messages.length = 0;
    const initiated = await request(sourceSession.token, "POST", `/api/organizations/${sourceOrg.id}/agents/${agent.id}/transfers`, { email: recipient.email });
    expect(initiated.status).toBe(201);
    const token = transferToken(messages[0]!);
    const declined = await request(recipientSession.token, "POST", `/api/agent-transfers/${token}/decline`, {});
    expect(declined.status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.sources WHERE organization_id=$1", [destinationOrg.id])).rows[0]!.count).toBe(0);
    const profile = await request(sourceSession.token, "PATCH", `/api/organizations/${sourceOrg.id}/agents/${agent.id}`, { name: "Renamed after decline" });
    expect(profile.status).toBe(200);
    expect(profile.body.agent.name).toBe("Renamed after decline");
    const current = await request(sourceSession.token, "GET", `/api/organizations/${sourceOrg.id}/agents/${agent.id}/transfers/current`);
    expect(current.body.transfer).toBeNull();
  });
});
