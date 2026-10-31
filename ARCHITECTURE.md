# KasiTek source and runtime architecture

Owner: Platform engineering. Last reviewed: 2026-10-24.

KasiTek uses a Git monorepo with independently deployable products. Source ownership is expressed
by product directories and shared package exports. Co-location does not grant cross-product
membership, database access or permission to call internal operations.

## Source owners

| Path | Responsibility |
| --- | --- |
| `products/growth/web/` | Vite/React Router Growth UI, prerendered public landing, same-origin API proxy, and product-side Agents integrations |
| `products/growth/database/` | Growth Prisma database package |
| `products/growth/api/` | Growth API, provider callbacks and workers |
| `products/agents/api/` | Agents API, fresh platform schema, Restate business worker and tests |
| `products/agents/web/` | Agents customer-service client; current local management implementation |
| `products/agency/api/` | Tenant API, migrations and workers |
| `products/agency/web/` | Partner and tenant portal |
| `products/agency/api-client/` | Private React tenant API client |
| `apps/admin-site/` | Privileged UI using Growth, Agents, and Agency reporting APIs over HTTP |
| `apps/labs-site/` | Public Labs website |
| `packages/contracts/` | Shared transport and event contracts |
| `packages/server-support/` | Shared server implementation behind explicit exports |
| `packages/ui/` | Shared workspace theme, appearance definitions and generic React controls |
| `services/analytics/` | Analytics ingestion, publishing, registry and query service |
| `services/operations/` | Independent Labs admin sessions, durable monitoring, incidents, and notification intent |
| `infra/identity/` | Keycloak development identity configuration |
| `infra/agents-runtime/` | Pinned local Restate runtime and recovery verification |
| `infra/firecrawl/` | Optional pinned local website crawl provider; independent from agent execution |
| `infra/observability/` | Collector configuration and deployment source |

## Dependency and data rules

Runtime product code may import its own private packages and explicit shared package exports.
It may not import another product's private source. `pnpm verify:boundaries` checks these imports;
integration tests may cross product seams to pin consumer contracts.

Service-to-service integration remains over the existing authenticated HTTP interfaces. Product
migrations, organizations, memberships, sessions, databases and secrets remain separately owned.
Shared login does not synchronize product permissions. Agency customer identity remains scoped
according to its existing contracts. Source relocation does not change cookie scopes or callbacks.

## Growth browser boundary

Growth's React Router application uses Vite with server rendering disabled at runtime and an
explicit public prerender for `/`. Private route modules load data in the browser through
same-origin `/api` requests. Core remains the authority for sessions, organization membership,
permissions, data, and agent delegation. Browser state cannot authorize a product operation.

The production frontend process, `products/growth/web/scripts/serve.mjs`, serves `build/client`
and streams `/api` requests to the independently deployed Growth API. It preserves the browser
Host for exact-origin checks and rebuilds forwarding headers from trusted configuration.
`FRONTEND_URL` identifies the public origin. API secrets and product signing keys remain server-side.
The standalone Agents UI, Agency, Labs website, and Admin retain their own build and deployment boundaries.

The [frontend release runbook](products/growth/docs/internal/operations/growth-frontend-release.md)
records SEO, caching, session integration, validation requirements, and rollback.

## Administrative reporting

The existing admin provides cross-product reporting through product-owned metadata APIs.
Growth, Agents, and Agency retain independent databases and resource identities. Authoritative
current-state and financial values come from those APIs. Registered event trends come from Labs
Analytics. The admin does not join product databases or duplicate shared execution accounting.

With `OPS_BACKEND_URL` configured, Labs Operations validates its own opaque admin session through
the dedicated Keycloak client and explicit issuer/subject grants. Product adapters verify
request-bound, short-lived administrative actor assertions. Growth also checks its existing
explicit admin record; a product outage cannot supply a cached or inferred platform grant. Reporting, exports, commercial writes, and support-content access
have separate capabilities. Organization/workspace display labels and IDs may appear in scoped customer records;
messages, prompts, credentials, and raw provider payloads are excluded.

Sources expose their own availability, freshness, completeness, and instrumented-scope coverage.
Unknown or unsupported values remain explicit. `/operations` exposes durable incidents and
monitor coverage while retaining source publication and Analytics projection diagnostics.
Queue progress and historical completeness remain separate.
Customer search filters safe name/ID records within product ownership, with a 100-character bound;
it does not change aggregate metrics. Analytics can use a separate non-owner reporting pool while
ingestion and workers retain their writer pool. The dedicated development process profile uses
private configuration and identity-checked start/status/stop commands, without replacing the
existing Agents API/UI or databases. Model usage and estimated cost have one execution
owner in Agents, with verified Growth and Agency attribution. Reports do not invent a unique
cross-product person count or a combined amount across currencies.

See the [reporting contract and operations reference](docs/operations/admin-reporting.md) for
source coverage, additive migrations, configuration, verification, and rollback. The
[admin README](apps/admin-site/README.md#cross-product-reporting) maps the implemented pages.

## Target Agents integration

The [Agents target architecture](products/agents/docs/architecture/agent-platform-architecture.md)
separates the shared execution service from the standalone Agents product. Growth and Agencies
embed features through an authenticated execution API without requiring their customers to create
Agents-product accounts, memberships, or subscriptions. Product permissions, entitlements, and
workspace structures remain separately owned.

The standalone client targets mostly plug-and-play support, FAQ, booking, and intake agents
for customer channels, with a shared staff inbox. Research and campaign customer experiences
belong in Growth or Agencies. The Agents client catalogue is separate from shared runtime
capabilities. Website, WhatsApp, Telegram, Facebook and Instagram adapters share the customer
Inbox, staff takeover/reply/return controls and delivery authority. Google and Microsoft Calendar
share a confirmed booking workflow; HubSpot supports confirmed intake and staff-only contact
lookup. Live provider setup and owner acceptance remain separate from fixture verification.

External agents access product MCP through OAuth or deliberately supported scoped keys. Embedded
product backends call the shared execution API. Executing agents call typed owning-product APIs
with destination-specific delegated authority. These are three separate contracts. Ordinary
product features operate independently; agent-powered features may depend on the shared service.

The standalone Agents implementation uses Keycloak 26.6.0, product-owned membership,
bounded execution grants, PostgreSQL admission and outbox, and a Restate business harness.
The harness includes ordered conversations, reviewed personal memory, pinned skills,
context compaction, bounded model/tool operations, version-pinned business subagents,
isolated temporary Python analysis, exact report review and UTC/event automation.
Root budgets bound the entire task tree. The website FAQ uses the same harness
with optional capabilities disabled. Approved immutable source revisions use scoped
lexical/local semantic retrieval and citation/dependency records. Private S3 storage
holds source bodies, evidence from connected reads and reports. Memory bodies and bounded memory
citation snapshots remain in private PostgreSQL. Selected native/MCP public-repository
read adapters share the controller; authenticated GitHub acceptance remains pending.
The standalone organization assistant uses ordinary human-principal tasks and pinned business
specialists, with verified private member links over Telegram/WhatsApp behind organization allowlists.
Explicit `tool-directed` v4 coordinators discover permitted specialists, start parallel work,
read paginated results and follow up in isolated child conversations under bounded root policy.
Schema096 and `product-capabilities-v13` / `AgentsBusinessRunV23` retain durable progress and queued
user instructions; earlier task workflows remain pinned. See the
[adaptive orchestration reference](products/agents/docs/operations/adaptive-orchestration.md).
Its lifecycle and purpose-routing records do not grant cross-product authority. Knowledge source
bodies and temporary extraction receipts now live in PostgreSQL; unrelated connected evidence and
artifacts continue to use private object storage. See the [private assistant reference](products/agents/docs/operations/private-assistant.md).
Growth's managed assistant now uses the adaptive loop with its three existing same-business
specialists under signed product authority. Growth retains membership, business permissions and
exact-effect approvals; child execution does not create Agents-product membership. Agency
delegation remains unavailable. Workspace execution
is explicitly unavailable until the Lina adapter is implemented. No existing database or
production deployment is changed by this source reset.

## Build and release rules

Runtime apps use the root Node 24/pnpm workspace and lockfile. Shared exports build first, then
consumer packages. Prisma generation belongs to Growth. The documentation sites and Railway IaC
remain isolated tooling installs, as recorded in the root README.

CI selects changed products and transitive shared-package consumers. Required aggregate checks
remain present even when unrelated jobs skip. Deployments remain per-service with explicit source
paths and runtime dependencies. [Hosting cutover](docs/operations/hosting-cutover.md) records the
unverified provider connections; source import alone is not a production cutover.

Product architecture documentation remains under each product. Historical plans and ADRs may
refer to earlier repository splits; the [directory restructure record](docs/operations/directory-restructure.md)
maps the previous package paths. Existing ADR numbers retain their original product or platform scope.

## Administrative customer operations

The existing Labs admin customer workspace calls product-owned metadata and scoped operation APIs.
Recovery uses explicit operate authority and durable actor/customer/request-bound receipts.
Verified Agents execution mappings provide cross-product navigation; the BFF never joins product
databases or impersonates customer sessions. The feature is development-only and independently
gated for metadata and each action. See [Customer operations](docs/operations/admin-customer-operations.md).

## Incident and operations centre

Labs Operations runs a separate API and worker against its own PostgreSQL database. The worker
collects fixed product-owned signal endpoints using destination-specific observer keys. It never
receives human admin signing or identity-session credentials. Transactional leases and fencing
protect collection; stable fingerprints and active-episode uniqueness protect incident state.
The API independently observes worker progress. Unknown evidence cannot resolve an incident.

Product services retain business recovery authority. Operations records human investigation and
links to existing customer controls. Its transactional outbox delivers immutable per-recipient
in-app events through Growth. Delivery outages preserve incidents and pending intent. Safe
audit queries federate source-owned projections through a current human admin assertion.

See the [incident-centre reference](docs/operations/incident-centre.md),
[operator runbook](docs/labs/operations-centre-runbook.md), and
[domain decision](docs/labs/adr/0002-labs-operations-and-admin-identity.md). Production rollout,
external notifications, and an external uptime provider remain separate owner decisions.
