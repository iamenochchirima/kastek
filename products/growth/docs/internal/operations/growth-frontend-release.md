---
id: growth-frontend-release
title: Release the Growth frontend
owner: engineering
last_reviewed: 2026-10-24
---

# Release the Growth frontend

Use this runbook for the Vite/React Router frontend and its same-origin API proxy. Source changes
and local verification do not authorize a production deployment or DNS change.

## Prepare the artifact

1. Use the root Node 24/pnpm toolchain and frozen lockfile.
2. Build shared exports, the Growth API, and the frontend with root `pnpm build:growth`.
3. Retain the exact `products/growth/web/build/client` artifact, `scripts/serve.mjs`, and
   `scripts/route-contract.json` with their source commit and configuration revision.
4. Retain the previous deployable Next artifact and its runtime dependencies until rollback
   acceptance is complete. Keep previous hashed assets available during promotion so open tabs
   can finish without broken lazy imports.
5. Record any bundled font files and their licenses. Do not restore build-time Google font
   downloads as a prerequisite for an otherwise reproducible build.

The Node static/proxy server is portable to Railway or another Node hosting environment.
Configure its root start command as:

```bash
node products/growth/web/scripts/serve.mjs --hostname 0.0.0.0
```

The server reads `PORT`, defaulting to 3000. It resolves its build directory relative to its own
source, independent of the process working directory. `vite preview` is not a production service.
This runbook does not establish which current provider, DNS, CDN, or TLS configuration is live.

## Configure the boundary

1. Set `CORE_API_BASE_URL` to the Growth API's HTTP or HTTPS origin. Do not append `/api`.
2. Set `FRONTEND_URL` to `https://growth.kasitek.co.za` in both API and frontend configuration.
   Set `GROWTH_WEB_ORIGIN` consistently for consumers that use that setting.
3. Set `GROWTH_CANONICAL_ORIGIN=https://growth.kasitek.co.za` on the frontend server.
4. Set `GROWTH_NOINDEX=1` for isolated previews. Keep preview hosts outside the canonical host.
5. Configure TLS termination and preserve the browser Host to the frontend process. Restrict
   direct API access to the intended network and authorized consumers. Core must not trust
   arbitrary caller-supplied forwarding headers.
6. Register the exact public `/api/auth/callback` with Keycloak. Review connected-provider return
   URLs against their owning API configuration.
7. If WhatsApp embedded signup is enabled, set public build-time `VITE_META_APP_ID` and
   `VITE_META_EMBEDDED_SIGNUP_CONFIG_ID`. Rebuild after changing them.
8. If the environment supplies a CSP, set `GROWTH_CONTENT_SECURITY_POLICY` to the tested policy.
   Verify provider SDKs, microphone/call flows, fonts, and inline framework scripts against it.

Keep provider secrets, OIDC client secrets, database URLs, and Agents signing keys out of
`VITE_*` variables and public artifacts. Vite substitutes public variables at build time.
The Node server reads runtime variables from the process environment; it does not load a web
`.env` file automatically.

## Verify the isolated release

1. Check `/__health`, the raw `/` HTML, canonical URL, robots, sitemap, and social metadata.
   Compare production headers on the canonical host and a noindex preview host.
2. Check all recorded routes and legacy redirects. Unknown paths and missing assets must return
   404; API requests must reach Core rather than the SPA fallback. The analytics playground
   remains unavailable in production builds.
3. Run the isolated `frontend-identity.test.ts` path with its dedicated test database. Confirm
   separate callback cookies, Origin denial, organization selection, uploads larger than 5 MB,
   export filenames, persistence, and logout. Never substitute a production database.
4. Run the focused Analytics and Agents browser engineering checks against the built server.
   Verify remaining feature families through authorized real API results, including provider
   unavailability. A fixture success does not establish live-provider acceptance.
5. Check WhatsApp SSE without response buffering, disconnect cleanup, and reconnect authorization.
   Check agent HTTP cursor polling separately; it is not an SSE transport.
6. Verify the actual service worker in a browser context that allows service workers. Install,
   revisit, release a changed worker, accept its update, and confirm one intentional reload.
   Open an authenticated route offline and confirm the generic offline document contains no
   prior user's content. Check push subscription, notification display, and same-origin clicks.
7. Inspect the shipped bundle for server packages, credentials, and source maps. Check public
   caching and private `no-store` responses. Use only immutable caching for hashed build assets;
   HTML, manifest, and `/sw.js` must revalidate.
8. Compare equivalent production Next and Vite artifacts with the same data, browser, CPU, and
   network settings. Record five cold and five warm samples, their medians, transferred JavaScript,
   request counts, app readiness, navigation timing, long tasks, and layout shifts. Investigate
   unexplained regressions before promotion. Local runs do not establish field Core Web Vitals.
9. Record actual command output, artifact identifiers, pending checks, and owner acceptance in
   the release record. Keep model evaluations and live-model grading with the owner.

The worker test is `node --test products/growth/web/scripts/service-worker.test.mjs` from the
repository root. It verifies cache ownership, private navigation bypass, offline fallback,
update acceptance, push link restrictions, and static manifest icon dimensions. It does not
replace browser install, push delivery, or update verification. The migration's API and browser
launchers target the built server; full feature parity, performance comparison, provider setup,
and production topology require their own recorded evidence.

## Roll back the frontend

1. Stop promotion if login, tenant selection, persisted operations, delivery, or private cache
   behavior differs from the accepted build.
2. Restore the previous tested Next frontend artifact and matching static assets. Keep the
   compatible Growth API changes, including organization selection, available during rollback.
3. Preserve `/sw.js` at scope `/`. Serve a new worker revision that retains the public-only cache
   policy and advances its cache version. Do not reintroduce the worker that cached private pages.
4. Let the normal waiting-worker acceptance flow apply the update. Do not unregister unrelated
   workers or clear unrelated Cache Storage. Version cleanup removes only Growth-owned cache names.
5. Verify cookies, callbacks, pending writes, open-tab asset loading, offline fallback, and push
   subscription behavior after rollback. Avoid repeating accepted mutations during recovery.

## Release record decisions

The owner is Enock. This frontend/runtime migration is high risk because it changes navigation,
bootstrap, cookie forwarding, streaming, and installed-worker behavior across Growth.
Affected services are Growth web, its static/API proxy, and the compatible Growth API organization
selection endpoint. Identity and connected-provider callback configuration must remain compatible.
Other products' frameworks, agent execution, and product databases are unchanged.

Schema migrations are not applicable. New analytics events and browser telemetry are not
applicable. Preserve existing product analytics contracts and authentication logs. Frontend server
logs must not include tokens, cookies, message bodies, or uploaded content. Use existing request
and service logs to investigate API failures; do not infer new dashboards or hosted observability
from this migration.

Release identity consists of the source SHA, built artifact, runtime configuration revision, and
existing platform release process. Record those values at promotion rather than treating the
package's default version as a release. Production deployment, DNS changes, production performance
claims, and a post-release review date remain unset until the owner authorizes a release.
