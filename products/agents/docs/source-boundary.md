# Implementation boundary

Agents is a fresh standalone product. Its API and worker use the dedicated
`agents_platform` PostgreSQL schema in `api/schema/001_platform.sql`. There is no
legacy data migration or Growth runtime dependency.

## Current modules

| Module in `api/src/platform` | Responsibility |
| --- | --- |
| `contracts.ts` | Two execution kinds, FAQ configuration, scope, grants, limits, and task states. |
| `auth.ts`, `config.ts` | OIDC login, validated identity, session configuration, and backchannel logout. |
| `store.ts` | Product membership, drafts, immutable versions, approved knowledge, website bindings, atomic admission, and reservations. |
| `app.ts`, `server.ts`, `widget.ts` | Management and website HTTP APIs, task history, progress, cancellation, and widget delivery. |
| `business.ts` | Restate FAQ workflow, scoped retrieval, bounded model calls, operation records, and usage settlement. |
| `dispatcher.ts`, `worker.ts` | Leased outbox delivery, stable runtime identity, cancellation reconciliation, and worker lifecycle. |
| `setup.ts` | Fresh database initialization and schema identity checks. |

The management client is in `web/`. The API and worker run independently of Growth
and Agencies. The implementation currently admits the standalone Agents journey;
embedded product execution remains future work.

## Execution

An immutable version declares `business` or `workspace`. Only `business` runs.
Workspace admission fails explicitly with `RUNTIME_UNAVAILABLE`.

The FAQ configuration disables delegation, sandboxes, business-action tools,
additional workflows, and schedules. Its single model reply uses approved source
revisions and bounded lexical retrieval. The complete prompt, including source
labels and instructions, fits the input limit. Current provider execution uses only
OpenRouter's configured free model, with no paid fallback.

Admission records a task, reservation, and outbox entry atomically. Duplicate
request keys return the same authorized task, and conflicting payloads fail.
Restate 1.7.13 and SDK 1.17.3 execute a keyed workflow. The worker also records its
invocation ID, so a lost dispatcher response does not discard runtime identity.

A started model operation with no confirmed result becomes `uncertain` on replay;
it does not start a second provider request. Successful usage settles once.
Definitive provider rejections release the unused reservation and record zero usage.
Uncertain outcomes conservatively account for the reservation. Cancellation is a
request until its result is known. An in-flight model call can remain uncertain.

Runtime workflow and journal retention are seven days. Outbox retries stop after
24 hours, before that retention expires. Settled tasks are never resubmitted.

## Verification and release limits

Tests cover PostgreSQL admission, immutable versions, scope checks, reservations,
HTTP behavior, and actual Restate execution with fixture model responses. Runtime
checks cover duplicate dispatch, lost responses, worker connection restart and
replay, cancellation, and usage settlement. Fixture replies are not real model
acceptance. The live browser journey separately verifies four real free-model tasks through
private Test, publication, an external widget and lost-response recovery. Keycloak 26.6.0
verification covers real PKCE login, invalid state/nonce/verifier denial, signed backchannel
logout and the execution client's audience and narrow role. These are local acceptance checks,
not production rollout or signup-email verification.

Outbound MCP, product business actions, service-to-service product admission,
subagents, temporary sandboxes, schedules, Lina execution, and evaluation adapters
are not implemented. There are no active OTLP exporters. Services emit structured
stdout with bounded errors; production monitoring, alerts, deployment identity,
and rollout remain unverified.
