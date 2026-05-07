import { createServer } from "node:http";

process.loadEnvFile?.(".env.local");
process.env.PORT ??= process.env.PROVIDER_RELAY_PORT ?? "8990";

import { Room, RoomEvent } from "@livekit/rtc-node";

import { json, notFound, readJsonBody } from "../lib/http.mjs";

const port = Number.parseInt(process.env.PORT || "8990", 10);
const authToken = process.env.META_CLOUD_API_PROVIDER_TOKEN || "";
const serviceName = "kasitek-meta-provider-livekit-relay";
const bridgeSessions = new Map();

function log(event, payload = {}) {
  console.log(
    JSON.stringify({
      service: serviceName,
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  );
}

function requireAuth(request, response) {
  if (!authToken) return true;
  const authorization = request.headers.authorization || "";
  if (authorization === `Bearer ${authToken}`) return true;
  json(response, 401, { error: "Unauthorized" });
  return false;
}

function summarizeSession(session) {
  if (!session) return null;
  return {
    callId: session.callId,
    waCallId: session.waCallId,
    roomName: session.roomName,
    participantIdentity: session.participantIdentity,
    status: session.status,
    connected: session.connected,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastError: session.lastError || null,
  };
}

function getLiveKitBridgeParticipant(body) {
  const participant = body?.mediaSession?.livekit?.bridgeParticipant;
  const serverUrl = body?.mediaSession?.livekit?.serverUrl;
  const roomName = body?.mediaSession?.livekit?.roomName;
  if (!participant || !serverUrl || !roomName) {
    throw new Error("LiveKit bridge participant details are required");
  }
  if (!participant.participantToken || !participant.identity) {
    throw new Error("LiveKit bridge participant token and identity are required");
  }
  return {
    serverUrl,
    roomName,
    participantIdentity: participant.identity,
    participantName: participant.name || participant.identity,
    participantToken: participant.participantToken,
    participantMetadata: participant.metadata || null,
  };
}

async function disconnectSession(callId, reason = "manual") {
  const existing = bridgeSessions.get(callId);
  if (!existing) return null;

  try {
    await existing.room.disconnect();
  } catch (error) {
    log("relay.disconnect_error", {
      callId,
      message: error instanceof Error ? error.message : "Unknown disconnect error",
    });
  }

  bridgeSessions.delete(callId);
  return {
    ...existing,
    status: "disconnected",
    connected: false,
    updatedAt: new Date().toISOString(),
    disconnectReason: reason,
  };
}

async function connectBridgeParticipant(body) {
  const callId = body.callId;
  const waCallId = body.waCallId || null;
  const livekit = getLiveKitBridgeParticipant(body);

  if (!callId) {
    throw new Error("callId is required");
  }

  const existing = bridgeSessions.get(callId);
  if (existing?.connected) {
    log("relay.connect_reused", {
      callId,
      roomName: existing.roomName,
      participantIdentity: existing.participantIdentity,
    });
    return summarizeSession(existing);
  }

  if (existing) {
    await disconnectSession(callId, "replaced");
  }

  const room = new Room();
  log("relay.connect_begin", {
    callId,
    waCallId,
    roomName: livekit.roomName,
    serverUrl: livekit.serverUrl,
    participantIdentity: livekit.participantIdentity,
    hasParticipantToken: Boolean(livekit.participantToken),
  });
  const session = {
    callId,
    waCallId,
    roomName: livekit.roomName,
    participantIdentity: livekit.participantIdentity,
    participantName: livekit.participantName,
    participantMetadata: livekit.participantMetadata,
    connected: false,
    status: "connecting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: null,
    room,
  };

  room
    .on(RoomEvent.Connected, () => {
      session.connected = true;
      session.status = "active";
      session.updatedAt = new Date().toISOString();
      log("relay.connected", {
        callId,
        roomName: session.roomName,
        participantIdentity: session.participantIdentity,
      });
    })
    .on(RoomEvent.ConnectionStateChanged, (state) => {
      session.status = String(state);
      session.updatedAt = new Date().toISOString();
      log("relay.connection_state", {
        callId,
        state: String(state),
      });
    })
    .on(RoomEvent.Disconnected, (reason) => {
      session.connected = false;
      session.status = "disconnected";
      session.updatedAt = new Date().toISOString();
      log("relay.disconnected", {
        callId,
        reason: reason || null,
      });
    });

  bridgeSessions.set(callId, session);
  await room.connect(livekit.serverUrl, livekit.participantToken);
  log("relay.connect_success", {
    callId,
    roomName: session.roomName,
    participantIdentity: session.participantIdentity,
    connected: session.connected,
  });
  return summarizeSession(session);
}

async function handleCallAction(request, response, callId) {
  if (!requireAuth(request, response)) return;

  try {
    const body = await readJsonBody(request);
    const action = body.action || null;
    log("relay.action_received", {
      callId,
      action,
      roomName: body?.mediaSession?.livekit?.roomName || null,
      serverUrl: body?.mediaSession?.livekit?.serverUrl || null,
      bridgeParticipantIdentity: body?.mediaSession?.livekit?.bridgeParticipant?.identity || null,
    });

    if (action === "accept") {
      const session = await connectBridgeParticipant({
        ...body,
        callId,
      });

      json(response, 200, {
        status: "completed",
        result: {
          accepted: true,
          relay: "livekit",
          session,
        },
        providerEvents: [
          {
            eventType: "provider_status",
            status: "CONNECTING",
            source: "meta-cloud-api-livekit-relay",
            payload: {
              relay: "livekit",
              callId,
              session,
            },
          },
          {
            eventType: "provider_status",
            status: "ACTIVE",
            source: "meta-cloud-api-livekit-relay",
            payload: {
              relay: "livekit",
              callId,
              session,
            },
          },
        ],
      });
      return;
    }

    if (action === "reject" || action === "end") {
      const session = await disconnectSession(callId, action);
      json(response, 200, {
        status: "completed",
        result: {
          ended: action === "end",
          rejected: action === "reject",
          relay: "livekit",
          session: summarizeSession(session),
        },
        providerEvents: [
          {
            eventType: "provider_hangup",
            status: action === "reject" ? "REJECTED" : "COMPLETED",
            source: "meta-cloud-api-livekit-relay",
            payload: {
              relay: "livekit",
              callId,
              action,
            },
          },
        ],
      });
      return;
    }

    json(response, 400, { error: `Unsupported action: ${action || "unknown"}` });
  } catch (error) {
    log("relay.action_failed", {
      callId,
      message: error instanceof Error ? error.message : "Failed to process action",
    });
    json(response, 400, { error: error instanceof Error ? error.message : "Failed to process action" });
  }
}

async function handleCallSignal(request, response, callId) {
  if (!requireAuth(request, response)) return;

  try {
    const body = await readJsonBody(request);
    const kind = body.kind || null;
    const session = bridgeSessions.get(callId);
    log("relay.signal_received", {
      callId,
      kind,
      hasSession: Boolean(session),
    });

    json(response, 200, {
      status: "completed",
      result: {
        relay: "livekit",
        ignored: true,
        kind,
        session: summarizeSession(session),
      },
      providerEvents: [],
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "Failed to process signal" });
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
    if (!requireAuth(request, response)) return;
    json(response, 200, {
      ok: true,
      service: serviceName,
      sessions: [...bridgeSessions.values()].map(summarizeSession),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    json(response, 200, {
      service: serviceName,
      endpoints: [
        "GET /health",
        "POST /calls/:id/actions",
        "POST /calls/:id/signals",
      ],
    });
    return;
  }

  const actionMatch = url.pathname.match(/^\/calls\/([^/]+)\/actions$/);
  if (request.method === "POST" && actionMatch) {
    await handleCallAction(request, response, decodeURIComponent(actionMatch[1]));
    return;
  }

  const signalMatch = url.pathname.match(/^\/calls\/([^/]+)\/signals$/);
  if (request.method === "POST" && signalMatch) {
    await handleCallSignal(request, response, decodeURIComponent(signalMatch[1]));
    return;
  }

  notFound(response);
});

server.listen(port, () => {
  log("relay.started", {
    port,
    protected: Boolean(authToken),
  });
});
