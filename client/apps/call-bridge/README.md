# KasiTek Call Bridge Stub

Local helper service for exercising the WhatsApp calling bridge contract.

## Required env

On the Rust server:

```bash
WHATSAPP_CALL_PROVIDER=webrtc
WHATSAPP_CALL_SIGNALING_URL=http://127.0.0.1:8787
WHATSAPP_CALL_BRIDGE_TOKEN=your-shared-token
WHATSAPP_CALL_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
WHATSAPP_CALL_TURN_USERNAME=your-turn-username
WHATSAPP_CALL_TURN_CREDENTIAL=your-turn-password
```

You can still provide a raw ICE payload with `WHATSAPP_CALL_ICE_SERVERS_JSON`, but for normal
deployments the `WHATSAPP_CALL_TURN_*` env vars are now the simpler option.

For the production-shaped local relay loop, set the Rust server provider to `meta-cloud-api`
instead of `webrtc` so the bridge contract and provider worker use the same mode.

On the bridge stub:

```bash
KASITEK_API_BASE_URL=http://127.0.0.1:8080
WHATSAPP_CALL_BRIDGE_TOKEN=your-shared-token
WHATSAPP_CALL_BRIDGE_MODE=stub
WHATSAPP_CALL_PROVIDER=manual
PORT=8787
```

For a real provider-oriented deployment shape, use:

```bash
KASITEK_API_BASE_URL=http://127.0.0.1:8080
WHATSAPP_CALL_BRIDGE_TOKEN=your-shared-token
WHATSAPP_CALL_BRIDGE_MODE=production
WHATSAPP_CALL_PROVIDER=meta-cloud-api
PORT=8787
```

## Run locally

```bash
pnpm dev:call-bridge
```

For the production-shaped local relay loop, start the worker in a second terminal:

```bash
pnpm dev:call-bridge:worker:meta-stub
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

Worker env defaults:

```bash
CALL_BRIDGE_BASE_URL=http://127.0.0.1:8787
WHATSAPP_CALL_BRIDGE_TOKEN=your-shared-token
CALL_BRIDGE_WORKER_POLL_MS=1000
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
- `GET /sessions/:id`
- `GET /provider/tasks`
- `GET /provider/tasks/:id`
- `POST /calls/:id/actions`
- `POST /calls/:id/signals`
- `POST /provider/events`
- `POST /provider/calls/:id/status`
- `POST /provider/calls/:id/signals`
- `POST /provider/meta/events`
- `POST /provider/tasks/claim-next`
- `POST /provider/tasks/:id/claim`
- `POST /provider/tasks/:id/result`
- `POST /simulate/status`
- `POST /simulate/signal`
- `POST /simulate/answer`
- `POST /simulate/candidate`

## Current limitation

This service now exposes a provider-facing bridge surface, but `WHATSAPP_CALL_BRIDGE_MODE=stub`
still uses synthetic answer/candidate events for local testing. A real production bridge still
needs provider-specific media and signaling integration behind the provider endpoints. The current
`meta-cloud-api` adapter is a production-shaped entry point, but it still records and normalizes
provider work rather than completing true provider media integration. The bridge now also exposes
provider task endpoints so an external worker can claim outbound action/signal work and report
results back to the bridge.

The `worker:meta-stub` process closes that relay loop for local development by claiming
`meta-cloud-api` provider tasks and feeding normalized bridge events back into KasiTek. It is
still a stub worker, not a real production media provider.
