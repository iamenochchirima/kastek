---
title: Content library release record
owner: engineering
last_reviewed: 2026-11-03
---

# Content library release record

Change: retained image/video library, social templates with literal fields, safe post reuse, and
shared REST/MCP/internal agent tools. Implementation issue is
[KAS-267](https://linear.app/kasitek/issue/KAS-267/growth-reusable-media-library-and-content-templates-with-agent-parity).

Owner: Growth engineering. Risk: standard, with additive schema and delegated private writes.
Affected services: Growth API/web/database/shared contracts and the Growth adapter inside Agents.
Other products' identity, data, hosting and business APIs are unaffected.

Platform release version: `0.4.0`, authorized for push, merge and production deployment by the
owner on 3 November 2026. The feature and logo commits are `715e05df8` and `44982a69a`.
The release artifact manifest records the merged source SHA, Railway deployment/image
identities, Vercel deployment, migration checksums and production verification. Promotion followed
successful additive migrations, backend readiness and frontend preview checks.

## Contracts and data

Thirteen additive version-1 operations extend the canonical catalogue. New views are
`/content/media` and `/content/templates`. WhatsApp `/templates` is unchanged. Existing shared
operation flags, scopes and workspace entitlements remain in force; no new credentials, provider
permissions, secrets, workers or environment variables are required.

Apply `20261103110000_content_media_library`, then `20261103111000_content_templates` once
through the migration ledger. Prisma and API SQL are identical copies; never execute both copies
against one schema. Back up the Growth database and retain existing content storage before rollout.
The changes add metadata, indexes, templates and durable receipts, with no byte/object relocation,
provider effects, destructive backfill or legacy data import. No separate Analytics migration is
needed for these operations.

## Measurement and observability

Reuse registered `growth.agent.access@1` operation lifecycle events and the transactional analytics
outbox. New operation names identify media metadata/archive, template save/materialization and
post duplication outcomes. Growth engineering owns successful saves and template-to-draft outcomes,
revision conflicts, uncertain receipts and operation latency. Do not infer publication success from
draft creation. Read-only render is observable in canonical operation telemetry, not a new draft event.

Existing structured `growth.operation.completed` logs carry service, operation, outcome, actor kind,
duration, correlation ID and bounded error code. Do not log captions, tags, default alt text, field
values, asset bytes or signed preview URLs. Existing content-created webhooks apply to materialized
and duplicated drafts. No new exporter, Collector configuration, OTLP endpoint, dashboard or alert
pipeline is introduced. Collector/exporter revision and new hosted signal validation are not
applicable to this change. Existing hosted retention/monitoring limitations remain documented in
the observability runbook.

## Rollout

1. Apply additive migrations before enabling the new API and web artifact.
2. Release shared contracts, Growth API, Agents runtime adapter and web from the same reviewed SHA.
3. Verify media browse/upload/pick, metadata edit, archive/restore, template render/materialization
   and duplication in an owned workspace. Confirm analytics outbox and bounded logs contain no text
   or credentials. No provider publication is required for these private-content acceptance checks.
4. New internal configurations use publication 11/runtime 8. Existing publication 10/runtime 7
   remain pinned. Use the existing explicit defaults-upgrade action when the owner chooses to give
   existing agents the new tool set. Retained versions must remain published for retries.
5. Check current credential revocation, member/admin permissions, storage availability and receipts.
   Review failure rates and latency on the first working day after promotion.

There is no new feature flag framework. Existing `GROWTH_AGENT_ACCESS_ENABLED` gates canonical
access, and `GROWTH_AGENT_EFFECTS_ENABLED` gates destructive/effect operations. Private draft and
metadata writes retain the existing requested-action policy. No new human approval detour exists.

## Rollback

Roll back web/API/adapter artifacts together and stop assigning publication 11 to new agents.
Retain pinned runtime/publication versions required by existing tasks. Keep additive schema,
media bytes, template rows and immutable mutation receipts. Do not run destructive down migrations
or delete assets referenced by posts/templates. An uncertain write is reconciled by its existing
request identity, never retried using a new identity. Disable existing agent access/effects flags
if delegated admission must be stopped while investigating.

## Validation

Real PostgreSQL service and transport tests, browser fixture checks, publication/runtime schema
checks, typechecks, builds, route inventory and import-boundary checks provide implementation
acceptance. Final implementation checks passed: 51 Growth/API/database/MCP regression tests with no skips,
2 actual internal adapter/binding tests, and 52 frontend tests. Additional output-schema validation
covered real REST/MCP success and denied-scope envelopes. API/web production builds, typechecks,
focused web lint, 52-route inventory, generated API/OpenAPI contracts, 844 local OpenAPI references,
Prisma validation and product import boundaries passed. Exact commands and artifacts belong to
the issue/PR evidence. Browser fixtures use an
owned random schema and temporary storage; they do not import production records or publish to
social providers. Production rollout evidence is recorded in `docs/operations/releases/platform-0.4.0-artifacts.json`
after promotion. Post-release review follows live acceptance.

Current technical behavior is documented in [content media and templates](../architecture/content-library.md),
operation coverage and public media/template, REST and MCP docs. The feature map records the new
routes. A new ADR is not applicable: this extends the existing asset and canonical operation
architecture. New provider acceptance, OAuth/Identity changes and cloud configuration are not
applicable. This file is the user-visible change record for the candidate; final production release
notes must link the promoted artifact identity.

## Production outcome

Deployed on 3 November 2026 through PR #55 at
`defbe2be3b5d0912f01515b4a8a62e51d28cb534`, platform `0.4.0`. All ten services watching
shared contracts deployed that source successfully; the full nineteen-service fleet is healthy.
Vercel deployment `dpl_FhwVttEMFMByzXUHaJCmZu5NLBR4` is promoted on app.kasitek.co.za.
Its prebuilt source tree matches the merged source exactly.

Both additive migration checksums were read back before the merge. Private database and media
backups are verified and retained outside the temporary worktree. Exact deployments, image
digests, previous rollback identities and checksums are in
`docs/operations/releases/platform-0.4.0-artifacts.json`.

Live internal tools verified retained media preview, literal template rendering, materialization,
duplication and same-identity replay. The actual external OAuth MCP connection saved and replayed
a private draft. All three verification drafts were removed and the technical verification
template was archived; no provider post was published. Eight successful durable receipts and eight
registered lifecycle outbox rows were read back. Current publication 11/runtime 8 and retained
publication 10/runtime 7 are installed. Existing pinned agents were not silently upgraded.

Production HTTP checks passed for new routes, authentication, API proxy, unknown-route rejection
and exact logo/shell hashes. Signed-in browser inspection rendered two retained image uploads,
the Templates view and the actual 32×32 logo.

CI additionally passed 86 Growth migration browser journeys and 53 Agents browser journeys. The
broad Agents source suite remains baseline-red: 28 failing cases were already failing on base
main, with zero new failing cases; 2,283 tests passed and 112 skipped. The changed adapter tests
passed in that suite. This does not claim full Agents CI is green. Compare runs 41624928846 and
41609659434. Immediate release smoke found no new failed/uncertain receipts. Review adoption,
errors and latency on 4 November 2026; no recurring automation was created.
