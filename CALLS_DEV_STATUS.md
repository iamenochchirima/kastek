# Calls Feature — Local Dev Status

## Branch
`calls` — pushed to origin, all code changes are up to date.

---

## What Works
- Incoming WhatsApp call webhook received and session created ✓
- Frontend shows incoming call notification in real time ✓
- User can click Accept — action POSTs to Rust and returns 200 ✓
- Call status transitions: RINGING → CONNECTING ✓
- LiveKit is now the media provider (visible in the call UI) ✓
- Local stack startup script works (`./scripts/run_local_stack.sh`) ✓

## What Doesn't Work Yet
- Call never reaches ACTIVE — stays at CONNECTING then Meta terminates it
- Root causes:
  1. **No microphone on the test machine** — browser shows "No microphone available", WebRTC can't establish audio
  2. **DB latency** — accept action takes 15-21s (machine in ZA, Neon DB in eu-west-2); Meta times out waiting for audio

## Next Step
Connect a machine with a working microphone (laptop) and test. The microphone was the last visible blocker — fix that first and see if the call reaches ACTIVE.

---

## Architecture (Call Flow)

```
WhatsApp caller
    ↓ webhook
kasitek-core (port 4000)   ← main API, also handles webhooks
kasitek-calls (port 4010)  ← call session management, RTC provider
    ↓ POST /calls/:id/actions
call-bridge (port 8987)    ← Node.js, queues provider tasks
    ↑ polls
provider-worker            ← picks up tasks, forwards to relay
    ↓ POST /calls/:id/actions
provider-relay (port 8990) ← connects to LiveKit as bridge participant
    ↓
LiveKit (port 7880)        ← SFU, browser agent joins here
    ↑
Browser (agent frontend)
```

---

## Env Changes NOT in Git (must apply manually on laptop)

The following must be set in ALL of these files:
- `.env`
- `server/kasitek-core/.env`
- `server/kasitek-calls/.env`
- `client/.env.local`
- `client/apps/call-bridge/.env.local`

### Change 1 — Switch call provider to livekit
```
# Replace:
WHATSAPP_CALL_PROVIDER=meta-cloud-api
# With:
WHATSAPP_CALL_PROVIDER=livekit
```

### Change 2 — Add LiveKit dev credentials (livekit-server --dev defaults)
```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

### Change 3 — Silence SQLx latency warnings
```
RUST_LOG=info,sqlx::query=error,sqlx::pool::acquire=error
```

---

## Services & Ports

| Service | Port | Start Command |
|---|---|---|
| kasitek-core | 4000 | `cd server/kasitek-core && cargo run` |
| kasitek-calls | 4010 | `cd server/kasitek-calls && cargo run` |
| kasitek-tenants | 8090 | `cd server/kasitek-tenants && cargo run` |
| call-bridge | 8987 | `cd client && pnpm dev:call-bridge` |
| provider-relay | 8990 | `cd client && pnpm --filter call-bridge provider:meta-livekit-relay` |
| client (Next.js) | 3000 | `cd client && pnpm run dev` |
| admin (Next.js) | 3001 | `cd client && pnpm dev:admin` |
| LiveKit | 7880 | `livekit-server --dev --bind 0.0.0.0` |
| ngrok | — | `ngrok http http://localhost:4000` |

Or run everything at once: `./scripts/run_local_stack.sh` (opens gnome-terminal tabs)

---

## Key Files

| File | What it does |
|---|---|
| `server/kasitek-calls/src/services/rtc_media_provider.rs` | Rust RTC provider — `LiveKitMediaProvider` generates LiveKit tokens in the mediaSession |
| `client/apps/call-bridge/src/server.mjs` | Node.js bridge — receives actions from Rust, queues provider tasks |
| `client/apps/call-bridge/src/providers/meta-cloud-api.mjs` | Creates provider tasks for worker to process |
| `client/apps/call-bridge/src/providers/meta-cloud-api-livekit-relay.mjs` | Connects to LiveKit as bridge participant using tokens from mediaSession |
| `client/apps/call-bridge/src/workers/meta-cloud-api-stub.mjs` | Polls bridge for tasks and forwards to relay (runs with META_CLOUD_API_WORKER_MODE=relay) |
| `client/apps/call-bridge/src/lib/bridge-context.mjs` | Session state, task queue, forwards events back to Rust via webhook |

---

## Why WHATSAPP_CALL_PROVIDER=livekit (not meta-cloud-api)

- `livekit` → Rust uses `LiveKitMediaProvider` → generates LiveKit tokens in `mediaSession`
- `meta-cloud-api` → Rust uses `BridgeMediaProvider` → no LiveKit tokens → relay fails
- The call-bridge `providers/index.mjs` was updated to map `"livekit"` → `MetaCloudApiProvider` so the bridge still queues tasks correctly
- Both need to align: Rust generates tokens WITH livekit provider, bridge queues tasks WITH meta-cloud-api adapter
