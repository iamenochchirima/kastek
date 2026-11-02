---
title: Service deployment ownership
owner: platform-ops
last_reviewed: 2026-11-02
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
