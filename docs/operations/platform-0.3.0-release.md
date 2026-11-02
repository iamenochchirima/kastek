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
