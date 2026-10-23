import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { processIdentity, sameProcess, stopOwned, portFree, ownsPort, services, root } from './reporting-dev.mjs';

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
