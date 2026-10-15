import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
const pg = createRequire(
  new URL('../../../kasitek-growth/server/kasitek-core/package.json', import.meta.url),
)('pg');
import { buildApp as buildAgentsApp } from '../../../kasitek-agents/src/http/app.ts';
import { loadConfig as loadAgentsConfig } from '../../../kasitek-agents/src/config/index.ts';
import { buildApp as buildCoreApp } from '../../../kasitek-growth/server/kasitek-core/src/app.js';
import { readConfig } from '../../../kasitek-growth/server/kasitek-core/src/config.js';
import { registerAdminOperationsRoutes } from '../../../kasitek-growth/server/kasitek-core/src/routes/admin-operations.js';

// Run from the workspace root with both database variables explicitly set to
// the same fresh, disposable database after applying Agents migrations.
const agentsDatabaseUrl = process.env.AGENTS_ADMIN_TEST_DATABASE_URL;
const coreDatabaseUrl = process.env.CORE_ADMIN_AGENTS_TEST_DATABASE_URL;

test(
  'Growth admin operator command reaches Agents and creates the approved kill switch',
  { skip: !agentsDatabaseUrl || !coreDatabaseUrl },
  async () => {
    const schema = `admin_agents_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new pg.Pool({ connectionString: coreDatabaseUrl });
    const corePool = new pg.Pool({
      connectionString: coreDatabaseUrl,
      options: `-c search_path=${schema},public -c timezone=UTC`,
    });
    const agentsPool = new pg.Pool({ connectionString: agentsDatabaseUrl });
    const secret = randomBytes(32).toString('hex');
    let schemaCreated = false;
    let agentsApp: ReturnType<typeof buildAgentsApp> | undefined;
    let coreApp: Awaited<ReturnType<typeof buildCoreApp>> | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await corePool.query(`
        CREATE TABLE "AdminUser" (
          id text PRIMARY KEY,
          name text NOT NULL,
          email text NOT NULL,
          password text NOT NULL,
          role text NOT NULL,
          "createdAt" timestamp NOT NULL DEFAULT now(),
          "updatedAt" timestamp NOT NULL DEFAULT now()
        )
      `);
      const creatorId = `creator-${randomUUID()}`;
      const approverId = `approver-${randomUUID()}`;
      await corePool.query(
        `INSERT INTO "AdminUser" (id,name,email,password,role) VALUES
          ($1,'Synthetic creator','creator@example.invalid','unused','admin'),
          ($2,'Synthetic approver','approver@example.invalid','unused','operator')`,
        [creatorId, approverId],
      );

      const agentsConfig = loadAgentsConfig({
        NODE_ENV: 'test',
        AGENTS_DATABASE_URL: agentsDatabaseUrl,
        AUTH_MODE: 'hmac',
        INTERNAL_AUTH_SECRET: secret,
        LOG_LEVEL: 'silent',
      });
      agentsApp = buildAgentsApp({ config: agentsConfig, pool: agentsPool });
      await agentsApp.listen({ host: '127.0.0.1', port: 0 });
      const address = agentsApp.server.address() as AddressInfo;

      const coreConfig = readConfig({
        DATABASE_URL: coreDatabaseUrl,
        ENVIRONMENT: 'test',
        LOG_LEVEL: 'silent',
        AGENTS_API_URL: `http://127.0.0.1:${address.port}`,
        AGENTS_INTERNAL_AUTH_SECRET: secret,
      });
      coreApp = await buildCoreApp(
        { pool: corePool, config: coreConfig },
        [registerAdminOperationsRoutes],
      );

      const organizationId = `migration-smoke-${randomUUID()}`;
      const create = await coreApp.inject({
        method: 'POST',
        url: '/api/admin/operations/commands',
        headers: {
          cookie: `kasitek_admin_session=${creatorId}`,
          'idempotency-key': `migration-smoke-${randomUUID()}`,
        },
        payload: {
          commandType: 'kill_switch_enable',
          targetId: organizationId,
          payload: {
            organizationId,
            scopeType: 'organization',
            scopeId: organizationId,
            reason: 'TypeScript migration integration smoke',
          },
        },
      });
      assert.equal(create.statusCode, 202, create.body);
      const command = create.json<{ id: string; status: string }>();
      assert.equal(command.status, 'awaiting_approval');

      const approved = await coreApp.inject({
        method: 'POST',
        url: `/api/admin/operations/commands/${encodeURIComponent(command.id)}/approve`,
        headers: { cookie: `kasitek_admin_session=${approverId}` },
        payload: {},
      });
      assert.equal(approved.statusCode, 202, approved.body);
      assert.equal(approved.json<{ status: string }>().status, 'completed');

      const effect = await agentsPool.query(
        `SELECT scope_type,scope_id,enabled FROM agent_kill_switches
         WHERE organization_id=$1`,
        [organizationId],
      );
      assert.deepEqual(effect.rows, [
        { scope_type: 'organization', scope_id: organizationId, enabled: true },
      ]);
    } finally {
      if (coreApp) await coreApp.close();
      if (agentsApp) await agentsApp.close();
      await Promise.all([agentsPool.end(), corePool.end()]);
      if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await adminPool.end();
    }
  },
);
