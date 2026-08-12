# Implementation blockers

This file records only issues that prevent a specific blueprint item from being
verified or completed. Work on independent items continues.

## B-001 — Direct client lint baseline failure

- **Blueprint:** Slice 0 verification; client lint/typecheck/build baseline.
- **Evidence:** `pnpm --filter client lint` fails in the unmodified
  `client/apps/client/src/app/(dashboard)/agents/page.tsx:30` with
  `react-hooks/immutability`: `agentsUnavailable` is reassigned from an async
  callback after rendering.
- **Impact:** The direct-client baseline and any slice whose completion requires
  a clean client lint remain unverified until this pre-existing error is fixed.
- **Next action:** Repair the page without changing its Agents availability
  semantics, then rerun the client lint and production build.

## B-002 — Admin lint command has no ESLint flat configuration

- **Blueprint:** Slice 0 verification; admin lint baseline.
- **Evidence:** `pnpm --filter admin lint` invokes ESLint 9.39.2, which stops
  because `client/apps/admin` has no `eslint.config.{js,mjs,cjs}`.
- **Impact:** Admin lint cannot run under the checked-in command.
- **Next action:** Add or migrate the admin ESLint configuration, then rerun
  the required command.

## B-003 — Local integration and authenticated smoke environment unavailable

- **Blueprint:** Slice 0 database/Temporal and authenticated health-smoke
  verification.
- **Evidence:** no Agent or core database URL is exported to this execution
  environment; no local service responds on ports 4000, 4100, 3000, or 3001.
  Agent database integration tests therefore remain skipped, and authenticated
  KasiAi/Agents smoke tests cannot run.
- **Impact:** Database, Temporal, and browser-health evidence is pending a
  configured isolated environment; unit verification can continue.
- **Next action:** Start the documented local stack with non-production test
  credentials and databases, then run migration, authenticated health, and
  end-to-end smoke checks.

## B-004 — Client production build cannot run in this sandbox

- **Blueprint:** Slice 0 direct-client production build baseline.
- **Evidence:** `pnpm build:client` reaches `next build` but Turbopack fails
  while processing `globals.css`: creating a subprocess that binds a port is
  not permitted by the sandbox (`os error 1`).
- **Impact:** This is an execution-environment limitation in addition to B-001;
  it does not establish a product build failure.
- **Next action:** Rerun after B-001 in an environment that permits Next.js
  build worker process creation.
