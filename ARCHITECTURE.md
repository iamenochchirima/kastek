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
| `apps/evals/` | Evaluation client for the control plane: sandboxes, provisioning, sessions and outcomes |
| `apps/admin-site/` | Privileged UI using Growth, Agents, and Agency reporting APIs over HTTP |
| `apps/labs-site/` | Public Labs website |
| `packages/contracts/` | Shared transport and event contracts |
| `packages/server-support/` | Shared server implementation behind explicit exports |
| `packages/ui/` | Shared workspace theme, appearance definitions and generic React controls |
| `services/analytics/` | Analytics ingestion, publishing, registry and query service |
| `services/billing/` | Billing accounts, plan catalog, Paystack, subscriptions, invoices, credits, usage and entitlement snapshots |
| `services/evals/` | Evaluation control plane: sandbox, workspace, agent, outcome and session references; paired Growth/Agents local provisioner; operator API; terminal and browser clients |
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

## Evaluation control plane

`services/evals/` is the evaluation control plane for agent evaluation. It records
isolated sandbox environments, immutable sandbox version manifests, workspace and
agent references, saved outcomes and interactive session/turn references. It does
not execute agents.

The terminal client configures agents and chats through the Agents product's normal
HTTP APIs and a normal workspace session. It stores ids, digests and states in the
control plane, not transcript text or customer PII. Persistent sandbox evaluations
use the same normal task path. Evaluation trials remain isolated per-run scopes and
reserve the agent for one trial, so the two paths are not mixed on one agent. The
service is local and development only until hosted lifecycle and retention controls
land. Provisioned sandboxes use real central-billing sandbox plans rather than
disabled billing. The client lists product agents through normal product APIs,
records interactive sessions and digests, and leaves transcript text in the product
runtime. Agent setup profiles define versioned Assistant or business-agent
configurations, apply them through normal Agents APIs and register the published
agent version. Sandbox sync applies current schema migrations, restarts runtimes and
records a new sandbox version. Confirmed deletion stops runtime processes, drops
product databases, removes local files and retires the registry record. See
`services/evals/README.md`.

## Billing boundary

`services/billing/` is the financial system of record. It owns billing accounts, payer identity,
tenant links, the dynamic capability and plan catalog, Paystack checkout and webhooks,
subscriptions, invoices, AI usage ledgers, usage events, reconciliation and signed entitlement
snapshots. Product APIs keep their own organizations and feature definitions, link a tenant to a
billing account, and verify the signed snapshot before serving paid access. Products never read
the billing database.

Billing accounts are independent of product memberships. A Growth organization, Agents
organization, or Agency workspace is linked by `(product, tenant_id)`. One billing account can
hold multiple product subscriptions and receive one invoice. Embedded Agents usage belongs to the
host product’s plan; standalone Agents has its own plan. Agency partners are the default payer for
their client workspaces.

Plans are priced per currency and versioned. Published versions are immutable and existing
subscribers stay pinned; a new version only affects new checkouts. Plan versions declare whether
their price is VAT-inclusive or VAT-exclusive, and Paystack always receives the gross amount.
Monthly billing is the only interval. Paystack South Africa settles ZAR only, so a USD checkout
requires another provider even though USD prices can be stored. AI usage is held in USD
micro-units and shown to customers as dollars.

Growth has no legacy billing implementation or local billing tables. When
`BILLING_SERVICE_URL`, `BILLING_SERVICE_SECRET`, and `BILLING_SNAPSHOT_SECRET` are absent,
customer billing routes fail closed with `503` rather than using a local provider.

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
Schemas096–098 retain durable progress, queued user instructions, immutable work continuation
segments and nullable execution allowances. New admissions use policy v2 and
`product-capabilities-v14` / `AgentsBusinessRunV24`; v13/V23 and earlier task workflows remain
pinned. Local and shared call, tool and lifetime specialist limits have no default cap. Explicit
grants, quotas, concurrency and provider capacity remain enforced. See the
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
