# Rust → TypeScript server migration audit

Date: 2026-10-04. Scope: existing Rust servers and their supporting crates only.
Active remaining work: [REMAINING.md](REMAINING.md).

## Conclusion

Growth Core, Agency Tenant and Labs Analytics have substantive TypeScript
implementations. Their registered routes, process dispatch, database authority and
shared-library replacements exist. The audit found five concrete request-contract
defects, listed below. It found no additional confirmed missing worker or server
feature in the inspected implementation and recorded fixtures. Analytics shares
one timestamp-decoding defect within F4; its substantive worker/reporting port exists.

This conclusion does not certify every response field or provider effect through a
fresh execution. The review covered all three server inventories, current runtime
and request boundaries, SQL/schema/assets, shared packages, worker bindings and
existing integration evidence. Deeper executable probes focused on likely port
differences. Database/provider/browser suites already recorded in PARITY.md were
not all rerun. Each confirmed defect has a reproducible local probe; broad old
“partial” labels are not evidence of missing code.

## Inspected revisions

| Repository | Current revision | Preserved Rust comparison |
| --- | --- | --- |
| Growth, `rewrite` | `0435c5839020812cace9def9612572a1bd0a78a3` | `abd419c6ae0d84ca19a0a9cb802cc2bb2626d963` |
| Agency, `main` | `6bb98f40fe284f535e544ae57333667f6d3a5f0b` | `2c7902170a8f75257c0e47b86ffaf38068dd2227` |
| Labs, `main` | `4b9ddd7846a0369df779f15df1dfd2cf96269867` | `4eb66ad` |
| Agents, already TypeScript | `6bc06d44952f7d6149268b793eb40a1012acb0fc` | Not a Rust server migration |

The three migrated repositories were clean at inspection. Agents has concurrent
modified/untracked files from another task; they were preserved, not built as a
stable migration baseline or included in these findings.

## Confirmed remaining defects

### F1 — A rejected Growth organization request updates session activity

Locations: `kasitek-growth/server/kasitek-core/src-ts/identity/json-body.ts:42`,
`identity/json-body-schemas.generated.ts`, `routes/orgs.ts:14`, and manual route
decoders such as bookings/AI/Analytics. The generator itself explicitly says it
emits duplicate-field shapes, not runtime validation.

The source census has 106 typed JSON request operations: 24 explicit Fastify body
schemas, 82 without. Generated shapes support duplicate-field detection but are not
full input validators. The audit probed `POST /api/orgs` with `{}` or
`{"name":false}`: it reaches authentication and returns 401, while Rust
`Json<CreateOrgRequest>` rejects the request before entering the handler. With a
valid synthetic session, the TypeScript route returns 400 only after updating
`Session.lastActivityAt`; no organization write was observed. This establishes one
specific state-effect difference. It does not establish arbitrary invalid data
persistence or justify a full route-wide schema rewrite. The active plan fixes only
the confirmed session mutation.

The 24 explicit schemas contain their source-shaped members, including inspected
nested members. Field presence alone does not prove all optional/null/default rules.
Other malformed-request status precedence may differ, but the audit found no
additional concrete state effect that should expand the current migration task.

### F2 — JSON media dispatch differs from Rust

Locations: Growth `src-ts/app.ts:106`; Agency `src-ts/app.ts:44`.

Both register their custom JSON parser only for `application/json`. HTTP probes of
`application/problem+json` and vendor JSON return a content-type 400 instead of
decoding JSON as the Rust extractor does. Growth's global form parser also lets a
URL-encoded body reach authentication on typed `POST /api/orgs`; that request should
fail JSON extraction. Agency correctly rejects form media. Preserve the genuine
Growth form/raw/binary endpoints when correcting parser dispatch.

### F3 — Growth rejects a valid signed i64 push expiry

Locations: Growth `src-ts/routes/notifications.ts:62` and
`src-ts/services/notifications.ts:91`. Rust source:
`server/kasitek-core/src/db/notification_models.rs`,
`WebPushSubscriptionRequest.expiration_time: Option<i64>`.

The numeric boundary retains big integers, but the route/interface then require a
safe JavaScript number. An authenticated synthetic session/SQL-sink probe accepted
expiry 100 and inserted the subscription, while valid expiry `9007199254740993`
returned 400 without an insert. Carry the lossless signed integer to storage.

### F4 — Report timestamp decoders differ from Chrono

Locations: Growth `src-ts/routes/analytics.ts:13`; Agency
`src-ts/controllers/analytics.ts:44`; Labs Analytics `src-ts/reporting.ts:95`. Source: Labs Rust
`crates/analytics-reporting/src/lib.rs`, `ReportQueryInput` with Chrono timestamps.

Current parsers turn `2030-02-30T00:00:00Z` into March 2 and hour 24 into the next
day. They also reject valid source-style `2030-01-01 00:00:00+0000`. These are
request-decoding differences, not deployment concerns. Preserve source calendar,
offset and precision behavior. Labs Analytics already has a fuller typed date
decoder, but it rejects leap-second inputs such as
`2015-02-18T23:59:60.234567+05:00` with `invalid calendar timestamp` in a direct
`decodeReportRequest` probe. The pinned Labs Cargo.lock uses Chrono 0.4.45; its
locally cached `datetime/serde.rs` delegates to the date parser, and
`format/parse.rs:231` explicitly accepts second 60. Correct this within the same
timestamp task; inspect/reuse the calendar rules rather than relying on JavaScript
Date acceptance or claiming the current Labs decoder is a complete replacement.

Other inspected report rules correctly reject null arrays/maps/defaulted bools and
unknown comparison members. `comparison.kind` is a source String, not an extraction
enum; Analytics owns its later semantic check.

### F5 — Agency's API-key duplicate check misses `scopes`

Location: Agency `src-ts/controllers/admin.ts:245`, consumed by `src-ts/app.ts:63`.
Source `CreateApiKeyBody` has `label` and `scopes: Option<Value>`; the TS body schema
lists only `label`. Repeated root `scopes` reaches authorization (403 in the probe)
instead of the Rust extractor 400. Adding an unconstrained `scopes` property lets
the existing duplicate checker enforce the root DTO without restricting nested
arbitrary JSON. Comparison of all 22 registered typed DTO schemas found this as
the only omitted root member.

## Preserved implementation and evidence

| Area | Audit result |
| --- | --- |
| HTTP inventory | Growth registrar matches 537 Rust operations plus two documented additions; Agency matches all 81. Analytics' source configure function and current registrars account for its 15 operations. Registration proves presence, not all transitive behavior. |
| Processes | All 18 source modes have owning Node/TS entrypoints. Growth's nine worker families and dedicated/combined dispatch are bound; Agency has API/publisher+backfill/standalone-backfill; Analytics has API/worker/migrate/registry. Existing native process fixtures record boot, claims and shutdown. |
| Database | All 117 baseline SQL migrations are byte-identical: Growth 82, Agency 12, Analytics 23. Growth Prisma schema is unchanged. Analytics SQLx ledger/checksum/advisory-lock compatibility and transaction-local scope authorization remain implemented. Existing isolated fixtures cover their effects. |
| Analytics assets | All 122 baseline contract/metric files remain byte-identical. Registry check validates 52 contracts, 45 metrics, 68 dimensions and two metric sets; digest `732a46944532031fe28e6141e7e8ab938f91e9a01d54f26a3e5559d8735a0fb1`. |
| Shared crates | Producer/outbox/reporting/config/crypto/telemetry equivalents exist in Labs packages. Growth actions/execution/types are locally implemented. Current focused action checks cover the 19 definitions and execution gates; shared fixtures cover wire precision, signatures, crypto envelopes and output serialization. |
| Package delivery | Growth and Agency pin contracts 0.2.0 and server-support 0.1.9. Their local tarballs match manifest SHA-256 values; manifest source-file hashes match current Labs package source. Agents' contracts archive also matches its recorded checksum. Local delivery works; authenticated registry publication is not yet performed. |
| Server integration | Existing A13 fixture runs real Growth, Tenant and Agents producer paths through TypeScript Analytics ingestion/projection/scoped reports. Worker/outbox restart, deduplication and denial evidence already exists. Reuse it for the finite final check, rather than inventing new harnesses. |
| Rust retirement | All four repos have zero tracked `.rs`, Cargo manifests/locks or Rust toolchain files, no root `target/` cache, and no matching active retired Rust server/build process was found. Native manifests/launchers use Node/tsx/tsc. Rust recovery commits remain available. |

Fresh checks in this audit used bundled Node 24.19.0:

- All three server typechecks passed; both Labs shared-package typechecks passed.
- Analytics request/query/config/health/registry fixtures: 14 passed, zero skips.
- Shared crypto/producer/reporting/config/JSON fixtures: 22 passed, zero skips.
- Growth route census: one passed; audit reviewer also ran action/request/process
  fixtures, nine passed with one DB-dependent native-process test skipped.
- Agency route census: one passed; audit reviewer ran route/body/host/query fixtures,
  five passed, zero skips.
- Actual Analytics registry `--check` passed.

These overlapping runs are not a combined coverage percentage. A skipped database
case is not a pass. Fresh database-backed full workflow evidence was not manufactured
from registration counts or typechecks.

## Old open items that are not remaining server implementation

- Reconstructing and rerunning all Rust servers is not required to fix these
  source-defined defects. The pinned source, unchanged schemas and focused comparison
  fixtures remain available. Do not reinstall Rust or regenerate multi-gigabyte caches.
- A separate schema/error/effect/output matrix for every endpoint duplicates the
  grouped fixtures and makes completion indefinite. Concrete differences belong in
  the active checklist; hypothetical unspecified variants do not.
- Full production-length lease waits or repeated OS-kill scenarios add no new
  implementation requirement where durable expired-lease/restart behavior is proven.
- Agency conversation/message “remaining pagination” is stale: those source lists
  have no pagination request contract to port.
- New unsupported social publishers, two absent source Agents proxy helpers, inactive
  parent-client session policy, mapped-domain verification policy and source worker
  recovery limitations are preexisting behavior. They need separate product decisions.
- Exhaustive browser journeys, new identity work, real Google/mail/provider/DNS
  configuration, private-registry access/publication, Railway cutover and production
  observability are outside this server-language migration's completion boundary.

The following implementation follow-up records the fixes and focused evidence. The
cross-service workflow evidence above remains the existing baseline; it was not
rerun for these request-boundary-only changes.

## Change and release record

The baseline audit changed planning records only. The implementation follow-up below
records separate server commits and focused verification. Owner: Enoch. Documentation
risk: low. New public APIs/events/version or Collector changes: none. Rollout and
deployment: excluded by the owner. Recovery: pinned Git baselines above.

## Implementation follow-up — 2026-10-04

All five audited request-contract defects are corrected:

| Finding | Result | Commit |
| --- | --- | --- |
| F1 Growth organization DTO validation | Fastify validates the body before session handling. | Growth `f1b8a950` |
| F2 JSON media handling | Growth and Agency accept JSON suffix media; Growth rejects form media outside its explicit form routes. | Growth `f1b8a950`; Agency `925b763` |
| F3 Growth push expiry | Signed i64 values retain precision through PostgreSQL insertion. | Growth `f1b8a950` |
| F4 report timestamps | Growth and Agency validate and normalize UTC timestamps; Labs Analytics accepts leap seconds and preserves their notation and instant. | Growth `f1b8a950`; Agency `925b763`; Labs `50d3764` |
| F5 Agency API-key scopes DTO | Duplicate root `scopes` is rejected while nested JSON keeps last-value behavior. | Agency `925b763` |

Focused verification with bundled Node 24.19.0:

- Growth core typecheck passed; focused tests: 9 passed, 1 database-dependent test
  skipped.
- Agency tenant typecheck passed; focused tests: 4 passed, 2 database-dependent tests
  skipped.
- Labs Analytics typecheck passed; focused decoder test: 1 passed.
- `git diff --check` passed in all three repositories.

The broader producer → ingestion → projection fixture was not rerun: these changes
only affect request decoding, validation and report timestamp representation. The
existing cross-service evidence above covers unchanged paths. No shared package or
consumer pin changed. Growth is committed on `rewrite` (`f1b8a950`), Agency on `main`
(`925b763`) and Labs on `main` (`50d3764`). A pre-existing unrelated edit to Labs
`packages/server-support/src/json.ts` remains uncommitted and was not included. No
push or deployment was performed.
