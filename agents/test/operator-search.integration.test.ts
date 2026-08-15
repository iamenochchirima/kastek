import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { buildApp } from "../src/http/app";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("operator search (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  it("searches the safe investigation entities without returning payload fields", async () => {
    const marker = `operator-search-${randomUUID()}`;
    const organizationId = `org-${marker}`;
    const definitionId = randomUUID();
    const versionId = randomUUID();
    const installationId = randomUUID();
    const conversationId = randomUUID();
    const participantId = randomUUID();
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    const runId = randomUUID();
    const correlationId = randomUUID();
    const auditId = randomUUID();

    await pool.query(
      `INSERT INTO agent_definitions (id, organization_id, name, slug, created_by)
       VALUES ($1, $2, $3, $4, 'operator-search-test')`,
      [definitionId, organizationId, marker, marker],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_definition_id, version_number, status, instructions, checksum, created_by)
       VALUES ($1, $2, 1, 'published', 'safe test instructions', $3, 'operator-search-test')`,
      [versionId, definitionId, marker],
    );
    await pool.query(
      `INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, created_by)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'operator-search-test')`,
      [installationId, definitionId, versionId, organizationId],
    );
    await pool.query(
      `INSERT INTO conversations (id, installation_id, organization_id, external_conversation_id, title, owner_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conversationId, installationId, organizationId, marker, marker, marker],
    );
    await pool.query(
      `INSERT INTO participants (id, conversation_id, organization_id, participant_type, external_id, display_name)
       VALUES ($1, $2, $3, 'user', $4, $5)`,
      [participantId, conversationId, organizationId, marker, marker],
    );
    await pool.query(
      `INSERT INTO messages (id, conversation_id, organization_id, participant_id, direction, message_type,
                             content, provider, provider_message_id, sequence_number, source_channel,
                             occurred_at, delivery_status)
       VALUES ($1, $2, $3, $4, 'inbound', 'text', '{"safe":true}'::jsonb, 'test', $5, 1,
               'test', now(), 'sent')`,
      [messageId, conversationId, organizationId, participantId, marker],
    );
    await pool.query(
      `INSERT INTO delivery_attempts (id, organization_id, conversation_id, message_id, channel_type, status, attempt_number)
       VALUES ($1, $2, $3, $4, 'test', 'sent', 1)`,
      [deliveryId, organizationId, conversationId, messageId],
    );
    await pool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id,
                               conversation_id, trigger_type, status, correlation_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', 'completed', $7, 'operator-search-test')`,
      [runId, organizationId, definitionId, versionId, installationId, conversationId, correlationId],
    );
    await pool.query(
      `INSERT INTO audit_records (id, organization_id, actor_type, actor_id, action, resource_type, resource_id, correlation_id)
       VALUES ($1, $2, 'system', $3, 'operator_search_test', 'agent_run', $4, $5)`,
      [auditId, organizationId, marker, runId, correlationId],
    );

    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      AGENTS_DATABASE_URL: databaseUrl,
      AUTH_MODE: "headers",
      TEMPORAL_ENABLED: "false",
    });
    const app = buildApp({ config, pool });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/operator/search?q=${encodeURIComponent(marker)}&limit=100`,
        headers: { "x-organization-id": "platform", "x-actor-id": "admin-search-test", "x-kasitek-operator": "true" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { results: Array<{ kind: string; organization_id: string }> };
      const kinds = new Set(body.results.map((result) => result.kind));
      expect(kinds).toEqual(new Set(["organization", "workspace", "user", "run", "agent", "installation", "delivery", "conversation", "message", "audit"]));
      expect(body.results.every((result) => result.organization_id === organizationId)).toBe(true);
      expect(JSON.stringify(body)).not.toContain("safe test instructions");
      expect(JSON.stringify(body)).not.toContain("raw_payload");
    } finally {
      await app.close();
      await pool.query("DELETE FROM delivery_attempts WHERE id = $1", [deliveryId]);
      await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);
      await pool.query("DELETE FROM agent_runs WHERE id = $1", [runId]);
      await pool.query("DELETE FROM participants WHERE id = $1", [participantId]);
      await pool.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
      await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
      await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
      await pool.query("DELETE FROM agent_definitions WHERE id = $1", [definitionId]);
    }
  });

  afterAll(async () => {
    await pool.end();
  });
});
