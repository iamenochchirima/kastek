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
applied transactionally and checksum read back before rollout. Live MCP smoke remains pending deployment. These checks do not prove every provider's
live delivery or expand provider format/edit capabilities.

Rollback: restore prior service images and retained internal selections, retain additive schema
and execution receipts. Existing succeeded/uncertain effects must never be reissued with a new
identity. Prior code will restore its previous approval requirement. Post-release review: after
production MCP smoke verification on 2 November 2026.
