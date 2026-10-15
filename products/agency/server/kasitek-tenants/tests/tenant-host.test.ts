import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { readConfig } from '../src/config.js';
import { TenantError } from '../src/error.js';
import { resolveWorkspaceFromRequest } from '../src/middleware.js';
import type { TenantContext } from '../src/context.js';

type WorkspaceRow = {
  workspace_id: string;
  workspace_slug: string;
  display_name: string;
  status: string;
};

function resolverContext(
  domains: Map<string, WorkspaceRow>,
  workspaces: Map<string, WorkspaceRow>,
  defaultWorkspaceSlug?: string,
) {
  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const pool = {
    async query(sql: string, parameters: unknown[] = []) {
      calls.push({ sql, parameters });
      const rows = sql.includes('FROM workspace_domains')
        ? domains.get(String(parameters[0]))
        : workspaces.get(String(parameters[0]));
      return { rows: rows ? [rows] : [] };
    },
  } as unknown as Pool;
  const config = readConfig({
    TENANT_DATABASE_URL: 'postgres://unused',
    TENANT_PLATFORM_BASE_DOMAIN: 'agency.example',
    ...(defaultWorkspaceSlug
      ? { TENANT_DEFAULT_WORKSPACE_SLUG: defaultWorkspaceSlug }
      : {}),
  });
  return { context: { pool, config } as TenantContext, calls };
}

const workspace = (slug: string, status = 'active'): WorkspaceRow => ({
  workspace_id: `id-${slug}`,
  workspace_slug: slug,
  display_name: slug.toUpperCase(),
  status,
});
const resolvedWorkspace = (slug: string) => ({
  workspace_id: `id-${slug}`,
  workspace_slug: slug,
  display_name: slug.toUpperCase(),
});
const request = (headers: Record<string, string>) =>
  ({ headers }) as unknown as FastifyRequest;

test('tenant host resolution matches custom, platform, unknown and inactive cases', async () => {
  const customDomain = resolverContext(
    new Map([['brand.custom.example', workspace('acme')]]),
    new Map(),
  );
  assert.deepEqual(
    await resolveWorkspaceFromRequest(
      request({ host: 'fallback.example', 'x-kasitek-tenant-host': 'https://Brand.Custom.Example:443, edge.example' }),
      customDomain.context,
    ),
    resolvedWorkspace('acme'),
  );
  assert.equal(customDomain.calls[0]?.parameters[0], 'brand.custom.example');
  assert.equal(customDomain.calls.length, 1);

  const platform = resolverContext(new Map(), new Map([['alpha', workspace('alpha')]]));
  assert.deepEqual(
    await resolveWorkspaceFromRequest(
      request({
        'x-kasitek-tenant-host': 'http://Alpha.Agency.Example:443, proxy.example',
        'x-forwarded-host': 'beta.agency.example',
        host: 'host.example',
      }),
      platform.context,
    ),
    resolvedWorkspace('alpha'),
  );
  assert.equal(platform.calls[0]?.parameters[0], 'alpha.agency.example');
  assert.equal(platform.calls[1]?.parameters[0], 'alpha');

  const unknown = resolverContext(new Map(), new Map());
  await assert.rejects(
    resolveWorkspaceFromRequest(
      request({ host: 'one.two.agency.example' }),
      unknown.context,
    ),
    (error) => error instanceof TenantError && error.status === 404,
  );
  assert.equal(unknown.calls.length, 1);

  const fallback = resolverContext(new Map(), new Map([['home', workspace('home')]]), 'home');
  assert.deepEqual(
    await resolveWorkspaceFromRequest(request({ host: 'unmapped.example' }), fallback.context),
    resolvedWorkspace('home'),
  );
  assert.equal(fallback.calls.length, 2);

  const inactive = resolverContext(
    new Map([['paused.custom.example', workspace('paused', 'suspended')]]),
    new Map(),
  );
  await assert.rejects(
    resolveWorkspaceFromRequest(
      request({ host: 'paused.custom.example' }),
      inactive.context,
    ),
    (error) => error instanceof TenantError && error.status === 403,
  );
});
