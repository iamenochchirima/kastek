import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_WORKERS,
  API_WORKERS,
  apiWorkersEnabled,
  processWorkers,
  runWorkerGroup,
  type WorkerRunners,
} from "../src-ts/workers/runtime.js";
const log = { info() {}, warn() {}, error() {} };

test("source process modes retain dedicated, combined and embedded worker boundaries", () => {
  assert.deepEqual(processWorkers("analytics-publisher"), [
    "analytics_publisher",
    "analytics_backfill",
  ]);
  assert.deepEqual(processWorkers("all-workers"), ALL_WORKERS);
  assert.deepEqual(processWorkers("whatsapp-marketing-worker"), [
    "whatsapp_campaigns",
  ]);
  assert.deepEqual(processWorkers("email-inbox-worker"), ["email_inbox"]);
  assert.equal(processWorkers(undefined), undefined);
  assert.equal(processWorkers("not-a-source-process"), undefined);
  assert.equal(processWorkers("toString"), undefined);
  assert.equal(API_WORKERS.includes("analytics_publisher" as never), false);
  assert.equal(API_WORKERS.length, 7);
  for (const disabled of ["1", "TRUE", "yes", " on "])
    assert.equal(apiWorkersEnabled(disabled), false);
  for (const enabled of [undefined, "", "0", "false"])
    assert.equal(apiWorkersEnabled(enabled), true);
});

test("worker failure aborts siblings and waits for their resource cleanup", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const failure = new Error("fixture failure");
  const runners = Object.fromEntries(
    ALL_WORKERS.map((name) => [
      name,
      async (signal: AbortSignal) => {
        events.push(`start:${name}`);
        if (name === "analytics_publisher") {
          await Promise.resolve();
          throw failure;
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            events.push(`cleanup:${name}`);
            resolve();
          };
          if (signal.aborted) finish();
          else signal.addEventListener("abort", finish, { once: true });
        });
      },
    ]),
  ) as WorkerRunners;
  await assert.rejects(
    runWorkerGroup(
      processWorkers("analytics-publisher")!,
      runners,
      controller,
      log,
    ),
    (error) => error === failure,
  );
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(events, [
    "start:analytics_publisher",
    "start:analytics_backfill",
    "cleanup:analytics_backfill",
  ]);
});

test("a disabled worker can return while another worker runs until shutdown", async () => {
  const controller = new AbortController();
  let started = false,
    cleaned = false;
  const runners = Object.fromEntries(
    ALL_WORKERS.map((name) => [
      name,
      async (signal: AbortSignal) => {
        if (name === "analytics_publisher") return;
        started = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              cleaned = true;
              resolve();
            },
            { once: true },
          ),
        );
      },
    ]),
  ) as WorkerRunners;
  const done = runWorkerGroup(
    processWorkers("analytics-publisher")!,
    runners,
    controller,
    log,
  );
  assert.equal(started, true);
  assert.equal(controller.signal.aborted, false);
  controller.abort();
  await done;
  assert.equal(cleaned, true);
});
