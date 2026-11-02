import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchesGlob } from 'node:path';

const matrix = JSON.parse(await readFile(new URL('../infra/railway/watch-paths.json', import.meta.url), 'utf8'));
const services = Object.keys(matrix.services).sort();
const nodeServices = services.filter(name => !['identity', 'restate', 'otel-collector'].includes(name));
const selected = file => services.filter(name => matrix.services[name].some(pattern => matchesGlob('/' + file, pattern)));
const expect = (file, names) => assert.deepEqual(selected(file), [...names].sort(), file);
assert.equal(matrix.schemaVersion, 1);
assert.equal(services.length, 13);
assert.equal(matrix.imageOnlyServices.length, 6);
for (const patterns of Object.values(matrix.services)) {
  assert.ok(patterns.length > 0);
  assert.ok(patterns.every(pattern => pattern.startsWith('/') && !pattern.includes('VERSION')));
}
expect('products/growth/api/src/operations/mcp.ts', ['growth-api', 'growth-analytics-worker']);
expect('products/growth/api/sql/20261102190000_content_agent_workflows.sql', ['growth-api', 'growth-analytics-worker']);
expect('products/growth/database/prisma/migrations/example/migration.sql', ['growth-api', 'growth-analytics-worker']);
expect('products/agents/api/src/composition/server.ts', ['agents-api', 'agents-worker']);
expect('products/agents/api/schema/001_platform.sql', ['agents-api', 'agents-worker']);
expect('products/agency/api/src/server.ts', ['agency-api', 'agency-analytics-worker']);
expect('services/analytics/src/server.ts', ['analytics-api', 'analytics-worker']);
expect('services/analytics/metrics/domains/agents/runtime.yaml', ['analytics-api', 'analytics-worker']);
expect('services/operations/src/server.ts', ['operations-api', 'operations-worker']);
expect('packages/contracts/src/growth-operations.ts', nodeServices);
expect('pnpm-lock.yaml', nodeServices);
expect('infra/backend/Dockerfile', nodeServices.filter(name => !name.startsWith('agents-')));
expect('.dockerignore', ['agents-api', 'agents-worker']);
expect('infra/identity/email-provider/src/main/java/Example.java', ['identity']);
expect('infra/agents-runtime/production/restate.toml', ['restate']);
expect('infra/observability/otel-collector/config.production.template.yaml', ['otel-collector']);
for (const file of ['VERSION', 'AGENTS.md', 'docs/operations/platform-0.3.0-release.md',
  'products/growth/docs/features/README.md', 'products/growth/web/src/app/page.tsx',
  'products/growth/api/tests/growth-mcp-2026.test.ts', 'products/agents/api/test/product-capabilities.test.ts',
  'infra/identity/README.md', 'infra/observability/otel-collector/compose.yaml', 'infra/railway/watch-paths.json']) expect(file, []);
console.log('Railway watch-path matrix passed: 13 Git services, 6 image-only services, runtime/shared inputs and excluded changes.');
