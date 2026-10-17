# Implementation boundary

Agents is a fresh standalone product. Its API and business worker use the dedicated
`agents_platform` PostgreSQL schema. Setup loads the ordered SQL files in
`api/schema/` into a fresh database and checks their combined digest on subsequent
startup. It does not migrate an older database or import Growth state.

## Current modules

| Module in `api/src/platform` | Responsibility |
| --- | --- |
| `contracts.ts` | Agent configuration, two execution kinds, grants, limits, and task states. |
| `auth.ts`, `config.ts` | OIDC login, product sessions, identity configuration, and backchannel logout. |
| `store.ts` | Membership, drafts, immutable publication, knowledge, ordered admission, and root reservations. |
| `app.ts`, `server.ts`, `widget.ts` | Management and website APIs, continuation, history deletion, progress, cancellation, and widget delivery. |
| `execution.ts` | Current authority, task and operation identities, claims, receipts, and usage settlement. |
| `business.ts` | Restate business controller, model and tool rounds, ordered turns, and compaction coordination. |
| `model.ts`, `context.ts` | Provider protocol, conservative request accounting, scoped context snapshots, and complete message groups. |
| `memory.ts`, `memory-routes.ts` | Personal memory candidates, authenticated acceptance, revisions, expiry, forgetting, source invalidation, and pinned skills. |
| `artifacts.ts`, `task-artifacts.ts` | Private S3-compatible content, root/task provenance, explicit transfers, downloads, integrity and deletion. |
| `delegation.ts`, `tool-descriptors.ts` | Published specialist bindings, atomic child admission, bounded results and pinned adapter contracts. |
| `sandbox.ts`, `sandbox-executor.ts`, `sandbox-reaper.ts` | Isolated analysis, durable resource/command identities, artifact export and independent cleanup. |
| `dispatcher.ts`, `worker.ts`, `worker-security.ts` | Leased outbox delivery, runtime identity, cancellation reconciliation, request signatures, and worker lifecycle. |
| `setup.ts` | Fresh database initialization and schema checks. |

The management client is in `web/`. Its create, configure, Test, and website
publication journey shares these APIs. Growth and Agencies retain independent
membership, permissions, and domain records. Embedded execution remains unavailable.

## Business execution

The technical categories remain `business` and `workspace`. The business harness
owns its model and tool loop. Restate 1.7.13 with SDK 1.17.3 coordinates durable
steps and recovery. Workspace execution remains unavailable until the separate
Lina adapter is implemented.

Each task pins an immutable agent version and harness release. An ordered
conversation turn uses authorized prior outcomes, selected knowledge, optionally
approved personal memory, pinned skills, and complete model/tool groups. Context
snapshots preserve request digests and source revisions in private PostgreSQL
records. Compaction is an identified model operation with its own budget and
recorded result. Large generated content uses private S3-compatible artifacts.
Context snapshots are not currently stored as S3 objects.

Selected tools are `knowledge.search`, `knowledge.read`, `memory.search`, and
`memory.propose`, `agents.delegate` and `sandbox.analyze`. Trusted code validates their arguments and scope. A memory
proposal creates a candidate. Only an authenticated management action accepts,
corrects, or forgets it. Publishing a skill creates an immutable revision; skill
text cannot install tools or grant permission.

A minimal website FAQ uses this same controller with optional capabilities
disabled. Public visitors receive conversation-scoped context and approved public
knowledge. Personal memory, skills, and memory tools are denied for website
publication and execution.

Provider requests use only `nvidia/nemotron-3-super-120b-a12b:free` through OpenRouter,
with fallback disabled and reasoning effort `none`. Input preflight conservatively
counts serialized UTF-8 bytes against the configured token allowance and reserves
framing separately. This estimate is not an exact tokenizer count. Returned usage,
finish reasons, tool calls, and unexpected reasoning are validated.

## Admission, limits, and recovery

Admission atomically records the task, stable conversation sequence, root
reservation, and outbox command. Duplicate keys return the same authorized task;
changed payloads conflict. Model, tool, and compaction operations have separate
stable identities and receipts. A recorded result is reused after replay. An
unconfirmed model request becomes uncertain rather than generating another reply.

The development profile allows a root allocation up to 32,000 accounted tokens,
12 model calls including compaction and children, and 24 tool calls. Its model input allowance
is at most 8,192 conservative estimated tokens, with 1,024 output tokens and a
120-second deadline per model call. Root wall lifetime is 24 hours. Accounted
active operation time is bounded to 15 minutes. Organization limits are two
accepted active roots, two model operations, and four tool operations in flight.

The 100,000-token organization allowance applies to the UTC admission day.
Operations settle the original root reservation even after midnight. This is not
a separate physical-consumption cap for each later day. Uncertain operations
conservatively consume their reservation. Definitive rejection releases unused
usage. Settlement is idempotent at both operation and root level.

A coordinator can admit two version-pinned read-only business specialists with
explicit briefs and source subsets. Children use private conversation branches and
subdivide one root allocation; they do not consume new root slots or organization
reservations. Their current authority is also bounded by the root grant. A parent
waits for all admitted dependent children and identifies partial or uncertain results.

Optional analysis uses the verified local no-network gVisor Python profile.
The task owns stable allocation and command IDs; reconnect reads receipts/status.
Private artifact references survive resource destruction. An independent reaper
cleans expired and stopping-root resources. Root settlement retains ownership of
pending children and resources. See the runtime reference for setup and limits.

Cancellation records intent and blocks new work. It does not undo an accepted
effect or prove that a provider stopped. An uncertain outcome stays visible.
Runtime journals and workflows retain seven days. Outbox retries stop at 24 hours,
and settled tasks are not submitted again.

Memory changes and expiry invalidate future use through namespace generations
and dispatch checks. Conversation deletion tombstones its source history, cancels
open tasks, and invalidates linked memory. It does not physically erase old
revisions, completed provider requests, journals, or backups.

## Verification and release limits

Focused PostgreSQL tests cover memory scope, candidate review, revision conflicts,
forgetting, expiry, source-history deletion, immutable skills, and dispatch locking.
Real MinIO checks cover signed private storage, integrity, lost-response recovery,
and deletion during an upload. The standalone SDK worker check verifies signature
acceptance and denial over HTTP2, including forged invocation requests.

Deterministic provider fixtures exercise model protocol, context, and failure
paths. They do not establish real model behavior. The current real-model browser journey verifies contextual follow-up, approved memory across
conversations, a completed memory.search tool receipt, pinned skills and correction/forget controls.
The website/widget journey and real Keycloak checks remain distinct acceptance paths. Worker signature
fixtures do not certify cluster key distribution or a production deployment.

Outbound MCP, destination business writes, in-task effect approval, schedules, Lina execution and evaluation adapters remain unavailable. Subagents require explicit published bindings; analysis also requires the pinned backend, resource controls and private storage.
Production rollout, secret management, durable log retention, monitoring, backups,
and signup-email delivery require separate verification. There are no active OTLP
exporters. Services emit bounded structured stdout diagnostics.
