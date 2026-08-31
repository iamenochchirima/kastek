---
title: Agent conversation ordering
owner: agent-platform
last_reviewed: 2026-08-31
---

# Agent conversation ordering

KasiTek uses one active agent run per conversation. Different conversations may execute in
parallel. A conversation-bound run is active while it is `received`, `queued`, `running`,
`awaiting_approval`, `awaiting_human`, or `awaiting_external_event`.

## Admission contract

Conversation admission is protected at three levels:

1. The API transaction locks the conversation row before inspecting or allocating a run.
2. The database partial unique index `agent_runs_one_active_conversation_uidx` rejects a race that
   reaches insertion from another code path or replica.
3. One Temporal workflow owns one run, using the stable `agent-run-<run-id>` workflow identity.

The index migration fails closed if legacy data already has competing active runs. Operators must
resolve those rows explicitly before retrying migration 088.

## Backpressure and retries

The current contract deliberately applies backpressure instead of silently creating a second run:

- a platform request sent while a conversation is active receives `409 conversation_busy`;
- a channel request sent while a conversation is active receives the same error and its transaction
  rolls back, so the message is not partially persisted;
- a channel adapter must retry the same provider event and provider message identity after the active
  run reaches a terminal state;
- a duplicate redelivery with the same provider identity returns the original durable message/run;
- a platform client retries with its original idempotency key for transport uncertainty and receives
  the original run/message;
- retries of failed, cancelled, or expired platform runs create a new run linked by `causation_id`
  without duplicating the inbound message.

This is explicit admission backpressure, not a durable queued-message feature. A durable queue can
be added only with a defined acknowledgement, promotion, cancellation, and ordering contract.

## State behavior

`received` and `queued` are durable run lifecycle states owned by the Temporal workflow. A run moves
to `running` only after admission. Approval, human handoff, and external-event waits retain the
conversation lock invariant because they remain active. Cancellation or expiry makes the run
terminal; it does not delete or reorder the transcript. Completion writes the assistant message
before releasing the active-run index. Supersession applies to memory facts, not conversation
messages.

## Message sequence

Inbound acceptance, conversation append, and terminal assistant/error replies allocate the next
sequence number while holding the conversation row lock. Provider identities and platform
idempotency keys prevent a retry or redelivery from allocating a second sequence number. Delayed
media transcription updates the existing message/run path; it does not append a second user message.

## Operations

Watch active and queued run counts, oldest queue age, `conversation_busy` outcomes, provider
redelivery, and Temporal workflow failures. If a run remains active after worker loss, Temporal
replays the durable workflow. If provider outcome is unknown, follow the model/effect reconciliation
procedure before retrying. See the [Agent Temporal recovery runbook](../runbooks/agent-temporal-recovery.md).
