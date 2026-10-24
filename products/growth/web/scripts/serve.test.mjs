import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createGrowthServer } from './serve.mjs';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function fixture(callback, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'growth-static-'));
  await mkdir(join(root, 'assets'));
  for (const [path, body] of Object.entries({ 'index.html': '<h1>Growth landing</h1>', '__spa-fallback.html': '<div>App</div>', 'sw.js': '// worker', 'manifest.webmanifest': '{}', 'assets/app-12345678.js': 'export{}', 'assets/unhashed.js': 'export{}' })) await writeFile(join(root, path), body);
  const upstream = http.createServer(callback ?? ((_request, response) => response.end('api')));
  const upstreamUrl = await listen(upstream);
  const server = createGrowthServer({ root, upstream: upstreamUrl, canonicalOrigin: 'https://growth.test', frontendOrigin: 'https://growth.test', ...options });
  const origin = await listen(server);
  return { root, server, upstream, origin, async cleanup() { await close(server); await close(upstream); await rm(root, { recursive: true, force: true }); } };
}
function raw(origin, path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin, { path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('production serves prerendered root, known private routes and accurate missing resource statuses', async () => {
  const app = await fixture();
  try {
    const home = await raw(app.origin, '/', { host: 'growth.test' });
    assert.equal(home.status, 200);
    assert.match(home.body.toString(), /Growth landing/);
    assert.equal(home.headers['x-robots-tag'], undefined);
    const privatePage = await raw(app.origin, '/agents/conversations/abc');
    assert.equal(privatePage.status, 200);
    assert.match(privatePage.body.toString(), /App/);
    assert.equal(privatePage.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(privatePage.headers['cache-control'], 'no-store');
    for (const path of ['/missing', '/assets/missing.js', '/__spa-fallback.html', '/index.html.map', '/analytics/playground', '/analytics/playground/']) assert.equal((await raw(app.origin, path)).status, 404, path);
    assert.equal((await raw(app.origin, '/agents', {}, 'POST')).status, 405);
    assert.equal((await raw(app.origin, '/__health')).body.toString(), 'ok');
  } finally { await app.cleanup(); }
});

test('static cache policies cover assets, worker, HTML, manifest and preview hosts', async () => {
  const app = await fixture();
  try {
    assert.equal((await raw(app.origin, '/assets/app-12345678.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
    for (const path of ['/assets/unhashed.js', '/sw.js', '/manifest.webmanifest', '/']) assert.equal((await raw(app.origin, path)).headers['cache-control'], 'public, max-age=0, must-revalidate');
    const worker = await raw(app.origin, '/sw.js');
    assert.equal(worker.headers['service-worker-allowed'], '/');
    assert.equal((await raw(app.origin, '/sw.js', { 'if-none-match': worker.headers.etag })).status, 304);
    assert.equal(worker.headers['x-content-type-options'], 'nosniff');
    assert.equal((await raw(app.origin, '/')).headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal((await raw(app.origin, '/assets/app-12345678.js', {}, 'HEAD')).body.length, 0);
  } finally { await app.cleanup(); }
});

test('legacy permanent redirects preserve query strings and do not consume invitation routes', async () => {
  const app = await fixture();
  try {
    for (const [path, target] of [['/pricing1?campaign=test', 'https://kasitek.co.za/pricing?campaign=test'], ['/solutions/website', 'https://kasitek.co.za'], ['/fliers', 'https://kasitek.co.za'], ['/privacy-policy', 'https://kasitek.co.za/privacy-policy']]) {
      const response = await raw(app.origin, path);
      assert.equal(response.status, 308);
      assert.equal(response.headers.location, target);
    }
    assert.equal((await raw(app.origin, '/early-access/private-token')).status, 200);
  } finally { await app.cleanup(); }
});

test('forwarding preserves raw URL, method, binary body, public Host, redirects and separate cookies', async () => {
  let received;
  const payload = Buffer.from([0, 255, 33, 0, 254]);
  const app = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
    response.writeHead(307, { location: '/api/next', 'set-cookie': ['one=1; HttpOnly; Path=/', 'two=2; Secure; Path=/'], 'content-type': 'application/octet-stream' });
    response.end(payload);
  });
  try {
    const response = await raw(app.origin, '/api/files/a%2Fb?q=x%20y', { host: 'growth.test', 'content-type': 'application/octet-stream', cookie: 'kasitek_session=secret', origin: 'https://growth.test', 'x-forwarded-for': 'spoof', 'x-forwarded-proto': 'http', forwarded: 'spoof', 'x-kasitek-background': '1' }, 'PATCH', payload);
    assert.equal(response.status, 307);
    assert.equal(response.headers.location, '/api/next');
    assert.equal(response.headers['set-cookie'].length, 2);
    assert.deepEqual(response.body, payload);
    assert.equal(received.method, 'PATCH');
    assert.equal(received.url, '/api/files/a%2Fb?q=x%20y');
    assert.deepEqual(received.body, payload);
    assert.equal(received.headers.host, 'growth.test');
    assert.equal(received.headers.cookie, 'kasitek_session=secret');
    assert.equal(received.headers.origin, 'https://growth.test');
    assert.equal(received.headers['x-kasitek-background'], '1');
    assert.equal(received.headers['x-forwarded-proto'], 'https');
    assert.notEqual(received.headers['x-forwarded-for'], 'spoof');
    assert.equal(received.headers.forwarded, undefined);
  } finally { await app.cleanup(); }
});

test('API missing routes remain upstream responses and auth never becomes cacheable', async () => {
  const app = await fixture((request, response) => {
    response.writeHead(request.url.includes('missing') ? 404 : 200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' });
    response.end('{}');
  });
  try {
    const missing = await raw(app.origin, '/api/missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.toString(), '{}');
    assert.equal((await raw(app.origin, '/api/auth/me')).headers['cache-control'], 'no-store');
  } finally { await app.cleanup(); }
});

test('SSE forwards immediately and client disconnect closes its upstream subscription', async () => {
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const app = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.write('data: ready\n\n');
    response.on('close', disconnected);
  });
  try {
    await new Promise((resolve, reject) => {
      const request = http.get(`${app.origin}/api/realtime/whatsapp`, response => {
        response.once('data', chunk => {
          try { assert.equal(chunk.toString(), 'data: ready\n\n'); response.destroy(); resolve(); } catch (error) { reject(error); }
        });
      });
      request.on('error', reject);
    });
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('SSE upstream was not closed')), 1500))]);
  } finally { await app.cleanup(); }
});

test('static traversal, invalid escapes, hidden files and escaping symlinks are rejected', async () => {
  const app = await fixture();
  const secret = join(app.root, '..', `secret-${process.pid}`);
  await writeFile(secret, 'private');
  await symlink(secret, join(app.root, 'leak.txt'));
  await writeFile(join(app.root, '.env'), 'private');
  try {
    for (const path of ['/leak.txt', '/.env']) assert.equal((await raw(app.origin, path)).status, 404);
    for (const path of ['/%2e%2e/secret', '/%5csecret', '/%00', '/%zz']) assert.equal((await raw(app.origin, path)).status, 400);
  } finally { await app.cleanup(); await rm(secret, { force: true }); }
});

test('upstream connection failure and response timeout return bounded 503', async () => {
  const app = await fixture(() => {}, { headersTimeout: 40 });
  try {
    const timedOut = await raw(app.origin, '/api/auth/callback?code=private');
    assert.equal(timedOut.status, 503);
    assert.equal(timedOut.body.toString(), 'Service unavailable');
    await close(app.upstream);
    assert.equal((await raw(app.origin, '/api/missing')).status, 503);
  } finally { await close(app.server); await rm(app.root, { recursive: true, force: true }); }
});

test('large uploads and attachment download headers pass through without frontend body limits', async () => {
  const payload = Buffer.alloc(6 * 1024 * 1024, 255);
  const app = await fixture(async (request, response) => {
    let size = 0;
    for await (const chunk of request) size += chunk.length;
    response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="contacts.csv"' });
    response.end(String(size));
  });
  try {
    const result = await raw(app.origin, '/api/contacts/import', { 'content-type': 'application/octet-stream' }, 'POST', payload);
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), String(payload.length));
    assert.equal(result.headers['content-disposition'], 'attachment; filename="contacts.csv"');
  } finally { await app.cleanup(); }
});
