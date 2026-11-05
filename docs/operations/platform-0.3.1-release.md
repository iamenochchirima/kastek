# Platform 0.3.1: Direct authorized content actions

Change: remove mandatory Growth human approval from agent content execution.
Owner: Enoch Chirima. Risk: standard.
Affected services: Growth API/worker and Agents API/worker; shared contracts remain a watched
build input for other Node roles. Growth frontends require no source change.

Content tools execute under current delegated grants with durable request receipts, snapshot
validation, readiness checks and duplicate prevention. Optional exact previews remain normal
model-readable results. The MCP transport no longer registers approval cards/forms or app-only
confirmation tools. Non-content review requirements are unchanged. Internal publication 10 and
adapter 7 use explicit authorized_write authority; retained publications remain available.

API contract: version 1, same business operations. Content review metadata changes to none.
Prepared content snapshots report prepared. Additive migration
20261102210000_content_requested_actions adds requested_action provenance without deleting
historical approval sources. It records delegated execution, not a human decision.

Rollout: apply the SQL/Prisma-mirrored migration transactionally and record its checksum before
API rollout. Merge the verified change to main; existing Git integrations deploy watched roles.
Read back live watch patterns after removing retired card-source paths. No production Meta app,
OAuth scope expansion, Vercel source change or new secret is required. The old confirmation secret
is unused and can be removed separately after rollback compatibility is no longer needed.

Analytics: no new registry event. Existing durable access/operation events and structured outcomes
continue; no approved event is fabricated. Collector configuration and exporter changes are not
applicable. Existing request/correlation and service identity applies. Never log tokens or content.

Documentation: MCP/REST integration, operation architecture, runbook, feature map and ADR 0003
superseding ADR 0002 updated with this change. KAS-261 records the owner's revised acceptance scope.

Validation: focused owned PostgreSQL, legacy SDK and modern protocol checks cover ordinary writes,
optional previews, stale/revoked grants and repeat identities. Internal runtime checks cover
explicit write authority and observation-only recovery. Build/boundary and production evidence
passed with 36 Growth checks and 14 focused Agents checks, zero skipped. Growth/Agents API builds,
import boundaries, release identity, OpenAPI and watch matrix passed. Production migration was
applied transactionally and checksum read back before rollout. Live MCP smoke passed after deployment. These checks do not prove every provider's
live delivery or expand provider format/edit capabilities.

Rollback: restore prior service images and retained internal selections, retain additive schema
and execution receipts. Existing succeeded/uncertain effects must never be reissued with a new
identity. Prior code will restore its previous approval requirement. Post-release review: after
production MCP smoke verification on 2 November 2026.


## Production verification

PR #45 merged at a55147ed5048f959e30522e26c4fb1efe8c75401. All 19 Railway roles have successful
active artifacts; the 13 Git watch configurations match the inventory, and six databases remain
image-only. Growth and Agents health return 200; identity discovery retains auth.kasitek.co.za.
The [artifact manifest](releases/platform-0.3.1-artifacts.json) records exact deployed identities.

The ordinary production MCP delete tool removed the existing disposable unpublished draft without
a form/card/page approval. Its audit source is requested_action. Same-key replay returned the
identical receipt/result; authoritative readback returned not_found. Database readback found one
request receipt and zero approval events. No public provider post was changed by this smoke.

The 36 Growth checks include OAuth, SDK/modern MCP, REST/internal parity, schedule/reschedule/
unschedule, publication admission and an owned Facebook provider fixture, stale grants/revisions,
replay and bounded observations. Fourteen focused Agents policy/runtime/publication checks passed.
Broader Agents source CI was already failing before this patch and remains separately tracked;
these focused results do not claim that full suite passes. Public docs CI passed. Internal docs CI
caught a relative ADR link outside its site root; this follow-up uses the canonical repository
link, and the corrected internal site build passed locally using its Node 22 toolchain.
