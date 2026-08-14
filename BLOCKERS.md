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
  database at `localhost:5433`; migrations are applied. With the isolated local
  Temporal dev server running at `127.0.0.1:7233`, the complete Agent suite
  passed **49 files / 204 tests / 0 skipped** under Node 22.22.2:
  `RUN_AGENTS_DB_INTEGRATION_TESTS=true RUN_TEMPORAL_INTEGRATION_TESTS=true
  TEMPORAL_TEST_ADDRESS=127.0.0.1:7233 pnpm --dir agents test`.
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
- **Additional local evidence (2026-08-14):** an isolated local stack started
  core (`:4000`), Agent API (`:4110` and standard `:4100`), Temporal worker,
  MCP gateways (`:4210` and standard `:4200`), client (`:3000`), and admin
  (`:3001`). Core, Agent, gateway, client, and admin liveness/readiness or
  route checks returned successfully. The real smoke passed on the isolated
  ports, and the standard `4100/4200` topology also passed
  `pnpm run test:e2e:local`. A temporary verified local product session rendered the authenticated
  `/agents` page with HTTP 200, and a local admin principal rendered
  `/dashboard` with HTTP 200. The smoke used an ephemeral ES256 key and
  deleted its temporary product session after the request.
- **Remaining evidence:** this is HTTP/SSR route verification, not a browser
  automation run. Real provider effects/recovery, hosted routing/scaling, and
  cross-browser client/admin scenarios remain unverified. The default
  `agents/.env` still needs a dedicated development ES256 installation-token
  key before the standard launcher can run the installation smoke without
  temporary setup.
- **Impact:** local service and authenticated route health are verified;
  hosted/provider recovery and browser automation release gates remain open.
- **Next action:** add the development signing key to the standard local setup,
  then run approved/denied publication, worker-restart, provider recovery, and
  authenticated browser smoke scenarios.

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

## B-007 — Approval actor/resource role matrix is not yet defined

- **Blueprint:** Slice 10 approval verification; remediation AR-002.
- **Evidence:** approval records bind the organization, installation, capability, arguments, preview,
  and effect key. The initial separation-of-duties policy is now explicit and enforced: the run
  initiator cannot approve their own action (`22b2748`, `agents/test/http.test.ts`). The public
  decision route still receives only a generic authenticated actor ID and does not yet have an
  approved workspace role/resource matrix or external-service principal model.
- **Impact:** atomic decision state, retry idempotency, and self-approval protection are implemented,
  but full approver/resource authorization cannot be claimed. Do not expand real external effects
  beyond controlled testing until the role/resource policy and identity inputs exist.
- **Next action:** approve the workspace approver/resource decision matrix and persist/propagate the
  initiating human or service principal needed for cross-resource authorization checks.

## B-011 — Public capability feature-flag and resource-discovery policy is not yet defined

- **Blueprint:** Slice 7 public capability discovery; audit remediation AR-006.
- **Evidence:** The public action catalog currently defines lifecycle, actor, runtime, grant,
  entitlement, API-scope, and Agent availability metadata. It does not define a product-owned
  feature-flag namespace or a safe resource-policy query that can be evaluated without a requested
  resource. Direct-user request contexts also do not yet resolve an approved action-grant mapping.
  The public REST transport now has deployment-level exact-route flags and standard deprecation
  headers (`8a68bab`), but those controls intentionally do not substitute for action-level policy.
- **Impact:** Discovery safely denies non-public lifecycle entries and filters installation grants,
  scopes, entitlements, and availability, but resource-level and feature-flag filtering cannot be
  claimed without inventing policy. The affected AR-006 items remain unchecked.
- **Next action:** approve the public principal/grant mapping and feature/resource policy contract,
  then add the policy resolver and cross-organization discovery tests before exposing more actions.

## B-008 — Redis replay-store integration environment is unavailable

- **Blueprint:** Slice 7/13 delegation replay verification; remediation AR-007.
- **Evidence:** `services::realtime::delegation_replay_tests::replay_store_is_shared_across_instances_and_expires`
  requires `REDIS_REPLAY_TEST_URL`. No local Redis server is installed, and attempting to start the
  isolated `redis:7-alpine` container failed because the Docker daemon is unavailable. On
  2026-08-14, running the test against the configured remote `REDIS_URL` with
  `REDIS_REPLAY_TEST_URL="$REDIS_URL"` failed the second-instance assertion (`second.claim(...)`
  returned true), so that endpoint is not accepted as an isolated replay-test target.
- **Impact:** replay-store code and its cross-instance/expiry regression test compile, but the test
  remains explicitly ignored and AR-007's multi-instance, restart, and expiry checks remain open.
- **Next action:** provide an isolated Redis URL or start Docker, then run
  `REDIS_REPLAY_TEST_URL=redis://127.0.0.1:6380 cargo test -p kasitek-core
  services::realtime::delegation_replay_tests -- --ignored` from `server/`.

## B-009 — Temporal worker-recovery integration (resolved locally)

- **Blueprint:** Slice 4/7/10 verification; approval wait, worker replacement, cancellation, and
  replay recovery.
- **Evidence:** an isolated Temporal dev server was started with the local
  Temporal CLI on `127.0.0.1:7233`, and the recovery integration was run
  directly and as part of the full Agent suite. The worker-replacement approval
  wait resumed exactly once; the full suite passed **49 files / 204 tests / 0
  skipped** with `RUN_AGENTS_DB_INTEGRATION_TESTS=true
  RUN_TEMPORAL_INTEGRATION_TESTS=true`.
- **Resolution:** local approval continuation, worker replacement, signal
  recovery, cancellation, and durable run paths are now verified. Hosted
  Temporal, provider-side crash recovery, and external deployment smoke remain
  part of B-003 rather than this local environment blocker.

## B-010 — Core seeded-database integration tests are unavailable in the current run

- **Blueprint:** Slice 0/1 core database verification.
- **Evidence:** `cargo test -p kasitek-core --lib -- --include-ignored` on 2026-08-14 reached the
  configured PostgreSQL database and passed **118 tests**, but the two seeded-data cases failed
  because the expected fixtures were absent: `services::connections::tests::database_sync_preserves_organization_ownership`
  expected two records for `org_connections_a` and found zero, while
  `services::inbox::tests::conversation_reads_are_isolated_by_organization` could not find
  `conversation_meta_a`. The third failure is the separate Redis replay gate in B-008.
- **Impact:** core unit and contract coverage is green, but zero-failure seeded database
  verification cannot be claimed until the fixture dataset is loaded into an isolated test
  database. The run did confirm the current core library total is 118 passing tests.
- **Next action:** provision/load the documented isolated core fixture dataset and rerun
  `cargo test -p kasitek-core --lib -- --include-ignored`; provide an isolated Redis URL for B-008.
