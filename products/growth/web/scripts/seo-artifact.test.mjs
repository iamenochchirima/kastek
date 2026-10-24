import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const root = new URL('../build/client/', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');

test('landing has meaningful prerendered HTML, canonical metadata and public indexing', () => {
  assert.match(html, /<title>Growth \| KasiTek<\/title>/);
  assert.match(html, /<h1[^>]*>Stay close to<br\s*\/?>your customers\.<\/h1>/);
  assert.match(html, /rel="canonical" href="https:\/\/growth.kasitek.co.za\/"/);
  assert.match(html, /name="robots" content="index, follow"/);
  assert.doesNotMatch(html, /name="robots" content="noindex/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /href="\/signup"/);
});
test('SPA fallback is separate, private and contains no user or business bootstrap', async () => {
  const fallback = await readFile(new URL('__spa-fallback.html', root), 'utf8');
  assert.match(fallback, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(fallback, /emailVerified|accessToken|kasitek_session|Fixture user/);
});
test('sitemap contains only the public canonical and public HTML excludes private scripts', async () => {
  const sitemap = await readFile(new URL('sitemap.xml', root), 'utf8');
  assert.equal((sitemap.match(/<loc>/g) ?? []).length, 1);
  assert.match(sitemap, /https:\/\/growth.kasitek.co.za\//);
  assert.doesNotMatch(html, /src="[^"\s]*(?:twilio|inbox-page|posts-workspace)/);
});
test('browser artifacts contain no database runtime, secret material or published source maps', async () => {
  let count = 0;
  for (const file of await readdir(new URL('assets/', root))) {
    assert.equal(file.endsWith('.map'), false, 'Source maps must not be published');
    if (!file.endsWith('.js')) continue;
    count++;
    const source = await readFile(new URL(`assets/${file}`, root), 'utf8');
    assert.equal(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@|sk-or-v1-[a-f0-9]{32,}|PrismaClientInitializationError/.test(source), false, `Private runtime or credential material in ${file}`);
  }
  assert.ok(count > 20, 'Expected real route-split application artifacts');
});
