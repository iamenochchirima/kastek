import pino from "pino";
import type { FastifyError } from "fastify";
import { currentCorrelationId } from "./context";
import { redactTelemetryText } from "./redaction";

function firstEnvironmentValue(names: string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return fallback;
}

export function operationalLogFields(): Record<string, string> {
  return {
    service_name: firstEnvironmentValue(["OTEL_SERVICE_NAME", "KASITEK_SERVICE_NAME"], "kasitek-agents"),
    deployment_environment: firstEnvironmentValue(["OTEL_DEPLOYMENT_ENVIRONMENT", "DEPLOYMENT_ENVIRONMENT", "NODE_ENV"], "unknown"),
    service_version: firstEnvironmentValue(["KASITEK_VERSION", "PLATFORM_VERSION"], "unknown"),
    release_id: firstEnvironmentValue(["KASITEK_RELEASE_ID", "RELEASE_ID", "KASITEK_VERSION"], "unknown"),
    commit_sha: firstEnvironmentValue(["KASITEK_COMMIT_SHA", "GIT_SHA", "COMMIT_SHA"], "unknown"),
  };
}

/** Fields that must never be emitted by an operational logger. */
export const operationalLogRedaction = {
  paths: [
    "authorization",
    "headers.authorization",
    "cookie",
    "headers.cookie",
    "set-cookie",
    "headers.set-cookie",
    "apiKey",
    "api_key",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "clientSecret",
    "client_secret",
    "token",
    "secret",
    "password",
    "body.messages",
    "body.prompt",
    "body.content",
  ],
  censor: "[REDACTED]",
};

/** Removes network identifiers and query strings from Fastify's request summaries. */
export const operationalLogSerializers = {
  req: (request: { method?: string; url?: string; httpVersion?: string; id?: string }) => ({
    id: request.id,
    method: request.method,
    url: request.url?.split(/[?#]/, 1)[0]?.slice(0, 256),
    version: request.httpVersion,
  }),
  res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
  err: (error: FastifyError) => ({
    type: redactTelemetryText(error.name, 128),
    code: redactTelemetryText(error.code, 128),
    message: redactTelemetryText(error.message, 512),
    stack: redactTelemetryText(error.stack ?? "", 4096),
  }),
};

/** Operational event identifiers are stable, lowercase, dot-separated names. */
export function isStableEventName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(value);
}

/** Shared operational logger for workers, migrations, and non-Fastify processes. */
export const operationalLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: operationalLogFields(),
  redact: operationalLogRedaction,
  serializers: operationalLogSerializers,
  formatters: {
    log: (object: Record<string, unknown>) => {
      if (object.event === undefined || isStableEventName(object.event)) return object;
      return {
        ...object,
        event: "operation.invalid.event",
        invalid_event: redactTelemetryText(object.event, 128),
      };
    },
  },
  mixin: () => {
    const correlationId = currentCorrelationId();
    return correlationId ? { correlation_id: correlationId } : {};
  },
});
