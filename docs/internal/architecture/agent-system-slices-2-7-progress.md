# Agent system implementation progress: slices 2–7

This record is intentionally narrower than the blueprint completion checkboxes. A checkbox is only
marked when the complete deliverable and its verification exist.

## Implemented evidence

- Installation credential records use copy-once scrypt hashes, MCP scopes, token exchange, and
  rotation/revocation. MCP requests validate the ES256 installation token against the current
  credential and installation: `9f7203d`, `48b16bf`.
- Installation resource/connector grants and capability discovery are organization- and
  installation-scoped: `5745184`, `b3830c8`.
- Agent invocations can issue short-lived ES256 delegations and kasitek-core verifies issuer,
  audience, expiry, subject, organization, installation, capability, argument-hash, and
  idempotency claims. Replay prevention uses a Redis-backed atomic `SET NX` store rather than
  process memory; the external cross-replica/restart verification remains blocked until Redis is
  available (`BLOCKERS.md` B-008).
- Durable external-effect receipts and exact single-use approval records have migrations and
  repository transitions, including reconciliation-required outcomes. Approval decisions require
  `runs:approve`, and effects stay reserved until execution: `82ebdb0`, `63a90f7`, `e94e16a`,
  `ad7e0ec`, `7508423`, `7ecc36a`.
- The Agent Platform has a stateless MCP gateway process, installation-scoped MCP discovery/call
  transport, gateway authentication hardening, and durable MCP runs: `e90661c`, `75f051e`,
  `5d3787e`, `1c95d9c`.
- Installation calls now have an explicit non-Temporal fallback for read manifests that declare
  `execution: immediate`; it still creates a durable run, tool proposal, completion/failure
  evidence, and idempotency boundary. Durable/approval-required capabilities continue through
  Temporal.
- Provider-neutral connector manifests, canonical Telegram/Discord inbound envelopes, and delivery
  adapter boundaries are implemented and unit tested: `6e40567`, `b8e1c50`.
- Core action metadata and typed content adapters cover content listing, draft creation, and publish
  policy metadata without bypassing normalized request context: `440cf2f`, `e1d431a`.
- Hosted-agent product operations now cover durable run history/cancellation, installation resource
  and connector grants, built-in Telegram/Discord connector manifests, credentials, schedule
  triggers, knowledge URL ingestion, memory deletion/revalidation, channel registration/pairing,
  model policy configuration, pause/resume, and per-installation usage summaries. The core proxy,
  Agent API, and client detail experience are committed in `152192e`, `81807cb`, `5765e7e`,
  `55e33d6`, `52def06`, and `4e04a17`.
- The hosted-agent detail experience now includes a graph editor that writes the validated version
  `configuration.workflow` schema, supports node/edge and loop-bound editing, approval/wait/fan-out
  controls, and secret-safe JSON import/export. It uses the existing draft/publish/rollback
  lifecycle and is committed in `b2de22f`; full graph execution and end-to-end workflow test-run
  proof remain unchecked until the editor is connected to the durable workflow activity path.
- KasiAi runs now build grounded dynamic context from the authenticated actor and organization,
  granted capability names/modules, durable conversation, and bounded route/entity/page context
  marked as untrusted UI data. The shared builder and regression test are committed in `4e8df19`.
- KasiAi now keeps a compact redacted run-activity trail in chat for context preparation, model/tool
  activity, approval waits, failures, and completion, with a link to the durable timeline. The UI
  slice is committed in `ca5c200`; full approval-preview/result/retry interaction and authenticated
  browser proof remain open.
- External-agent setup now has a dedicated `/agents/connect` wizard for named copy-once credentials,
  independent MCP/REST scopes, installation capability/resource health, optional resource grants,
  and copyable MCP/REST client examples. Rotation/revocation and audit inspection remain linked to
  the existing detail/activity views. The slice is committed in `eaf6106`.
- The grounded context builder states a response provenance contract: separate reviewed knowledge,
  tool-derived facts, untrusted user data, unavailable actions, and uncertain information. The
  contract is covered by the context regression test in `71f9945`; model-judged/adversarial release
  evaluations remain unchecked.
- Approval/effect/invocation remediation is now in a coherent committed backend slice:
  `a0cf679` adds the shared installation invocation boundary, immediate-read durability, approval
  compare-and-set/idempotency, effect receipt transitions, gateway transport hardening, migrations
  `033`–`035`, and a local E2E smoke harness. Delegation key rotation and the Redis-backed replay
  store are committed in `e2c9d24`; public capability discovery filtering and pagination are
  committed in `fdf211a`.

## Verification evidence

On 2026-08-13, Agent Platform migrations through `035` applied to the local Agent PostgreSQL
database. With `RUN_AGENTS_DB_INTEGRATION_TESTS=true`, `pnpm --dir agents test` passed 41 files /
156 tests (one explicitly skipped Temporal recovery integration) under Node 22.22.2, and
`pnpm --dir agents build` passed. Gateway tests now cover body/timeout/disconnect/upstream/kill-switch
behavior and two independent replicas. `cargo fmt --check`, `cargo check -p kasitek-core`, and the
core library suite passed 71 tests with three explicitly ignored seeded-database/Redis cases.
Client and admin lint/typecheck/build verification also passed under Node 22.22.2 (one client lint
warning and 34 admin lint warnings, zero errors). External Redis, Temporal, browser, provider, and
frontend interaction matrices remain release gates tracked in the canonical checklist and
`BLOCKERS.md`.

The local smoke also passed on isolated API/gateway ports with a temporary development signing key
and `TEMPORAL_ENABLED=false`, exercising REST discovery/idempotency and MCP gateway negotiation
through the explicit immediate-read path against PostgreSQL. This does not replace the blocked
Temporal worker-restart or hosted gateway proof.

## Current checkbox reconciliation

The primary blueprint currently has **116 checked and 108 unchecked items out of 224**. This is a
progress count only; an unchecked item remains release work or an evidence-backed blocker.

## Remaining work

The hosted gateway route/deployment smoke, public Rust `/v1` middleware and principal matrix,
complete content handler transport, provider sandbox runs, admin operator delegation/read models,
and full UI/production verification remain unchecked in the blueprint until implemented and run in
their target environments.
