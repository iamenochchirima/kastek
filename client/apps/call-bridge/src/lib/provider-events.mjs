function normalizeEventType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");

  switch (normalized) {
    case "status":
    case "provider_status":
    case "remote_status":
      return "provider_status";
    case "signal":
    case "provider_signal":
    case "remote_signal":
      return "provider_signal";
    case "answer":
    case "provider_answer":
    case "remote_answer":
      return "provider_answer";
    case "candidate":
    case "provider_candidate":
    case "remote_candidate":
      return "provider_candidate";
    case "hangup":
    case "bye":
    case "end":
    case "provider_hangup":
    case "remote_hangup":
      return "provider_hangup";
    default:
      return normalized || null;
  }
}

function normalizeStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  switch (normalized) {
    case "RINGING":
    case "CONNECTING":
    case "ACTIVE":
    case "COMPLETED":
    case "REJECTED":
    case "MISSED":
    case "FAILED":
    case "CANCELLED":
      return normalized;
    case "":
      return undefined;
    default:
      return normalized;
  }
}

function normalizeSignalKind(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  switch (normalized) {
    case "offer":
    case "answer":
    case "candidate":
    case "bye":
      return normalized;
    case "":
      return undefined;
    default:
      return normalized;
  }
}

export function normalizeProviderEvent(input, seed = {}) {
  return {
    callId: input.callId || seed.callId,
    waCallId: input.waCallId || seed.waCallId,
    eventType: normalizeEventType(input.eventType || seed.eventType),
    status: normalizeStatus(input.status),
    signalKind: normalizeSignalKind(input.signalKind || seed.signalKind),
    signalPayload: input.signalPayload || seed.signalPayload,
    payload: input.payload,
    source: input.source || seed.source || "bridge-provider",
  };
}
