import "../src/telemetry";
import { trace, metrics, SpanStatusCode } from "@opentelemetry/api";
import { shutdownTelemetry } from "../src/telemetry";
import { operationalLogger } from "../src/telemetry/logger";
import { redactTelemetryText } from "../src/telemetry/redaction";
import { withProviderSpan, withSpan } from "../src/telemetry/spans";

async function main(): Promise<void> {
  const tracer = trace.getTracer("kasitek-agents-smoke");
  const meter = metrics.getMeter("kasitek-agents-smoke");
  const counter = meter.createCounter("kasitek.local.smoke.count", { description: "Local telemetry smoke signal" });
  await tracer.startActiveSpan("kasitek.local.smoke", { attributes: { "kasitek.smoke": true } }, async (span) => {
    try {
      await withSpan("http.server.smoke", { "http.method": "GET", "http.route": "/_telemetry-smoke" }, async () => undefined);
      await withSpan("database.query.smoke", { "db.operation.name": "SELECT" }, async () => undefined);
      await withProviderSpan("synthetic-provider", "request", async () => undefined);
      await withSpan("worker.job.smoke", { "job.name": "telemetry-smoke" }, async () => undefined);
      try {
        await withSpan("smoke.expected_error", {}, async () => {
          throw new Error("expected telemetry smoke failure");
        });
      } catch {
        operationalLogger.warn({ event: "kasitek.local.smoke.expected.error", outcome: "handled" }, "Expected telemetry smoke failure handled");
      }
      counter.add(1, { signal: "metrics" });
      operationalLogger.info({ event: "kasitek.local.smoke", outcome: "success" }, "Local telemetry smoke completed");
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
  await shutdownTelemetry();
}

main().catch((error) => {
  process.stderr.write(`${redactTelemetryText(error instanceof Error ? error.message : error, 512)}\n`);
  process.exitCode = 1;
});
