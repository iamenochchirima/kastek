/* Standalone deterministic contract check. Run infra/agents-runtime/verify.sh. */
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const tmp = process.env.RUNTIME_CONTRACT_TMP;
assert.ok(tmp, 'Run this check through infra/agents-runtime/verify.sh');
const container = `kasitek-runtime-contract-${process.pid}-${Date.now()}`;
const image = 'docker.restate.dev/restatedev/restate:1.7.13';
const workerFile = path.join(tmp, 'worker.cjs');
const markerFile = path.join(tmp, 'completed-steps.txt');
const workerLog = path.join(tmp, 'worker.log');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 }).trim();
let worker;
let workerOutput = '';
let startedContainer = false;
let cleanupPromise;

function cleanup() {
  cleanupPromise ??= (async () => {
    await stopWorker();
    if (startedContainer) docker('rm', '-f', container);
  })();
  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => cleanup().finally(() => process.exit(130)));
}

fs.writeFileSync(workerFile, `
const http2 = require('node:http2');
const fs = require('node:fs');
const restate = require('@restatedev/restate-sdk/node');
const run = restate.workflow({
  name: 'AgentsRuntimeContract',
  options: { workflowRetention: { days: 7 }, journalRetention: { days: 7 } },
  handlers: {
    run: async (ctx, input) => {
      await ctx.run('completed-before-restart', () => {
        fs.appendFileSync(process.env.CONTRACT_MARKERS, input.key + '\\n');
        return input.key;
      });
      console.log('CONTRACT_STEP_RECORDED:' + input.key);
      await ctx.sleep(input.delayMs);
      return { key: input.key, completed: true };
    }
  }
});
http2.createServer(restate.createEndpointHandler({services: [run]}))
  .listen(Number(process.env.CONTRACT_PORT), '0.0.0.0', () => console.log('CONTRACT_READY'));
`);

async function waitUntil(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}

async function startWorker(port) {
  let ready = false;
  workerOutput = '';
  const log = fs.openSync(workerLog, 'a');
  worker = spawn(process.execPath, [workerFile], {
    env: { ...process.env, CONTRACT_PORT: String(port), CONTRACT_MARKERS: markerFile },
    stdio: ['ignore', 'pipe', log],
  });
  fs.closeSync(log);
  worker.stdout.on('data', chunk => {
    workerOutput += chunk.toString();
    if (workerOutput.includes('CONTRACT_READY')) ready = true;
  });
  await waitUntil(() => {
    assert.equal(worker.exitCode, null, 'Worker exited before becoming ready');
    return ready;
  }, 'worker ready');
}

async function stopWorker() {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, 'exit');
    worker.kill('SIGKILL');
    await exited;
  }
}

async function main() {
  const portProbe = net.createServer();
  portProbe.listen(0, '0.0.0.0');
  await once(portProbe, 'listening');
  const workerPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  await startWorker(workerPort);
  docker('run', '-d', '--name', container,
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', '127.0.0.1::8080', '-p', '127.0.0.1::9070', image);
  startedContainer = true;
  const ingress = `http://${docker('port', container, '8080/tcp')}`;
  const admin = `http://${docker('port', container, '9070/tcp')}`;
  await waitUntil(async () => (await fetch(`${admin}/health`)).ok, 'Restate ready');
  const registration = await fetch(`${admin}/deployments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: `http://host.docker.internal:${workerPort}`, force: false }),
  });
  assert.ok(registration.ok, `Registration failed: ${await registration.text()}`);

  const serviceResponse = await fetch(`${admin}/services/AgentsRuntimeContract`);
  assert.ok(serviceResponse.ok);
  const service = await serviceResponse.json();
  assert.equal(service.workflow_completion_retention, '7d', JSON.stringify(service));
  assert.equal(service.journal_retention, '7d', JSON.stringify(service));

  async function send(key, delayMs) {
    const response = await fetch(`${ingress}/restate/send/AgentsRuntimeContract/${key}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, delayMs }),
    });
    const body = await response.text();
    assert.ok(response.ok, `Submission failed: ${body}`);
    return JSON.parse(body);
  }
  const first = await send('restart-proof', 5000);
  const duplicate = await send('restart-proof', 5000);
  assert.equal(duplicate.invocationId, first.invocationId);
  await waitUntil(() => workerOutput.includes('CONTRACT_STEP_RECORDED:restart-proof'), 'first recorded durable step');
  await stopWorker();
  await startWorker(workerPort);
  const result = await waitUntil(async () => {
    const response = await fetch(`${ingress}/restate/output/${first.invocationId}`);
    return response.ok ? response.json() : false;
  }, 'same invocation completes after worker restart');
  assert.deepEqual(result, { key: 'restart-proof', completed: true });
  assert.equal(fs.readFileSync(markerFile, 'utf8').split('\n').filter(line => line === 'restart-proof').length, 1);

  const cancellable = await send('cancel-proof', 60_000);
  await waitUntil(() => workerOutput.includes('CONTRACT_STEP_RECORDED:cancel-proof'), 'cancellable workflow started');
  const cancelResponse = await fetch(`${admin}/invocations/${cancellable.invocationId}/cancel`, { method: 'PATCH' });
  assert.ok(cancelResponse.ok, `Cancellation request failed: ${await cancelResponse.text()}`);
  // A successful cancellation request alone is not a confirmed terminal outcome.
  const cancellation = await waitUntil(async () => {
    const response = await fetch(`${ingress}/restate/output/${cancellable.invocationId}`);
    const body = await response.json();
    if (response.status === 409 && /cancel/i.test(body.message)) return { status: response.status, body };
    if (response.status === 409) throw new Error(JSON.stringify(body));
    return false;
  }, 'confirmed cancellation');
  console.log(JSON.stringify({
    check: 'deterministic-runtime-contract', server: '1.7.13', sdk: '1.17.3',
    duplicateInvocation: first.invocationId, replayCompletedStepCount: 1,
    cancellationRequested: true, cancellationConfirmed: cancellation.status,
    workflowRetention: service.workflow_completion_retention, journalRetention: service.journal_retention,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  if (fs.existsSync(workerLog)) console.error(fs.readFileSync(workerLog, 'utf8').slice(-12000));
  if (startedContainer) {
    try { console.error(docker('logs', '--tail', '40', container)); } catch {}
  }
  process.exitCode = 1;
}).finally(cleanup);
