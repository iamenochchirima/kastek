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

## B-003 — Temporal and authenticated browser smoke verification remain unavailable

- **Blueprint:** Slice 0 database/Temporal and authenticated health-smoke
  verification.
- **Resolved evidence:** `agents/.env` supplies a local Agent PostgreSQL
  database at `localhost:5433`; `pnpm migrate` applied migrations 027–032,
  and `set -a; source .env; set +a; RUN_AGENTS_DB_INTEGRATION_TESTS=true
  pnpm test` passed all 39 files / 113 tests on 2026-08-13.
- **Remaining evidence:** no local core/API/browser process is running on
  ports 4000, 4100, 3000, or 3001. The configured Temporal Cloud namespace
  has not yet been exercised with a worker recovery, approval continuation,
  and MCP smoke run.
- **Impact:** Agent database verification is no longer blocked. Temporal
  recovery and authenticated end-to-end browser/MCP verification remain open.
- **Next action:** Start the API, Temporal worker, and gateway with the
  configured development environment, then execute the durable MCP approval
  and recovery smoke tests.

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
