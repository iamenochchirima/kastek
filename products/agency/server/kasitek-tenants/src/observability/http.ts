import {
  context,
  metrics,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  correlationId,
  extractRequestTrace,
  withCorrelationId,
} from "./context.js";
export function installHttpObservability(app: FastifyInstance): void {
  const meter = metrics.getMeter("kasitek.http"),
    count = meter.createCounter("http.server.request.count"),
    duration = meter.createHistogram("http.server.request.duration", {
      unit: "s",
    }),
    errors = meter.createCounter("http.server.request.error.count"),
    inFlight = meter.createUpDownCounter("http.server.request.in_flight");
  const state = new WeakMap<
    FastifyRequest,
    {
      span: Span;
      started: number;
      method: string;
      route: string;
      finished: boolean;
    }
  >();
  const finish = (request: FastifyRequest, status: number) => {
    const item = state.get(request);
    if (!item || item.finished) return;
    item.finished = true;
    const attributes = {
      "http.request.method": item.method,
      "http.route": item.route,
      "http.response.status_code": status,
    };
    const seconds = (performance.now() - item.started) / 1000;
    inFlight.add(-1, {
      "http.request.method": item.method,
      "http.route": item.route,
    });
    count.add(1, attributes);
    duration.record(seconds, attributes);
    if (status >= 500 || status === 499) errors.add(1, attributes);
    item.span.setAttribute("http.response.status_code", status);
    item.span.setAttribute("http.status_code", status);
    const statusCode =
      status >= 500 || status === 499
        ? SpanStatusCode.ERROR
        : SpanStatusCode.OK;
    item.span.setStatus({ code: statusCode });
    item.span.setAttribute(
      "otel.status_code",
      statusCode === SpanStatusCode.ERROR ? "ERROR" : "OK",
    );
    item.span.end();
    const fields = {
      event: "http.request.completed",
      method: item.method,
      route: item.route,
      status,
      duration_seconds: seconds,
    };
    if (status >= 500) request.log.error(fields, "HTTP request completed");
    else if (status >= 400) request.log.warn(fields, "HTTP request completed");
    else request.log.info(fields, "HTTP request completed");
  };
  app.addHook("onRequest", (request, reply, done) => {
    const id = correlationId(request.headers["x-correlation-id"]);
    request.headers["x-correlation-id"] = id;
    reply.header("x-correlation-id", id);
    const method = request.method,
      route = (request.routeOptions.url ?? "unmatched")
        .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
        .slice(0, 128);
    const span = trace
      .getTracer("kasitek-tenants")
      .startSpan(
        `${method} ${route}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            "http.request.method": method,
            "http.method": method,
            "http.route": route,
            "http.target": route,
            "http.flavor": request.raw.httpVersion,
            correlation_id: id,
          },
        },
        extractRequestTrace(request.headers),
      );
    state.set(request, {
      span,
      started: performance.now(),
      method,
      route,
      finished: false,
    });
    inFlight.add(1, { "http.request.method": method, "http.route": route });
    request.log = request.log.child({ correlation_id: id });
    reply.raw.once("close", () =>
      finish(request, reply.raw.writableFinished ? reply.statusCode : 499),
    );
    context.with(trace.setSpan(context.active(), span), () =>
      withCorrelationId(id, done),
    );
  });
  app.addHook("onResponse", (request, reply, done) => {
    finish(request, reply.statusCode);
    done();
  });
}
