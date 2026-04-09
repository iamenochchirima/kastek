# KasiTek Call Bridge Stub

Local helper service for exercising the WhatsApp calling bridge contract.

## Required env

On the Rust server:

```bash
WHATSAPP_CALL_PROVIDER=webrtc
WHATSAPP_CALL_SIGNALING_URL=http://127.0.0.1:8787
WHATSAPP_CALL_BRIDGE_TOKEN=your-shared-token
```

On the bridge stub:

```bash
KASITEK_API_BASE_URL=http://127.0.0.1:8080
WHATSAPP_CALL_BRIDGE_TOKEN=your-shared-token
PORT=8787
```

## Run locally

```bash
pnpm dev:call-bridge
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Fast local call-loop test

1. Start the Rust server with the call bridge env vars above.
2. Start the client app.
3. Start the bridge stub with `pnpm dev:call-bridge`.
4. Open the inbox in a non-production local environment.
5. Select any WhatsApp conversation.
6. Click `Simulate Call`.
7. Click `Answer`.

Expected flow:

- the inbox creates a simulated inbound call
- KasiTek sends the `accept` action to the bridge stub
- the browser creates a WebRTC offer and posts it to KasiTek
- KasiTek forwards that signal to the bridge stub
- the bridge stub emits a synthetic `answer` and `candidate`
- KasiTek receives them through the signed bridge webhook
- the inbox receives realtime `call.signal` events

## Manual bridge endpoints

Available on the stub:

- `GET /health`
- `GET /sessions`
- `POST /calls/:id/actions`
- `POST /calls/:id/signals`
- `POST /simulate/status`
- `POST /simulate/signal`
- `POST /simulate/answer`
- `POST /simulate/candidate`

## Current limitation

This service is still a stub. It simulates the provider/media side and does not carry real WhatsApp audio yet.
