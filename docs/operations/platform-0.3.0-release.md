# Platform 0.3.0 release

Owner: Enoch Chirima. Risk: high (delegated public-action approval boundary).
Status: implementation and isolated verification; production migration applied; deployment artifact
identity and native-client acceptance pending. Review date: 2026-11-03.

## Change and scope

Explicitly requested private content draft/media writes execute without a separate human review.
Public/destructive content actions share `content.actions.preview`, immutable snapshots and exact
confirmation. Capable MCP `2026-07-28` hosts can present confirmation in chat; legacy/incapable
clients retain the Growth review page. Other reviewed writes keep their existing behavior.

Growth REST, MCP and internal agents share the business handlers, authority checks and durable
ledger. Internal agents call Growth directly. Current manifest/policy revision is 9, adapter release
6; publications 2–8 retain exact contracts. Existing workspace versions/customizations stay pinned.
This release does not add provider formats, expand Instagram or other provider permissions, change
Meta app configuration or prove live publication for every platform.

Affected services: Growth API and its embedded workers, plus Agents API/worker for product capability
policy and adapter registration. The Growth analytics publisher may share the API artifact and must
retain its documented command. No frontend source change is required by this feature. Other
Git-watched service deployments must be recorded if triggered by the merged version change.

## Release identity and controlled rollout

Platform version: `0.3.0`, a compatible feature release from `0.2.0`. API operations remain version 1;
MCP protocol versions and agent publication revisions are separate identities.

- Merge commit, exact service artifact/deployment IDs and configuration revision: pending release owner.
- `20261102190000_content_agent_workflows` was applied transactionally to production before code
  rollout, with checksum recorded in the Prisma migration ledger and column presence verified. API
  SQL and Prisma are mirrors; apply only one. Growth bootstrap does not auto-migrate. The migration
  adds a nullable, constrained `GrowthOperationReview.decisionSource`; historical rows are unchanged.
- Dedicated `GROWTH_MCP_CONFIRMATION_SECRET` has been staged on Growth API; verify presence and
  production minimum 32-byte length without printing it. Do not reuse another service's key.
- Retain `GROWTH_AGENT_ACCESS_ENABLED` and `GROWTH_AGENT_EFFECTS_ENABLED` gates. Validate scoped reads
  and direct drafts before checking one confirmed public action. Never bypass confirmation to test.
- Upgrade managed defaults explicitly only where the owner requests it. Do not rewrite customized
  selections or existing task versions.

## Analytics and operations

Existing `growth.agent.access@1` lifecycle events and durable receipt outcomes are reused; new event
names and registry migrations are not applicable. `decisionSource` records `requested_draft`,
`growth_ui` or `mcp_form` for audit; historical null remains valid. Success measures are requested
drafts saved once, exact previews displayed, stale/revoked proposals denied, confirmed effects
receipted once and uncertain effects reconciled without duplicate admission. Scheduling success
means accepted queued work, not provider publication.

Existing bounded access telemetry remains the investigation surface. Do not log content bodies,
confirmation input, sealed request state, secrets, OAuth codes or bearer tokens. No new Collector
configuration, OTLP endpoint, exporter or dashboard is introduced: not applicable. Existing
service/environment/release identity must accompany deployed signals; production signal validation
and redaction sampling remain release checks. Central retention and alerting remain the documented
platform gap; local fixtures do not close it. Exporter disable behavior remains unchanged.

## Documentation and validation

Updated current records: public MCP/REST contracts, operation architecture, agent-access runbook,
feature map and ADR 0002. Requirements originate in the owner's approved chat scope. No new product
UI, responsive layout or browser component is introduced, so UI layout checks are not applicable.

Isolated evidence available before release: Growth/Agents builds; retained-publication and adapter
pinning; private-write policy/grant/receipt/recovery tests; content snapshot/authority/replay checks;
MCP protocol form/fallback checks; repository boundaries. The release owner reported focused runs
of 38 Growth and 13 Agents checks with no skips. Earlier internal-parity runs separately passed
9 Growth and 21 Agents tests. Consolidated exact commands and final results belong in the PR and
release artifact evidence; do not sum overlapping test suites.

Pending production acceptance:

- Confirm exact deployed source/config identities against the applied migration; check health, discovery and OAuth.
- Save/read back a requested private draft through the connected external client without app review.
- Observe the native host render the exact preview/form, then confirm one authorized public action
  and its receipt. Protocol fixtures alone do not prove ChatGPT rendering or a completed live journey.
- Verify an incapable/legacy client gets the Growth review fallback; test rejection, stale preview
  and current grant checks without publishing unintended content.
- Inspect bounded logs, lifecycle delivery and provider readback for the accepted action.

## Rollback

Disable external effects with the existing effects flag if approval or provider outcomes are unsafe;
keep status/reconciliation available. Restore the previously verified service artifacts and matching
configuration if required. Record their exact IDs before promotion. Do not drop the additive nullable
column: old code ignores it, and retained ledger decisions are needed for reconciliation. Preserve
review, token and provider receipt history. Secret rotation invalidates outstanding sealed forms;
users prepare a fresh preview, and OAuth grants remain independent. Do not retry an unknown effect
with a new request identity during rollback. Frontend rollback is not applicable to this feature.

## Deployment watch-path correction

The owner requested service-specific watch paths during rollout. Live settings already scoped source
by product but also included `VERSION`, which caused all 13 Git-backed roles to rebuild for this
release. The old account's read-only configuration confirmed service-specific source filters.

All 13 production services now watch their actual runtime/build/shared inputs and exclude `VERSION`,
documentation, tests and frontend-only changes. Six database services remain image-only. The
[inventory](../../infra/railway/watch-paths.json) and [operating rules](../../infra/railway/README.md)
record the configuration. Matrix checks passed and every live pattern array was read back exactly.
This updates deployment selection only; application behavior, events, migrations and secrets are
unaffected. Restore the privately captured previous patterns to roll back this configuration.
The already queued release deployments are retained; the correction applies to subsequent pushes.

## First hosted MCP acceptance

All 19 Railway roles reported success after PR 37. The connected external MCP client saved the
requested Hello world draft directly, with `decisionSource=requested_draft`; repeating the stable
request returned the same draft and receipt. The host advertised protocol 2026 and both form
capabilities, but its publish continuation failed closed before approval. No provider action ran.
Bounded confirmation failure categories and response-shape flags were added to diagnose the host
interaction without logging content, tokens or opaque state. Explicit unsupported-form protocol
errors retain the owned Growth review fallback. Native confirmation acceptance remains pending.

The diagnostic round trip identified `accept` with an empty content object, missing the required
boolean choice. Its state, argument and ownership checks passed. The official OpenAI SDK emits the
same request structure and supports boolean fields; no supported server-side schema correction was
identified. Empty acceptance is never approval. This precise host mismatch now returns the owned
Growth review fallback after a fresh grant check, with a bounded diagnostic event. Nonempty malformed
answers remain errors. Nine protocol checks passed after this interoperability fix. Actual native
form rendering remains unverified; do not describe the current host as having completed in-chat
confirmation.

## Internal preview handoff verification

The internal preview-to-action handoff now carries trusted task metadata separately from model
input. Action preparation creates its own exact proposed review and does not copy approval from
the preview. A PostgreSQL-backed regression covers preview, preparation, human UI approval and
commit receipt, plus repeated preparation and cross-task, cross-chat, stale and unbound denials.
The combined core/protocol rerun passed 20 tests without skips, and the Growth API build passed.
No migration, analytics event, manifest revision, frontend or secret change is needed for this fix.

## Native confirmation compatibility probe

The owner rejected the browser detour as the intended chat workflow. Native form requests now
use an explicit required confirm/cancel string choice, default cancel. Signed state binds the
answer-schema revision; outstanding boolean states expire safely. Ten protocol tests passed
without skips and the API build passed. This is a compatibility probe, not evidence of native
rendering. Fixed capability telemetry additionally records declared/supported MCP App MIME
support without dumping client metadata. Actual in-chat confirmation remains release acceptance.
