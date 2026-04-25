import { createServer } from "node:http";

import { createBridgeContext } from "./lib/bridge-context.mjs";
import { exampleAnswerSdp } from "./lib/example-answer.mjs";
import { json, notFound, readJsonBody } from "./lib/http.mjs";
import { normalizeProviderEvent } from "./lib/provider-events.mjs";
import { createProviderAdapter } from "./providers/index.mjs";

const context = createBridgeContext();
const providerAdapter = createProviderAdapter(context);

function requireBridgeAuthorization(request, response) {
  if (!context.bridgeAuthorized(request)) {
    json(response, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

async function handleCallAction(request, response, callId) {
  if (!requireBridgeAuthorization(request, response)) return;

  try {
    const body = await readJsonBody(request);
    const result = await providerAdapter.onAction(callId, body);
    json(response, 200, result);
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Failed to process action" });
  }
}

async function handleCallSignal(request, response, callId) {
  if (!requireBridgeAuthorization(request, response)) return;

  try {
    const body = await readJsonBody(request);
    const result = await providerAdapter.onSignal(callId, body);
    json(response, 200, result);
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Failed to process signal" });
  }
}

async function handleProviderEvent(request, response, seed = {}) {
  if (!requireBridgeAuthorization(request, response)) return;

  try {
    const body = await readJsonBody(request);
    const normalizedEvent = providerAdapter.normalizeProviderEvent
      ? providerAdapter.normalizeProviderEvent(body, seed)
      : normalizeProviderEvent(body, seed);
    const result = await context.forwardProviderEvent(normalizedEvent, {
      path: seed.path || "provider_event",
      normalizedEventType: normalizedEvent.eventType,
      normalizedStatus: normalizedEvent.status || null,
      normalizedSignalKind: normalizedEvent.signalKind || null,
    });

    json(response, 200, {
      ok: true,
      session: result.session,
      forwarded: result.forwarded,
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Failed to forward provider event" });
  }
}

async function handleProviderTaskClaim(request, response, taskId) {
  if (!requireBridgeAuthorization(request, response)) return;

  const task = context.claimProviderTask(taskId);
  if (!task) {
    json(response, 404, { error: "Provider task not found" });
    return;
  }

  context.log("provider_task.claimed", {
    taskId,
    callId: task.callId,
    kind: task.kind,
    attempts: task.attempts,
  });

  json(response, 200, { ok: true, task });
}

async function handleClaimNextProviderTask(request, response) {
  if (!requireBridgeAuthorization(request, response)) return;

  try {
    const body =
      request.method === "POST"
        ? await readJsonBody(request)
        : {};

    const task = context.claimNextProviderTask({
      provider: body.provider || null,
      kind: body.kind || null,
    });

    if (!task) {
      json(response, 404, { error: "No pending provider task available" });
      return;
    }

    context.log("provider_task.claimed_next", {
      taskId: task.id,
      callId: task.callId,
      kind: task.kind,
      provider: task.provider,
      attempts: task.attempts,
    });

    json(response, 200, { ok: true, task });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Failed to claim next provider task" });
  }
}

async function handleProviderTaskResult(request, response, taskId) {
  if (!requireBridgeAuthorization(request, response)) return;

  try {
    const body = await readJsonBody(request);
    const existingTask = context.getProviderTask(taskId);
    if (!existingTask) {
      json(response, 404, { error: "Provider task not found" });
      return;
    }

    const task = context.completeProviderTask(taskId, {
      status: body.status || "completed",
      result: body.result,
      error: body.error || null,
    });

    const providerEvents = Array.isArray(body.providerEvents)
      ? body.providerEvents
      : body.providerEvent
        ? [body.providerEvent]
        : [];
    const forwardedEvents = [];

    for (const event of providerEvents) {
      const normalizedEvent = providerAdapter.normalizeProviderEvent
        ? providerAdapter.normalizeProviderEvent(event, {
            callId: existingTask.callId,
            waCallId: existingTask.waCallId,
            path: "provider/tasks/:id/result",
          })
        : normalizeProviderEvent(event, {
            callId: existingTask.callId,
            waCallId: existingTask.waCallId,
          });

      const forwarded = await context.forwardProviderEvent(normalizedEvent, {
        path: "provider/tasks/:id/result",
        taskId,
        normalizedEventType: normalizedEvent.eventType,
        normalizedStatus: normalizedEvent.status || null,
        normalizedSignalKind: normalizedEvent.signalKind || null,
      });
      forwardedEvents.push(forwarded.forwarded);
    }

    context.log("provider_task.completed", {
      taskId,
      callId: task.callId,
      kind: task.kind,
      status: task.status,
      hasError: Boolean(task.error),
      forwardedEventCount: forwardedEvents.length,
    });

    json(response, 200, {
      ok: true,
      task,
      forwardedEvent: forwardedEvents[0] || null,
      forwardedEvents,
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Failed to store provider task result" });
  }
}

const server = createServer(async (request, response) => {
  if (!request.url) {
    notFound(response);
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, {
      ok: true,
      service: context.serviceName,
      bridgeMode: context.bridgeMode,
      provider: context.provider,
      kasitekBaseUrl: context.kasitekBaseUrl,
      hasBridgeToken: Boolean(context.bridgeToken),
      synthAnswerEnabled: context.synthAnswerEnabled,
      sessionsTracked: context.callSessions.size,
      adapter: providerAdapter.name,
      providerIngressMode: providerAdapter.normalizeProviderEvent ? "adapter-specific" : "generic",
      providerTasksTracked: context.providerTasks.size,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    json(response, 200, {
      service: context.serviceName,
      bridgeMode: context.bridgeMode,
      provider: context.provider,
      adapter: providerAdapter.name,
      synthAnswerEnabled: context.synthAnswerEnabled,
      providerIngressMode: providerAdapter.normalizeProviderEvent ? "adapter-specific" : "generic",
      endpoints: [
        "GET /health",
        "GET /sessions",
        "GET /sessions/:id",
        "GET /provider/tasks",
        "GET /provider/tasks/:id",
        "POST /calls/:id/actions",
        "POST /calls/:id/signals",
        "POST /provider/events",
        "POST /provider/calls/:id/status",
        "POST /provider/calls/:id/signals",
        "POST /provider/meta/events",
        "POST /provider/tasks/claim-next",
        "POST /provider/tasks/:id/claim",
        "POST /provider/tasks/:id/result",
        "POST /simulate/status",
        "POST /simulate/signal",
        "POST /simulate/answer",
        "POST /simulate/candidate",
      ],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/provider/tasks") {
    if (!requireBridgeAuthorization(request, response)) return;
    json(response, 200, {
      tasks: context.listProviderTasks(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/provider/tasks/claim-next") {
    await handleClaimNextProviderTask(request, response);
    return;
  }

  const providerTaskMatch = request.method === "GET" ? url.pathname.match(/^\/provider\/tasks\/([^/]+)$/) : null;
  if (providerTaskMatch) {
    if (!requireBridgeAuthorization(request, response)) return;
    const taskId = decodeURIComponent(providerTaskMatch[1]);
    const task = context.getProviderTask(taskId);
    if (!task) {
      json(response, 404, { error: "Provider task not found" });
      return;
    }
    json(response, 200, { task });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    json(response, 200, {
      sessions: [...context.callSessions.values()].map(context.sessionSummary),
    });
    return;
  }

  const sessionMatch = request.method === "GET" ? url.pathname.match(/^\/sessions\/([^/]+)$/) : null;
  if (sessionMatch) {
    const callId = decodeURIComponent(sessionMatch[1]);
    const session = context.getSession(callId);
    if (!session) {
      json(response, 404, { error: "Call session not found" });
      return;
    }
    json(response, 200, { session });
    return;
  }

  const actionMatch = request.method === "POST" ? url.pathname.match(/^\/calls\/([^/]+)\/actions$/) : null;
  if (actionMatch) {
    await handleCallAction(request, response, decodeURIComponent(actionMatch[1]));
    return;
  }

  const signalMatch = request.method === "POST" ? url.pathname.match(/^\/calls\/([^/]+)\/signals$/) : null;
  if (signalMatch) {
    await handleCallSignal(request, response, decodeURIComponent(signalMatch[1]));
    return;
  }

  if (request.method === "POST" && url.pathname === "/provider/events") {
    await handleProviderEvent(request, response, { path: "provider/events" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/provider/meta/events") {
    await handleProviderEvent(request, response, { path: "provider/meta/events" });
    return;
  }

  const providerTaskClaimMatch =
    request.method === "POST" ? url.pathname.match(/^\/provider\/tasks\/([^/]+)\/claim$/) : null;
  if (providerTaskClaimMatch) {
    await handleProviderTaskClaim(request, response, decodeURIComponent(providerTaskClaimMatch[1]));
    return;
  }

  const providerTaskResultMatch =
    request.method === "POST" ? url.pathname.match(/^\/provider\/tasks\/([^/]+)\/result$/) : null;
  if (providerTaskResultMatch) {
    await handleProviderTaskResult(request, response, decodeURIComponent(providerTaskResultMatch[1]));
    return;
  }

  const providerStatusMatch =
    request.method === "POST" ? url.pathname.match(/^\/provider\/calls\/([^/]+)\/status$/) : null;
  if (providerStatusMatch) {
    await handleProviderEvent(request, response, {
      callId: decodeURIComponent(providerStatusMatch[1]),
      eventType: "provider_status",
      path: "provider/calls/:id/status",
    });
    return;
  }

  const providerSignalMatch =
    request.method === "POST" ? url.pathname.match(/^\/provider\/calls\/([^/]+)\/signals$/) : null;
  if (providerSignalMatch) {
    await handleProviderEvent(request, response, {
      callId: decodeURIComponent(providerSignalMatch[1]),
      eventType: "provider_signal",
      path: "provider/calls/:id/signals",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/simulate/status") {
    await handleProviderEvent(request, response, {
      eventType: "provider_status",
      source: "bridge-stub",
      path: "simulate/status",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/simulate/signal") {
    await handleProviderEvent(request, response, {
      eventType: "provider_signal",
      source: "bridge-stub",
      path: "simulate/signal",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/simulate/answer") {
    await handleProviderEvent(request, response, {
      eventType: "provider_answer",
      signalKind: "answer",
      signalPayload: {
        type: "answer",
        sdp: exampleAnswerSdp(),
      },
      source: "bridge-stub",
      path: "simulate/answer",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/simulate/candidate") {
    await handleProviderEvent(request, response, {
      eventType: "provider_candidate",
      signalKind: "candidate",
      signalPayload: {
        candidate: "candidate:stub 1 udp 2122260223 127.0.0.1 3478 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
      source: "bridge-stub",
      path: "simulate/candidate",
    });
    return;
  }

  notFound(response);
});

server.listen(context.port, () => {
  context.log("server.started", {
    port: context.port,
    kasitekBaseUrl: context.kasitekBaseUrl,
    hasBridgeToken: Boolean(context.bridgeToken),
    synthAnswerEnabled: context.synthAnswerEnabled,
    adapter: providerAdapter.name,
  });
});
