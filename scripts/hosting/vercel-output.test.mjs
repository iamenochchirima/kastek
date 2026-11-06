import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVercelRoutes } from './vercel-output.mjs';
const options = { apiOrigin: 'https://backend.example', frontendOrigin: 'https://app.example', growthRoutes: [{ path: '/' }, { path: '/content' }, { path: '/posts/:id' }], preview: true };
function route(config, path, method = 'GET', host = 'app.example') {
  return config.routes.find(rule => rule.src && new RegExp(`^(?:${rule.src})$`).test(path) && (!rule.methods || rule.methods.includes(method)) && (!rule.has || rule.has.every(condition => condition.type === 'host' && new RegExp(`^(?:${condition.value})$`).test(host))) && !rule.continue);
}
test('browser APIs including organization switching and MCP bypass functions', () => {
  const config = createVercelRoutes('growth', options);
  for (const path of ['/api/social/media', '/api/social/media/upload', '/api/whatsapp/realtime', '/mcp', '/v1/operations', '/oauth/token']) assert.equal(route(config, path, 'POST').dest, 'https://backend.example$1');
  assert.equal(route(config, '/api/orgs/set-active', 'POST').dest, 'https://backend.example$1');
  assert.equal(route(config, '/content').dest, '/__spa-fallback.html');
  assert.equal(route(config, '/posts/abc').dest, '/__spa-fallback.html');
  for (const path of ['/unknown', '/assets/missing.js', '/__spa-fallback.html', '/source.js.map', '/.env', '/analytics/playground']) assert.equal(route(config, path).status, 404, path);
  assert.equal(route(config, '/content', 'POST').status, 405);
});
test('Agency strips client tenant headers and pins its configured public host', () => {
  const config = createVercelRoutes('agency', options);
  const rule = route(config, '/api/tenant/api/partner/auth/callback');
  assert.equal(rule.dest, 'https://backend.example/$1');
  assert.deepEqual(rule.transforms.filter(item => item.target.key === 'x-kasitek-tenant-host'), [
    { type: 'request.headers', op: 'delete', target: { key: 'x-kasitek-tenant-host' } },
    { type: 'request.headers', op: 'set', target: { key: 'x-kasitek-tenant-host' }, args: 'app.example' },
  ]);
  assert.equal(route(config, '/api/tenant/api/me', 'GET', 'unverified-tenant.example').status, 421);
  assert.equal(route(config, '/api/other').status, 404);
});
test('verified Agency wildcard retains each tenant host and denies lookalike or unrelated hosts', () => {
  const config = createVercelRoutes('agency', { ...options, frontendOrigin: 'https://portal.kasitek.co.za', agencyWildcardDomain: '*.portal.kasitek.co.za' });
  for (const host of ['alpha.portal.kasitek.co.za', 'beta-2.portal.kasitek.co.za']) {
    const rule = route(config, '/api/tenant/api/client/me', 'GET', host);
    assert.equal(rule.dest, 'https://backend.example/$1');
    const capturedHost = new RegExp(`^(?:${rule.has[0].value})$`).exec(host).groups.tenantHost;
    assert.equal(capturedHost, host);
    const headers = { 'x-kasitek-tenant-host': 'attacker.example' };
    for (const transform of rule.transforms) {
      if (transform.op === 'delete') delete headers[transform.target.key];
      if (transform.op === 'set') headers[transform.target.key] = transform.args.replace('$tenantHost', capturedHost);
    }
    assert.equal(headers['x-kasitek-tenant-host'], host);
    assert.equal(rule.transforms.some(item => item.target.key === 'x-forwarded-host'), false);
  }
  for (const host of ['evil.example', 'alpha.portal.kasitek.co.za.evil.example', 'alpha.other.kasitek.co.za', '-alpha.portal.kasitek.co.za', 'nested.alpha.portal.kasitek.co.za']) assert.equal(route(config, '/api/tenant/api/client/me', 'GET', host).status, 421, host);
  const canonical = route(config, '/api/tenant/api/partner/me', 'GET', 'portal.kasitek.co.za');
  assert.equal(canonical.transforms.find(item => item.target.key === 'x-kasitek-tenant-host' && item.op === 'set').args, 'portal.kasitek.co.za');
  assert.throws(() => createVercelRoutes('agency', { ...options, agencyWildcardDomain: '*.other.example' }));
});
test('configuration rejects unsafe origins and keeps production HTML private', () => {
  for (const apiOrigin of ['', 'http://backend.example', 'https://user:secret@backend.example', 'https://backend.example/path']) assert.throws(() => createVercelRoutes('growth', { ...options, apiOrigin }));
  const config = createVercelRoutes('agents', { ...options, preview: false });
  assert.equal(config.routes[0].headers['cache-control'], 'no-store');
  assert.equal(config.routes[0].headers['x-robots-tag'], undefined);
  assert.equal(route(config, '/app/agents').dest, '/index.html');
  for (const [path, method] of [['/mcp', 'POST'], ['/oauth/token', 'POST'], ['/.well-known/oauth-authorization-server', 'GET'], ['/.well-known/oauth-protected-resource/mcp', 'GET']]) assert.equal(route(config, path, method).dest, 'https://backend.example$1', path);
});
