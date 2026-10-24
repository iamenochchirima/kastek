import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '../../..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sampleCount = Number(option('--samples', '5'));
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 10) throw Error('--samples must be between 1 and 10');
const targets = option('--targets', 'next,vite').split(',');
if (targets.some(target => !['next', 'vite'].includes(target))) throw Error('--targets supports next,vite');
const output = resolve(option('--output', join(repoRoot, '.audit/growth-vite/performance.json')));
const fixturePort = Number(option('--fixture-port', '54410'));
const fixture = `http://127.0.0.1:${fixturePort}`;
const allRoutes = ['/', '/login', '/agents', '/inbox', '/content/posts'];
const routes = option('--routes', allRoutes.join(',')).split(',');
if (routes.some(route => !allRoutes.includes(route))) throw Error('--routes must select known measurement routes');
const settings = { viewport: { width: 1440, height: 900 }, cpuSlowdown: 4, network: { latency: 50, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 }, samples: sampleCount, serviceWorkers: 'block', settleMilliseconds: 500, readinessTimeoutMilliseconds: 12_000 };
const children = [];
const report = {
  generatedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  methodology: 'Local Chromium lab measurements against one synthetic API fixture. Each cold sample uses a new browser context, and its paired warm sample repeats document navigation in the same context. These are full document navigations, not client-side route transitions. Data-ready time waits for a route heading or primary agent action; failed or redirected routes are not success evidence. No evaluations, model calls, external providers, field percentiles, or production scalability claims.',
  settings, targets: {},
};
try { const existing = JSON.parse(await readFile(output, 'utf8')); report.targets = existing.targets ?? {}; } catch (error) { if (error.code !== 'ENOENT') throw error; }
async function save() { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
function run(command, args, env = {}) {
  const child = spawn(command, args, { cwd: webRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Bound retained diagnostics and never copy request URLs or environment values into the report.
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
  child.stdout.resume();
  children.push(child);
  return { child, getDiagnostics: () => diagnostics };
}
async function stop(child) { if (child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 6000); timer.unref(); })]); }
async function wait(url, serverProcess) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverProcess.child.exitCode !== null) throw Error('Server exited before readiness');
    try { const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.status < 500) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Server readiness timed out');
}
function median(values) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function summarize(samples) {
  const summary = {};
  for (const route of allRoutes) {
    summary[route] = {};
    for (const cache of ['cold', 'warm']) {
      const rows = samples.filter(sample => sample.route === route && sample.cache === cache);
      const passed = rows.filter(row => row.ready && !row.runtimeErrors.length && row.status < 400);
      summary[route][cache] = { measured: rows.length, successful: passed.length, finalPaths: [...new Set(rows.map(row => row.finalPath))], medians: Object.fromEntries(['navigationMs', 'dataReadyMs', 'jsTransferBytes', 'requestCount', 'apiRequestCount', 'longTaskMs', 'cls', 'heapUsedBytes', 'lcpMs'].map(metric => [metric, median(passed.map(row => row[metric]))])) };
    }
  }
  return summary;
}
async function measure(context, origin, route, cache) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...settings.network, connectionType: 'wifi' });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: settings.cpuSlowdown });
  await cdp.send('Performance.enable');
  await page.addInitScript(() => {
    window.__growthMeasurement = { longTaskMs: 0, cls: 0, lcpMs: null };
    for (const [type, apply] of [
      ['longtask', entry => { window.__growthMeasurement.longTaskMs += entry.duration; }],
      ['layout-shift', entry => { if (!entry.hadRecentInput) window.__growthMeasurement.cls += entry.value; }],
      ['largest-contentful-paint', entry => { window.__growthMeasurement.lcpMs = entry.startTime; }],
    ]) try { new PerformanceObserver(list => list.getEntries().forEach(apply)).observe({ type, buffered: true }); } catch {}
  });
  const errors = [];
  const failedResponses = [];
  const requests = new Map();
  const requestTypes = new Map();
  let bytes = 0;
  cdp.on('Network.requestWillBeSent', ({ requestId, request, type }) => { requests.set(requestId, request.url); requestTypes.set(requestId, type); });
  cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => { if (requestTypes.get(requestId) === 'Script') bytes += encodedDataLength; });
  page.on('pageerror', error => errors.push(error.name + ': ' + error.message.slice(0, 200)));
  page.on('response', response => { if (response.status() >= 400) { const url = new URL(response.url()); failedResponses.push({ path: url.pathname, status: response.status() }); } });
  let status = null;
  let ready = false;
  let failure = null;
  const start = performance.now();
  try {
    const response = await page.goto(origin + route, { waitUntil: 'load', timeout: settings.readinessTimeoutMilliseconds });
    status = response?.status() ?? null;
    const locator = route === '/agents' ? page.getByRole('button', { name: 'New conversation', exact: true }) : route === '/inbox' ? page.getByRole('heading', { name: 'Inbox', exact: true }) : route === '/content/posts' ? page.getByRole('heading', { name: 'Posts', exact: true }) : page.locator('h1').first();
    if (status >= 400 || errors.length) throw Error('Route failed before readiness');
    await Promise.race([
      locator.waitFor({ state: 'visible', timeout: settings.readinessTimeoutMilliseconds }),
      page.getByRole('heading', { name: /We couldn.t load this page|Unexpected Application Error|Unable to load workspace/ }).waitFor({ state: 'visible', timeout: settings.readinessTimeoutMilliseconds }).then(() => { throw Error('Fixture route rendered an error view'); }),
    ]);
    ready = true;
  } catch (error) { failure = error.name === 'TimeoutError' ? error.name : error.message.slice(0, 200); }
  const dataReadyMs = performance.now() - start;
  await page.waitForTimeout(settings.settleMilliseconds);
  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    return { navigationMs: navigation?.loadEventEnd ?? null, ...window.__growthMeasurement };
  }).catch(() => ({}));
  const { metrics: processMetrics } = await cdp.send('Performance.getMetrics');
  const result = { route, cache, status, ready, failure, finalPath: new URL(page.url()).pathname, dataReadyMs, ...metrics, jsTransferBytes: bytes, requestCount: requests.size, apiRequestCount: [...requests.values()].filter(url => { try { return new URL(url).pathname.startsWith('/api/'); } catch { return false; } }).length, heapUsedBytes: processMetrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null, runtimeErrors: errors, failedResponses, observedHeadings: await page.locator('h1,h2').allTextContents() };
  await page.close();
  return result;
}

let browser;
try {
  const api = run(process.execPath, ['e2e/fixtures/growth-agents-api.mjs'], { GROWTH_AGENTS_FIXTURE_API_PORT: String(fixturePort), GROWTH_AGENTS_FIXTURE_REQUIRE_SESSION: '1', GROWTH_WEB_ORIGIN: 'http://127.0.0.1:3411' });
  await wait(fixture + '/__fixture/attempts', api);
  const fixtureCheck = await (await fetch(fixture + '/__fixture/attempts')).json();
  if (!Array.isArray(fixtureCheck.attempts)) throw Error('Fixture port is occupied by a different service');
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  report.fixture = { sourceSha256: createHash('sha256').update(await readFile(join(webRoot, 'e2e/fixtures/growth-agents-api.mjs'))).digest('hex'), note: 'Authenticated synthetic business, no external provider calls. The fixture can omit other feature-specific data; missing or erroneous cases are reported separately.' };
  for (const target of targets) {
    const port = target === 'next' ? 3410 : 3411;
    const origin = `http://127.0.0.1:${port}`;
    let baselineRecord = null;
    try { baselineRecord = JSON.parse(await readFile(join(repoRoot, '.audit/growth-vite/baseline-build.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const baselineCommit = option('--baseline-commit', baselineRecord?.source ?? null);
    const artifact = target === 'next' ? { sourceCommit: baselineCommit ? execFileSync('git', ['rev-parse', baselineCommit], { cwd: repoRoot, encoding: 'utf8' }).trim() : null, sourceCaveat: 'Retained build source comes from --baseline-commit or the local baseline-build.json record. Parallel API/PWA edits may have been present; this is not a pristine release artifact.', buildId: (await readFile(join(webRoot, '.next/BUILD_ID'), 'utf8')).trim(), manifestSha256: createHash('sha256').update(await readFile(join(webRoot, '.next/build-manifest.json'))).digest('hex') } : { rootHtmlSha256: createHash('sha256').update(await readFile(join(webRoot, 'build/client/index.html'))).digest('hex') };
    const serverProcess = run(process.execPath, target === 'next' ? [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)] : ['scripts/serve.mjs', '--hostname', '127.0.0.1', '--port', String(port)], { CORE_API_BASE_URL: fixture, NEXT_PUBLIC_API_BASE_URL: fixture, GROWTH_WEB_ORIGIN: origin, FRONTEND_URL: origin, NODE_ENV: 'production' });
    try {
      await wait(origin + '/login', serverProcess);
      const previous = report.targets[target];
      const sameArtifact = previous?.artifact && (target === 'next' ? previous.artifact.buildId === artifact.buildId : previous.artifact.rootHtmlSha256 === artifact.rootHtmlSha256);
      const samples = routes.length < allRoutes.length && sameArtifact ? previous.samples.filter(sample => !routes.includes(sample.route)) : [];
      report.targets[target] = { capturedAt: new Date().toISOString(), artifact, samples, summary: {} };
      for (const route of routes) {
        for (let sample = 0; sample < sampleCount; sample++) {
          const context = await browser.newContext({ viewport: settings.viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
          await context.addCookies([{ name: 'kasitek_active_org', value: 'growth-fixture-one', domain: '127.0.0.1', path: '/' }, ...(['/', '/login'].includes(route) ? [] : [{ name: 'kasitek_session', value: 'fixture-session', domain: '127.0.0.1', path: '/' }])]);
          try {
            for (const cache of ['cold', 'warm']) {
              samples.push({ capturedAt: new Date().toISOString(), fixtureSha256: report.fixture.sourceSha256, sample: sample + 1, ...await measure(context, origin, route, cache) });
              report.targets[target].summary = summarize(samples);
              await save();
            }
          } finally { await context.close(); }
        }
        process.stdout.write(`${target}: ${route} measured ${sampleCount} cold and ${sampleCount} warm samples\n`);
      }
    } catch (error) {
      report.targets[target] = { ...report.targets[target], captureFailure: error.message };
      await save();
      throw error;
    } finally { await stop(serverProcess.child); }
  }
  report.comparison = {};
  if (report.targets.next?.summary && report.targets.vite?.summary) for (const route of allRoutes) {
    report.comparison[route] = {};
    for (const cache of ['cold', 'warm']) {
      const before = report.targets.next.summary[route][cache];
      const after = report.targets.vite.summary[route][cache];
      const comparable = route !== '/' && before.successful === sampleCount && after.successful === sampleCount && JSON.stringify(before.finalPaths) === JSON.stringify(after.finalPaths) && before.finalPaths.length === 1 && before.finalPaths[0] === route;
      report.comparison[route][cache] = { comparable, reason: comparable ? 'Matched route and successful fixture samples; lab medians only.' : 'Changed landing-page content, missing successful fixture samples, or different final route. No performance conclusion.', percentChange: comparable ? Object.fromEntries(Object.keys(before.medians).map(metric => [metric, before.medians[metric] > 0 && after.medians[metric] !== null ? 100 * (after.medians[metric] - before.medians[metric]) / before.medians[metric] : null])) : null };
    }
  }
  await save();
  process.stdout.write(`Saved bounded lab evidence to ${output}\n`);
} finally {
  await browser?.close();
  await Promise.all(children.map(stop));
}
