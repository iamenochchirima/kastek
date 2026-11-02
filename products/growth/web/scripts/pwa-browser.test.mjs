import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { createGrowthServer } from './serve.mjs';
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'growth-worker-browser-'));
  await cp(resolve('build/client'), root, { recursive: true });
  const upstream = http.createServer((_request, response) => { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":"Unauthorized"}'); });
  const server = createGrowthServer({ root, upstream: await listen(upstream) });
  const origin = await listen(server);
  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  await context.addInitScript(() => sessionStorage.setItem('page-loads', String(Number(sessionStorage.getItem('page-loads') || 0) + 1)));
  const page = await context.newPage();
  return { root, context, page, origin, async cleanup() { await browser.close(); await close(server); await close(upstream); await rm(root, { recursive: true, force: true }); } };
}
test('built app first worker install keeps the page intact and private navigation offline', { timeout: 30000 }, async () => {
  const app = await fixture();
  try {
    await app.page.goto(app.origin);
    await app.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.equal(await app.page.evaluate(() => sessionStorage.getItem('page-loads')), '1');
    const manifest = await (await app.page.request.get(app.origin + '/manifest.webmanifest')).json();
    assert.equal(manifest.scope, '/'); assert.equal(manifest.start_url, '/');
    await app.context.setOffline(true);
    await app.page.goto(app.origin + '/agents');
    await app.page.getByRole('heading', { name: /offline/i }).waitFor();
    assert.doesNotMatch(await app.page.content(), /Fixture user|private-sentinel/);
  } finally { await app.cleanup(); }
});
test('installed legacy worker waits for acceptance and removes only Growth caches', { timeout: 40000 }, async () => {
  const app = await fixture();
  try {
    const worker = await readFile(join(app.root, 'sw.js'), 'utf8');
    await writeFile(join(app.root, 'sw.js'), `self.addEventListener('install', event => event.waitUntil((async () => { const cache = await caches.open('kasitek-pwa-v1-pages'); await cache.put('/agents', new Response('private-sentinel')); await caches.open('unrelated-product-cache'); await self.skipWaiting(); })())); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));`);
    await app.page.goto(app.origin);
    await app.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await writeFile(join(app.root, 'sw.js'), worker);
    await app.page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; await registration.update(); });
    await expect.poll(() => app.page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
    assert.equal(await app.page.evaluate(() => sessionStorage.getItem('page-loads')), '1');
    await app.page.evaluate(() => window.dispatchEvent(new Event('kasitek:apply-pwa-update')));
    await app.page.waitForFunction(() => Number(sessionStorage.getItem('page-loads')) === 2, null, { timeout: 5000 });
    await app.page.waitForLoadState('load');
    assert.equal(await app.page.evaluate(() => sessionStorage.getItem('page-loads')), '2');
    assert.equal(await app.page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)), false);
    const keys = await app.page.evaluate(() => caches.keys());
    assert.equal(keys.includes('kasitek-pwa-v1-pages'), false); assert.equal(keys.includes('unrelated-product-cache'), true);
    await app.context.setOffline(true);
    await app.page.goto(app.origin + '/agents');
    await app.page.getByRole('heading', { name: /offline/i }).waitFor();
    assert.doesNotMatch(await app.page.content(), /private-sentinel/);
  } finally { await app.cleanup(); }
});
