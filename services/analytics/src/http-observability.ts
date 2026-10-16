import {randomUUID} from 'node:crypto';
import {
  context,
  metrics,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {isSafeCorrelationId} from '@kasitek-labs/server-support/telemetry';

type RequestState = {
  span: Span;
  started: number;
  method: string;
  route: string;
  finished: boolean;
};

function requestParent(request: FastifyRequest) {
  const carrier = {
    traceparent: request.headers.traceparent,
    tracestate: request.headers.tracestate,
  };
  const parent = propagation.deleteBaggage(context.active());
  return propagation.extract(parent, carrier, {
    keys: (value) => Object.keys(value),
    get: (value, key) =>
      typeof value[key as keyof typeof value] === 'string'
        ? (value[key as keyof typeof value] as string)
        : undefined,
  });
}

/** Preserve the Analytics API's bounded Rust HTTP spans and request metrics. */
export function installHttpObservability(app: FastifyInstance): void {
  const meter = metrics.getMeter('kasitek.http');
  const count = meter.createCounter('http.server.request.count');
  const duration = meter.createHistogram('http.server.request.duration', {
    unit: 's',
  });
  const errors = meter.createCounter('http.server.request.error.count');
  const inFlight = meter.createUpDownCounter('http.server.request.in_flight');
  const state = new WeakMap<FastifyRequest, RequestState>();

  const finish = (request: FastifyRequest, status: number) => {
    const item = state.get(request);
    if (!item || item.finished) return;
    item.finished = true;

    const attributes = {
      'http.request.method': item.method,
      'http.route': item.route,
      'http.response.status_code': status,
    };
    const seconds = (performance.now() - item.started) / 1000;
    inFlight.add(-1, {
      'http.request.method': item.method,
      'http.route': item.route,
    });
    count.add(1, attributes);
    duration.record(seconds, attributes);
    if (status >= 500 || status === 499) errors.add(1, attributes);

    item.span.setAttribute('http.response.status_code', status);
    item.span.setAttribute('http.status_code', status);
    const failed = status >= 500 || status === 499;
    item.span.setStatus({
      code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    item.span.setAttribute('otel.status_code', failed ? 'ERROR' : 'OK');
    item.span.end();

    const fields = {
      event: 'http.request.completed',
      method: item.method,
      route: item.route,
      status,
      duration_seconds: seconds,
    };
    if (status >= 500) request.log.error(fields, 'HTTP request completed');
    else if (status >= 400) request.log.warn(fields, 'HTTP request completed');
    else request.log.info(fields, 'HTTP request completed');
  };

  app.addHook('onRequest', (request, reply, done) => {
    const supplied = request.headers['x-correlation-id'];
    const candidate =
      typeof supplied === 'string' && isSafeCorrelationId(supplied.trim())
        ? supplied.trim()
        : request.id;
    const correlationId = isSafeCorrelationId(candidate)
      ? candidate
      : randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    reply.header('x-correlation-id', correlationId);

    const method = request.method;
    const route = (request.routeOptions.url ?? 'unmatched')
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      .slice(0, 128);
    const target = request.url.split(/[?#]/, 1)[0]!.slice(0, 256);
    const span = trace.getTracer('kasitek-analytics').startSpan(
      `${method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': method,
          'http.method': method,
          'http.route': route,
          'http.target': target,
          'http.flavor': request.raw.httpVersion,
          correlation_id: correlationId,
        },
      },
      requestParent(request),
    );

    state.set(request, {
      span,
      started: performance.now(),
      method,
      route,
      finished: false,
    });
    inFlight.add(1, { 'http.request.method': method, 'http.route': route });

    request.log = request.log.child({correlation_id: correlationId});
    reply.raw.once('close', () =>
      finish(request, reply.raw.writableFinished ? reply.statusCode : 499),
    );
    context.with(trace.setSpan(context.active(), span), done);
  });

  app.addHook('onResponse', (request, reply, done) => {
    finish(request, reply.statusCode);
    done();
  });
}
