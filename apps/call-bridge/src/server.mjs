import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT || "8787", 10);
const kasitekBaseUrl = (process.env.KASITEK_API_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const bridgeToken = process.env.WHATSAPP_CALL_BRIDGE_TOKEN || "";

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-kasitek-call-bridge-token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 1024 * 1024) {
        reject(new Error("Body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
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

function notFound(response) {
  json(response, 404, { error: "Not found" });
}

function exampleAnswerSdp() {
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=KasiTek Call Bridge Stub",
    "t=0 0",
    "a=msid-semantic: WMS",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:stub",
    "a=ice-pwd:stubpassword",
    "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
    "a=setup:active",
    "a=mid:0",
    "a=sendrecv",
    "a=rtpmap:111 opus/48000/2",
    "",
  ].join("\r\n");
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
      service: "kasitek-call-bridge-stub",
      kasitekBaseUrl,
      hasBridgeToken: Boolean(bridgeToken),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    json(response, 200, {
      service: "kasitek-call-bridge-stub",
      endpoints: [
        "GET /health",
        "POST /simulate/status",
        "POST /simulate/signal",
        "POST /simulate/answer",
        "POST /simulate/candidate",
      ],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/simulate/status") {
    try {
      const body = await readJsonBody(request);
      const result = await postBridgeEvent({
        callId: body.callId,
        waCallId: body.waCallId,
        eventType: body.eventType || "provider_status",
        status: body.status,
        payload: body.payload || {
          provider: "stub",
          note: "Manual status event from local call bridge stub",
        },
        source: body.source || "bridge-stub",
      });
      json(response, 200, { ok: true, forwarded: result });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "Failed to forward status" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/simulate/signal") {
    try {
      const body = await readJsonBody(request);
      const result = await postBridgeEvent({
        callId: body.callId,
        waCallId: body.waCallId,
        eventType: body.eventType || "provider_signal",
        status: body.status,
        signalKind: body.signalKind,
        signalPayload: body.signalPayload,
        payload: body.payload || {
          provider: "stub",
          note: "Manual signal event from local call bridge stub",
        },
        source: body.source || "bridge-stub",
      });
      json(response, 200, { ok: true, forwarded: result });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "Failed to forward signal" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/simulate/answer") {
    try {
      const body = await readJsonBody(request);
      const result = await postBridgeEvent({
        callId: body.callId,
        waCallId: body.waCallId,
        eventType: "provider_answer",
        status: body.status || "ACTIVE",
        signalKind: "answer",
        signalPayload: body.signalPayload || {
          type: "answer",
          sdp: body.sdp || exampleAnswerSdp(),
        },
        payload: body.payload || {
          provider: "stub",
          note: "Synthetic answer emitted by local call bridge stub",
        },
        source: body.source || "bridge-stub",
      });
      json(response, 200, { ok: true, forwarded: result });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "Failed to forward answer" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/simulate/candidate") {
    try {
      const body = await readJsonBody(request);
      const result = await postBridgeEvent({
        callId: body.callId,
        waCallId: body.waCallId,
        eventType: "provider_candidate",
        signalKind: "candidate",
        signalPayload: body.signalPayload || {
          candidate: body.candidate || "candidate:stub 1 udp 2122260223 127.0.0.1 3478 typ host",
          sdpMid: body.sdpMid || "0",
          sdpMLineIndex: body.sdpMLineIndex || 0,
        },
        payload: body.payload || {
          provider: "stub",
          note: "Synthetic ICE candidate emitted by local call bridge stub",
        },
        source: body.source || "bridge-stub",
      });
      json(response, 200, { ok: true, forwarded: result });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "Failed to forward candidate" });
    }
    return;
  }

  notFound(response);
});

server.listen(port, () => {
  console.log(
    JSON.stringify({
      service: "kasitek-call-bridge-stub",
      port,
      kasitekBaseUrl,
      hasBridgeToken: Boolean(bridgeToken),
    }),
  );
});
