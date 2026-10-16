import {
  providerResultSpan,
  resultSpan,
} from "@kasitek-labs/server-support/telemetry";

export {
  recordDependencyFailure,
  recordQueueAge,
  recordRetry,
} from "@kasitek-labs/server-support/telemetry";

export const operationSpan = resultSpan;

export const providerSpan = providerResultSpan;

export const workerSpan = <T>(name: string, run: () => Promise<T>) =>
  operationSpan("worker", name, run);

export const queueSpan = <T>(name: string, run: () => Promise<T>) =>
  operationSpan("queue", name, run);
