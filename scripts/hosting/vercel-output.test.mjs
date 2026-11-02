import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVercelRoutes } from './vercel-output.mjs';
const options = { apiOrigin: 'https://backend.example', frontendOrigin: 'https://app.example', growthRoutes: [{ path: '/' }, { path: '/content' }, { path: '/posts/:id' }], preview: true };
function route(config, path, method = 'GET', host = 'app.example') {
  return config.routes.find(rule => rule.src && new RegExp(`^(?:${rule.src})$`).test(path) && (!rule.methods || rule.methods.includes(method)) && (!rule.has || rule.has.every(condition => condition.type === 'host' && new RegExp(`^(?:${condition.value})$`).test(host))) && !rule.continue);
}
test('bulk requests and MCP bypass functions; only organization switching uses a function', () => {
  const config = createVercelRoutes('growth', options);
  for (const path of ['/api/social/media', '/api/social/media/upload', '/api/whatsapp/realtime', '/mcp', '/v1/operations', '/oauth/token']) assert.equal(route(config, path, 'POST').dest, 'https://backend.example$1');
  assert.equal(route(config, '/api/orgs/set-active', 'POST').dest, '/_hosting/org-switch');
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
    assert.deepEqual(rule.transforms.filter(item => item.target.key === 'x-kasitek-tenant-host'), [{ type: 'request.headers', op: 'delete', target: { key: 'x-kasitek-tenant-host' } }]);
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
});
test('packaged org-switch handler preserves browser Host, cookies and body through the existing proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vercel-org-switch-'));
  const upstream = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['kasitek_active_org=org; Path=/; HttpOnly'] });
    response.end(JSON.stringify({ url: request.url, host: request.headers.host, forwarded: request.headers['x-forwarded-host'], origin: request.headers.origin, cookie: request.headers.cookie, body }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const oldApi = process.env.CORE_API_BASE_URL, oldFrontend = process.env.FRONTEND_URL;
  process.env.CORE_API_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.FRONTEND_URL = options.frontendOrigin;
  let frontend;
  try {
    await mkdir(join(directory, 'scripts'));
    for (const file of ['serve.mjs', 'route-contract.json']) await cp(new URL(`../../products/growth/web/scripts/${file}`, import.meta.url), join(directory, 'scripts', file));
    await cp(new URL('./org-switch.mjs', import.meta.url), join(directory, 'index.mjs'));
    const { default: handler } = await import(pathToFileURL(join(directory, 'index.mjs')));
    frontend = http.createServer(handler);
    await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${frontend.address().port}`;
    const response = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/api/orgs/set-active`, { method: 'POST', headers: { host: 'app.example', origin: options.frontendOrigin, cookie: 'kasitek_session=fixture', 'content-type': 'application/json', 'x-forwarded-host': 'spoof.example' } }, async response => {
        let body = ''; for await (const chunk of response) body += chunk;
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
      request.on('error', reject); request.end('{"orgId":"org"}');
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['set-cookie'][0], /kasitek_active_org=org/);
    assert.deepEqual(JSON.parse(response.body), { url: '/api/orgs/set-active', host: 'app.example', forwarded: 'app.example', origin: options.frontendOrigin, cookie: 'kasitek_session=fixture', body: '{"orgId":"org"}' });
    assert.equal((await fetch(`${base}/api/social/media`, { method: 'POST', body: 'x' })).status, 404);
  } finally {
    if (oldApi === undefined) delete process.env.CORE_API_BASE_URL; else process.env.CORE_API_BASE_URL = oldApi;
    if (oldFrontend === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = oldFrontend;
    if (frontend) await new Promise(resolve => frontend.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
