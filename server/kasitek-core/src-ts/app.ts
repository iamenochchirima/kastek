import { installHttpObservability } from "./observability/http.js";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { isIP } from "node:net";
import type { CoreContext } from "./context.js";
import { acceptsUrlencodedForm, installErrorHandler, RequestExtractionError } from "./error.js";
import { formatSerdeJsonSyntaxError } from "@kasitek-labs/server-support/json";
import { redactTelemetryLogArguments } from "@kasitek-labs/server-support/telemetry";
import { apiJson } from "./json.js";
import {
  parseRequestJson,
  validateIntegerTokenSchema,
  normalizeTypedNumberSchema,
  normalizeRustNumericContract,
  normalizeRustValueFields,
  isSerdeValueBodyBoundary,
  normalizeSerdeValueBodyBoundary,
} from "./identity/json-body.js";

export type RouteRegistrar = (
  app: FastifyInstance,
  context: CoreContext,
) => void | Promise<void>;

export async function buildApp(
  context: CoreContext,
  registrars: RouteRegistrar[] = [],
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    exposeHeadRoutes: false,
    // Serde does not coerce JSON fields or silently remove unknown properties.
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
      },
    },
    logger: {
      level: context.config.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
      ],
      hooks: {
        logMethod(args, method) {
          return method.apply(this, redactTelemetryLogArguments(args));
        },
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  installHttpObservability(app);
  installErrorHandler(app);
  app.setNotFoundHandler((request, reply) => {
    // Most Rust cfg.route registrations have method guards at resource selection,
    // returning an empty 404. Waitlist alone uses web::resource and returns 405.
    if (
      request.url.split("?")[0] === "/api/waitlist" &&
      request.method !== "POST" &&
      app.hasRoute({ method: "POST", url: "/api/waitlist" })
    )
      return reply.code(405).header("allow", "POST").send();
    return reply.code(404).send();
  });
  // Actix selects the resource before invoking its extractors. Unknown paths and
  // method-guard misses therefore never attempt to decode their request body.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.is404) return;
    if (
      request.url.split("?")[0] === "/api/waitlist" &&
      request.method !== "POST" &&
      app.hasRoute({ method: "POST", url: "/api/waitlist" })
    )
      return reply.code(405).header("allow", "POST").send();
    return reply.code(404).send();
  });
  app.setReplySerializer(apiJson);
  // Keep Fastify's prototype-poisoning checks while retaining integer JSON tokens above 2^53.
  const safeJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    /^application\/(?:[a-z0-9.-]+\+)?json$/i,
    { parseAs: "string" },
    (request, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      let parsed: unknown;
      try {
        parsed = parseRequestJson(request, text);
      } catch (error) {
        return done(
          new RequestExtractionError(
            "json",
            formatSerdeJsonSyntaxError(text, error),
          ),
        );
      }
      safeJson(request, text, (error) => {
        if (error) return done(error);
        done(null, parsed);
      });
    },
  );
  app.addHook("preValidation", async (request) => {
    const mediaType = request.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      mediaType === "application/x-www-form-urlencoded" &&
      !acceptsUrlencodedForm(request.routeOptions.url)
    )
      throw new RequestExtractionError("json", "Content type error");
    if (isSerdeValueBodyBoundary(request)) {
      normalizeSerdeValueBodyBoundary(request);
    } else {
      validateIntegerTokenSchema(request, request.routeOptions.schema?.body);
      normalizeTypedNumberSchema(request, request.routeOptions.schema?.body);
      normalizeRustNumericContract(request);
      normalizeRustValueFields(request);
    }
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  await app.register(cors, {
    delegator: (request, callback) => {
      const value = request.headers.origin;
      let allowed = value === context.config.frontendUrl;
      if (value) {
        try {
          const parsed = new URL(value);
          const http = ["http:", "https:"].includes(parsed.protocol);
          if (http && request.url.startsWith("/api/widget/v1/")) allowed = true;
          const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
          const loopback =
            hostname === "localhost" ||
            hostname === "::1" ||
            (isIP(hostname) === 4 && hostname.startsWith("127."));
          const local = ["development", "dev", "local", "test"].includes(
            context.config.environment.toLowerCase(),
          );
          if (
            http &&
            local &&
            loopback &&
            !parsed.username &&
            !parsed.password &&
            parsed.pathname === "/" &&
            !parsed.search &&
            !parsed.hash
          )
            allowed = true;
        } catch {
          /* Invalid origins are not reflected. */
        }
      }
      callback(null, {
        origin: allowed,
        credentials: true,
        maxAge: 3600,
        methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "Idempotency-Key",
          "X-Audio-Idempotency-Key",
          "X-Audio-File-Name",
          "X-Audio-Caption",
          "X-Audio-Display-Name",
        ],
      });
    },
  });
  const health = () => ({
    service: "kasitek-core",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
  app.get("/", health);
  app.get("/health", health);
  for (const register of registrars) await register(app, context);
  return app;
}
