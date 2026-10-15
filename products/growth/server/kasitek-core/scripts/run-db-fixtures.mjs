import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These fixtures create and drop only their own synthetic schemas. Retain the
// historical script entrypoints without running Cargo or loading public seeds.
const profiles = {
  'early-access': {
    source: 'EARLY_ACCESS_TEST_DATABASE_URL',
    bindings: ['CORE_EARLY_ACCESS_TEST_DATABASE_URL'],
    tests: ['early-access'],
  },
  referrals: {
    source: 'REFERRALS_TEST_DATABASE_URL',
    bindings: ['CORE_BILLING_TEST_DATABASE_URL', 'CORE_ORGS_TEST_DATABASE_URL'],
    tests: ['billing', 'orgs'],
  },
  'connections-inbox': {
    source: 'SEEDED_CORE_TEST_DATABASE_URL',
    bindings: ['CORE_CONNECTIONS_TEST_DATABASE_URL', 'CORE_INBOX_TEST_DATABASE_URL'],
    tests: ['connections', 'inbox-meta'],
  },
};
const profile = profiles[process.argv[2]];
if (!profile) throw new Error('Choose early-access, referrals or connections-inbox');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24');
const connection = process.env[profile.source];
if (!connection) throw new Error(`Set ${profile.source} to a disposable local PostgreSQL database`);
let local = false;
try {
  const url = new URL(connection);
  local = ['postgres:', 'postgresql:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
} catch { /* Report without exposing the database URL or credentials. */ }
if (!local) throw new Error('Refusing database fixtures against a non-local database');
const env = { ...process.env };
for (const key of profile.bindings) env[key] = connection;
const result = spawnSync('pnpm', ['exec', 'tsx', '--test',
  ...profile.tests.map(name => `tests/${name}.test.ts`)], {
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'), env, stdio: 'inherit',
});
if (result.error) throw new Error('Unable to launch the native fixture runner');
process.exit(result.status ?? 1);
