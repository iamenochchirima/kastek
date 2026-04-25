function ensureValue(value, message) {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }
  return value;
}

export function createBridgeContext(env = process.env) {
  const port = Number.parseInt(env.PORT || "8787", 10);
  const kasitekBaseUrl = (env.KASITEK_API_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
  const bridgeToken = env.WHATSAPP_CALL_BRIDGE_TOKEN || "";
  const bridgeMode = (env.WHATSAPP_CALL_BRIDGE_MODE || "stub").trim().toLowerCase();
  const provider = (env.WHATSAPP_CALL_PROVIDER || "manual").trim() || "manual";
  const synthAnswerEnabled = bridgeMode === "stub";
  const serviceName = "kasitek-call-bridge";
  const callSessions = new Map();
  const providerTasks = new Map();

  function log(event, payload = {}) {
    console.log(
      JSON.stringify({
        service: serviceName,
        event,
        bridgeMode,
        provider,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    );
  }

  function bridgeAuthorized(request) {
    if (!bridgeToken) return true;
    return request.headers["x-kasitek-call-bridge-token"] === bridgeToken;
  }

  function getSession(callId) {
    return callSessions.get(callId) || null;
  }

  function upsertSession(callId, patch) {
    const current = getSession(callId) || { callId, createdAt: new Date().toISOString() };
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    callSessions.set(callId, next);
    return next;
  }

  function sessionSummary(session) {
    if (!session) return null;
    return {
      callId: session.callId,
      waCallId: session.waCallId || null,
      status: session.status || null,
      lastAction: session.lastAction || null,
      lastSignalKind: session.lastSignalKind || null,
      lastProviderEventType: session.lastProviderEventType || null,
      pendingProviderAction: session.pendingProviderAction || null,
      pendingProviderSignal: session.pendingProviderSignal || null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  function listProviderTasks() {
    return [...providerTasks.values()].sort((left, right) =>
      String(left.createdAt).localeCompare(String(right.createdAt)),
    );
  }

  function createProviderTask(input) {
    const id =
      globalThis.crypto?.randomUUID?.() ||
      `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const task = {
      id,
      callId: input.callId,
      waCallId: input.waCallId || null,
      provider: input.provider || provider,
      kind: input.kind,
      payload: input.payload || {},
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      claimedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };
    providerTasks.set(id, task);
    return task;
  }

  function getProviderTask(taskId) {
    return providerTasks.get(taskId) || null;
  }

  function claimProviderTask(taskId) {
    const task = getProviderTask(taskId);
    if (!task) return null;
    const next = {
      ...task,
      status: "claimed",
      attempts: Number(task.attempts || 0) + 1,
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    providerTasks.set(taskId, next);
    return next;
  }

  function completeProviderTask(taskId, patch = {}) {
    const task = getProviderTask(taskId);
    if (!task) return null;
    const next = {
      ...task,
      status: patch.status || "completed",
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: patch.result ?? task.result ?? null,
      error: patch.error ?? null,
    };
    providerTasks.set(taskId, next);
    return next;
  }

  async function postBridgeEvent(payload) {
    if (!bridgeToken) {
      throw new Error("WHATSAPP_CALL_BRIDGE_TOKEN is required");
    }

    const response = await fetch(`${kasitekBaseUrl}/api/webhooks/whatsapp/calls/bridge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kasitek-call-bridge-token": bridgeToken,
      },
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Bridge webhook failed with status ${response.status}`);
    }
    return body;
  }

  async function forwardProviderEvent(input, metadata = {}) {
    const payload = {
      callId: input.callId,
      waCallId: input.waCallId,
      eventType: input.eventType,
      status: input.status,
      signalKind: input.signalKind,
      signalPayload: input.signalPayload,
      payload: input.payload || {},
      source: input.source || "bridge-provider",
    };

    ensureValue(payload.callId || payload.waCallId, "callId or waCallId is required");
    ensureValue(payload.eventType, "eventType is required");

    const callId = payload.callId || payload.waCallId;
    const existing = getSession(callId);
    const session = upsertSession(callId, {
      callId,
      waCallId: payload.waCallId || existing?.waCallId || null,
      status: payload.status || existing?.status || null,
      lastProviderEventType: payload.eventType,
      lastProviderEventPayload: payload,
      lastSignalKind: payload.signalKind || existing?.lastSignalKind || null,
      lastSignalPayload: payload.signalPayload || existing?.lastSignalPayload || null,
    });

    log("provider_event.forward", {
      callId,
      waCallId: payload.waCallId || null,
      eventType: payload.eventType,
      status: payload.status || null,
      signalKind: payload.signalKind || null,
      ...metadata,
    });

    const forwarded = await postBridgeEvent(payload);
    return { forwarded, session };
  }

  return {
    port,
    kasitekBaseUrl,
    bridgeToken,
    bridgeMode,
    provider,
    synthAnswerEnabled,
    serviceName,
    callSessions,
    providerTasks,
    log,
    bridgeAuthorized,
    getSession,
    upsertSession,
    sessionSummary,
    listProviderTasks,
    createProviderTask,
    getProviderTask,
    claimProviderTask,
    completeProviderTask,
    forwardProviderEvent,
  };
}
