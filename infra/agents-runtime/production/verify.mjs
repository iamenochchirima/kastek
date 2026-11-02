import assert from 'node:assert/strict';
import { requestIdentityPublicKey } from './request-identity.mjs';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:http2';
import { createEndpointHandler, service } from '../../../products/agents/api/node_modules/@restatedev/restate-sdk/dist/index.js';

const image = process.env.RESTATE_TEST_IMAGE ?? 'kasitek-restate:packaging-check-20261102';
const name = `kasitek-restate-production-test-${randomUUID()}`;
const volume = `${name}-data`;
const pair = generateKeyPairSync('ed25519');
const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
const environment = { ...process.env, RESTATE_SIGNING_PRIVATE_KEY_PEM: pem };
function docker(args, options = {}) { return execFileSync('docker', args, { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, ...options }).trim(); }
const key = requestIdentityPublicKey(pem);
const calls = [];
const worker = createServer(createEndpointHandler({ services: [service({ name: 'ProductionSigningProbe', handlers: { run: async () => { calls.push('run'); return { ok: true }; } } })], identityKeys: [key], logger: () => {} }));
const sessions = new Set();
worker.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
worker.listen(0, '0.0.0.0'); await once(worker, 'listening');
async function ready(url) {
  let last = '';
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; last = `${response.status} ${await response.text()}`; } catch (error) { last = error.message + ' ' + error.cause?.message; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Restate did not become healthy: ' + last);
}
try {
  let missingKeyRejected = false;
  try { docker(['run', '--rm', image, '--dump-config'], { env: { ...process.env, RESTATE_SIGNING_PRIVATE_KEY_PEM: '' } }); } catch { missingKeyRejected = true; }
  assert.equal(missingKeyRejected, true);
  const config = docker(['run', '--rm', '-e', 'RESTATE_SIGNING_PRIVATE_KEY_PEM', image, '--dump-config']);
  assert.match(config, /base-dir = "\/restate-data"/);
  assert.match(config, /bind-address = "0\.0\.0\.0:8080"/);
  assert.match(config, /bind-address = "0\.0\.0\.0:9070"/);
  assert.match(config, /request-identity-private-key-pem-file = "\/tmp\/kasitek-restate\.[^/]+\/request-identity.pem"/);
  assert.doesNotMatch(config, /BEGIN PRIVATE KEY/);
  docker(['volume', 'create', volume]);
  docker(['run', '-d', '--name', name, '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::8080', '-p', '127.0.0.1::9070', '-e', 'RESTATE_SIGNING_PRIVATE_KEY_PEM', '-v', `${volume}:/restate-data`, image]);
  const port = target => docker(['port', name, `${target}/tcp`]).split(':').at(-1);
  let admin = `http://127.0.0.1:${port(9070)}`, ingress = `http://127.0.0.1:${port(8080)}`;
  await ready(admin);
  const mode = docker(['exec', name, 'sh', '-c', 'stat -c %a /tmp/kasitek-restate.*/request-identity.pem']);
  assert.equal(mode, '600');
  const registered = await fetch(`${admin}/deployments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uri: `http://host.docker.internal:${worker.address().port}` }), signal: AbortSignal.timeout(15000) });
  assert.equal(registered.status, 201, `Signed discovery registration returned ${registered.status}: ${await registered.text()}`);
  const response = await fetch(`${ingress}/ProductionSigningProbe/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'production-signing-probe' }, body: '{}', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  docker(['restart', name]);
  admin = `http://127.0.0.1:${port(9070)}`; ingress = `http://127.0.0.1:${port(8080)}`;
  await ready(admin);
  const replay = await fetch(`${ingress}/ProductionSigningProbe/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'production-signing-probe' }, body: '{}', signal: AbortSignal.timeout(20000) });
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { ok: true }); assert.equal(calls.length, 1);
  const client = connect(`http://127.0.0.1:${worker.address().port}`);
  const unsignedStatus = await new Promise((resolve, reject) => { const request = client.request({ ':method': 'GET', ':path': '/discover', accept: 'application/vnd.restate.endpointmanifest.v3+json' }); let status; request.on('response', headers => status = headers[':status']); request.on('data', () => {}); request.on('end', () => resolve(status)); request.on('error', reject); request.end(); });
  client.close(); assert.equal(unsignedStatus, 401);
  console.log(JSON.stringify({ image, missingKeyRejected, privateFileMode: mode, signedDiscovery: true, signedInvocation: true, unsignedRejected: true, restartReplayCalls: calls.length, persistentVolume: true }));
} catch (error) {
  console.error(error.message);
  try { console.error(docker(['logs', '--tail', '30', name])); } catch {}
  process.exitCode = 1;
} finally {
  try { docker(['rm', '-f', name]); } catch {}
  try { docker(['volume', 'rm', volume]); } catch {}
  for (const session of sessions) session.destroy();
  await new Promise(resolve => worker.close(resolve));
}
