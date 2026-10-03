import type { FastifyInstance, FastifyError, FastifyRequest } from "fastify";

type ValidationIssue = NonNullable<FastifyError["validation"]>[number];

function pointerParts(instancePath: string | undefined): string[] {
  if (!instancePath) return [];
  return instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function actualType(value: unknown): string {
  if (value === undefined) return "a missing value";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a sequence";
  if (typeof value === "string") return "a string";
  if (typeof value === "boolean") return "a boolean";
  if (typeof value === "bigint") return "an integer";
  if (typeof value === "number")
    return Number.isInteger(value) ? "an integer" : "a number";
  return "a map";
}

function expectedType(value: unknown): string {
  const labels: Record<string, string> = {
    array: "a sequence",
    boolean: "a boolean",
    integer: "an integer",
    null: "null",
    number: "a number",
    object: "a map",
    string: "a string",
  };
  if (Array.isArray(value))
    return value
      .map((item) => labels[String(item)] ?? String(item))
      .join(" or ");
  return labels[String(value)] ?? "a valid value";
}

function issueLocation(context: string | undefined, parts: readonly string[]) {
  const root = context === "querystring" ? "query" : context ?? "request";
  return parts.length ? ` at \`${root}.${parts.join(".")}\`` : "";
}

function extractionDetail(
  issues: NonNullable<FastifyError["validation"]>,
  context: string | undefined,
  request: FastifyRequest,
): string {
  const root =
    context === "querystring"
      ? request.query
      : context === "params"
        ? request.params
        : context === "headers"
          ? request.headers
          : request.body;
  const issue = issues[0] as ValidationIssue | undefined;
  if (!issue) return "Invalid request";

  const parts = pointerParts(issue.instancePath);
  const location = issueLocation(context, parts);
  const params = issue.params as Record<string, unknown> | undefined;
  if (
    issue.keyword === "required" &&
    typeof params?.missingProperty === "string"
  )
    return `missing field \`${params.missingProperty}\`${location}`;
  if (
    issue.keyword === "additionalProperties" &&
    typeof params?.additionalProperty === "string"
  )
    return `unknown field \`${params.additionalProperty}\`${location}`;
  if (issue.keyword === "type") {
    const actual = valueAtPath(root, parts);
    return `invalid type: ${actualType(actual)}, expected ${expectedType(params?.type)}${location}`;
  }
  if (issue.keyword === "enum")
    return `invalid value${location}; ${issue.message ?? "value is not allowed"}`;
  return `${issue.message ?? "invalid value"}${location}`;
}

/** Preserve the Rust API's {error,code} response and explicit status. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Framework extractors in Actix return text, unlike explicit domain AppError JSON. */
export class RequestExtractionError extends ApiError {
  constructor(
    public readonly extractor: "json" | "query",
    message = "Invalid request",
  ) {
    super(
      400,
      "bad_request",
      `${extractor === "json" ? "Json" : "Query"} deserialize error: ${message}`,
    );
    this.name = "RequestExtractionError";
  }
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof RequestExtractionError)
      return reply
        .code(error.status)
        .type("text/plain; charset=utf-8")
        .send(error.message);
    if (error instanceof ApiError) {
      if (error.status === 429) reply.header("retry-after", "60");
      return reply
        .code(error.status)
        .send({ error: error.message, code: error.code });
    }
    if ("validation" in error && error.validation) {
      const context = error.validationContext;
      const label = context === "querystring" ? "Query" : "Json";
      const detail = extractionDetail(error.validation, context, request);
      return reply
        .code(400)
        .type("text/plain; charset=utf-8")
        .send(`${label} deserialize error: ${detail}`);
    }
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      const bytes = request.headers["content-length"],
        limit = request.routeOptions.bodyLimit;
      const raw =
        [
          "/api/webhooks/whatsapp",
          "/api/webhooks/meta",
          "/api/webhooks/paystack",
          "/api/webhooks/tiktok",
        ].includes(request.routeOptions.url ?? "") ||
        (request.method === "DELETE" &&
          request.routeOptions.url === "/api/social/posts/:id");
      const message = raw
        ? "payload reached size limit"
        : bytes
          ? `JSON payload (${bytes} bytes) is larger than allowed (limit: ${limit} bytes).`
          : `JSON payload has exceeded limit (${limit} bytes).`;
      return reply.code(413).type("text/plain; charset=utf-8").send(message);
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE")
      return reply
        .code(
          request.routeOptions.url?.startsWith("/api/webhooks/twilio/")
            ? 415
            : 400,
        )
        .type("text/plain; charset=utf-8")
        .send("Content type error");
    if (
      error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      error.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    )
      return reply
        .code(400)
        .type("text/plain; charset=utf-8")
        .send("Json deserialize error: Invalid JSON");
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({ error: error.message, code: "bad_request" });
    }
    // Database error messages/details often contain row values or query parameters.
    const database = error as Error & {
      severity?: string;
      code?: string;
      table?: string;
      constraint?: string;
    };
    const isDatabase =
      typeof database.severity === "string" &&
      /^[A-Z0-9]{5}$/.test(database.code ?? "");
    request.log.error(
      {
        event: isDatabase ? "database.query.failed" : "operation.failed",
        error_type: error.name,
        ...(isDatabase
          ? {
              sqlstate: database.code,
              table: database.table,
              constraint: database.constraint,
            }
          : {}),
      },
      "Request failed",
    );
    return reply
      .code(500)
      .send({
        error: isDatabase
          ? "Database operation failed"
          : "Internal server error",
        code: "internal_error",
      });
  });
}
