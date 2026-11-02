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

The first media probe ran through privileged Railway SSH and was insufficient: the application
runs as UID 1000 and could not write the root-owned mount. Ownership was corrected and a separate
UID 1000 write/delete probe passed. For a new `/data/media` volume, initialize it from a privileged
maintenance session before accepting uploads; keep the application process unprivileged:

```sh
mkdir -p /data/media
chown 1000:1000 /data /data/media
chmod 0750 /data/media
```

Sixteen public frontend checks passed, including session denial, correct login redirects/PKCE and
Agency wildcard routing with caller-header spoof rejection. SMTP certificate-verified TLS and
authentication succeeded without sending email. Completed human sign-in/logout, actual email
delivery, authenticated browser uploads/streaming and external-agent/provider publication remain
unverified. Local Facebook tests establish provider behavior, not hosted agent acceptance.

CI is not fully green. The latest inspected Monorepo validation run found an ambiguous Growth
Retry-button locator; the separate Agents Source Checks run had 24 failures, 2,255 passes and
112 skips. Some failures are fixture/infrastructure drift, while review suppression, execution
export redaction, controlled-model uncertainty and a grounded execution timeout need separate
reproduction. These logs do not establish a live defect, and successful readiness checks do not
certify those workflows. The owner explicitly authorized deployment based on local working
behavior without making the full CI suite a promotion gate. The focused Agent Platform UI run
passed after its stale assertions were corrected.

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

Old source deployments were already failing when inventoried; their availability is not a
verified rollback target. Domain/source settings and previous frontend artifact IDs are retained,
but a complete rollback was not executed during this rollout.

Post-release review: 2026-11-03. Remaining acceptance is listed above. Growth's existing landing-page
SEO metadata still references its legacy `growth.kasitek.co.za` canonical origin; application routing
uses `app.kasitek.co.za`. This metadata cleanup was not included in the hosting fixes.

## Identity hostname configuration revision

Change: `identity-auth-domain-2026-11-02`, owned by Enoch Chirima. Risk: standard.
Identity now uses `https://auth.kasitek.co.za`; Cloudflare holds a DNS-only Railway CNAME
and ownership verification record. Railway supplies the validated HTTPS certificate.
`KC_HOSTNAME` and the passwordless relying-party ID use this origin. There were no completed
human accounts or enrolled passkeys when the issuer changed; no membership migration was needed.
Existing signup pages on the previous hostname must restart from their product's signup entry.

Rollout uses the existing Identity image, followed by cached redeployment of the seven issuer
consumers: Growth API/analytics worker, Agents API/worker, Agency API/analytics worker and
Operations API. Their issuer variables reference Identity's hostname. Product command issuers,
client secrets, callbacks and production Meta settings are unchanged. Vercel needs no redeployment.
The initial artifact manifest remains a historical capture; this configuration revision has its
own deployment evidence. API/schema migrations and new analytics events: not applicable.
Platform source version remains 0.2.0; this is an infrastructure configuration revision.

Documentation: release configuration record and Growth deployment topology updated. Existing
readiness, authentication failure logs and Keycloak event retention apply; no log payload change.
Collector/exporter configuration is unchanged; durable log retention and alert delivery remain
unconfigured as recorded above. Monitor readiness and login-start failures during the cutover.

Rollback before account enrollment restores the previous `KC_HOSTNAME` and passwordless RP ID,
then restarts the same seven consumers. Keep both DNS bindings and the private previous config
until acceptance. After users enroll, issuer/subject membership keys and passkey RP IDs require
an explicit migration assessment before reverting. No database or user deletion is part of rollback.
Post-release review: 2026-11-03.

Validation: all 19 Railway services report successful deployments. Certificate validation,
Identity readiness/discovery and passwordless RP ID checks passed. All four product login
starts and Growth signup reach the new origin with PKCE S256 and unchanged callbacks; no user
input was submitted. See the [configuration verification record](./releases/identity-auth-domain-2026-11-02.json).
Product import boundaries and whitespace checks passed. Completed human login/logout and email
delivery remain unverified; the existing CI limitations above still apply.
