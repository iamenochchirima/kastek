import { existsSync } from "node:fs";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from "@opentelemetry/semantic-conventions";
import { currentCorrelationId } from "./telemetry/context";

if (existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");

function firstEnvironmentValue(names: string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return fallback;
}

function telemetryConfigured(): boolean {
  if (["1", "true", "yes", "on"].includes((process.env.OTEL_SDK_DISABLED ?? "").toLowerCase())) return false;
  return [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  ].some((name) => Boolean(process.env[name]?.trim()));
}

const serviceName = firstEnvironmentValue(["OTEL_SERVICE_NAME", "KASITEK_SERVICE_NAME"], "kasitek-agents");
const serviceVersion = firstEnvironmentValue(["KASITEK_VERSION", "PLATFORM_VERSION"], "unknown");
const releaseId = firstEnvironmentValue(["KASITEK_RELEASE_ID", "RELEASE_ID", "KASITEK_VERSION"], "unknown");
const commitSha = firstEnvironmentValue(["KASITEK_COMMIT_SHA", "GIT_SHA", "COMMIT_SHA"], "unknown");
const deploymentEnvironment = firstEnvironmentValue(["OTEL_DEPLOYMENT_ENVIRONMENT", "DEPLOYMENT_ENVIRONMENT", "NODE_ENV"], "unknown");

let sdk: NodeSDK | undefined;
let shutdownPromise: Promise<void> | undefined;

if (telemetryConfigured()) {
  try {
    sdk = new NodeSDK({
      serviceName,
      resource: defaultResource().merge(resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: serviceVersion,
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: deploymentEnvironment,
        "kasitek.release_id": releaseId,
        "kasitek.commit_sha": commitSha,
        "kasitek.environment": deploymentEnvironment,
      })),
      instrumentations: [getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-http": {
          redactedQueryParams: ["token", "access_token", "refresh_token", "api_key", "key", "code", "signature"],
          applyCustomAttributesOnSpan: (span, request) => {
            const rawTarget = "path" in request ? request.path : request.url;
            const target = rawTarget?.split(/[?#]/, 1)[0]?.slice(0, 256);
            if (target) {
              span.setAttribute("http.target", target);
              span.setAttribute("url.full", target);
            }
            for (const attribute of ["user_agent.original", "client.address", "client.port", "server.address", "server.port"]) {
              span.setAttribute(attribute, "[REDACTED]");
            }
          },
        },
        "@opentelemetry/instrumentation-openai": { enabled: false },
        "@opentelemetry/instrumentation-aws-sdk": { enabled: false },
        "@opentelemetry/instrumentation-aws-lambda": { enabled: false },
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-host-metrics": { enabled: false },
        "@opentelemetry/instrumentation-pino": {
          disableLogCorrelation: false,
          disableLogSending: false,
          logKeys: { traceId: "trace_id", spanId: "span_id", traceFlags: "trace_flags" },
          logHook: (_span, record) => {
            const correlationId = currentCorrelationId();
            if (correlationId) record.correlation_id = correlationId;
          },
        },
      })],
    });
    sdk.start();
  } catch (error) {
    sdk = undefined;
    process.stderr.write(`OpenTelemetry initialization failed; continuing with structured stdout logging: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  shutdownPromise ??= Promise.race([
    sdk.shutdown().catch((error: unknown) => {
      process.stderr.write(`OpenTelemetry shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        process.stderr.write("OpenTelemetry shutdown exceeded the 3 second limit\n");
        resolve();
      }, 3_000);
      timer.unref();
    }),
  ]);
  await shutdownPromise;
}
