import { normalizeProviderEvent } from "../lib/provider-events.mjs";

function normalizeMetaProviderEvent(body, seed = {}) {
  const candidateSignalPayload =
    body.signalPayload ||
    body.signal ||
    (body.sdp ? { type: body.signalKind || body.kind || "answer", sdp: body.sdp } : undefined);

  return normalizeProviderEvent(
    {
      callId: body.callId || body.call_id || seed.callId,
      waCallId: body.waCallId || body.wa_call_id || body.call_id || seed.waCallId,
      eventType: body.eventType || body.event_type || body.type || seed.eventType,
      status: body.status || body.state || body.callStatus || body.call_status,
      signalKind: body.signalKind || body.signal_kind || body.kind || body.signal_type,
      signalPayload: candidateSignalPayload,
      payload: body.payload || body.providerPayload || body.provider_payload || body,
      source: body.source || "meta-cloud-api",
    },
    seed,
  );
}

export function createMetaCloudApiProvider(context) {
  async function onAction(callId, body) {
    const providerTask = context.createProviderTask({
      callId,
      waCallId: body.waCallId || context.getSession(callId)?.waCallId || null,
      kind: "action",
      payload: {
        action: body.action || null,
        request: body,
      },
    });

    const session = context.upsertSession(callId, {
      callId,
      waCallId: body.waCallId || context.getSession(callId)?.waCallId || null,
      status: context.getSession(callId)?.status || null,
      lastAction: body.action || null,
      lastActionPayload: body,
      pendingProviderAction: {
        action: body.action || null,
        requestedAt: new Date().toISOString(),
        taskId: providerTask.id,
      },
    });

    context.log("call.action.meta_cloud_api", {
      callId,
      waCallId: body.waCallId || null,
      action: body.action || null,
      synthAnswerEnabled: context.synthAnswerEnabled,
    });

    return {
      ok: true,
      session,
      requiresProviderRelay: true,
      provider: "meta-cloud-api",
      providerTask,
      note: "Action recorded for real provider handling. No synthetic answer is generated in this mode.",
    };
  }

  async function onSignal(callId, body) {
    const providerTask = context.createProviderTask({
      callId,
      waCallId: body.waCallId || context.getSession(callId)?.waCallId || null,
      kind: "signal",
      payload: {
        kind: body.kind || null,
        signal: body.signal || null,
        request: body,
      },
    });

    const session = context.upsertSession(callId, {
      callId,
      waCallId: body.waCallId || context.getSession(callId)?.waCallId || null,
      status: context.getSession(callId)?.status || null,
      lastSignalKind: body.kind || null,
      lastSignalPayload: body.signal || null,
      pendingProviderSignal: {
        kind: body.kind || null,
        requestedAt: new Date().toISOString(),
        taskId: providerTask.id,
      },
    });

    context.log("call.signal.meta_cloud_api", {
      callId,
      waCallId: body.waCallId || null,
      kind: body.kind || null,
      synthAnswerEnabled: context.synthAnswerEnabled,
    });

    return {
      ok: true,
      session,
      requiresProviderRelay: true,
      provider: "meta-cloud-api",
      providerTask,
      note: "Signal recorded for real provider handling. No synthetic answer is generated in this mode.",
    };
  }

  return {
    name: "meta-cloud-api",
    onAction,
    onSignal,
    normalizeProviderEvent: normalizeMetaProviderEvent,
  };
}
