import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { processIdentity, sameProcess, stopOwned, portFree, ownsPort, services, root, validateDevelopmentTargets } from './reporting-dev.mjs';

test('ownership verifies PID birth, working directory and command; external processes are never stopped', async () => {
  const actual = await processIdentity(process.pid), calls = [];
  assert.equal(sameProcess(actual, actual), true);
  for (const key of ['pid', 'started', 'cwd', 'commandHash']) {
    const stale = { ...actual, [key]: 'changed', ownership: 'managed' };
    assert.equal(sameProcess(stale, actual), false);
    await stopOwned(stale, async () => actual, (...args) => calls.push(args));
  }
  await stopOwned({ ...actual, ownership: 'external' }, async () => actual, (...args) => calls.push(args));
  assert.deepEqual(calls, []);
  await stopOwned({ ...actual, ownership: 'managed' }, async () => actual, (...args) => calls.push(args));
  assert.deepEqual(calls, [[process.pid, 'SIGTERM']]);
});

test('port collision is detected and listener belongs to the exact process', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  try { assert.equal(await portFree(port), false); assert.equal(await ownsPort(process.pid, port), true); assert.equal(await ownsPort(999999999, port), false); }
  finally { await new Promise(done => server.close(done)); }
  assert.equal(await portFree(port), true);
});

test('process inspection does not return command arguments or environment secrets', async () => {
  const secret = 'fixture-secret-not-for-output';
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', secret], { env: { ...process.env, FIXTURE_SECRET: secret }, stdio: 'ignore', cwd: root });
  await once(child, 'spawn');
  try { const actual = await processIdentity(child.pid); assert.ok(actual); assert.equal(JSON.stringify(actual).includes(secret), false); assert.deepEqual(Object.keys(actual).sort(), ['commandHash', 'cwd', 'pid', 'started']); }
  finally { child.kill(); await once(child, 'exit'); }
});

test('development profile isolates Agents and disables unrelated Growth API workers', () => {
  assert.equal(services.find(s => s.name === 'agents').port, 14100);
  assert.equal(services.find(s => s.name === 'growth').overrides.KASITEK_DISABLE_BACKGROUND_WORKERS, 'true');
  assert.deepEqual(services.filter(s => s.startupMigrations).map(s => s.name), ['agency', 'agency-publisher']);
});

test('managed shutdown signals a real child and leaves a stale identity alive', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', cwd: root });
  await once(child, 'spawn');
  const actual = await processIdentity(child.pid);
  try {
    assert.match(await stopOwned({ ...actual, started: 'stale', ownership: 'managed' }), /untouched/);
    assert.ok(await processIdentity(child.pid));
    const exited = once(child, 'exit');
    assert.equal(await stopOwned({ ...actual, ownership: 'managed' }), 'shutdown requested');
    await exited;
    assert.equal(await processIdentity(child.pid), null);
  } finally { child.kill(); }
});


test('development targets validate optional reporting databases and reject pg connection overrides', () => {
  const item=services.find(service=>service.name==='analytics');
  const env={ANALYTICS_DATABASE_URL:'postgres://owner@127.0.0.1:15432/analytics_reporting_dev'};
  assert.equal(validateDevelopmentTargets(item,env).length,1);
  const reader='postgresql://reader@localhost:15432/analytics_reporting_dev';
  assert.deepEqual(validateDevelopmentTargets(item,{...env,ANALYTICS_REPORTING_DATABASE_URL:reader}).map(item=>item.key),['ANALYTICS_DATABASE_URL','ANALYTICS_REPORTING_DATABASE_URL']);
  for(const url of ['postgres://reader@remote.example/analytics_reporting_dev','postgres://reader@127.0.0.1/shared','https://127.0.0.1/analytics_reporting_dev','postgres://127.0.0.1/analytics_reporting_dev?host=remote.example','postgres://127.0.0.1/analytics_reporting_dev#fragment']){
    assert.throws(()=>validateDevelopmentTargets(item,{...env,ANALYTICS_REPORTING_DATABASE_URL:url}),/ANALYTICS_REPORTING_DATABASE_URL/);
    assert.throws(()=>validateDevelopmentTargets(item,{ANALYTICS_DATABASE_URL:url}),/ANALYTICS_DATABASE_URL/);
  }
});

test('configured reporting and ingestion URLs are loopback origins at the expected service ports', () => {
  const item=services.find(service=>service.name==='admin');
  const env={CORE_BACKEND_URL:'http://127.0.0.1:4000',TENANTS_BACKEND_URL:'http://localhost:8090',AGENTS_BACKEND_URL:'http://[::1]:14100',ANALYTICS_REPORTING_URL:'http://localhost:4300',ANALYTICS_INGESTION_URL:'http://127.0.0.1:4300',AGENTS_ANALYTICS_INGESTION_URL:'http://localhost:4300'};
  assert.deepEqual(validateDevelopmentTargets(item,env),[]);
  for(const key of Object.keys(env))for(const invalid of ['http://remote.example:4300','http://localhost:9999','http://credential@localhost:4300','http://localhost:4300/api','http://localhost:4300/?target=remote','http://localhost:4300/#fragment','https://localhost:4300'])assert.throws(()=>validateDevelopmentTargets(item,{...env,[key]:invalid}),new RegExp(key));
  assert.throws(()=>validateDevelopmentTargets(item,{...env,CORE_BACKEND_URL:undefined}),/CORE_BACKEND_URL/);
});

test('operations worker uses a separate profile and cannot inherit human credentials', async()=>{
 const {operationsWorkerProfile,validateOperationsCredentials}=await import('./reporting-dev.mjs');
 const api=services.find(s=>s.name==='operations'),worker=services.find(s=>s.name==='operations-worker');
 assert.equal(api.port,4400);assert.equal(worker.port,undefined);assert.notEqual(worker.env,api.env);
 const env={DATABASE_URL:'postgres://local@localhost:15432/kasitek_operations_dev',OPS_ENVIRONMENT:'development',OPS_SOURCES_JSON:'[]',OPS_ADMIN_AUTHORITY_SECRET:'human-key',OPS_OIDC_CLIENT_SECRET:'oidc-key',OPS_SESSION_ENCRYPTION_KEY:'session-key',KASITEK_ADMIN_SERVICE_SECRET:'product-human-key',OPS_NOTIFICATION_SECRET:'publisher-key',UNRELATED_SECRET:'unrelated-key'};
 const profile=operationsWorkerProfile(env);assert.equal(profile.OPS_NOTIFICATION_SECRET,'publisher-key');assert.equal(profile.DATABASE_URL,env.DATABASE_URL);
 for(const key of ['OPS_ADMIN_AUTHORITY_SECRET','OPS_OIDC_CLIENT_SECRET','OPS_SESSION_ENCRYPTION_KEY','KASITEK_ADMIN_SERVICE_SECRET','UNRELATED_SECRET'])assert.equal(profile[key],undefined);
 validateOperationsCredentials(worker,profile);
 for(const key of ['OPS_ADMIN_AUTHORITY_SECRET','OPS_OIDC_CLIENT_SECRET','OPS_SESSION_ENCRYPTION_KEY','KASITEK_ADMIN_SERVICE_SECRET'])assert.throws(()=>validateOperationsCredentials(worker,{...profile,[key]:'secret'}),/must not receive/);
 assert.throws(()=>validateOperationsCredentials(api,profile),/assertion key/);
});

test('operations profiles reject shared databases and remote or mismatched source origins',()=>{
 const item=services.find(s=>s.name==='operations-worker'),env={DATABASE_URL:'postgres://local@localhost:15432/kasitek_operations_dev',OPS_SOURCES_JSON:JSON.stringify([{id:'growth',source:'growth',origin:'http://localhost:4000',secret:'x'.repeat(64)}])};
 assert.equal(validateDevelopmentTargets(item,env).length,1);
 for(const origin of ['http://remote.example:4000','http://localhost:4300','http://localhost:4000/path','http://localhost:4000?credential=leak','http://user:secret@localhost:4000'])assert.throws(()=>validateDevelopmentTargets(item,{...env,OPS_SOURCES_JSON:JSON.stringify([{source:'growth',origin}])}),/observer/);
 assert.throws(()=>validateDevelopmentTargets(item,{...env,DATABASE_URL:'postgres://local@localhost:15432/shared'}),/dedicated/);
 assert.throws(()=>validateDevelopmentTargets(item,{...env,OPS_SOURCES_JSON:'broken'}),/source configuration/);
});
