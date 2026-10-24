import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await readFile(join(webRoot, 'scripts/route-contract.json'), 'utf8'));
const routes = contract.routes.map(({ path }) => new RegExp(`^${path.split('/').map(part => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}/*$`));
const redirects = new Map([
  ['about', '/about'], ['data-deletion', '/data-deletion'], ['demo', '/demo'], ['get-quote', '/get-quote'],
  ['meta-business-platform', '/meta-business-platform'], ['pricing', '/pricing'], ['pricing1', '/pricing'],
  ['privacy-policy', '/privacy-policy'], ['terms', '/terms'], ['waitlist', '/waitlist'], ['early-access', '/early-access'], ['fliers', ''], ['solutions', ''],
]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.map': 'application/json' };
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function end(response, status, message) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(message);
}
function cleanHeaders(headers) {
  const excluded = new Set([...hopHeaders, ...String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

const assetExtensions = new Set(['.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.wasm']);
function previousRoots(value) {
  let roots;
  try { roots = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw Error('GROWTH_PREVIOUS_ASSET_ROOTS must be a JSON array of absolute directories'); }
  if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !isAbsolute(root))) throw Error('GROWTH_PREVIOUS_ASSET_ROOTS must be a JSON array of absolute directories');
  return roots;
}
function hashedAsset(path) {
  return assetExtensions.has(extname(path)) && (/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path) || /(?:^|\/)[a-f0-9]{8,}[.-]/.test(path));
}
async function locateFile(root, relative) {
  try {
    const rootPath = await realpath(root);
    const filename = await realpath(resolve(rootPath, relative));
    if (!filename.startsWith(rootPath + sep)) return null;
    const file = await stat(filename);
    return file.isFile() ? { filename, file } : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

export function createGrowthServer({ root = join(webRoot, 'build/client'), upstream = process.env.CORE_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000', canonicalOrigin = process.env.GROWTH_CANONICAL_ORIGIN ?? 'https://growth.kasitek.co.za', frontendOrigin = process.env.FRONTEND_URL ?? 'http://localhost:3000', environment = process.env.NODE_ENV ?? 'production', headersTimeout = 120_000, previousAssetRoots = process.env.GROWTH_PREVIOUS_ASSET_ROOTS ?? '[]', legacyNextStaticRoot = process.env.GROWTH_LEGACY_NEXT_STATIC_ROOT } = {}) {
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw Error('CORE_API_BASE_URL must be an HTTP(S) origin');
  const frontend = new URL(frontendOrigin);
  const canonical = new URL(canonicalOrigin);
  const resolvedRoot = resolve(root);
  const retainedRoots = previousRoots(previousAssetRoots);
  if (legacyNextStaticRoot && !isAbsolute(legacyNextStaticRoot)) throw Error('GROWTH_LEGACY_NEXT_STATIC_ROOT must be an absolute static directory');
  const server = http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    if (process.env.GROWTH_CONTENT_SECURITY_POLICY) response.setHeader('content-security-policy', process.env.GROWTH_CONTENT_SECURITY_POLICY);
    if (request.headers.host !== canonical.host || process.env.GROWTH_NOINDEX === '1') response.setHeader('x-robots-tag', 'noindex, nofollow');
    const rawPath = request.url ?? '/';
    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return end(response, 400, 'Invalid request');
    const encodedPath = rawPath.split('?', 1)[0];
    let path;
    try {
      path = decodeURIComponent(encodedPath);
      if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')) return end(response, 400, 'Invalid path');
    } catch { return end(response, 400, 'Invalid path'); }
    if (path === '/api' || path.startsWith('/api/')) {
      const headers = cleanHeaders(request.headers);
      // Forward the browser Host for Core's exact-origin cookie mutation checks.
      headers.host = request.headers.host;
      delete headers.forwarded;
      for (const name of Object.keys(headers)) if (name.startsWith('x-forwarded-')) delete headers[name];
      headers['x-forwarded-host'] = request.headers.host;
      headers['x-forwarded-proto'] = frontend.protocol.slice(0, -1);
      headers['x-forwarded-for'] = request.socket.remoteAddress;
      const outgoing = (target.protocol === 'https:' ? https : http).request(target, { method: request.method, path: rawPath, headers }, incoming => {
        clearTimeout(deadline);
        const forwarded = cleanHeaders(incoming.headers);
        forwarded['cache-control'] = 'no-store';
        response.writeHead(incoming.statusCode ?? 502, forwarded);
        response.flushHeaders();
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      const deadline = setTimeout(() => outgoing.destroy(Error('Upstream response timeout')), headersTimeout);
      deadline.unref();
      outgoing.on('error', () => {
        clearTimeout(deadline);
        if (!response.headersSent) end(response, 503, 'Service unavailable');
        else response.destroy();
      });
      request.on('aborted', () => outgoing.destroy());
      response.on('close', () => { clearTimeout(deadline); if (!response.writableFinished) outgoing.destroy(); });
      request.pipe(outgoing);
      return;
    }
    if (path === '/__health') return end(response, 200, 'ok');
    const normalized = path.replace(/^\/|\/$/g, '');
    if (redirects.has(normalized) || normalized.startsWith('solutions/')) {
      const suffix = rawPath.includes('?') ? rawPath.slice(rawPath.indexOf('?')) : '';
      response.writeHead(308, { location: `https://kasitek.co.za${redirects.get(normalized) ?? ''}${suffix}`, 'cache-control': 'public, max-age=3600' });
      return response.end();
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) return end(response, 405, 'Method not allowed');
    if (path.replace(/\/+$/, '') === '/analytics/playground' && environment !== 'development') return end(response, 404, 'Not found');
    try {
      // Archives provide static assets only, never old documents or API responses.
      if (path.split('/').some(part => part.startsWith('.')) || path.endsWith('.map') || path === '/__spa-fallback.html') return end(response, 404, 'Not found');
      const legacyPath = path.startsWith('/_next/static/');
      if (legacyPath && (!assetExtensions.has(extname(path)) || !/^\/_next\/static\/(?:chunks\/|css\/|media\/|[^/]+\/_(?:build|ssg)Manifest\.js$)/.test(path))) return end(response, 404, 'Not found');
      let located = await locateFile(resolvedRoot, path === '/' ? 'index.html' : path.slice(1));
      if (!located && path.startsWith('/assets/') && hashedAsset(path)) {
        for (const retainedRoot of retainedRoots) {
          located = await locateFile(retainedRoot, path.slice(1));
          if (located) break;
        }
      }
      if (!located && legacyPath && legacyNextStaticRoot) located = await locateFile(legacyNextStaticRoot, path.slice('/_next/static/'.length));
      if (!located && !legacyPath && path !== '/' && routes.some(route => route.test(path))) {
        located = await locateFile(resolvedRoot, '__spa-fallback.html');
        response.setHeader('x-robots-tag', 'noindex, nofollow');
      }
      if (!located) return end(response, 404, 'Not found');
      const { filename, file } = located;
      const extension = extname(filename);
      const immutable = (path.startsWith('/assets/') || legacyPath) && hashedAsset(path);
      response.setHeader('content-type', types[extension] ?? 'application/octet-stream');
      response.setHeader('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
      if (filename.endsWith('__spa-fallback.html') || (extension === '.html' && /(?:^|;\s*)kasitek_session=[^;]+/.test(request.headers.cookie ?? ''))) response.setHeader('cache-control', 'no-store');
      if (path === '/sw.js') response.setHeader('service-worker-allowed', '/');
      const etag = `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}"`;
      response.setHeader('etag', etag);
      response.setHeader('last-modified', file.mtime.toUTCString());
      if (request.headers['if-none-match'] === etag) { response.writeHead(304); return response.end(); }
      response.setHeader('content-length', file.size);
      response.writeHead(200);
      if (request.method === 'HEAD') return response.end();
      createReadStream(filename).on('error', () => response.destroy()).pipe(response);
    } catch (error) { end(response, ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 503, ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'Not found' : 'Service unavailable'); }
  });
  server.requestTimeout = 0;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const port = Number(value('--port', value('-p', process.env.PORT ?? '3000')));
  const hostname = value('--hostname', value('-H', process.env.HOST ?? '0.0.0.0'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port');
  const server = createGrowthServer();
  server.listen(port, hostname, () => process.stdout.write(`Growth listening on ${hostname}:${server.address().port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref(); });
}
