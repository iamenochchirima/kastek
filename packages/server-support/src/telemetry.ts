import {
  context,
  propagation,
  trace,
  metrics,
  SpanStatusCode,
} from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { envTruthy } from "./config.js";
export function redactTelemetryText(value: unknown, maxLength = 4096): string {
  return Array.from(String(value))
    .slice(0, maxLength)
    .join("")
    .replace(
      /(Bearer\s+)[^\s,;&]+|([?&](?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|key|code|signature|password|secret)=)[^&\s]+|((?:authorization|token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=])\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^,\s;&]+)/gi,
      (_match, bearer, query, field) => `${query ?? field ?? bearer}[REDACTED]`,
    );
}
const envFirst = (names: string[]): string =>
  names.map((n) => process.env[n]?.trim()).find(Boolean) ?? "unknown";
export function telemetryResource(serviceName: string) {
  return resourceFromAttributes({
    "service.name": process.env.OTEL_SERVICE_NAME || serviceName,
    "service.version": envFirst(["KASITEK_VERSION", "PLATFORM_VERSION"]),
    "deployment.environment.name": envFirst([
      "OTEL_DEPLOYMENT_ENVIRONMENT",
      "DEPLOYMENT_ENVIRONMENT",
      "ENVIRONMENT",
      "RAILWAY_ENVIRONMENT_NAME",
    ]),
    "kasitek.release_id": envFirst([
      "KASITEK_RELEASE_ID",
      "RELEASE_ID",
      "KASITEK_VERSION",
    ]),
    "kasitek.commit_sha": envFirst([
      "KASITEK_COMMIT_SHA",
      "GIT_SHA",
      "COMMIT_SHA",
    ]),
    "kasitek.artifact_digest": envFirst([
      "KASITEK_ARTIFACT_DIGEST",
      "ARTIFACT_DIGEST",
    ]),
    "kasitek.environment": envFirst([
      "OTEL_DEPLOYMENT_ENVIRONMENT",
      "DEPLOYMENT_ENVIRONMENT",
      "ENVIRONMENT",
      "RAILWAY_ENVIRONMENT_NAME",
    ]),
    "service.instance.id": envFirst([
      "KASITEK_INSTANCE_ID",
      "RAILWAY_REPLICA_ID",
      "HOSTNAME",
    ]),
    "process.runtime.name": "nodejs",
    "process.runtime.version": process.version,
  });
}
export function initTelemetry(serviceName: string): {
  shutdown: () => Promise<void>;
} {
  if (
    envTruthy("OTEL_SDK_DISABLED") ||
    ![
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    ].some((n) => process.env[n]?.trim())
  )
    return { shutdown: async () => {} };
  let sdk: NodeSDK;
  try {
    sdk = new NodeSDK({
      resource: telemetryResource(serviceName),
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-http": {
            redactedQueryParams: [
              "token",
              "access_token",
              "refresh_token",
              "api_key",
              "key",
              "code",
              "signature",
              "password",
              "secret",
            ],
            applyCustomAttributesOnSpan: (span, request) => {
              const raw = "path" in request ? request.path : request.url;
              const target = raw?.split(/[?#]/, 1)[0]?.slice(0, 256);
              if (target) {
                span.setAttribute("http.target", target);
                span.setAttribute("url.full", target);
              }
              for (const name of [
                "user_agent.original",
                "client.address",
                "client.port",
                "server.address",
                "server.port",
              ])
                span.setAttribute(name, "[REDACTED]");
            },
          },
          "@opentelemetry/instrumentation-pg": {
            enhancedDatabaseReporting: false,
          },
          "@opentelemetry/instrumentation-openai": { enabled: false },
          "@opentelemetry/instrumentation-aws-sdk": { enabled: false },
          "@opentelemetry/instrumentation-aws-lambda": { enabled: false },
        }),
      ],
    });
    sdk.start();
  } catch (error) {
    process.stderr.write(
      `OpenTelemetry initialization failed: ${redactTelemetryText(error, 512)}\n`,
    );
    return { shutdown: async () => {} };
  }
  return {
    shutdown: async () => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        sdk.shutdown().catch((error) => {
          process.stderr.write(
            `OpenTelemetry shutdown failed: ${redactTelemetryText(error, 512)}\n`,
          );
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
export function injectTraceContext(headers: Headers): void {
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  });
}
export const isSafeCorrelationId = (value: string): boolean =>
  /^[A-Za-z0-9._:-]{1,128}$/.test(value);
// SDK initialization occurs after this module is imported. Acquiring instruments
// before metrics.setGlobalMeterProvider permanently selects the no-op provider.
function createInstruments() {
  const meter = metrics.getMeter("kasitek");
  return {
    counter: meter.createCounter("kasitek.operation.count"),
    errors: meter.createCounter("kasitek.operation.error.count"),
    duration: meter.createHistogram("kasitek.operation.duration", { unit: "s" }),
    inFlight: meter.createUpDownCounter("kasitek.operation.in_flight"),
    retries: meter.createCounter("kasitek.operation.retry.count"),
    queue: meter.createHistogram("kasitek.queue.age", { unit: "s" }),
    failures: meter.createCounter("kasitek.dependency.failure.count"),
  };
}
let instruments: ReturnType<typeof createInstruments> | undefined;
const getInstruments = () => instruments ??= createInstruments();
const operationAttributes = (kind: string, name: string) => ({
  "operation.kind": kind,
  "operation.name": name,
});
export const recordRetry = (kind: string, name: string, count: number): void => {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  getInstruments().retries.add(count, operationAttributes(kind, name));
};
export const recordQueueAge = (name: string, ageSeconds: number): void =>
  getInstruments().queue.record(Math.max(0, ageSeconds), { "queue.name": name });
export const recordDependencyFailure = (
  provider: string,
  operation: string,
): void =>
  getInstruments().failures.add(1, {
    "peer.service": provider,
    "operation.name": operation,
  });
async function runResultSpan<T>(
  kind: string,
  name: string,
  spanName: string,
  spanAttributes: Record<string, string>,
  operation: () => Promise<T>,
  onError?: () => void,
): Promise<T> {
  return trace
    .getTracer("kasitek")
    .startActiveSpan(
      spanName,
      {
        attributes: {
          ...operationAttributes(kind, name),
          ...spanAttributes,
        },
      },
      async (span) => {
        const started = performance.now();
        const attributes = operationAttributes(kind, name);
        let outcome: "success" | "error" = "success";
        getInstruments().inFlight.add(1, attributes);
        try {
          const active = trace.setSpan(context.active(), span);
          const value = await context.with(active, operation);
          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute("otel.status_code", "OK");
          return value;
        } catch (error) {
          outcome = "error";
          getInstruments().errors.add(1, { ...attributes, outcome });
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute("otel.status_code", "ERROR");
          span.setAttribute(
            "exception.type",
            error instanceof Error ? error.name : typeof error,
          );
          onError?.();
          throw error;
        } finally {
          getInstruments().counter.add(1, { ...attributes, outcome });
          getInstruments().duration.record(
            (performance.now() - started) / 1000,
            { ...attributes, outcome },
          );
          getInstruments().inFlight.add(-1, attributes);
          span.end();
        }
      },
    );
}
export function resultSpan<T>(
  kind: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  return runResultSpan(kind, name, "kasitek.background", {}, operation);
}
export async function providerResultSpan<T>(
  provider: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runResultSpan(
    "dependency",
    operation,
    "kasitek.provider",
    { "peer.service": provider, "kasitek.provider.operation": operation },
    fn,
    () => recordDependencyFailure(provider, operation),
  );
}
