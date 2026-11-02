# Platform 0.2.0 release

Owner: Enoch Chirima. Risk: high. Deployed: 2026-11-02. Status: hosted readiness verified;
completed human and external-agent journeys remain acceptance work.

The owner authorized merging the accumulated implementation into `main` and deploying Railway
backends and Vercel frontends. This includes Agents execution, Growth OAuth MCP and equivalent
REST/internal operations, Facebook content management, administration and operations.

## Configuration and data

The destination uses fresh databases, as explicitly selected by the owner. Old services and
databases were retained. The existing API domain bindings moved to the new Railway project;
Cloudflare API and Agents records now point to the new deployments. Production Meta app settings
were not edited. Users need new memberships and provider connections in the destination.
Environment exports remain private and uncommitted.

Code merged through pull requests [#23](https://github.com/Kasitek-Labs/kastek/pull/23),
[#24](https://github.com/Kasitek-Labs/kastek/pull/24) and
[#25](https://github.com/Kasitek-Labs/kastek/pull/25). The
[artifact manifest](./releases/platform-0.2.0-artifacts.json) records all 19 successful Railway
deployments, five ready Vercel production artifacts, their exact source revisions and DNS rollback
targets. Unchanged services retain their earlier verified merged-source artifact. Packaging lives
in `infra/backend`, the Agents API Dockerfile, `infra/identity/HOSTED.md` and the signed
`infra/agents-runtime/production` profile.

Growth keeps its embedded workers with its persistent media volume; its separate analytics
publisher handles backfill. Other products retain their documented API/worker commands.
Products and Identity use six separate databases. Agents additionally needs private object
storage and durable Restate data. MCP/OAuth discovery uses Growth's public API origin.

Growth's 96 tracked migrations, the fresh Agents schema, 18 Agency migrations, 29 Analytics
migrations and four Operations migrations were applied to their owning databases. Agents requires
the pinned pgvector 0.8.7 image and independent production cursor-signing keys. Exact callbacks,
private storage, signed Restate requests and independent service keys are configured.

Railway application services track `Kasitek-Labs/kastek` on `main` with scoped source watchers.
Vercel Hobby rejects Git integration for this private organization repository. Frontends therefore
use verified prebuilt artifacts from clean merged-source archives; automatic Git deployments are
disabled and stale repository links were removed. Future Vercel updates need the documented
manual promotion procedure or a separately chosen supported plan.

## Validation and observation

The complete application build and import checks passed locally. The Growth API suite passed
147 tests; 92 fixture-dependent checks skipped. Separate focused owned PostgreSQL verification
passed 12 tests without skips, covering access/revocation, transactional analytics and retained
publication identities. New setup targets manifest/policy 8 and adapter 5.

Real Operations, Agents, Identity and Restate images built successfully. Identity's fresh realm,
execution roles and session revocation grants passed against PostgreSQL. Restate signed discovery,
invocation, unsigned rejection and durable restart replay passed. Four Vercel hosting tests passed.
All19 Railway roles report success. All six APIs are healthy and Operations authenticates all four
product sources. Hosted Agents private storage passed write/read/delete and anonymous denial;
eight current/retained workflows were registered through signed private discovery. Growth's
persistent media path is writable. Canonical MCP discovery returns the public API issuer and
unauthenticated MCP initialization returns its OAuth challenge.

Sixteen public frontend checks passed, including session denial, correct login redirects/PKCE and
Agency wildcard routing with caller-header spoof rejection. SMTP certificate-verified TLS and
authentication succeeded without sending email. Completed human sign-in/logout, actual email
delivery, authenticated browser uploads/streaming and external-agent/provider publication remain
unverified. Local Facebook tests establish provider behavior, not hosted agent acceptance.

Registered analytics events and bounded logs are reused. Analytics projection and Operations
workers show current progress; no synthetic business events were inserted. Central log retention
and alert delivery remain unconfigured; the Collector currently uses its debug exporter.
New deployment-only events and API contracts: not applicable. Current behavior and hosting
requirements remain in the feature map, deployment topology and hosting cutover documentation.

## Rollout and rollback

Existing public frontend aliases were promoted after their runtime checks. The original production
Meta app configuration was preserved. Login starts reach the hosted Keycloak form, but this does
not establish a completed user session or third-party OAuth consent.

Keep previous provider source settings, deployment IDs and domain targets for rollback. Restore
matching frontend/backend artifacts without dropping additive schemas, receipts or durable queues.
Disable Growth agent effects/access separately when needed. Never blindly retry an uncertain
provider mutation. Keep old production data untouched.

Post-release review: 2026-11-03. Remaining acceptance is listed above. Growth's existing landing-page
SEO metadata still references its legacy `growth.kasitek.co.za` canonical origin; application routing
uses `app.kasitek.co.za`. This metadata cleanup was not included in the hosting fixes.
