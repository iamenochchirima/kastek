import { exampleAnswerSdp } from "../lib/example-answer.mjs";

export function createManualProvider(context) {
  async function onAction(callId, body) {
    const session = context.upsertSession(callId, {
      callId,
      waCallId: body.waCallId || context.getSession(callId)?.waCallId || null,
      status: context.getSession(callId)?.status || null,
      lastAction: body.action || null,
      lastActionPayload: body,
    });

    context.log("call.action", {
      callId,
      waCallId: body.waCallId || null,
      action: body.action || null,
      synthAnswerEnabled: context.synthAnswerEnabled,
    });

    let syntheticEvent = null;
    if (body.action === "accept" && context.synthAnswerEnabled) {
      syntheticEvent = await context.forwardProviderEvent(
        {
          callId,
          waCallId: body.waCallId,
          eventType: "provider_status",
          status: "CONNECTING",
          payload: {
            provider: context.provider,
            note: "Bridge acknowledged accept action in stub mode",
          },
          source: "bridge-stub",
        },
        { reason: "accept_action" },
      );
    }

    return {
      ok: true,
      session,
      synthAnswerEnabled: context.synthAnswerEnabled,
      syntheticEvent: syntheticEvent?.forwarded || null,
    };
  }

  async function onSignal(callId, body) {
    const session = context.upsertSession(callId, {
      callId,
      waCallId: body.waCallId || context.getSession(callId)?.waCallId || null,
      status: context.getSession(callId)?.status || null,
      lastSignalKind: body.kind || null,
      lastSignalPayload: body.signal || null,
    });

    context.log("call.signal", {
      callId,
      waCallId: body.waCallId || null,
      kind: body.kind || null,
      synthAnswerEnabled: context.synthAnswerEnabled,
    });

    const syntheticEvents = [];

    if (body.kind === "offer" && context.synthAnswerEnabled) {
      syntheticEvents.push(
        await context.forwardProviderEvent(
          {
            callId,
            waCallId: body.waCallId,
            eventType: "provider_answer",
            status: "ACTIVE",
            signalKind: "answer",
            signalPayload: {
              type: "answer",
              sdp: exampleAnswerSdp(),
            },
            payload: {
              provider: context.provider,
              note: "Bridge auto-generated answer in stub mode",
            },
            source: "bridge-stub",
          },
          { reason: "stub_offer_answer" },
        ),
      );

      syntheticEvents.push(
        await context.forwardProviderEvent(
          {
            callId,
            waCallId: body.waCallId,
            eventType: "provider_candidate",
            signalKind: "candidate",
            signalPayload: {
              candidate: "candidate:stub 1 udp 2122260223 127.0.0.1 3478 typ host",
              sdpMid: "0",
              sdpMLineIndex: 0,
            },
            payload: {
              provider: context.provider,
              note: "Bridge auto-generated ICE candidate in stub mode",
            },
            source: "bridge-stub",
          },
          { reason: "stub_offer_candidate" },
        ),
      );
    }

    if (body.kind === "bye" && context.synthAnswerEnabled) {
      syntheticEvents.push(
        await context.forwardProviderEvent(
          {
            callId,
            waCallId: body.waCallId,
            eventType: "provider_hangup",
            status: "COMPLETED",
            signalKind: "bye",
            signalPayload: body.signal || { reason: "remote-ended" },
            payload: {
              provider: context.provider,
              note: "Bridge acknowledged bye signal in stub mode",
            },
            source: "bridge-stub",
          },
          { reason: "stub_bye" },
        ),
      );
    }

    return {
      ok: true,
      session,
      synthAnswerEnabled: context.synthAnswerEnabled,
      syntheticEvents: syntheticEvents.map((event) => event.forwarded),
    };
  }

  return {
    name: "manual",
    onAction,
    onSignal,
  };
}
