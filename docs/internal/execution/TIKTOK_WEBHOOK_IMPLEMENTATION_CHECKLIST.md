---
title: TikTok Webhook Implementation Checklist
slug: /execution/tiktok-webhook-implementation-checklist
---

# TikTok webhook and webhook-hardening implementation checklist

Status: planned  
Primary scope: `server/kasitek-core`, `client/packages/database`, and provider configuration  
Related scope: webhook security and delivery consistency for existing providers

## Outcome

KasiTek must receive TikTok publishing and authorization events securely, acknowledge them
quickly, process them exactly once from the product's perspective, and retain status polling as
a reconciliation fallback. Webhook delivery must not introduce status races, duplicate usage,
or cross-workspace updates.

This work does not add TikTok comments, likes, mentions, or direct messages to Inbox. TikTok's
standard webhook product does not expose those events for this integration.

## Current baseline

- [x] TikTok OAuth, encrypted access/refresh token storage, creator-info lookup, direct photo and
      video publishing, and publish-status polling are implemented.
- [x] TikTok publish jobs remain in `PROCESSING` until status polling reports success or failure.
- [x] The social publishing worker already runs reconciliation on a configurable interval.
- [x] The client API proxy preserves request headers and raw request bytes, which are required for
      provider signature verification.
- [x] Meta/Instagram webhooks already demonstrate raw-body HMAC verification and event handling.
- [x] Paystack webhooks already demonstrate durable receipt records, duplicate suppression, and
      processing outcomes.
- [ ] No `POST /api/webhooks/tiktok` endpoint exists.
- [ ] No durable TikTok webhook event record or processor exists.
- [ ] TikTok authorization removal is not propagated into connection state.
- [ ] Polling and future webhook updates do not yet share one atomic transition function.
- [ ] WhatsApp webhook POST payloads are not currently signature-verified.

## Non-negotiable design rules

- [ ] Verify the TikTok signature against the exact raw request body before JSON parsing.
- [ ] Use `AUTH_TIKTOK_CLIENT_SECRET` only on the server and support separate Sandbox and
      Production deployments/configuration.
- [ ] Reject signatures with missing, malformed, invalid, or stale timestamps.
- [ ] Treat delivery as at-least-once, duplicated, delayed, and potentially out of order.
- [ ] Persist and deduplicate an accepted event before acknowledging it.
- [ ] Return HTTP 200 quickly after durable receipt; do not perform provider calls in the intake
      request.
- [ ] Scope every publish-job update through the TikTok connection and organization. Never update
      a job using an unscoped external identifier.
- [ ] Make terminal state transitions atomic and monotonic. A delayed event must not move a job
      from `PUBLISHED` or `FAILED` back to `PROCESSING`.
- [ ] Keep status polling enabled as repair/reconciliation, not as a second independent state
      machine.
- [ ] Keep user-authored Content records when authorization is removed; remove tokens and mark the
      connection as requiring reconnection.
- [ ] Never log client secrets, access tokens, refresh tokens, complete signatures, or raw user
      content.

## Target flow

```text
TikTok
  -> POST /api/webhooks/tiktok
  -> preserve raw body
  -> verify TikTok-Signature
  -> validate client_key and timestamp
  -> derive idempotency key
  -> insert durable event (or recognize duplicate)
  -> return HTTP 200

Social worker
  -> claim received TikTok events
  -> normalize event content
  -> resolve connection + organization + publish job
  -> apply atomic domain transition
  -> record processed / ignored / failed result
  -> retry transient failures with a bounded policy

Status poller
  -> reconcile jobs still in PROCESSING
  -> call the same domain transition functions
```

## Event contract

| TikTok event | Required KasiTek behavior |
| --- | --- |
| `post.publish.complete` | Mark the matching direct-post job published when this is the terminal result available for the selected privacy mode. Store the `publish_id` and provider event metadata. |
| `post.publish.failed` | Mark the matching job failed with TikTok's reason. Preserve an operator-safe error and the original provider reason in protected metadata. |
| `post.publish.publicly_available` | Store the public TikTok `post_id`, public-availability state, and timestamp. Do not meter a second publish. |
| `post.publish.no_longer_publicaly_available` | Mark public availability false in metadata without deleting the KasiTek Content record or rewriting its historical publish result. Preserve TikTok's event spelling at the adapter boundary only. |
| `post.publish.inbox_delivered` | Record delivery metadata for future Inbox Share support; ignore safely for Direct Post if no matching workflow exists. |
| `authorization.removed` | Clear encrypted TikTok tokens, set the connection to `NEEDS_REAUTH`, record a non-sensitive reason, and synchronize the shared Connections view. |
| Unknown/test event | Persist diagnostics, mark ignored, and return HTTP 200 after successful signature verification. |

## Phase 1 — schema and durable receipt

- [ ] Add a provider-neutral `SocialWebhookEvent` model rather than a TikTok-only table so future
      social providers can reuse it.
- [ ] Include:
  - provider
  - deterministic event key
  - event type
  - external user/account identifier where supplied
  - event creation timestamp
  - protected JSON payload
  - processing status (`RECEIVED`, `PROCESSING`, `PROCESSED`, `IGNORED`, `FAILED`)
  - attempt count
  - next attempt time
  - received, processed, and updated timestamps
  - sanitized error message
- [ ] Add a unique index on `(provider, eventKey)`.
- [ ] Add worker indexes for `(provider, status, nextAttemptAt)` and receipt time.
- [ ] Derive the TikTok event key from the signed, immutable event fields/body because TikTok does
      not provide a dedicated webhook event ID.
- [ ] Define a retention period for processed raw webhook payloads and document the cleanup job.
- [ ] Add the Prisma migration and regenerate database types if required.

## Phase 2 — secure HTTP intake

- [ ] Add `POST /api/webhooks/tiktok` to `kasitek-core`.
- [ ] Accept raw bytes rather than `web::Json` so signature verification uses the original body.
- [ ] Parse `TikTok-Signature` into timestamp (`t`) and signature (`s`) components.
- [ ] Compute HMAC-SHA256 using:

```text
AUTH_TIKTOK_CLIENT_SECRET
HMAC input: <timestamp>.<raw JSON body>
```

- [ ] Compare signatures in constant time.
- [ ] Enforce a documented replay window while allowing reasonable clock skew.
- [ ] Validate that the payload `client_key` equals `AUTH_TIKTOK_CLIENT_KEY`.
- [ ] Parse and validate the common event envelope only after signature verification.
- [ ] Insert or deduplicate the durable event in one short transaction.
- [ ] Return HTTP 200 for accepted duplicates and supported/unknown test events.
- [ ] Return 401/403 for invalid signatures and 400 for malformed signed payloads.
- [ ] Add unit tests for valid signatures, changed bodies, changed timestamps, malformed headers,
      stale timestamps, wrong client keys, and duplicate delivery.

## Phase 3 — shared TikTok publish transitions

- [ ] Extract the current polling success/failure SQL into shared service functions used by both
      webhook processing and polling.
- [ ] Resolve the target using all available scope:
  - `platform = TIKTOK`
  - `publish_id`
  - TikTok `user_openid`
  - connected channel
  - organization
- [ ] Lock or conditionally update the target job so polling and webhook processing cannot both
      win the same transition.
- [ ] Update only jobs in allowed source states, normally `PROCESSING`.
- [ ] Make a repeated success/failure event a no-op after the first terminal transition.
- [ ] Ensure `billing::record_meter_usage` remains idempotent by social publish job ID.
- [ ] Preserve `publish_id` separately from TikTok's final public `post_id`; do not overload one
      field in a way that prevents later event correlation.
- [ ] Record private completion independently from public availability because Sandbox and private
      posts never emit a public-availability event.
- [ ] Define precedence for conflicting terminal signals and log conflicts for inspection.
- [ ] Add database-backed tests for webhook-first, polling-first, duplicate, delayed, and
      conflicting event sequences.

## Phase 4 — authorization removal and connection health

- [ ] Handle `authorization.removed` using `user_openid`.
- [ ] Remove encrypted TikTok access and refresh tokens immediately.
- [ ] Set the matching TikTok channel to `NEEDS_REAUTH` rather than deleting user-authored content.
- [ ] Store only a normalized removal reason and timestamp in connection metadata.
- [ ] Synchronize the provider-neutral `ExternalConnection` projection.
- [ ] Surface a reconnect action in Connections.
- [ ] Stop polling jobs that can no longer be reconciled and attach an actionable reconnect error.
- [ ] Verify that one TikTok account connected to multiple organizations cannot cause an
      unauthorized cross-workspace mutation; document the intended multi-org behavior.

## Phase 5 — worker, retries, and observability

- [ ] Extend the social worker to claim durable webhook events using row locking or an atomic claim
      update.
- [ ] Process a bounded batch per iteration.
- [ ] Retry transient database/processing failures with exponential backoff and a maximum attempt
      count.
- [ ] Keep permanent validation/mapping failures visible in `FAILED` state for operator review.
- [ ] Emit structured metrics/logs for:
  - events received
  - signature failures
  - duplicates
  - processed events by type
  - ignored events
  - failed events and retries
  - processing delay
  - polling reconciliations after missed/delayed webhooks
- [ ] Add an internal inspection query or admin view before production scale; do not expose raw
      webhook bodies to ordinary workspace users.
- [ ] Verify the worker can resume events left in `PROCESSING` after process termination.

## Phase 6 — polling reconciliation

- [ ] Keep `/v2/post/publish/status/fetch/` reconciliation enabled.
- [ ] Poll only jobs that remain unresolved after a minimum delay; avoid checking newly submitted
      jobs before a webhook has a reasonable chance to arrive.
- [ ] Add backoff between repeated checks instead of checking every unresolved job on every worker
      pass.
- [ ] Use shared atomic transition functions so polling cannot undo webhook state.
- [ ] Record whether a terminal result came from `webhook` or `status_fetch`.
- [ ] Alert on jobs that exceed the expected processing window with neither a terminal webhook nor
      a terminal fetch result.

## Phase 7 — provider configuration and testing

- [ ] Add the TikTok Webhooks product only after the endpoint is deployed and reachable.
- [ ] Configure Sandbox callback:

```text
https://curtis-pastureless-sickerly.ngrok-free.dev/api/webhooks/tiktok
```

- [ ] Configure Production callback after approval/deployment:

```text
https://app.kasitek.co.za/api/webhooks/tiktok
```

- [ ] Confirm the ngrok client tunnel is running and the Next.js API proxy forwards the POST body
      and `TikTok-Signature` header unchanged.
- [ ] Pass TikTok's Test URL request with HTTP 200 and verify a durable ignored/test event exists.
- [ ] Test a Sandbox `SELF_ONLY` direct post through completion.
- [ ] Test an intentionally invalid media post and verify the failure reason reaches Content.
- [ ] Test duplicate delivery by replaying the same valid fixture.
- [ ] Test out-of-order fixtures for completion/public availability.
- [ ] Test account deauthorization and the reconnect state.
- [ ] Record a first-review demo only after the complete Sandbox flow passes.

## Related issue A — WhatsApp webhook signature verification

The current WhatsApp GET verification token protects subscription setup, but the POST receiver
deserializes and processes payloads without verifying Meta's request signature. This is separate
from TikTok functionality but is a material webhook security gap.

- [ ] Change the WhatsApp POST controller to accept raw bytes.
- [ ] Read and verify `X-Hub-Signature-256` before JSON parsing.
- [ ] Use the correct configured Meta/WhatsApp app secret and fail closed when it is unavailable.
- [ ] Add valid, modified-body, missing-header, and wrong-secret tests.
- [ ] Confirm the Next.js proxy preserves the signature header and body.
- [ ] Do not combine WhatsApp and TikTok event parsing; share only small signature/intake utilities
      where the contracts are genuinely identical.

## Related issue B — common webhook intake maturity

- [ ] Decide whether Meta/Instagram message webhooks should also move to durable receipt followed
      by background processing so provider callbacks are acknowledged quickly.
- [ ] Define one retention and redaction policy for raw provider webhook payloads.
- [ ] Standardize event processing statuses, retry policy, structured logs, and inspection tools.
- [ ] Audit every webhook receiver for signature verification, replay protection, idempotency,
      organization scoping, and bounded processing time.
- [ ] Keep provider adapters separate. A shared envelope must not erase provider-specific security
      or event semantics.

## Files expected to change

- `server/kasitek-core/src/routes.rs`
- `server/kasitek-core/src/controllers/social.rs` or a dedicated webhook controller
- `server/kasitek-core/src/controllers/whatsapp.rs`
- `server/kasitek-core/src/services/social.rs`
- `server/kasitek-core/src/services/whatsapp.rs` or a shared Meta signature helper
- `server/kasitek-core/src/main.rs`
- `client/packages/database/prisma/schema.prisma`
- `client/packages/database/prisma/migrations/...`
- `server/kasitek-core/README.md`
- targeted Rust unit and database-backed integration tests

## Completion criteria

- [ ] TikTok's Test URL receives HTTP 200 through both permanent ngrok and production routing.
- [ ] Invalid or replayed signatures cannot create or mutate data.
- [ ] Duplicate webhook delivery produces one product-level transition and one usage event.
- [ ] Webhook-first and polling-first completion converge on the same final state.
- [ ] Private, public, failed, no-longer-public, unknown, and deauthorization events are covered by
      fixtures and tests.
- [ ] A revoked TikTok connection cannot continue publishing and presents a clear reconnect action.
- [ ] Polling remains operational when webhook delivery is delayed or absent.
- [ ] WhatsApp webhook POST signatures are verified before payload parsing.
- [ ] Database migration, Prisma validation, Rust formatting, unit tests, integration tests, and
      `cargo check -p kasitek-core` pass.
- [ ] Provider configuration and operational runbooks contain no secrets and list exact Sandbox
      and Production callback URLs.

## Current product boundary

TikTok webhooks improve publishing status and authorization lifecycle handling. They do not make
TikTok an Inbox channel. Do not advertise TikTok comment, like, mention, or DM management until
TikTok provides an approved commercial API and the corresponding capability is implemented and
reviewed.
