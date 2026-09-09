---
id: agent-capability-awareness-staging
title: Agent capability awareness staging
sidebar_position: 20
owner: agent-platform
last_reviewed: 2026-09-09
---

# Agent capability awareness staging

This is an optional hosted-release runbook for validating the capability-aware runtime before
enabling it for a wider installation set. It is not required for local end-to-end acceptance.
Use an isolated staging organization and non-production provider accounts. Never paste
credentials, raw provider IDs, or message bodies into the release record.

## Preconditions

- The exact candidate artifact and migration revision are recorded.
- Staging has separate Agent/Core databases, queues, credentials, webhook endpoints, and telemetry
  destination as required by [Environments](../operations/environments.md).
- A staging organization has one Playground installation and one Live installation for the same
  agent version.
- The staging installation has a registered connector adapter, one MCP tool, one isolated plugin,
  one pinned dependency-ready skill, and one approval-gated effect.
- The release owner has a rollback target and an operator identity with the required read/write
  scopes.

## Candidate and Live checks

1. Read `GET /v1/agents/:agentId/deployment-status` and record the candidate/live version IDs,
   portable capability/extension digests, binding revision, and current rollback target.
2. Run `POST /v1/installations/:installationId/preflight` against the Live installation with the
   candidate version and Playground source installation. Confirm the result is ready and that no
   credential values or raw provider identifiers are returned.
3. Run one Playground capability question and one factual question. The capability question must
   reach the model and include the effective capability summary; the factual question must still
   use the evidence-only grounding policy.
4. Confirm the run journal contains `agent.capabilities.resolved` with the candidate digest,
   bounded callable/unavailable counts, `intent`, and `capabilityAwarenessEnabled`.
5. Confirm the model receives the connector, MCP, and plugin schemas only when their adapter,
   registration, grant, and readiness checks pass. Confirm the pinned skill body is loaded only
   for a matching request.
6. Invoke the approval-gated effect once. It must pause before the effect, resume only after an
   exact approval, and record durable completion evidence.

## Controlled rollout

Use the operator command boundary for `capability_awareness_enabled`; do not edit the database
directly. Enable the flag in this order:

1. one staging installation;
2. the staging organization;
3. the remaining staging installations after the first comparison is clean.

For each step, compare capability-request success, model-call admission, grounding blocks by
intent, capability-resolution failures, unavailable reasons, tool success, approval pauses, and
run latency against the previous flag state. The snapshot digest and callable-tool count should be
stable for equivalent runs; a flag change may only add/remove the model-facing native guidance.

If the comparison fails, clear the scoped flag through the same operator command boundary. Tool
grants, approvals, and the effective snapshot remain enforced while the model-facing contract is
rolled back.

## Promotion and rollback

After the staging comparison is accepted:

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
