import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { parse } from 'dotenv';
import { isolatedDatabase } from './helpers/database-fixture.js';
import { API_WORKERS, processWorkers } from '../src-ts/workers/runtime.js';
const modes = [
  'social-publishing-worker',
  'social-insights-worker',
  'whatsapp-marketing-worker',
  'whatsapp-inbox-worker',
  'email-inbox-worker',
  'billing-reconciliation-worker',
  'analytics-publisher',
  'analytics-backfill-worker',
  'public-webhooks-worker',
  'all-workers',
];
const url = process.env.CORE_PROCESS_MODES_TEST_DATABASE_URL;
test(
  'compiled native modes poll empty isolated queues, do not serve HTTP, and stop on SIGTERM; API worker flag and combined analytics are honored',
  { skip: !url, timeout: 90000 },
  async () => {
    const admin = new pg.Pool({ connectionString: url });
    const tables = (
      await admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename~'^[A-Za-z_]+$' AND tablename<>'_prisma_migrations'`,
      )
    ).rows.map((r) => r.tablename);
    await admin.end();
    const fixture = await isolatedDatabase(url!, 'process_modes', tables);
    const database = new URL(url!);
    database.searchParams.set('options', String(fixture.pool.options.options));
    let analyticsClaims = 0;
    const provider = createServer((_request, response) => {
      analyticsClaims++;
      response.writeHead(204);
      response.end();
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    // Both entrypoints load the repository .env. Explicit empty values prevent dotenv from
    // replacing fixture settings with any real credential; never copy those values.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    for (const name of Object.keys(parse(readFileSync(resolve('.env')))))
      env[name] = '';
    Object.assign(env, {
      DATABASE_URL: database.toString(),
      ENVIRONMENT: 'test',
      LOG_LEVEL: 'info',
      OTEL_SDK_DISABLED: 'true',
      AGENTS_API_URL: providerUrl,
      AGENTS_INTERNAL_AUTH_SECRET: 'fixture',
      ANALYTICS_INGESTION_URL: providerUrl,
      ANALYTICS_CORE_INGESTION_TOKEN: 'fixture',
      PAYSTACK_MODE: 'test',
      PAYSTACK_TEST_SECRET_KEY: 'fixture',
      PAYSTACK_API_BASE_URL: providerUrl,
      REDIS_URL: '',
      KASITEK_DISABLE_BACKGROUND_WORKERS: '1',
    });
    async function run(mode: string | undefined, apiFlag?: string) {
      const portProbe = createTcpServer();
      portProbe.listen(0, '127.0.0.1');
      await once(portProbe, 'listening');
      const port = (portProbe.address() as { port: number }).port;
      await new Promise<void>((r) => portProbe.close(() => r()));
      const child = spawn(process.execPath, [resolve('dist/bootstrap.js')], {
        env: {
          ...env,
          PORT: String(port),
          KASITEK_PROCESS: mode ?? '',
          KASITEK_DISABLE_BACKGROUND_WORKERS: apiFlag ?? '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (b) => (output += b));
      child.stderr.on('data', (b) => (output += b));
      const finished = once(child, 'exit');
      const expected = mode
        ? processWorkers(mode)!
        : apiFlag === '1'
          ? []
          : API_WORKERS;
      const deadline = Date.now() + 10000;
      const started = () =>
        expected.every((worker) =>
          output.split('\n').some((line) => {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              return (
                event.worker === worker && event.event === 'worker.started'
              );
            } catch {
              return false;
            }
          }),
        ) &&
        (mode !== undefined ||
          output.includes(
            apiFlag === '1'
              ? '"event":"worker.disabled"'
              : '"component":"background_workers"',
          ));
      try {
        while (!started() && Date.now() < deadline && child.exitCode === null)
          await delay(25);
        assert.ok(
          started(),
          `${mode ?? 'api'} did not start expected workers: ${output}`,
        );
        // Give the first empty DB poll time to finish; errors caught inside workers must fail this fixture.
        await delay(250);
        assert.equal(
          child.exitCode,
          null,
          `${mode ?? 'api'} exited unexpectedly: ${output}`,
        );
        assert.equal(
          /"(?:queue[^" ]*failed|worker.failed)"/.test(output),
          false,
          `${mode ?? 'api'} queue failed: ${output}`,
        );
        if (mode) {
          const probe = createTcpServer();
          await new Promise<void>((r, j) => {
            probe.once('error', j);
            probe.listen(port, '127.0.0.1', () => probe.close(() => r()));
          });
        } else {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          assert.equal(response.status, 200);
        }
        child.kill('SIGTERM');
        const exit = await Promise.race([
          finished,
          delay(5000, undefined, { ref: false }).then(() => {
            throw new Error(`Signal shutdown hung: ${mode ?? 'api'}`);
          }),
        ]);
        assert.equal(exit[0], 0, output);
        assert.equal(exit[1], null, output);
        return output;
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await finished;
      }
    }
    try {
      for (const mode of modes) {
        const before = analyticsClaims;
        const output = await run(mode);
        if (mode === 'analytics-publisher') {
          assert.match(output, /"worker":"analytics_publisher"/);
          assert.match(output, /"worker":"analytics_backfill"/);
          assert.ok(
            analyticsClaims > before,
            'combined analytics did not poll source backfill',
          );
        }
      }
      const disabled = await run(undefined, '1');
      assert.equal(disabled.includes('"event":"worker.started"'), false);
      const enabled = await run(undefined, '');
      for (const worker of API_WORKERS)
        assert.ok(enabled.includes(`"worker":"${worker}"`));
      assert.equal(enabled.includes('"worker":"analytics_publisher"'), false);
    } finally {
      await new Promise<void>((r) => provider.close(() => r()));
      await fixture.close();
    }
  },
);
