import test from 'node:test';
import assert from 'node:assert/strict';
import { getCoreSession, getWorkspaceSession, getWorkspaceContext } from '../src/lib/core-auth';
import { fetchOrgs, getActiveOrgId } from '../src/lib/orgs';
import { clearPrivateQueries } from '../src/lib/query-client';
import { ApiError } from '../src/lib/core-server-api';

const user = (id = 'one') => ({ user: { id, name: id, email: `${id}@example.test`, image: '', emailVerified: '2026-10-24' } });
const organization = { id: 'org', name: 'Fixture' };
const membership = () => ({ orgs: [organization], activeOrgId: 'org' });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const request = () => new Request('https://growth.test/agents');

test('matched loaders share one authenticated workspace read per Request and recheck new navigations', async t => {
  clearPrivateQueries();
  const calls: string[] = [];
  const navigation = request();
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push(path);
    assert.equal(init.credentials, 'include');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal);
    return json(path === '/api/auth/me' ? user() : membership());
  });
  const [session, organizations, activeOrgId, context] = await Promise.all([
    getWorkspaceSession(navigation), fetchOrgs(navigation), getActiveOrgId(navigation), getWorkspaceContext(navigation),
  ]);
  assert.equal(session?.user.id, 'one');
  assert.deepEqual(organizations, [organization]);
  assert.equal(activeOrgId, 'org');
  assert.equal(context.session?.user.id, 'one');
  assert.deepEqual(calls, ['/api/auth/me', '/api/orgs']);
  await getWorkspaceSession(request());
  assert.deepEqual(calls, ['/api/auth/me', '/api/orgs', '/api/auth/me', '/api/orgs']);
});

test('owned authentication expiry still returns null and no organization redirects to onboarding', async t => {
  clearPrivateQueries();
  let unauthorized = true;
  let organizationCalls = 0;
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    if (path === '/api/auth/me') return unauthorized ? json({ error: 'Sign in required' }, 401) : json(user());
    organizationCalls++;
    return json({ orgs: [], activeOrgId: null });
  });
  const expired = request();
  assert.equal(await getCoreSession(expired), null);
  assert.equal(await getWorkspaceSession(expired), null);
  assert.equal(organizationCalls, 0);
  unauthorized = false;
  await assert.rejects(getWorkspaceSession(request()), (error: unknown) => error instanceof Response && error.status === 302 && error.headers.get('location') === '/onboarding');
});

test('authorization and provider failures retain their HTTP errors rather than empty workspace results', async t => {
  clearPrivateQueries();
  for (const status of [403, 503]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => json({ error: 'Unavailable' }, status));
    await assert.rejects(getWorkspaceSession(request()), (error: unknown) => error instanceof ApiError && error.status === status);
    fetch.mock.restore();
  }
});

test('business changes and aborted navigation reject late bootstrap responses', async t => {
  clearPrivateQueries();
  let release!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { release = resolve; }));
  const old = getWorkspaceContext(request());
  clearPrivateQueries();
  release(json(user()));
  await assert.rejects(old, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  const controller = new AbortController();
  const aborted = getWorkspaceContext(new Request('https://growth.test/agents', { signal: controller.signal }));
  controller.abort();
  release(json(user()));
  await assert.rejects(aborted, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
});

test('an observed identity change permits its own new workspace and rejects an older pending organization read', async t => {
  clearPrivateQueries();
  let identity = 'one';
  let holdOrganization = false;
  let release!: (value: Response) => void;
  let started!: () => void;
  const organizationStarted = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    if (path === '/api/auth/me') return json(user(identity));
    if (holdOrganization) { holdOrganization = false; started(); return new Promise<Response>(resolve => { release = resolve; }); }
    return json(membership());
  });
  await getCoreSession(request());
  holdOrganization = true;
  const older = getWorkspaceContext(request());
  await organizationStarted;
  identity = 'two';
  const current = request();
  assert.equal((await getWorkspaceContext(current)).session?.user.id, 'two');
  release(json(membership()));
  await assert.rejects(older, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal((await getWorkspaceContext(current)).activeOrgId, 'org');
});
