# Platform 0.4.0: Reusable content

Deployed 3 November 2026. Owner: Enoch Chirima. Risk: standard.

PR [#55](https://github.com/Kasitek-Labs/kastek/pull/55) merged media library, social templates,
safe post reuse and the actual sidebar logo at `defbe2be3b5d0912f01515b4a8a62e51d28cb534`.

Staff can browse retained image/video uploads, reuse asset IDs in the composer, edit metadata,
inspect usage and archive/restore. Templates provide literal fields, platform-specific previews
and independent unscheduled drafts. Duplicate preserves source history. Thirteen new typed
canonical operations work through REST/API keys, OAuth MCP and internal tools.

Both additive migrations were ledgered and checksum verified before rollout. Database and media
backups are private and retained outside the temporary checkout. No destructive migration,
provider permission change, new credential or external publication was part of the release.

All ten affected Railway services deployed the merged source, and all nineteen services are
healthy. Vercel production deployment `dpl_FhwVttEMFMByzXUHaJCmZu5NLBR4` serves Growth on
app.kasitek.co.za. The [artifact manifest](releases/platform-0.4.0-artifacts.json) records exact
images, sources, migrations, rollback identities and live verification.

Acceptance passed 105 focused local tests, API/web builds, typechecks, focused lint, contracts and
boundaries. CI also passed 86 migration and 53 Agents browser journeys. Live checks verified
retained media, template-to-draft, safe duplicate/replay, real external MCP draft execution,
internal tools, eight receipt/outbox lifecycle records and the signed-in UI/logo. Verification
drafts were removed; the technical template is archived.

The broad Agents source suite still has 28 failures already present on base main, with zero new
failing cases. It is not reported as green. Details and remaining observability limits are in the
[release record](../../products/growth/docs/internal/operations/content-library-release.md).

Existing internal agents keep their pinned publications. New defaults use publication 11 and
runtime 8; use the established explicit defaults upgrade to adopt the new tool set. External MCP
clients may need to refresh tool discovery.

Rollback restores prior API/worker/web artifacts together while retaining additive schema, media
bytes and durable receipts. Do not repeat uncertain operations with new identities. Registered
operation events and structured logs are reused; no exporter/Collector change applies. Review
initial adoption, latency and errors on 4 November 2026.
