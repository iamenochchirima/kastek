import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots = { growth: 'products/growth/web', agents: 'products/agents/web', agency: 'products/agency/web' };
function origin(value, name) {
  if (!value) throw Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error(`${name} must be an HTTPS origin`);
  return url;
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const header = (key, args) => ({ type: 'request.headers', op: args === undefined ? 'delete' : 'set', target: { key }, ...(args === undefined ? {} : { args }) });

export function createVercelRoutes(product, { apiOrigin, frontendOrigin, growthRoutes = [], preview = true, agencyWildcardDomain }) {
  if (!roots[product]) throw Error('Unknown frontend');
  const api = origin(apiOrigin, 'API origin');
  const frontend = origin(frontendOrigin, 'FRONTEND_URL');
  const routes = [{ src: '/.*', headers: { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'cache-control': 'no-store', ...(preview ? { 'x-robots-tag': 'noindex, nofollow' } : {}) }, continue: true }];
  const source = product === 'agency' ? '/api/tenant(?:/(.*))?' : product === 'growth' ? '(/api(?:/.*)?|/v1(?:/.*)?|/mcp|/oauth/(?:authorize|register|token|revoke))' : '(/api(?:/.*)?)';
  const transforms = [header('forwarded'), header('x-kasitek-tenant-host')];
  if (product === 'agency' && agencyWildcardDomain) {
    if (agencyWildcardDomain !== `*.${frontend.hostname}` || frontend.port) throw Error('AGENCY_VERIFIED_WILDCARD_DOMAIN must match the configured frontend host');
    const tenantHost = `[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${escape(frontend.hostname)}`;
    // Bind tenant routing to the matched public host, independent of upstream forwarding headers.
    routes.push({ src: source, dest: `${api.origin}/$1`, has: [{ type: 'host', value: `(?<tenantHost>${tenantHost})` }], transforms: [...transforms, header('x-kasitek-tenant-host', '$tenantHost'), header('x-forwarded-proto', 'https')] });
  }
  if (product === 'agency') transforms.push(header('x-kasitek-tenant-host', frontend.host), header('x-forwarded-proto', 'https'));
  routes.push({ src: source, dest: `${api.origin}${product === 'agency' ? '/$1' : '$1'}`, ...(product === 'agency' ? { has: [{ type: 'host', value: escape(frontend.host) }] } : {}), transforms });
  if (product === 'agency') routes.push({ src: '/api/tenant(?:/.*)?', status: 421 });
  routes.push({ src: '/api(?:/.*)?', status: 404 });
  if (product === 'growth') {
    routes.push({ src: '/analytics/playground/*', status: 404 }, { src: '/__spa-fallback\\.html', status: 404 });
    const redirects = { about: '/about', 'data-deletion': '/data-deletion', demo: '/demo', 'get-quote': '/get-quote', 'meta-business-platform': '/meta-business-platform', pricing: '/pricing', pricing1: '/pricing', 'privacy-policy': '/privacy-policy', terms: '/terms', waitlist: '/waitlist', 'early-access': '/early-access', fliers: '', solutions: '' };
    for (const [from, to] of Object.entries(redirects)) routes.push({ src: `/${from}/*`, status: 308, headers: { Location: `https://kasitek.co.za${to}` } });
    routes.push({ src: '/solutions/.*', status: 308, headers: { Location: 'https://kasitek.co.za' } });
    routes.push({ src: '/sw\\.js', headers: { 'service-worker-allowed': '/' }, continue: true });
  }
  routes.push({ src: '/(?:.*\\.map|(?:.*/)?\\.[^/]+(?:/.*)?)', status: 404 });
  routes.push({ src: '/assets/.*', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true });
  routes.push({ src: '/.*', methods: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], status: 405 });
  routes.push({ handle: 'filesystem' });
  routes.push({ src: '/assets/.*', status: 404 });
  if (product === 'growth') {
    for (const { path } of growthRoutes) {
      if (path === '/' || path === '/analytics/playground') continue;
      const pattern = path.split('/').map(part => part.startsWith(':') ? '[^/]+' : escape(part)).join('/');
      routes.push({ src: `${pattern}/*`, methods: ['GET', 'HEAD'], dest: '/__spa-fallback.html', headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
    }
  } else routes.push({ src: '/[^.]*', methods: ['GET', 'HEAD'], dest: '/index.html', headers: { 'cache-control': 'no-store' } });
  routes.push({ src: '/.*', status: 404 });
  return { version: 3, routes };
}

export async function packageVercelOutput(product, env = process.env) {
  if (!roots[product]) throw Error('Choose growth, agents or agency');
  const root = join(repository, roots[product]);
  const output = join(root, '.vercel/output');
  const apiOrigin = product === 'growth' ? env.CORE_API_BASE_URL : product === 'agents' ? env.AGENTS_API_PROXY_TARGET : env.TENANT_BACKEND_URL;
  const frontendOrigin = env.FRONTEND_URL;
  const contract = product === 'growth' ? JSON.parse(await readFile(join(root, 'scripts/route-contract.json'), 'utf8')) : { routes: [] };
  const config = createVercelRoutes(product, { apiOrigin, frontendOrigin, growthRoutes: contract.routes, preview: env.VERCEL_ENV !== 'production', agencyWildcardDomain: env.AGENCY_VERIFIED_WILDCARD_DOMAIN });
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(join(root, product === 'growth' ? 'build/client' : 'dist'), join(output, 'static'), {
    recursive: true,
    filter: source => !source.split('/').some(part => part.startsWith('.') || part.endsWith('.map')),
  });
  await writeFile(join(output, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await packageVercelOutput(process.argv[2]));
