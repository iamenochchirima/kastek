# Calls consolidation into Core

## Decision

Calls are a Core module. `kasitek-core` owns call access control, provider configuration,
webhook handling, call records, and the client-facing API.

The previous `kasitek-calls` crate shared Core's database and session tables while duplicating
the WhatsApp Calls API. It did not provide a separate data boundary or a client-facing contract.

## Data migration

No database migration is required. Core already owns and uses the existing call tables:

- `CommunicationCall` for unified provider call records;
- `WhatsappCallSession` and `WhatsappCallEvent` for WhatsApp calling;
- `ExternalConnection` and `WhatsappConnection` for organisation-scoped provider access.

The existing records remain in place. Core now reads and writes them directly for all calls.

## Runtime migration

1. Deploy Core with the current Calls environment: Twilio configuration, Meta/WhatsApp
   connection credentials, public webhook URL, and token-encryption configuration.
2. Remove `KASITEK_CALLS_URL` from Core deployment configuration. Core no longer proxies
   Calls requests or forwards WhatsApp call webhooks to another process.
3. Point provider webhooks at Core. Existing public paths remain unchanged:
   - `/api/webhooks/whatsapp`
   - `/api/webhooks/twilio/voice`
   - `/api/webhooks/twilio/status`
   - `/api/webhooks/twilio/browser`
4. Stop the standalone Calls deployment after Core health checks and an inbound/outbound
   provider smoke test pass.

## Future extraction threshold

If voice work later requires persistent media sessions, live audio streaming, or independently
scaled media workers, extract a dedicated runtime worker behind an explicit event/API contract.
Core remains the system of record and public API owner; the runtime must not share Core's
database or user-session tables.
