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

Platform release identity: candidate `growth-content-library-2026-11-03` on
`codex/growth-content-library`, based on `aa3d10df3ff72b7e3a9455e7f53d0c4127898cbd`.
This record is implementation evidence, not a production release assertion. A compatible feature
release should use the next approved minor platform version. Deployment SHA, exact artifacts,
configuration revision and final platform tag must be recorded at promotion; package `0.1.0`
values are not platform release versions. The current `VERSION` is unchanged.

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
social providers. Hosted rollout and post-release review remain pending a release.

Current technical behavior is documented in [content media and templates](../architecture/content-library.md),
operation coverage and public media/template, REST and MCP docs. The feature map records the new
routes. A new ADR is not applicable: this extends the existing asset and canonical operation
architecture. New provider acceptance, OAuth/Identity changes and cloud configuration are not
applicable. This file is the user-visible change record for the candidate; final production release
notes must link the promoted artifact identity.
