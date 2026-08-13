# Implementation blockers

This file records only issues that prevent a specific blueprint item from being
verified or completed. Work on independent items continues.

## B-001 — Direct client lint baseline failure (resolved)

- **Blueprint:** Slice 0 verification; client lint/typecheck/build baseline.
- **Evidence:** `pnpm --filter client lint` fails in the unmodified
  `client/apps/client/src/app/(dashboard)/agents/page.tsx:30` with
  `react-hooks/immutability`: `agentsUnavailable` is reassigned from an async
  callback after rendering.
- **Resolution:** Reworked the async result into an immutable success/unavailable
  value. `pnpm --filter client lint` now passes with one existing non-blocking
  `<img>` warning; client TypeScript checking also passes.

## B-002 — Admin lint command has no ESLint flat configuration (resolved)

- **Blueprint:** Slice 0 verification; admin lint baseline.
- **Evidence:** `pnpm --filter admin lint` invokes ESLint 9.39.2, which stops
  because `client/apps/admin` has no `eslint.config.{js,mjs,cjs}`.
- **Resolution:** Added the ESLint 9 flat configuration at
  `client/apps/admin/eslint.config.mjs`. `pnpm --filter admin lint` now exits
  successfully with existing warnings only; hydration-related state effects
  are explicitly documented in the config while the shared state boundary is
  migrated.

## B-003 — Full approval/effect and browser smoke verification remain incomplete

- **Blueprint:** Slice 0 database/Temporal and authenticated health-smoke
  verification.
- **Resolved evidence:** `agents/.env` supplies a local Agent PostgreSQL
  database at `localhost:5433`; migrations are applied, and
  `set -a; source .env; set +a; RUN_AGENTS_DB_INTEGRATION_TESTS=true
  pnpm --dir agents test` passed **41 files / 156 tests** on 2026-08-13 under Node 22.22.2.
- **Current evidence:** a controlled local stack using Agent API, PostgreSQL,
  Temporal worker, and the stateless gateway passed `pnpm test:e2e:local` on
  2026-08-13. It created an isolated installation, exchanged REST and MCP
  credentials, verified filtered discovery, proved REST idempotency through a
  durable run, and initialized/called MCP through the gateway. The smoke
  archives its fixture after completion.
- **Additional current evidence:** the same smoke passed on isolated API/gateway
  ports `4110/4210` with a temporary development ES256 key and
  `TEMPORAL_ENABLED=false`. This exercised the explicit-immediate read path
  against the real PostgreSQL database, including REST idempotency and MCP
  gateway negotiation, without touching the other session's stack.
- **Remaining evidence:** the standard local-stack launcher now starts the
  gateway, but the default `agents/.env` still needs a dedicated development
  ES256 installation-token key before that smoke can run without temporary
  setup. Approval continuation, real provider effects/recovery, worker restart,
  and authenticated client/admin browser scenarios remain unverified.
- **Impact:** basic installation REST/MCP end-to-end verification is now
  available. The recovery and user-interface release gates remain open.
- **Next action:** add the development signing key to the standard local setup,
  then run approved/denied publication, worker-restart,
  and authenticated browser smoke scenarios.

## B-004 — Client production build cannot run in this sandbox (resolved)

- **Blueprint:** Slice 0 direct-client production build baseline.
- **Evidence:** `pnpm build:client` reaches `next build` but Turbopack fails
  while processing `globals.css`: creating a subprocess that binds a port is
  not permitted by the sandbox (`os error 1`).
- **Resolution:** After the Agents page lint fix, `pnpm build:client` completed
  successfully in this environment. Prisma-generated verification output was
  restored because it was a command artifact and not part of this task's changes.

## B-005 — Core route-surface migration overlaps active unrelated edits

- **Blueprint:** Slice 1 application shell and route-surface split.
- **Evidence:** `server/kasitek-core/src/routes.rs` has active uncommitted
  social/OAuth route changes outside this programme. A minimal `/v1/health` and
  `/v1/capabilities` mount was staged independently; the route table remains
  the shared target for splitting `api::product`, `api::admin`, `api::internal`,
  `api::provider_webhooks`, and `api::website`.
- **Impact:** I can add the shell and independently migrate domains, but cannot
  safely replace the central route table or claim route-surface parity until
  those edits are committed or explicitly handed over.
- **Next action:** Rebase the route split on the completed social/OAuth change,
  preserving its endpoint additions and response contracts.

## B-006 — Admin operator policy is not yet defined

- **Blueprint:** Slice 12 operator roles, support access, dual-control actions, and core-to-Agent
  operator delegation.
- **Evidence:** The current admin application exposes existing product-admin session roles, but the
  blueprint does not specify the operator role-to-scope mapping, support-access grant record, or
  dual-control policy needed for the new agent operations surface.
- **Impact:** I can continue implementing redacted operational read models and recovery primitives,
  but I will not invent privileged role semantics or expose customer-content support actions.
- **Next action:** Select and document the operator role matrix and support-grant policy, then wire
  the protected admin API and end-to-end authorization tests.

## B-007 — Approval actor/resource and self-approval policy is not yet defined

- **Blueprint:** Slice 10 approval verification; remediation AR-002.
- **Evidence:** approval records bind the organization, installation, capability, arguments, preview,
  and effect key, but the public decision route receives only a generic authenticated actor ID. The
  approved policy does not define which workspace roles may approve which resources, whether the run
  initiator may approve their own action, or how that initiator is represented for external agents.
- **Impact:** atomic decision state and retry idempotency are implemented, but full approver/resource
  authorization and self-approval verification cannot be claimed. Do not expand real external effects
  beyond controlled testing until this policy and its identity inputs exist.
- **Next action:** approve the decision matrix and persist/propagate the initiating human or service
  principal needed for separation-of-duties checks, then add cross-resource and self-approval tests.

## B-011 — Public capability feature-flag and resource-discovery policy is not yet defined

- **Blueprint:** Slice 7 public capability discovery; audit remediation AR-006.
- **Evidence:** The public action catalog currently defines lifecycle, actor, runtime, grant,
  entitlement, API-scope, and Agent availability metadata. It does not define a product-owned
  feature-flag namespace or a safe resource-policy query that can be evaluated without a requested
  resource. Direct-user request contexts also do not yet resolve an approved action-grant mapping.
- **Impact:** Discovery safely denies non-public lifecycle entries and filters installation grants,
  scopes, entitlements, and availability, but resource-level and feature-flag filtering cannot be
  claimed without inventing policy. The affected AR-006 items remain unchecked.
- **Next action:** approve the public principal/grant mapping and feature/resource policy contract,
  then add the policy resolver and cross-organization discovery tests before exposing more actions.

## B-008 — Redis replay-store integration environment is unavailable

- **Blueprint:** Slice 7/13 delegation replay verification; remediation AR-007.
- **Evidence:** `services::realtime::delegation_replay_tests::replay_store_is_shared_across_instances_and_expires`
  requires `REDIS_REPLAY_TEST_URL`. No local Redis server is installed, and attempting to start the
  isolated `redis:7-alpine` container failed because the Docker daemon is unavailable.
- **Impact:** replay-store code and its cross-instance/expiry regression test compile, but the test
  remains explicitly ignored and AR-007's multi-instance, restart, and expiry checks remain open.
- **Next action:** provide an isolated Redis URL or start Docker, then run
  `REDIS_REPLAY_TEST_URL=redis://127.0.0.1:6380 cargo test -p kasitek-core
  services::realtime::delegation_replay_tests -- --ignored` from `server/`.

## B-009 — Temporal worker-recovery integration environment is unavailable

- **Blueprint:** Slice 4/7/10 verification; approval wait, worker replacement, cancellation, and
  replay recovery.
- **Evidence:** `agents/test/temporal-recovery.integration.test.ts` is explicitly skipped unless
  `TEMPORAL_TEST_ADDRESS` and `RUN_TEMPORAL_INTEGRATION_TESTS=true` are set. The current full Agent
  run therefore reports one intentional skip; no local Temporal test server is running in this
  environment.
- **Impact:** unit/database approval transitions and the durable workflow implementation are tested,
  but worker replacement and live signal recovery are not yet externally verified.
- **Next action:** start an isolated Temporal test server, then run
  `TEMPORAL_TEST_ADDRESS=127.0.0.1:7233 RUN_TEMPORAL_INTEGRATION_TESTS=true
  RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents test -- temporal-recovery.integration.test.ts`.

## B-010 — Core seeded-database integration tests are unavailable in the current run

- **Blueprint:** Slice 0/1 core database verification.
- **Evidence:** `cargo test -p kasitek-core --lib` passed 71 tests and explicitly ignored three
  seeded-database cases: connection capability synchronization, conversation organization
  isolation, and Redis replay integration (the latter is also tracked as B-008).
- **Impact:** core unit and contract tests are green, but those database isolation checks cannot be
  represented as zero-ignore verification without a seeded core PostgreSQL database and Redis.
- **Next action:** provision the isolated core test database and Redis, then rerun
  `cargo test -p kasitek-core --lib -- --include-ignored` with the appropriate environment.
