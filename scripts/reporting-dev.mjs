import { readFile, writeFile, mkdir, stat, realpath, rm, readdir, readlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtime = resolve(root, '.runtime/admin-reporting');
const manifestPath = resolve(runtime, 'processes.json');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const service = (name, folder, entry, env, port, extra = {}) => ({ name, cwd: resolve(root, folder), entry, env, port, ...extra });
export const services = [
  service('analytics', 'services/analytics', 'dist/api-main.js', 'analytics', 4300, { portKey: 'ANALYTICS_API_PORT' }),
  service('analytics-worker', 'services/analytics', 'dist/worker-main.js', 'analytics'),
  service('growth', 'products/growth/api', 'dist/bootstrap.js', 'growth', 4000, { overrides: { KASITEK_DISABLE_BACKGROUND_WORKERS: 'true' } }),
  service('agency', 'products/agency/api', 'dist/bootstrap.js', 'agency', 8090, { portKey: 'TENANT_SERVER_PORT', startupMigrations: true }),
  service('agents', 'products/agents/api', 'dist/composition/server.js', 'agents', 14100),
  service('growth-publisher', 'products/growth/api', 'dist/bootstrap.js', 'growth', undefined, { overrides: { KASITEK_PROCESS: 'analytics-publisher' } }),
  service('agency-publisher', 'products/agency/api', 'dist/bootstrap.js', 'agency', undefined, { startupMigrations: true, overrides: { KASITEK_PROCESS: 'analytics-publisher' } }),
  service('operations', 'services/operations', 'dist/api-main.js', 'operations', 4400),
  service('operations-worker', 'services/operations', 'dist/worker-main.js', 'operations-worker'),
  service('admin', 'apps/admin-site', 'node_modules/next/dist/bin/next', 'admin', 3001, { args: ['start', '--port', '3001'], health: '/login' }),
];
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return { pid, started: fields[19], cwd: await realpath(`/proc/${pid}/cwd`), commandHash: createHash('sha256').update(await readFile(`/proc/${pid}/cmdline`)).digest('hex') };
  } catch { return null; }
}
export function sameProcess(saved, actual) { return !!actual && ['pid', 'started', 'cwd', 'commandHash'].every(key => saved[key] === actual[key]); }
export async function portFree(port) {
  return new Promise(done => { const server = createServer(); server.once('error', () => done(false)); server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => done(true))); });
}
export async function ownsPort(pid, port) {
  try {
    const fds = await readdir(`/proc/${pid}/fd`);
    const sockets = new Set((await Promise.all(fds.map(fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')))).map(value => /^socket:\[(\d+)\]$/.exec(value)?.[1]).filter(Boolean));
    for (const family of ['tcp', 'tcp6']) {
      const rows = (await readFile(`/proc/${pid}/net/${family}`, 'utf8')).trim().split('\n').slice(1);
      if (rows.some(row => { const fields = row.trim().split(/\s+/); return fields[3] === '0A' && parseInt(fields[1].split(':')[1], 16) === port && sockets.has(fields[9]); })) return true;
    }
  } catch { /* A process may exit between status reads. */ }
  return false;
}
async function tcp(host, port) {
  return new Promise(done => { const socket = connect({ host, port }); const finish = result => { socket.destroy(); done(result); }; socket.setTimeout(1500, () => finish(false)); socket.once('error', () => finish(false)); socket.once('connect', () => finish(true)); });
}
export async function healthy(item) {
  if (!item.port) return true;
  try { return (await fetch(`http://127.0.0.1:${item.port}${item.health ?? '/health'}`, { signal: AbortSignal.timeout(1500), redirect: 'manual' })).status < 400; } catch { return false; }
}
async function readManifest() {
  try { const data = JSON.parse(await readFile(manifestPath, 'utf8')); if (data.version !== 1 || !data.processes || typeof data.processes !== 'object') throw Error(); return data; }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, processes: {} }; throw Error('Invalid process manifest; inspect it locally.'); }
}
async function saveManifest(data) { const temporary = `${manifestPath}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, manifestPath); }
const dbKeys = { growth: ['DATABASE_URL'], agency: ['KASITEK_TENANTS_DATABASE_URL', 'TENANT_DATABASE_URL'], agents: ['AGENTS_DATABASE_URL'], analytics: ['ANALYTICS_DATABASE_URL'], operations: ['DATABASE_URL'], 'operations-worker': ['DATABASE_URL'] };
/** Validate every configured connection before launching any process. Never return credentials to output. */
export function validateDevelopmentTargets(item, env) {
  const databases = [];
  const primary = dbKeys[item.env]?.find(key => env[key]);
  if (dbKeys[item.env] && !primary) throw Error(`${item.name}: database configuration missing or invalid.`);
  const keys = [...(primary ? [primary] : []), ...(env.ANALYTICS_REPORTING_DATABASE_URL ? ['ANALYTICS_REPORTING_DATABASE_URL'] : [])];
  for (const key of keys) {
    let url; try { url = new URL(env[key]); } catch { throw Error(`${item.name}: ${key} missing or invalid.`); }
    // Query parameters can override pg's host/database parsing; this isolated profile needs no overrides.
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !(item.env.startsWith('operations') ? url.pathname === '/kasitek_operations_dev' : /^\/[A-Za-z0-9_]+_reporting_dev$/.test(url.pathname)) || url.search || url.hash) throw Error(`${item.name}: ${key} requires a dedicated loopback reporting development database.`);
    databases.push({ key, url });
  }
  const ports = { OPERATIONS_BACKEND_URL: 4400, OPS_NOTIFICATION_ORIGIN: 4000, CORE_BACKEND_URL: 4000, TENANTS_BACKEND_URL: 8090, AGENTS_BACKEND_URL: 14100, ANALYTICS_REPORTING_URL: 4300, ANALYTICS_INGESTION_URL: 4300, AGENTS_ANALYTICS_INGESTION_URL: 4300 };
  const required = new Set(item.env === 'admin' ? ['CORE_BACKEND_URL', 'TENANTS_BACKEND_URL', 'AGENTS_BACKEND_URL'] : item.env === 'agents' ? ['AGENTS_ANALYTICS_INGESTION_URL'] : item.name.endsWith('-publisher') ? ['ANALYTICS_INGESTION_URL'] : []);
  for (const [key, port] of Object.entries(ports)) {
    if (!required.has(key) && !env[key]) continue;
    let url; try { url = new URL(env[key]); } catch { throw Error(`${item.name}: ${key} missing or invalid.`); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port || 80) !== port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error(`${item.name}: ${key} must target the loopback development service origin.`);
  }
  if(item.env.startsWith('operations')) {
    let sources;try {sources=JSON.parse(env.OPS_SOURCES_JSON??'[]');}catch {throw Error(`${item.name}: invalid observer source configuration.`);}
    const expected={growth:4000,agents:14100,agency:8090,analytics:4300},seen=new Set();
    if(!Array.isArray(sources)||sources.length>4)throw Error(`${item.name}: invalid observer source configuration.`);
    for(const source of sources){let url;try{url=new URL(source.origin);}catch{throw Error(`${item.name}: invalid observer origin.`);}
      if(!Object.hasOwn(expected,source.source)||seen.has(source.source)||url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||Number(url.port)!==expected[source.source]||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw Error(`${item.name}: observer must target its dedicated loopback service.`);seen.add(source.source);
    }
  }
  return databases;
}
/** Workers receive observation and notification credentials only; human sessions remain in the API profile. */
export function operationsWorkerProfile(apiEnvironment){
 const allowed=['DATABASE_URL','ENVIRONMENT','NODE_ENV','KASITEK_RELEASE_ID','OPS_ENVIRONMENT','OPS_SOURCES_JSON','OPS_COLLECTION_ENABLED','OPS_EVALUATION_ENABLED','OPS_NOTIFICATIONS_ENABLED','OPS_NOTIFICATION_ORIGIN','OPS_NOTIFICATION_SECRET','OPS_ALLOWED_ORIGINS'];
 return Object.fromEntries(allowed.filter(key=>apiEnvironment[key]!==undefined).map(key=>[key,apiEnvironment[key]]));
}
export function validateOperationsCredentials(item,env){
 if(!item.env.startsWith('operations'))return;
 if(env.OPS_ENVIRONMENT!=='development')throw Error(`${item.name}: explicit development operations environment required.`);
 if(item.env==='operations-worker'){
  for(const key of ['OPS_ADMIN_AUTHORITY_SECRET','OPS_OIDC_CLIENT_SECRET','OPS_SESSION_ENCRYPTION_KEY','KASITEK_ADMIN_SERVICE_SECRET'])if(env[key])throw Error(`${item.name}: worker must not receive human administrative credentials.`);
 }else if(!env.OPS_ADMIN_AUTHORITY_SECRET||Buffer.byteLength(env.OPS_ADMIN_AUTHORITY_SECRET)<32)throw Error(`${item.name}: human administrative assertion key required.`);
}

export async function configuration(item) {
  const path = resolve(runtime, `${item.env}.env`), metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile() || (metadata.mode & 0o077)) throw Error(`${item.name}: configuration missing or not private (chmod 600).`);
  const env = parseEnv(await readFile(path, 'utf8'));
  if (env.NODE_ENV === 'production' || env.ANALYTICS_ENVIRONMENT === 'production' || env.OPS_ENVIRONMENT === 'production') throw Error(`${item.name}: development profile required.`);
  if (item.port && env[item.portKey ?? 'PORT'] && Number(env[item.portKey ?? 'PORT']) !== item.port) throw Error(`${item.name}: configured port differs from development profile.`);
  for (const {key,url} of validateDevelopmentTargets(item,env)) {
    if (!await tcp(url.hostname.replaceAll(/[\[\]]/g, ''), Number(url.port || 5432))) throw Error(`${item.name}: ${key} TCP endpoint unavailable.`);
  }
  validateOperationsCredentials(item,env);
  if (!item.env.startsWith('operations') && (!env.KASITEK_ADMIN_SERVICE_SECRET || Buffer.byteLength(env.KASITEK_ADMIN_SERVICE_SECRET) < 32)) throw Error(`${item.name}: administrative service credential missing or too short.`);
  if (item.name === 'growth-publisher' || item.name === 'agency-publisher') {
    const key = item.env === 'growth' ? 'ANALYTICS_CORE_INGESTION_TOKEN' : 'ANALYTICS_TENANT_INGESTION_TOKEN';
    if (!(env[key] ?? env.ANALYTICS_INGESTION_TOKEN)?.trim()) throw Error(`${item.name}: ingestion credential missing.`);
  }
  if (item.env === 'agents' && !env.AGENTS_ANALYTICS_INGESTION_TOKEN?.trim()) throw Error(`${item.name}: native ingestion credential missing.`);
  if (!existsSync(resolve(item.cwd, item.entry))) throw Error(`${item.name}: build entry point missing.`);
  if (item.name === 'admin' && !existsSync(resolve(item.cwd, '.next/BUILD_ID'))) throw Error('admin: production build missing.');
  return env;
}
export async function stopOwned(saved, identity = processIdentity, signal = process.kill) {
  if (saved.ownership !== 'managed') return 'external: left running';
  if (!sameProcess(saved, await identity(saved.pid))) return 'identity changed: left untouched';
  signal(saved.pid, 'SIGTERM'); return 'shutdown requested';
}
export async function run(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) !== 24) throw Error('Linux with workspace Node 24 is required.');
  const [action, ...args] = argv;
  if (!['preflight', 'start', 'status', 'stop', 'adopt'].includes(action)) throw Error('Usage: pnpm reporting:dev preflight|start|status|stop [service ...] [--allow-startup-migrations]; adopt service PID');
  if (args.some(arg => arg.startsWith('--') && arg !== '--allow-startup-migrations')) throw Error('Unknown reporting option.');
  const names = action === 'adopt' ? [args[0]] : args.filter(arg => !arg.startsWith('--'));
  const selected = names.length ? names.map(name => { const item = services.find(s => s.name === name); if (!item) throw Error('Unknown service name.'); return item; }) : services;
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  if ((await stat(runtime)).mode & 0o077) throw Error('Reporting runtime directory must be private (chmod 700).');
  const lock = resolve(runtime, 'process.lock');
  try { await mkdir(lock); } catch { throw Error('Another reporting operation is active; inspect a stale process.lock before removing it.'); }
  try {
    const manifest = await readManifest();
    if (action === 'status') {
      for (const item of selected) {
        const saved = manifest.processes[item.name], alive = saved && sameProcess(saved, await processIdentity(saved.pid)), ready = alive && await healthy(item) && (!item.port || await ownsPort(saved.pid, item.port));
        console.log(`${item.name}: ${ready ? saved.ownership === 'managed' ? 'running (managed)' : 'running (external)' : alive ? 'running, unhealthy' : item.port && !await portFree(item.port) ? 'unowned port occupied' : 'stopped'}`);
        if (!ready) process.exitCode = 1;
      } return;
    }
    if (action === 'stop') { for (const item of [...selected].reverse()) { const saved = manifest.processes[item.name]; console.log(`${item.name}: ${saved ? await stopOwned(saved) : 'not managed'}`); } return; }
    if (action === 'adopt') {
      const item = selected[0], actual = await processIdentity(Number(args[1]));
      if (!actual || actual.cwd !== await realpath(item.cwd) || !await healthy(item) || (item.port && !await ownsPort(actual.pid, item.port))) throw Error('External process identity or health does not match.');
      const command = (await readFile(`/proc/${actual.pid}/cmdline`, 'utf8')).split('\0');
      if (!command.some(part => resolve(item.cwd, part) === resolve(item.cwd, item.entry) || (item.name === 'admin' && part.startsWith('next-server (v')))) throw Error('External process entry point does not match.');
      manifest.processes[item.name] = { ...actual, ownership: 'external' }; await saveManifest(manifest); console.log(`${item.name}: external process recorded; stop will leave it running.`); return;
    }
    const configs = new Map();
    for (const item of selected) {
      configs.set(item.name, await configuration(item));
      const saved = manifest.processes[item.name], alive = saved && sameProcess(saved, await processIdentity(saved.pid));
      if (item.port && !await portFree(item.port) && !(alive && await healthy(item) && await ownsPort(saved.pid, item.port))) throw Error(`${item.name}: port occupied by an unowned or unhealthy process.`);
      if (action === 'start' && item.startupMigrations && !args.includes('--allow-startup-migrations')) throw Error(`${item.name}: startup runs migrations; pass --allow-startup-migrations after reviewing the dedicated development database.`);
      console.log(`${item.name}: preflight passed (configuration, build and TCP checks)`);
    }
    if (action === 'preflight') return;
    for (const item of selected) {
      const saved = manifest.processes[item.name];
      if (saved && sameProcess(saved, await processIdentity(saved.pid))) { if (!await healthy(item) || (item.port && !await ownsPort(saved.pid, item.port))) throw Error(`${item.name}: existing process unhealthy.`); console.log(`${item.name}: reused ${saved.ownership} process`); continue; }
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', ...configs.get(item.name), ...item.overrides, KASITEK_ENV_FILE: resolve(runtime, `${item.env}.env`) };
      if (item.port) env[item.portKey ?? 'PORT'] = String(item.port);
      const child = spawn(process.execPath, [`--env-file=${resolve(runtime, `${item.env}.env`)}`, item.entry, ...(item.args ?? [])], { cwd: item.cwd, env, detached: true, stdio: 'ignore' });
      await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); }); child.unref();
      const actual = await processIdentity(child.pid); if (!actual) throw Error(`${item.name}: exited during startup.`);
      manifest.processes[item.name] = { ...actual, ownership: 'managed' }; await saveManifest(manifest);
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) { await sleep(250); if (!(await processIdentity(child.pid))) break; if (await healthy(item) && (!item.port || await ownsPort(child.pid, item.port)) && (item.port || attempt >= 3)) { ready = true; break; } }
      if (!ready) throw Error(`${item.name}: startup failed or health timed out. Previously started services remain owned.`);
      manifest.processes[item.name] = { ...await processIdentity(child.pid), ownership: 'managed' }; await saveManifest(manifest);
      console.log(`${item.name}: started`);
    }
  } finally { await rm(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().catch(error => { console.error(error.message); process.exitCode = 1; });
