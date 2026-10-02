import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import {
  resultSpan,
  recordDependencyFailure,
} from "@kasitek/server-support/telemetry";
export { recordRetry, recordQueueAge } from "@kasitek/server-support/telemetry";
/** Record only the exception class; provider error strings can contain customer data. */
export async function providerSpan<T>(
  provider: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer("kasitek-core")
    .startActiveSpan(
      "kasitek.provider",
      {
        attributes: {
          "peer.service": provider,
          "kasitek.provider.operation": operation,
        },
      },
      async (span) => {
        try {
          const value = await operationSpan("dependency", operation, run);
          span.setStatus({ code: SpanStatusCode.OK });
          return value;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute(
            "exception.type",
            error instanceof Error ? error.name : "unknown",
          );
          recordDependencyFailure(provider, operation);
          throw error;
        } finally {
          span.end();
        }
      },
    );
}
/** Shared operation counters/timing stay live, but their error text sees only a safe class. */
export async function operationSpan<T>(
  kind: string,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  let original: unknown;
  let failed = false;
  try {
    return await resultSpan(kind, name, async () => {
      try {
        return await run();
      } catch (error) {
        failed = true;
        original = error;
        throw new Error(error instanceof Error ? error.name : "unknown");
      }
    });
  } catch (error) {
    throw failed ? original : error;
  }
}
export const workerSpan = <T>(name: string, run: () => Promise<T>) =>
  operationSpan("worker", name, run);
export const queueSpan = <T>(name: string, run: () => Promise<T>) =>
  operationSpan("queue", name, run);
