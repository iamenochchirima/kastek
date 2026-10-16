# Remaining Rust → TypeScript server migration work

Updated: 2026-10-04. Owner: Enoch.

This is the completed implementation checklist. It replaces the unfinished execution
items in [IMPLEMENTATION.md](IMPLEMENTATION.md). The findings and evidence are in
[AUDIT.md](AUDIT.md); the earlier implementation and parity records remain history.

The three servers and their shared-library replacements exist. This short list
records the five confirmed request-contract fixes and their focused verification.
It does not add another migration phase or new product features.

## Implementation checklist

- [x] **1. Prevent rejected Growth organization requests from updating the session.**
  `POST /api/orgs` now validates its required name and optional nullable string fields
  before entering the handler or touching session activity. Existing duplicate-field
  and lossless-number handling remains in place. Broader per-route error precedence
  for malformed requests has no confirmed additional state effect and is not a gate.
  **Minimal check:** malformed authenticated request returns 400 with no session
  update; valid body still reaches the existing handler. Reuse the current isolated
  HTTP fixture; no route-by-route DTO matrix.

- [x] **2. Restore accepted JSON content types in Growth and Agency.**
  Both accept `application/*+json` through their existing lossless parser. Growth
  rejects URL-encoded media on typed JSON routes and preserves its three real form
  routes, webhook, multipart and binary endpoints.
  **Minimal check:** normal JSON and two JSON-suffix media types; rejected form media
  on a JSON route; existing URL-encoded extractor fixture still passes; duplicate
  field handling still passes. Reuse transport fixtures.

- [x] **3. Preserve Growth push-subscription signed integers.**
  The route and service interface now carry a lossless parsed `bigint` through to
  PostgreSQL while retaining safe JavaScript integers and rejecting values outside
  signed i64.
  **Minimal check:** normal integer, `9007199254740993`, null/omitted expiry and a
  value outside signed i64. Verify the large value reaches storage without rounding.

- [x] **4. Fix report timestamp decoding across the servers.**
  Growth and Agency now validate calendar fields and normalize supported space and
  compact-offset timestamps to UTC while preserving fractional precision and second
  `60`. Labs Analytics accepts and preserves the same leap-second notation. The
  parsers are service-local; no shared-package version bump or date framework was
  added.
  **Minimal check:** reject February 30 and hour 24; accept the source-supported space
  separator/compact offset; retain UTC conversion and fractional precision; preserve
  second `60` notation and its instant. Focused parser fixtures cover Growth, Agency
  and Labs Analytics. No database or provider integration run is needed for these
  pure decoding changes.

- [x] **5. Complete Agency's API-key DTO field shape.**
  The body schema in `controllers/admin.ts` includes the root `scopes` property so
  duplicate root fields are rejected, while nested arbitrary JSON values retain
  last-value-wins behavior.
  **Minimal check:** repeated root `scopes` returns 400 before authorization or SQL;
  repeated keys inside the arbitrary `scopes` value retain last-value-wins. The
  default-scope and key lifecycle implementation was not changed.

## Final completion check

- [x] **6. Record the focused checks and commit the fixes.**
  All three affected service typechecks and focused fixtures passed. Growth: 9 passed,
  1 database-dependent skip. Agency: 4 passed, 2 database-dependent skips. Labs
  Analytics: 1 passed. `git diff --check` passed in all three repos.
  Commits: Growth `f1b8a950` on `rewrite`; Agency `925b763` on `main`; Labs `50d3764`
  on `main`. The existing cross-service producer/ingestion/projection fixture was not
  rerun because those paths were unchanged. No shared package changed. An unrelated
  pre-existing edit to Labs `packages/server-support/src/json.ts` was left untouched
  and is not included in the Labs commit. Nothing was pushed or deployed.

## Completion boundary

Complete when these five defects are fixed, the affected typechecks pass and the
focused fixtures pass. An actual regression discovered in those checks belongs here;
an unspecified “remaining variant” does not create another migration phase.

Excluded: UI redesign or exhaustive browser journeys, new authentication features,
Google/SMTP/DNS/provider setup, GitHub package publication/access grants, Railway
deployment, production monitoring and fixes to limitations already present in Rust.
Local checksummed package delivery works; private registry distribution is separate
setup work. Keycloak, the Collector and the already-TypeScript Agents platform are
not additional servers to migrate.
