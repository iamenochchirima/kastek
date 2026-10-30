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

The implementation uses a self-contained Node static/proxy server instead of a separate Caddy
process. This preserves the same-origin API boundary in both Railway images and the existing
production-path test launchers. Configure its root start command as:

```bash
node products/growth/web/scripts/serve.mjs --hostname 0.0.0.0
```

The server reads `PORT`, defaulting to 3000. It resolves its build directory relative to its own
source, independent of the process working directory. `vite preview` is not a production service.
The server streams Brotli or gzip for negotiated text responses of at least 1 KB, including
retained assets. Responses vary by `Accept-Encoding` and use representation-specific validators.
Fonts and other binary assets remain uncompressed; API and SSE bodies pass through unchanged.
Static request cancellation or a failure after response headers are sent closes that response;
the server does not attempt a second error response or terminate other requests.
`web/railway.json` selects the Growth Dockerfile and `/__health` readiness endpoint. The adjacent
`Dockerfile.dockerignore` includes Growth web and shared contract inputs while excluding secrets,
local artifacts, dependencies, and generated output. It overrides the root ignore rules for this
image without changing the Agents images' context. This source configuration does not establish
which current provider, DNS, CDN, or TLS configuration is live.

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
9. Keep prior Vite assets in read-only release directories and set `GROWTH_PREVIOUS_ASSET_ROOTS`
   to a JSON array of their absolute `build/client` paths. Only missing hashed `/assets/*` files
   can come from these directories. Current files take precedence; documents and APIs never
   fall back to an archived build.
10. During the Next-to-Vite cutover, set `GROWTH_LEGACY_NEXT_STATIC_ROOT` to the absolute retained
    `.next/static` directory for open Next tabs. Only browser chunks, styles, media, and build
    manifests under `/_next/static/*` are served. Source maps, source files, server artifacts, and
    symlinks that escape the configured directory remain unavailable. Retain the previous full
    Next release separately for rollback; this static archive does not run the Next server.

For example, `GROWTH_PREVIOUS_ASSET_ROOTS='["/releases/previous/build/client"]'` keeps the prior
Vite chunks available. Hashed assets use immutable caching; other files revalidate. HTML requests
with a product-session cookie and all private SPA documents use `Cache-Control: no-store`.
Remove archive configuration only after the release owner accepts open-tab and rollback checks.

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

## Run the engineering checks

After building, run these commands from the repository root:

```bash
pnpm --filter client typecheck
pnpm --filter client check:routes
pnpm --filter @kasitek/growth-core exec tsx --tsconfig ../web/tsconfig.json --test ../web/scripts/workspace-bootstrap.test.ts
pnpm --filter client lint
pnpm --filter client exec playwright install chromium
pnpm --filter client test:frontend
pnpm --filter client test:e2e:migration
pnpm --filter client test:e2e:agents
pnpm --filter client measure:frontend -- --targets vite
```

The CI Growth job runs the type, route, lint, frontend, migration-browser, and Agents-browser
checks after the selected product build. It installs Chromium and its system dependencies.
Other products retain their existing selected checks. The isolated database identity and signed
product HTTP journeys require their dedicated API/database/Restate configuration; the browser
fixture checks do not replace them.

`measure:frontend` defaults to both Next and Vite. Run that mode only in an isolated comparison
environment with the retained `.next` artifact, its recorded baseline identity, and a resolvable
Next runtime. Next is not a dependency of the migrated Growth client. The Vite-only command
records local samples without requiring the retired runtime. Neither mode establishes field
percentiles or production capacity.

## Recorded engineering evidence

The local migration verification on 2026-10-24 recorded these results. Counts describe the named
runs, not live-provider qualification or an unlimited functionality guarantee. Local evidence
files are under ignored `.audit/growth-vite/`; release owners must preserve the accepted outputs
with the promoted artifact.

| Check | Recorded result | Local evidence |
| --- | --- | --- |
| Vite build, frontend TypeScript, ESLint, and route contract | Passed; all 48 recorded page routes remain present | `final-build.log`, `final-lint.log`, route contract command output |
| Migration browser journeys | 65 passed across all recorded routes, responsive layouts, saved contacts/campaigns/templates/content/Inbox operations, checkout/OAuth handling and one authorization bootstrap per navigation | `migration-expanded-final.log` |
| Agents browser journeys | 19 passed, including quick access, scoped conversations, reviews, retries, and business switching | `agents-final.log` |
| Frontend contract, production proxy, SEO, and service worker checks | 41 passed, including compression, previous-build assets and two real Chromium install/update/offline journeys | `frontend-final-memoized.log` |
| Request-lifetime bootstrap boundaries | 5 passed; expiry, cancellation, business and identity changes remain isolated | `bootstrap-final.log` |
| Final affected Agents scope regressions | 3 passed after bootstrap consolidation | `agents-final-scope.log` |
| Retained-artifact visual comparison | 78 settled captures across 13 families, three widths and both frameworks; no page errors, remaining skeletons or document overflow | `visual-parity/capture-ledger.json` |
| Isolated OIDC and persisted product API journey | Passed through the built frontend, synthetic identity provider, and isolated database; includes uploads larger than 5 MB and logout | `frontend-identity.log` |
| Signed Growth/Agents HTTP and Restate integration | 8 passed, including real-browser assistant quick access through both APIs and persisted record checks | `signed-growth-http.log` |
| Final portable Docker build and disposable container | Passed; non-root user, health, compressed prerendered landing and private no-store fallback | `docker-memoized-final.log`, `container-smoke-final.json` |

The visual comparison used the retained pre-migration artifact after source changes. It is
retrospective baseline evidence, not a pristine rebuild or a pixel-identity claim. Six inspected
pairs retain their shell, controls and content, with minor font metric differences.

The persistence journey exposed a preexisting public API audit insert that omitted required
raw-SQL timestamps. Commit `c33a646d` supplies them explicitly and pins the fixture actor to the
persisted authenticated user. The four focused public API regression cases passed without a
schema change; evidence is `public-api.log`.

An independent read-only review covered browser environment/secrets, cookie and Host handling,
Core authority, scoped query clearing, offline caching, SEO ownership, Docker context, and CI.
Its Docker-ignore concern was withdrawn after checking the Dockerfile-specific override.
The PWA update test's premature asynchronous readiness poll was corrected; actual browser
verification confirms no first-install reload and one reload after explicit update acceptance.

The final local image is `sha256:c3c745254eb8c222832a36b08a82c7e00db941c786fc298643f6aa8f416cb900`,
built from the runtime source checkpoint `0a4ffc3d`. The source, configuration and image must be
recorded again for any later release candidate. The local saved-profile Growth API and frontend
were started on ports 4400 and 3000. An anonymous real Keycloak authorization request returned the
expected redirect to localhost:8080 and callback to localhost:3000/api/auth/callback. This checks
the configured entry point, not a completed human account login.

Hosted TLS/DNS, full live-provider callbacks, real push delivery, calls and provider account
acceptance remain owner release checks. Model evaluations remain owner-run.

### Local performance comparison

The bounded comparison used Chromium 151, a 1440 × 900 viewport, four-times CPU slowdown,
50 ms network latency and 1.6 Mbps download bandwidth. Each route has five cold and five warm
full-document navigations per framework. The Vite artifact was unchanged during its final run;
`performance.json` records hashes and settings. The retained Next artifact's build ID is
`PGFJPwxePQDkWNK9K8unS`; its source baseline was 39b27ba8, with concurrent API/PWA preparation
recorded in the audit. Fixture additions between captures qualify the comparison; this is local
engineering evidence, not a field percentile or a production speed guarantee.

| Route | Cold readiness, Next to Vite | Warm readiness, Next to Vite |
| --- | --- | --- |
| Login | 2642 ms to 1957 ms | 478 ms to 449 ms |
| Agents | 2734 ms to 2998 ms | 568 ms to 1077 ms |
| Posts | 2978 ms to 3471 ms | 674 ms to 1070 ms |

Root comparisons are excluded because its content changed. Inbox measurements are excluded
because the sparse measurement fixture produces an error in both frameworks; the separate typed
migration fixture verifies its route and saved reply flow. These profiles measure full reloads,
not in-app client navigation. Browser API counts cannot be compared as total system calls because
Next performs additional reads on its server.

The proposed 10% review threshold exposed missing static compression and repeated authorization
reads. Those defects were fixed and verified. Protected-page warm reloads remain slower because
the Vite application resolves session, organization and layout data in the browser. This is an
explicit architecture tradeoff, not a passing speedup claim. Review these measurements before
promotion and measure real-user Web Vitals only through separately approved monitoring.

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

## Campaigns release candidate

The 30 October 2026 local Campaigns change uses the existing Growth release path. The
[Campaigns behavior reference](../architecture/campaigns.md) records draft creation, authoritative
recipient preflight, explicit launch/scheduling and preserved recovery controls. This is a
compatible UI/API change without a schema migration. Release the tested web/API artifact pair.

User-visible changes include a compact campaign list and status filters, four-step creation,
reviewed Send now and Schedule actions, truthful draft feedback, recipient/template details and
confirmed cancel/delete controls. Existing campaign records and registered delivery analytics
remain in use. Contact exclusions use canonical contact IDs, not list-membership IDs.

The local engineering handoff records commit/check evidence in KAS-212 through KAS-217.
Record the actual platform release ID and artifact versions at deployment, then schedule the
owner's post-release review. Model evaluations, consenting live-provider acceptance, push, merge
and deployment are separate owner decisions. Roll back to the prior tested web/API pair if the
new UI or scheduling contract causes regressions; never replay campaigns during rollback.

## Templates and Calls redesign candidate — 30 October 2026

- Change/owner: approved Templates and Calls layouts and recoverable provider actions; engineering,
  with final visual and live-provider acceptance assigned to Enock. Linear KAS-219–KAS-223.
- Risk: standard. Growth web and existing Templates/Calls endpoints are affected. Other products
  and their independent authentication/deployment lifecycles are unchanged.
- Release identity: local candidate commits `bd14eca2`, `50c51cdd`, `8fa3b37e`, `f81ceeb3` plus
  the subsequent verification commit. A deployed platform release/tag is not applicable yet;
  retain the exact source SHA and built artifact when separately approved for release.
- API/schema/migrations: no production API or schema change. Source-account identity and
  browser-only Twilio readiness were already exposed and now have regression coverage.
- Rollout: normal Growth frontend artifact replacement after owner acceptance. No new feature
  flag, worker, credential, provider permission or configuration variable.
- Analytics: no new event contract; existing authenticated provider actions remain the outcome
  boundary. New dashboards/adoption metrics are not applicable to this styling change.
- Logging: raw template content and request payload browser logging removed. New telemetry
  exporters, Collector changes and alerts are not applicable. Existing server logging remains
  authoritative for provider failures.
- Documentation: feature map and `architecture/growth-communications-ui.md` describe actual
  behavior, storage constraints and the owner-run live checklist. Public provider capability
  contracts do not change.
- Validation: focused API readiness/source-account checks and controlled browser journeys cover
  responsive themes, account selection, persisted review status, partial-read errors and calling
  lifecycle cleanup. Exact commands/results and screenshots are recorded on the linked issues.
  Controlled SDK/media fixtures never contact Twilio or Meta. Database-dependent API cases require
  their owned test database and remain explicitly skipped when absent.
- Rollback: redeploy the previous tested Growth web artifact and retain hashed assets for open
  tabs. No data rollback is needed. Review browser call errors and template submission/sync after
  release; post-release date is assigned by the owner with deployment approval.

Live template submission/sync, consenting calls and WhatsApp Inbox calling remain owner-run.
No production release or model eval is implied by local engineering verification.
