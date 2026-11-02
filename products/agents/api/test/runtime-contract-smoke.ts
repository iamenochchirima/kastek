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
const workers = new Set();
let workerOutput = '';
let startedContainer = false;
let cleanupPromise;

function cleanup() {
  cleanupPromise ??= (async () => {
    for (const process of workers) await stopWorker(process);
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
const release = process.env.CONTRACT_RELEASE;
const child = restate.workflow({ name: 'AgentsRuntimeChild', handlers: {
  run: async (ctx, input) => {
    await ctx.run('child-start', () => fs.appendFileSync(process.env.CONTRACT_MARKERS, 'child:' + ctx.key + '\\n'));
    await ctx.sleep(input.delayMs);
    return { key: ctx.key, release };
  }
}});
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
      if (input.mode === 'review') {
        console.log('CONTRACT_REVIEW_WAIT:' + input.key);
        const decision = await ctx.promise('review').get();
        return { key: input.key, decision, release };
      }
      if (input.mode === 'children') {
        const a = ctx.workflowClient(child, input.key + '-a').run({ delayMs: 300 });
        const b = ctx.workflowClient(child, input.key + '-b').run({ delayMs: 400 });
        return { children: [await a, await b], release };
      }
      if (input.mode === 'cancel-child') {
        const pending = ctx.workflowClient(child, input.key + '-cancel').run({ delayMs: 60000 });
        const invocationId = await pending.invocationId;
        await ctx.sleep(300);
        ctx.invocation(invocationId).cancel();
        try { await pending; throw new restate.TerminalError('Child did not cancel'); }
        catch (error) {
          // Child cancellation crosses an RPC boundary as TerminalError(409),
          // unlike cancellation of this handler's own sleep/promise.
          if (!(error instanceof restate.TerminalError) || error.code !== 409) throw error;
          return { childCancelled: true, release };
        }
      }
      await ctx.sleep(input.delayMs);
      return { key: input.key, completed: true, release };
    },
    approve: restate.handlers.workflow.shared(async (ctx, input) => {
      await ctx.promise('review').resolve(input.decision);
      return { recorded: true };
    })
  }
});
http2.createServer(restate.createEndpointHandler({services: [run, child]}))
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

async function startWorker(port, release = 'v1') {
  let ready = false;
  workerOutput = '';
  const log = fs.openSync(workerLog, 'a');
  worker = spawn(process.execPath, [workerFile], {
    env: { ...process.env, CONTRACT_PORT: String(port), CONTRACT_MARKERS: markerFile, CONTRACT_RELEASE: release },
    stdio: ['ignore', 'pipe', log],
  });
  workers.add(worker);
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

async function stopWorker(target = worker) {
  if (target && target.exitCode === null && target.signalCode === null) {
    const exited = once(target, 'exit');
    target.kill('SIGKILL');
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

  async function send(key, delayMs, mode) {
    const response = await fetch(`${ingress}/restate/send/AgentsRuntimeContract/${key}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, delayMs, mode }),
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
  assert.deepEqual(result, { key: 'restart-proof', completed: true, release: 'v1' });
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
  async function output(invocationId, label) {
    return waitUntil(async () => {
      const response = await fetch(`${ingress}/restate/output/${invocationId}`);
      return response.ok ? response.json() : false;
    }, label);
  }
  const review = await send('review-proof', 0, 'review');
  await waitUntil(() => workerOutput.includes('CONTRACT_REVIEW_WAIT:review-proof'), 'durable review waits');
  await stopWorker();
  await startWorker(workerPort);
  const approve = await fetch(`${ingress}/AgentsRuntimeContract/review-proof/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
  });
  assert.ok(approve.ok, await approve.text());
  assert.deepEqual(await output(review.invocationId, 'review resumes after restart'), { key: 'review-proof', decision: 'approved', release: 'v1' });
  const children = await send('join-proof', 0, 'children');
  assert.deepEqual(await output(children.invocationId, 'children join'), {
    children: [{ key: 'join-proof-a', release: 'v1' }, { key: 'join-proof-b', release: 'v1' }], release: 'v1',
  });
  const childCancellation = await send('child-cancel-proof', 0, 'cancel-child');
  assert.deepEqual(await output(childCancellation.invocationId, 'explicit child cancellation'), { childCancelled: true, release: 'v1' });

  const oldInvocation = await send('old-release-proof', 5000);
  await waitUntil(() => workerOutput.includes('CONTRACT_STEP_RECORDED:old-release-proof'), 'old release started');
  const nextPortProbe = net.createServer();
  nextPortProbe.listen(0, '0.0.0.0');
  await once(nextPortProbe, 'listening');
  const nextPort = nextPortProbe.address().port;
  await new Promise(resolve => nextPortProbe.close(resolve));
  await startWorker(nextPort, 'v2');
  const nextRegistration = await fetch(`${admin}/deployments`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: `http://host.docker.internal:${nextPort}`, force: false }),
  });
  assert.ok(nextRegistration.ok, await nextRegistration.text());
  const newInvocation = await send('new-release-proof', 0);
  assert.deepEqual(await output(newInvocation.invocationId, 'new release selected'), { key: 'new-release-proof', completed: true, release: 'v2' });
  assert.deepEqual(await output(oldInvocation.invocationId, 'old release invocation preserved'), { key: 'old-release-proof', completed: true, release: 'v1' });
  console.log(JSON.stringify({
    check: 'deterministic-runtime-contract', server: '1.7.13', sdk: '1.17.3',
    duplicateInvocation: first.invocationId, replayCompletedStepCount: 1,
    cancellationRequested: true, cancellationConfirmed: cancellation.status,
    workflowRetention: service.workflow_completion_retention, journalRetention: service.journal_retention,
    durableReviewAfterRestart: true, childJoin: true, explicitChildCancellation: true,
    immutableDeploymentRouting: { original: 'v1', next: 'v2' },
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
