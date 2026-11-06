---
title: Service deployment ownership
owner: platform-ops
last_reviewed: 2026-11-06
---

# Service deployment ownership

This monorepo contains Growth, standalone Agents, Agency, Analytics, Labs and central Admin source.
Source changes do not modify hosted services or authorize deployment.

Growth web/API use products/growth/web and products/growth/api. Growth's independent workers use
the process modes listed in the API README. The optional Growth-to-Agents connection is configured
on Growth's backend only; normal Growth startup does not require it.

Agents API/worker use products/agents/api and its current Restate runtime. Follow that product's
README and source boundary for exact commands, worker version and database setup. Retired Temporal,
installation gateway and old private HMAC deployment commands are not supported.

Use separate databases, credentials, domains, service keys and telemetry destinations per
environment. Backend calls authenticate independently. Public widget deployment/origin settings
are explicit, while internal product commands use the approved service trust configuration.

Before a separately authorized hosted rollout, record exact code/schema/worker artifacts,
environment ownership, configured readiness checks, current permission mappings and disable plan.
Apply source migrations only to the intended environment with a matching source cutover.
The obsolete Growth widget-table removal must never reset Growth's business database.

The repository's `infra/backend/README.md` defines explicit
monorepo build arguments, start commands, runtime migration files and health paths for Growth,
Agency, Analytics and Operations. Agents retains its own backend image. These packaging files
do not establish hosted deployment readiness or change live service settings.

## Production Identity

Human sign-in uses `https://auth.kasitek.co.za/realms/kasitek`. Railway terminates
HTTPS for the DNS-only Cloudflare CNAME. Identity owns the exact public origin through
`KC_HOSTNAME`; its passwordless relying-party ID is `auth.kasitek.co.za`.
Growth, Agents, Agency and Operations API issuer settings reference
`${{identity.KC_HOSTNAME}}/realms/kasitek`. Restart each consuming API/worker after an
issuer change to discard cached discovery. Product command-signing issuers are independent.
Vercel frontends proxy authentication through their own backend and need no Identity issuer
variable. See `infra/identity/HOSTED.md` for realm configuration and hostname migration limits.

## Production region placement

Agents stateless services must stay in the same Railway region as `agents-db`. On 2026-11-06
`agents-api` and `agents-worker` were still in `europe-west4-drams3a` while `agents-db`,
`growth-api` and `identity` were in `asia-southeast1-eqsg3a`; each database round trip took
about 175 ms from the worker, and a single reply accumulated 34–64 s of context-assembly gaps.
Both Agents services were moved to `asia-southeast1-eqsg3a`, dropping worker-to-database round
trips to under 1 ms and a representative three-model/two-tool reply from about 162 s of active
work to about 9 s.

`restate` was subsequently moved to the same region. Its `/restate-data` volume is region-bound,
so it was detached (retained for rollback), the service was rescaled into
`asia-southeast1-eqsg3a`, a fresh volume was attached, and the worker deployment was
re-registered against the new Restate admin. Before detaching, suspended `AgentsSupportWaitingV1`
handoff invocations were confirmed drained and their conversations resolved, so no live durable
work was discarded; completed task state lives in `agents-db`, not in the Restate volume.
Worker-to-Restate round trips dropped from about 192 ms to about 3 ms, and the same
three-model/two-tool reply fell from about 9 s to about 6.5 s of active work, with operation
gaps of 0.1–1.0 s. A fresh Restate volume starts with no registered deployments: after any
future volume replacement, re-run the worker deployment registration and confirm all required
workflow services are listed.

## Shared production settings

Analytics ingestion and reporting URLs on Growth, Agents and Agency use direct Railway
references to `analytics-api.RAILWAY_PUBLIC_DOMAIN`. Production shared variables `NODE_ENV`
and `KASITEK_ENVIRONMENT` centralize environment labels only. Service keys, database credentials,
client secrets and release identities remain independently configured. The Collector endpoint
continues to use its direct service reference. See
`docs/operations/production-email-and-references.md` for rollout and rollback evidence.
