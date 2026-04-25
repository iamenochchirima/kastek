const bridgeBaseUrl = (process.env.CALL_BRIDGE_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const bridgeToken = process.env.WHATSAPP_CALL_BRIDGE_TOKEN || "";
const provider = "meta-cloud-api";
const pollIntervalMs = Number.parseInt(process.env.CALL_BRIDGE_WORKER_POLL_MS || "1000", 10);
const workerMode = (process.env.META_CLOUD_API_WORKER_MODE || "stub").trim().toLowerCase();
const providerBaseUrl = (process.env.META_CLOUD_API_PROVIDER_BASE_URL || "").replace(/\/$/, "");
const providerAuthToken = process.env.META_CLOUD_API_PROVIDER_TOKEN || "";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "x-kasitek-call-bridge-token": bridgeToken,
  };
}

function providerHeaders() {
  return {
    "Content-Type": "application/json",
    ...(providerAuthToken ? { Authorization: `Bearer ${providerAuthToken}` } : {}),
  };
}

function log(event, payload = {}) {
  console.log(
    JSON.stringify({
      service: "kasitek-call-bridge-worker",
      provider,
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  );
}

function exampleAnswerSdp() {
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=KasiTek Meta Worker Stub",
    "t=0 0",
    "a=msid-semantic: WMS",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:meta",
    "a=ice-pwd:metastubpassword",
    "a=fingerprint:sha-256 11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11",
    "a=setup:active",
    "a=mid:0",
    "a=sendrecv",
    "a=rtpmap:111 opus/48000/2",
    "",
  ].join("\r\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimNextTask() {
  const response = await fetch(`${bridgeBaseUrl}/provider/tasks/claim-next`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ provider }),
  });

  if (response.status === 404) {
    return null;
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Failed to claim provider task (${response.status})`);
  }
  return body.task || null;
}

async function completeTask(taskId, payload) {
  const response = await fetch(`${bridgeBaseUrl}/provider/tasks/${taskId}/result`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Failed to complete provider task (${response.status})`);
  }
  return body.task || null;
}

function buildTaskResult(task) {
  if (task.kind === "action") {
    const action = task.payload?.action;
    if (action === "accept") {
      return {
        status: "completed",
        result: { accepted: true },
        providerEvent: {
          eventType: "provider_status",
          status: "CONNECTING",
          source: "meta-cloud-api-worker",
          payload: {
            provider,
            note: "Worker accepted the inbound call action",
            taskId: task.id,
          },
        },
      };
    }

    if (action === "reject") {
      return {
        status: "completed",
        result: { rejected: true },
        providerEvent: {
          eventType: "provider_hangup",
          status: "REJECTED",
          source: "meta-cloud-api-worker",
          payload: {
            provider,
            note: "Worker rejected the call",
            taskId: task.id,
          },
        },
      };
    }

    if (action === "end") {
      return {
        status: "completed",
        result: { ended: true },
        providerEvent: {
          eventType: "provider_hangup",
          status: "COMPLETED",
          source: "meta-cloud-api-worker",
          payload: {
            provider,
            note: "Worker ended the call",
            taskId: task.id,
          },
        },
      };
    }
  }

  if (task.kind === "signal") {
    const kind = task.payload?.kind;
    if (kind === "offer") {
      return {
        status: "completed",
        result: { signalHandled: true, kind },
        providerEvent: {
          eventType: "provider_answer",
          status: "ACTIVE",
          signalKind: "answer",
          signalPayload: {
            type: "answer",
            sdp: exampleAnswerSdp(),
          },
          source: "meta-cloud-api-worker",
          payload: {
            provider,
            note: "Worker generated answer for inbound offer",
            taskId: task.id,
          },
        },
      };
    }

    if (kind === "candidate") {
      return {
        status: "completed",
        result: { signalHandled: true, kind },
        providerEvent: {
          eventType: "provider_candidate",
          signalKind: "candidate",
          signalPayload: task.payload?.signal || {
            candidate: "candidate:meta 1 udp 2122260223 127.0.0.1 3478 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
          source: "meta-cloud-api-worker",
          payload: {
            provider,
            note: "Worker relayed ICE candidate",
            taskId: task.id,
          },
        },
      };
    }

    if (kind === "bye") {
      return {
        status: "completed",
        result: { signalHandled: true, kind },
        providerEvent: {
          eventType: "provider_hangup",
          status: "COMPLETED",
          signalKind: "bye",
          signalPayload: task.payload?.signal || { reason: "worker-ended" },
          source: "meta-cloud-api-worker",
          payload: {
            provider,
            note: "Worker completed hangup signal",
            taskId: task.id,
          },
        },
      };
    }
  }

  return {
    status: "failed",
    error: `Unsupported provider task kind=${task.kind}`,
  };
}

function buildProviderRequest(task) {
  const request = task.payload?.request || {};
  if (task.kind === "action") {
    return {
      path: `/calls/${encodeURIComponent(task.callId)}/actions`,
      body: {
        taskId: task.id,
        provider,
        callId: task.callId,
        waCallId: task.waCallId,
        action: task.payload?.action || null,
        request,
        mediaSession: request.mediaSession || null,
        call: request.call || null,
      },
    };
  }

  if (task.kind === "signal") {
    return {
      path: `/calls/${encodeURIComponent(task.callId)}/signals`,
      body: {
        taskId: task.id,
        provider,
        callId: task.callId,
        waCallId: task.waCallId,
        kind: task.payload?.kind || null,
        signal: task.payload?.signal || null,
        request,
      },
    };
  }

  throw new Error(`Unsupported provider task kind=${task.kind}`);
}

function normalizeProviderResult(task, body) {
  const rawEvents = Array.isArray(body?.providerEvents)
    ? body.providerEvents
    : body?.providerEvent
      ? [body.providerEvent]
      : [];

  return {
    status: body?.status || "completed",
    result: body?.result || { providerAccepted: true, mode: workerMode },
    error: body?.error || null,
    providerEvents: rawEvents,
  };
}

async function processTaskViaProvider(task) {
  if (!providerBaseUrl) {
    throw new Error("META_CLOUD_API_PROVIDER_BASE_URL is required in relay mode");
  }

  const request = buildProviderRequest(task);
  const response = await fetch(`${providerBaseUrl}${request.path}`, {
    method: "POST",
    headers: providerHeaders(),
    body: JSON.stringify(request.body),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Provider request failed (${response.status})`);
  }
  return normalizeProviderResult(task, body);
}

async function processTask(task) {
  log("task.processing", {
    taskId: task.id,
    callId: task.callId,
    kind: task.kind,
    mode: workerMode,
  });
  const result = workerMode === "relay" ? await processTaskViaProvider(task) : buildTaskResult(task);
  const completed = await completeTask(task.id, result);
  log("task.completed", {
    taskId: task.id,
    callId: task.callId,
    kind: task.kind,
    status: completed?.status || result.status,
  });
}

async function run() {
  log("worker.started", { bridgeBaseUrl, pollIntervalMs, workerMode, providerBaseUrl: providerBaseUrl || null });
  while (true) {
    try {
      const task = await claimNextTask();
      if (task) {
        await processTask(task);
      }
    } catch (error) {
      log("worker.error", {
        message: error instanceof Error ? error.message : "Unknown worker failure",
      });
    }
    await sleep(pollIntervalMs);
  }
}

void run();
