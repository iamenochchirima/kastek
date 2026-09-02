---
title: Social publish batches
owner: platform-integrations
last_reviewed: 2026-09-02
---

# Social publish batches

## Admission

The batch admission endpoint is the only batch effect boundary. It recomputes the Core preflight
against the draft, verifies the approval snapshot when an Agent starts the batch, and requires an
idempotency key. A blocked target prevents all provider jobs from being queued. Do not manually
queue individual jobs to bypass a blocked preflight.

## Status handling

Use the batch status endpoint or the Agent capability
`kasitek.core.content_post_publish_batch_status`. Treat the aggregate and target states as the
source of truth:

- `SUCCEEDED`: every target has a confirmed provider result.
- `PARTIAL`: at least one target is confirmed and another failed or is blocked.
- `PROCESSING`: at least one target is queued or being reconciled.
- `BLOCKED`: preflight prevented provider effects.
- `FAILED`: no target is confirmed and the attempted targets failed.
- `UNKNOWN`: a provider may have accepted the request but Core did not receive confirmation.

Do not retry an `UNKNOWN` target. First reconcile it with the provider and record a confirmed
external ID or a provider-confirmed failure. Never retry a target whose job is `PUBLISHED`.
The legacy per-job retry and run-now actions enforce the same rule; a provider-confirmed failure
clears the indeterminate marker before it becomes retryable.

For confirmed failures, use `kasitek.core.content_post_publish_batch_retry` after a new approval,
or `POST /api/social/publish-batches/{batchId}/retry` from the authorized web surface. The retry
operation reuses the original target set, leaves published targets untouched, and requeues only
confirmed failed jobs. If no retryable target remains, the request is rejected instead of creating
a duplicate attempt.

## Observability and rollback

Search Core logs for `content.publish_batch.preflight`,
`content.publish_batch.admitted`, `content.publish_batch.idempotent_replay`, and
`content.publish_batch.retry_admitted`, and `content.publish_batch.status_refreshed`. These events include organization, post or batch ID,
counts, and bounded status fields; they must not include content, media URLs, tokens, or provider
payloads.

To disable the feature, stop granting or admitting the batch capability for new requests. Leave
existing batches in the worker/status path so confirmed, partial, and unknown results can be
reconciled. Keep the single-destination compatibility path available unless the incident affects
the provider adapter itself.
