import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
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

test('same-origin MCP, OAuth discovery and REST proxy to Core while consent remains a page', async () => {
  const received = [];
  const app = await fixture((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ proxied: request.url }));
  });
  try {
    for (const path of ['/mcp','/v1/operations','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server','/oauth/authorize?state=preserved','/oauth/token','/oauth/register','/oauth/revoke']) {
      const response = await raw(app.origin, path, { authorization: 'Bearer fixture' }, path === '/mcp' ? 'POST' : 'GET');
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body.toString()).proxied, path);
      assert.equal(received.at(-1).authorization, 'Bearer fixture');
    }
    const count = received.length;
    assert.match((await raw(app.origin, '/oauth/consent?request=fixture')).body.toString(), /App/);
    assert.equal(received.length, count);
    assert.equal((await raw(app.origin, '/oauth/unknown')).status, 404);
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

test('retained builds provide only missing hashed assets and cannot replace current documents or files', async () => {
  const retained = await mkdtemp(join(tmpdir(), 'growth-retained-'));
  await mkdir(join(retained, 'assets'));
  await writeFile(join(retained, 'assets/app-12345678.js'), 'old-overlap');
  await writeFile(join(retained, 'assets/older-abcdefgh.js'), 'old-chunk');
  await writeFile(join(retained, 'assets/unhashed.js'), 'old-unhashed');
  await writeFile(join(retained, 'index.html'), 'old-document');
  await writeFile(join(retained, 'old.html'), 'old-document');
  const secret = join(retained, 'outside.js');
  await writeFile(secret, 'secret');
  const app = await fixture(undefined, { previousAssetRoots: [retained, join(retained, 'missing-directory')] });
  await symlink(secret, join(app.root, 'assets/leak-abcdefgh.js'));
  // An archive symlink can point outside its root as well.
  await symlink(join(app.root, 'index.html'), join(retained, 'assets/leak-ijklmnop.js'));
  try {
    assert.equal((await raw(app.origin, '/assets/app-12345678.js')).body.toString(), 'export{}');
    const old = await raw(app.origin, '/assets/older-abcdefgh.js');
    assert.equal(old.body.toString(), 'old-chunk');
    assert.equal(old.headers['cache-control'], 'public, max-age=31536000, immutable');
    for (const path of ['/assets/unhashed-old.js', '/assets/leak-abcdefgh.js', '/assets/leak-ijklmnop.js', '/old.html']) assert.equal((await raw(app.origin, path)).status, 404, path);
    await writeFile(join(retained, 'assets/unhashed-old.js'), 'not-a-hash');
    assert.equal((await raw(app.origin, '/assets/unhashed-old.js')).status, 404);
    assert.equal((await raw(app.origin, '/')).body.toString(), '<h1>Growth landing</h1>');
    assert.equal((await raw(app.origin, '/agents')).body.toString(), '<div>App</div>');
    assert.equal((await raw(app.origin, '/api/old')).body.toString(), 'api');
    assert.equal((await raw(app.origin, '/assets/%2e%2e/index.html')).status, 400);
  } finally { await app.cleanup(); await rm(retained, { recursive: true, force: true }); }
});

test('legacy Next static archive serves browser files only and blocks server artifacts and escaping links', async () => {
  const retained = await mkdtemp(join(tmpdir(), 'growth-next-static-'));
  await mkdir(join(retained, 'chunks'));
  await mkdir(join(retained, 'css'));
  await mkdir(join(retained, 'server'));
  await writeFile(join(retained, 'chunks/runtime-12345678.js'), 'retained-next');
  await writeFile(join(retained, 'chunks/runtime-12345678.js.map'), 'source');
  await writeFile(join(retained, 'chunks/source.ts'), 'source');
  await writeFile(join(retained, 'css/12345678abcdefab.css'), 'body{}');
  await writeFile(join(retained, 'server/private.js'), 'private');
  const app = await fixture(undefined, { legacyNextStaticRoot: retained });
  await symlink(join(app.root, 'index.html'), join(retained, 'chunks/escape-12345678.js'));
  try {
    const old = await raw(app.origin, '/_next/static/chunks/runtime-12345678.js');
    assert.equal(old.status, 200);
    assert.equal(old.body.toString(), 'retained-next');
    assert.equal(old.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await raw(app.origin, '/_next/static/css/12345678abcdefab.css')).headers['cache-control'], 'public, max-age=31536000, immutable');
    for (const path of ['/_next/static/server/private.js', '/_next/static/chunks/runtime-12345678.js.map', '/_next/static/chunks/source.ts', '/_next/static/chunks/escape-12345678.js', '/_next/server/private.js', '/_next/static/missing.js']) assert.equal((await raw(app.origin, path)).status, 404, path);
  } finally { await app.cleanup(); await rm(retained, { recursive: true, force: true }); }
});

test('session-bearing HTML is never shared-cacheable and archive configuration fails closed', async () => {
  const app = await fixture();
  try {
    for (const path of ['/', '/index.html']) assert.equal((await raw(app.origin, path, { cookie: 'kasitek_session=fixture' })).headers['cache-control'], 'no-store');
    assert.throws(() => createGrowthServer({ previousAssetRoots: 'not-json' }), /JSON array/);
    assert.throws(() => createGrowthServer({ previousAssetRoots: ['relative/build'] }), /absolute directories/);
    assert.throws(() => createGrowthServer({ legacyNextStaticRoot: 'relative/static' }), /absolute static directory/);
  } finally { await app.cleanup(); }
});


test('text compression negotiates gzip and Brotli with representation-specific ETags and HEAD metadata', async () => {
  const app = await fixture();
  const text = 'const value = "compress this text";\n'.repeat(200);
  await writeFile(join(app.root, 'assets/large-12345678.js'), text);
  await writeFile(join(app.root, 'assets/font-12345678.woff2'), Buffer.alloc(4096, 1));
  try {
    const path = '/assets/large-12345678.js';
    const plain = await raw(app.origin, path);
    const gzip = await raw(app.origin, path, { 'accept-encoding': 'gzip' });
    const br = await raw(app.origin, path, { 'accept-encoding': 'gzip;q=0.5, br;q=1' });
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(gunzipSync(gzip.body).toString(), text);
    assert.equal(brotliDecompressSync(br.body).toString(), text);
    assert.ok(gzip.body.length < plain.body.length);
    assert.equal(gzip.headers['content-length'], undefined);
    assert.equal(plain.headers['content-length'], String(Buffer.byteLength(text)));
    assert.equal(gzip.headers.vary, 'Accept-Encoding');
    assert.equal(plain.headers.vary, 'Accept-Encoding');
    assert.notEqual(gzip.headers.etag, br.headers.etag);
    assert.notEqual(plain.headers.etag, gzip.headers.etag);
    assert.equal((await raw(app.origin, path, { 'accept-encoding': 'gzip;q=0, br;q=0' })).headers['content-encoding'], undefined);
    assert.equal((await raw(app.origin, path, { 'accept-encoding': 'br;q=0, gzip;q=1' })).headers['content-encoding'], 'gzip');
    assert.equal((await raw(app.origin, path, { 'accept-encoding': 'identity;q=1, gzip;q=0.1' })).headers['content-encoding'], undefined);
    assert.equal((await raw(app.origin, path, { 'accept-encoding': 'identity;q=0, *;q=0' })).status, 406);
    const head = await raw(app.origin, path, { 'accept-encoding': 'br' }, 'HEAD');
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-encoding'], 'br');
    assert.equal(head.headers['content-length'], undefined);
    assert.equal(head.headers.etag, br.headers.etag);
    const notModified = await raw(app.origin, path, { 'accept-encoding': 'gzip', 'if-none-match': gzip.headers.etag });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.headers.vary, 'Accept-Encoding');
    assert.equal(notModified.body.length, 0);
    assert.equal((await raw(app.origin, path, { 'accept-encoding': 'br', 'if-none-match': gzip.headers.etag })).status, 200);
    assert.equal((await raw(app.origin, '/assets/font-12345678.woff2', { 'accept-encoding': 'br,gzip' })).headers['content-encoding'], undefined);
    assert.equal((await raw(app.origin, '/sw.js', { 'accept-encoding': 'br,gzip' })).headers['content-encoding'], undefined);
  } finally { await app.cleanup(); }
});


test('aborting compressed static transfers closes the stream and leaves the server available', { timeout: 10000 }, async () => {
  const app = await fixture();
  // Incompressible source keeps both compressed transfers open until the client disconnects.
  await writeFile(join(app.root, 'assets/abort-12345678.js'), randomBytes(2 * 1024 * 1024).toString('hex'));
  try {
    for (const encoding of ['gzip', 'br']) {
      const serverClosed = new Promise(resolve => {
        app.server.once('request', (_request, response) => {
          response.once('close', () => resolve({ sent: response.headersSent, finished: response.writableFinished }));
        });
      });
      await new Promise((resolve, reject) => {
        const request = http.get(`${app.origin}/assets/abort-12345678.js`, { headers: { 'accept-encoding': encoding } }, response => {
          response.on('error', reject);
          response.once('data', chunk => {
            try {
              assert.equal(response.statusCode, 200);
              assert.equal(response.headers['content-encoding'], encoding);
              assert.ok(chunk.length > 0);
              response.destroy();
              resolve();
            } catch (error) { reject(error); }
          });
        });
        request.on('error', reject);
      });
      assert.deepEqual(await serverClosed, { sent: true, finished: false });
      assert.equal((await raw(app.origin, '/__health')).body.toString(), 'ok');
      assert.match((await raw(app.origin, '/')).body.toString(), /Growth landing/);
    }
  } finally { await app.cleanup(); }
});

test('a response completed during asynchronous static lookup is not written a second time', { timeout: 5000 }, async () => {
  const app = await fixture();
  try {
    // HTTP request listeners run before the pending filesystem lookup resumes.
    app.server.once('request', (_request, response) => response.end('Already handled'));
    assert.equal((await raw(app.origin, '/assets/app-12345678.js')).body.toString(), 'Already handled');
    assert.equal((await raw(app.origin, '/__health')).body.toString(), 'ok');
    assert.equal((await raw(app.origin, '/assets/app-12345678.js')).body.toString(), 'export{}');
  } finally { await app.cleanup(); }
});

test('a static error after headers are flushed closes that response without crashing the server', { timeout: 5000 }, async () => {
  const app = await fixture();
  try {
    app.server.once('request', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.flushHeaders();
    });
    await assert.rejects(raw(app.origin, '/assets/app-12345678.js'), /aborted|socket hang up/);
    assert.equal((await raw(app.origin, '/__health')).body.toString(), 'ok');
    assert.equal((await raw(app.origin, '/assets/app-12345678.js')).body.toString(), 'export{}');
  } finally { await app.cleanup(); }
});
