import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { KnowledgeStore } from "../src/platform/knowledge/knowledge";
import { PostgresKnowledgeObjectStore } from "../src/platform/knowledge/postgres-object-store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const parent = process.env.AGENTS_TEST_DATABASE_URL;
const database = `agents_attachments_${randomUUID().replaceAll("-", "")}`;
const origin = "http://localhost:3100";
const issuer = "https://identity.attachments.test";

describe.skipIf(!parent)("workspace knowledge attachments", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, app: Awaited<ReturnType<typeof buildPlatformApp>>;

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
        AGENTS_OIDC_CLIENT_SECRET: "attachments-fixture-secret-0000000000",
        OPENROUTER_API_KEY: "not-used",
      }),
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

  async function request(token: string, method: "GET" | "DELETE", url: string) {
    const response = await app.inject({ method, url, headers: { origin, cookie: `agents_session=${token}` } });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  }

  it("lists attached agents and detaches on agent deletion without deleting the source", async () => {
    const owner = await store.ensureAccount({ issuer, subject: randomUUID(), email: `owner-${randomUUID()}@example.test`, displayName: "Owner" });
    const org = await store.createOrganization(owner.id, "Attachment workspace");
    const session = await store.createSession({ accountId: owner.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    const scope = { accountId: owner.id, organizationId: org.id };
    const knowledge = new KnowledgeStore(pool, new PostgresKnowledgeObjectStore(pool));
    const job = await knowledge.admitText(scope, { operationId: randomUUID(), title: "Shared policy", text: "# Policy\n\nReturns are accepted within 30 days." });
    const source = (await knowledge.list(scope)).find(item => item.revisions.some(revision => revision.id === job.revisionId))!;
    await knowledge.setPolicy(scope, source.id, { operationId: randomUUID(), expectedGeneration: source.generation, action: "approve", revisionId: job.revisionId });

    const createAttached = async (name: string) => {
      const agent = await store.createAgent({ accountId: owner.id, organizationId: org.id, name });
      const configuration = defaultBusinessConfiguration();
      configuration.sourceRevisionIds = [job.revisionId];
      configuration.tools = ["knowledge.search", "knowledge.read"];
      configuration.knowledge = { mode: "pinned" };
      await store.saveConfiguration({ accountId: owner.id, organizationId: org.id, agentId: agent.id, configuration, expectedRevision: agent.draft_revision });
      return agent;
    };
    const first = await createAttached("First agent");
    await createAttached("Second agent");

    const before = await request(session.token, "GET", `/api/organizations/${org.id}/knowledge/sources`);
    expect(before.status).toBe(200);
    const shared = before.body.sources.find((item: { id: string }) => item.id === source.id);
    expect(shared.attachedAgents).toEqual(["First agent", "Second agent"]);

    const deleted = await request(session.token, "DELETE", `/api/organizations/${org.id}/agents/${first.id}`);
    expect(deleted.status).toBe(204);

    const after = await request(session.token, "GET", `/api/organizations/${org.id}/knowledge/sources`);
    const remaining = after.body.sources.find((item: { id: string }) => item.id === source.id);
    expect(remaining.state).toBe("active");
    expect(remaining.attachedAgents).toEqual(["Second agent"]);
    expect((await pool.query("SELECT state FROM agents_platform.sources WHERE id=$1", [source.id])).rows[0]!.state).toBe("active");
  });
});
