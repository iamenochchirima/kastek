---
id: agent-capability-awareness-local
title: Agent capability awareness local verification
sidebar_position: 20
owner: agent-platform
last_reviewed: 2026-09-09
---

# Agent capability awareness staging

This runbook validates the capability-aware runtime locally through the existing Agent API,
Temporal/MCP processes, and `https://dev-client.kasitek.co.za/` development proxy. It is not a
hosted staging or production-release procedure. Never paste credentials, raw provider IDs, or
message bodies into the local evidence record.

## Preconditions

- The local Agent database is migrated through the current migration revision.
- Agent API, worker, MCP gateway, and the development proxy are healthy.
- A local organization has one Playground installation and one Live installation for the same
  agent version.
- The staging installation has a registered connector adapter, one MCP tool, one isolated plugin,
  one pinned dependency-ready skill, and one approval-gated effect.
- The release owner has a rollback target and an operator identity with the required read/write
  scopes.

## Candidate and Live checks

Connection activation is installation-scoped. A successful native OAuth, API-key, or local
connector flow grants the catalog entry's declared bundle to the Playground installation; it does
not change Live. A disconnect revokes that installation bundle. Capability-changing requests aimed
at a Live installation fail with `PLAYGROUND_REQUIRED`; the operator must make the change in
Playground and deploy it. Plugin/MCP and skill changes must be present in the candidate extension
snapshot before promotion.

1. Read `GET /v1/agents/:agentId/deployment-status` and record the candidate/live version IDs,
   portable capability/extension digests, binding revision, and current rollback target.
2. Run `POST /v1/installations/:installationId/preflight` against the Live installation with the
   candidate version and Playground source installation. Confirm the result is ready and that no
   credential values or raw provider identifiers are returned.
3. Run one Playground capability question and one factual question. The capability question must
   reach the model and include the effective capability summary; the factual question must still
   use the evidence-only grounding policy.
4. Confirm the run journal contains `agent.capabilities.resolved` with the candidate digest,
   bounded callable/unavailable counts, and `intent`.
5. Confirm the model receives the connector, MCP, and plugin schemas only when their adapter,
   registration, grant, and readiness checks pass. Confirm the pinned skill body is loaded only
   for a matching request.
6. Invoke the approval-gated effect once. It must pause before the effect, resume only after an
   exact approval, and record durable completion evidence.

## Runtime contract

Capability awareness is always active. There is no rollout flag or alternate prompt path. A failed
capability-resolution or readiness check must produce a typed unavailable reason; it must not remove
the model-facing capability contract or replace a capability question with the factual grounding
fallback.

## Promotion and rollback

After the local checks pass:

1. Re-run Live preflight with the exact candidate and expected Live pointer.
2. Promote through `POST /v1/installations/:installationId/promote` with the Playground source,
   expected current version, and a unique idempotency key.
3. Re-read deployment status and record the activation event, candidate/live digests, binding
   revision, actor, and rollback target.
4. Run a Live capability question, one factual grounding check, and one approval-gated dry run.
5. If activation or post-activation checks fail, call
   `POST /v1/installations/:installationId/rollback` with the expected current version and the
   recorded rollback target. Verify that Playground, active runs, conversations, memories, and
   prior evidence were not mutated.

## Evidence record

Record the following in the active capability-awareness plan and release record:

- platform release ID, commit SHA, artifact digest, and migration result;
- candidate/live version IDs, portable/effective snapshot digests, and binding revision;
- deployment-status and preflight responses with secrets and raw provider identifiers removed;
- run IDs and event IDs for capability, factual-grounding, approval, promotion, activation, and
  rollback checks;
- flag scope, revision, enable/disable times, comparison window, and metric query/dashboard;
- release-owner decision and any remediation or rollback result.

The local capability staging-equivalent test is the acceptance evidence for local development. If
hosted staging is unavailable, leave this optional hosted-release procedure pending; it does not
block local implementation or local end-to-end testing.
