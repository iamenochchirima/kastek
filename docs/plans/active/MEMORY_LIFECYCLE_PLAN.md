# Memory lifecycle and retrieval plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-08-31

## Objective

Make memory behavior an explicit, typed part of an agent's runtime policy. Memory must be
disabled, explicit, reviewed, or automatic by declaration; every read and write must remain scoped
to the current organization, agent, installation, user, and conversation; and retrieval decisions
must be inspectable instead of being an opaque boolean regex gate.

## Scope

### Included

- A normalized memory policy with safe defaults and bounded limits.
- A memory lifecycle module that owns policy checks for retrieval and explicit writes.
- Explicit memory search and remember capabilities with scoped tool context.
- Structured retrieval decisions and regression tests for paraphrased references.
- Conversation admission protection against competing active runs.

### Excluded

- Model-generated automatic extraction and consolidation.
- PostgreSQL RLS activation before transaction-scoped database identity exists.
- Vector index rollout before embedding dimensions and provider ownership are measured.

## Context and constraints

- `memory_records` already has organization, agent, installation, conversation, user, provenance,
  sensitivity, expiry, status, and deletion fields.
- Existing direct repository and HTTP management paths must remain compatible.
- User-authored memory is untrusted evidence and must never become platform policy.
- Existing agents without a memory policy must retain current retrieval behavior while adopting
  bounded limits.
- A conversation may admit only one active run at a time. This tranche returns a retryable conflict
  rather than silently racing or dropping messages; queue admission is a later workflow tranche.

## Implementation plan

1. [x] Define normalized policy and structured retrieval decision interfaces.
2. [x] Add the lifecycle module and explicit memory capabilities.
3. [x] Apply the policy to runtime retrieval and memory tool invocation.
4. [x] Protect conversation run admission and add regression coverage.
5. [x] Update the architecture documentation and record the remaining privacy, API, and
   operations follow-up work.
6. [x] Run type, unit, integration, migration, and full-suite checks.

## Verification

- [ ] `pnpm --dir agents exec tsc --noEmit`.
- [ ] Targeted memory, context, tool, and run-admission tests.
- [ ] Full `pnpm --dir agents test`.
- [ ] `pnpm --dir agents run build`.
- [ ] Migration check and production deployment evidence if a watched runtime file changes.

## Release record

Change: Add typed memory policy/retrieval boundaries and prevent competing conversation runs.

Owner: Agent Platform.

Risk: Standard. Existing policy-free installations preserve retrieval behavior; new capabilities
are bounded and scoped. Conversation admission changes concurrent-message behavior to a retryable
conflict until queue admission is implemented.

Affected services and user surfaces: agents-api, agents-worker, Agent Platform PostgreSQL, hosted
agent execution, memory management, and conversation APIs.

Platform release version or release ID: assign at release time; current implementation commits are
recorded in the completed plan and audit document.

API/schema/migration changes: memory capabilities are internal runtime tools; conversation admission
adds an explicit `conversation_run_active` conflict. No destructive migration is required in this
tranche.

Feature flag or rollout method: existing memory policy defaults remain compatible. The memory tools
are available only when granted by the agent version policy and installation scope.

Analytics events and success metrics: record retrieval decision reason, candidate count, policy mode,
and memory tool outcomes without prompt or memory text. Success means no cross-installation reads or
writes and no concurrent active runs for one conversation.

Logs, metrics, dashboards, and alerts: structured bounded runtime events for retrieval decisions,
policy rejection, memory writes, and admission conflicts. Collector configuration: not applicable.

User, API, internal, and operational documentation: update memory architecture and API capability
documentation; document the retryable conversation conflict and future queue behavior.

Validation evidence: `pnpm exec tsc --noEmit`, `pnpm build`, migration tests (18 passed), targeted
run integration tests (5 passed), and the full database-backed Agents suite (100 files passed, 549
tests passed, 2 intentional Temporal recovery skips). Migrations 081, 082, and 083 applied to the
isolated PostgreSQL test database.

Rollback or disable plan: remove the memory capability grants from new versions; the repository
scope checks remain active. Roll back the application release without removing existing memory rows.

Post-release review date: set at release time.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Default policy | Policy-free installations retain current retrieval behavior with bounded limits. | Agent Platform | Decided |
| Automatic extraction | Not enabled by this tranche; it requires review, contradiction, and consolidation semantics. | Agent Platform | Open |
| Conversation contention | Reject with an explicit retryable conflict until a durable queue and wake-up path exist. | Agent Platform | Decided |
| RLS | Defer until every transaction sets organization and actor context and restricted-role tests exist. | Platform security | Open |

## Notes and blockers

The current repository remains responsible for ownership predicates. RLS is not enabled by this
plan because enabling policies without transaction-scoped identity would create either outages or
an apparent control that can be bypassed by pooled connections. Automatic extraction, review,
consolidation, derived-store deletion, and production rollout remain follow-up work in the audit.
