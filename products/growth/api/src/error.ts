import type { FastifyInstance, FastifyError, FastifyRequest } from "fastify";
import { formatSerdeValidationError } from "@kasitek-labs/server-support/json";

const urlencodedFormRoutes = new Set([
  "/oauth/token",
  "/oauth/revoke",
  "/api/auth/backchannel-logout",
  "/api/social/oauth/threads/uninstall",
  "/api/social/oauth/threads/data-deletion",
]);

export function acceptsUrlencodedForm(route: string | undefined): boolean {
  return route !== undefined && urlencodedFormRoutes.has(route);
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
  return formatSerdeValidationError(issues, context, root);
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
    public readonly extractor: "json" | "query" | "form",
    message = "Invalid request",
    status = 400,
  ) {
    const detail = extractor === "form"
      ? message
      : `${extractor === "json" ? "Json" : "Query"} deserialize error: ${message}`;
    super(status, "bad_request", detail);
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
      const form = acceptsUrlencodedForm(request.routeOptions.url);
      const raw =
        [
          "/api/webhooks/whatsapp",
          "/api/webhooks/meta",
          "/api/webhooks/tiktok",
        ].includes(request.routeOptions.url ?? "") ||
        (request.method === "DELETE" &&
          request.routeOptions.url === "/api/social/posts/:id");
      const message = form
        ? bytes
          ? `URL encoded payload is larger (${bytes} bytes) than allowed (limit: ${limit} bytes).`
          : `URL encoded payload has exceeded limit (limit: ${limit} bytes).`
        : raw
          ? "payload reached size limit"
          : bytes
            ? `JSON payload (${bytes} bytes) is larger than allowed (limit: ${limit} bytes).`
            : `JSON payload has exceeded limit (${limit} bytes).`;
      return reply.code(413).type("text/plain; charset=utf-8").send(message);
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      const form = urlencodedFormRoutes.has(request.routeOptions.url ?? "");
      return reply
        .code(
          form || request.routeOptions.url?.startsWith("/api/webhooks/twilio/")
            ? 415
            : 400,
        )
        .type("text/plain; charset=utf-8")
        .send(form ? "Content type error." : "Content type error");
    }
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
