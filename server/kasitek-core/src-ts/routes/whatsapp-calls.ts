import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { extractUser, resolveActiveOrgId } from '../identity/session.js';
import { ApiError } from '../error.js';
import * as calls from '../services/whatsapp/calls.js';
import { object } from '../services/whatsapp/calls/types.js';
function optionalText(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string')
    throw new ApiError(400, 'bad_request', 'Invalid request');
  return value;
}
export function registerWhatsappCallRoutes(
  app: FastifyInstance,
  context: CoreContext,
  options: calls.CallsOptions = {},
) {
  async function scope(request: FastifyRequest) {
    const user = await extractUser(request, context);
    return resolveActiveOrgId(request, context, user.id);
  }
  const id = (r: FastifyRequest) => String(object(r.params).id),
    base = '/api/whatsapp/calls';
  app.get(base, async (r) => calls.listCalls(context.pool, await scope(r)));
  app.get(base + '/summary', async (r) => {
    const org = await scope(r),
      raw = object(r.query).days;
    let days = 7n;
    if (raw != null) {
      if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw))
        throw new ApiError(400, 'bad_request', 'Invalid request');
      days = BigInt(raw);
      if (days < -(1n << 63n) || days >= 1n << 63n)
        throw new ApiError(400, 'bad_request', 'Invalid request');
    }
    return calls.callSummary(context.pool, org, days);
  });
  app.get(base + '/:id', async (r) =>
    calls.getCall(context.pool, await scope(r), id(r)),
  );
  app.get(base + '/:id/signals', async (r) =>
    calls.listCallSignals(context.pool, await scope(r), id(r)),
  );
  app.get(base + '/:id/media-session', async (r) =>
    calls.getCallMediaSession(context.pool, await scope(r), id(r)),
  );
  function body(request: FastifyRequest) {
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body)
    )
      throw new ApiError(400, 'bad_request', 'Invalid request');
    return object(request.body);
  }
  app.post(base + '/:id/signals', async (r) => {
    const org = await scope(r),
      b = body(r);
    return calls.postCallSignal(
      context.pool,
      context.config,
      org,
      id(r),
      {
        kind: optionalText(b.kind),
        payload: b.payload,
        source: optionalText(b.source),
      },
      options,
    );
  });
  app.post(base + '/:id/action', async (r) => {
    const org = await scope(r),
      b = body(r);
    return calls.applyCallAction(
      context.pool,
      context.config,
      org,
      id(r),
      { action: optionalText(b.action) },
      options,
    );
  });
}
