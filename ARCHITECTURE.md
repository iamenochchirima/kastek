# KasiTek source and runtime architecture

KasiTek uses a Git monorepo with independently deployable products. Source ownership is expressed
by product directories and shared package exports. Co-location does not grant cross-product
membership, database access or permission to call internal operations.

## Source owners

| Path | Responsibility |
| --- | --- |
| `products/growth/web/` | Growth UI and product-side Agents integrations |
| `products/growth/database/` | Growth Prisma database package |
| `products/growth/api/` | Growth API, provider callbacks and workers |
| `products/agents/api/` | Agents API, fresh platform schema, Restate business worker and tests |
| `products/agents/web/` | Agents management UI |
| `products/agency/api/` | Tenant API, migrations and workers |
| `products/agency/web/` | Partner and tenant portal |
| `products/agency/api-client/` | Private React tenant API client |
| `apps/admin-site/` | Privileged UI using Growth and Agency over HTTP |
| `apps/labs-site/` | Public Labs website |
| `packages/contracts/` | Shared transport and event contracts |
| `packages/server-support/` | Shared server implementation behind explicit exports |
| `services/analytics/` | Analytics ingestion, publishing, registry and query service |
| `infra/identity/` | Keycloak development identity configuration |
| `infra/agents-runtime/` | Pinned local Restate runtime and recovery verification |
| `infra/observability/` | Collector configuration and deployment source |

## Dependency and data rules

Runtime product code may import its own private packages and explicit shared package exports.
It may not import another product's private source. `pnpm verify:boundaries` checks these imports;
integration tests may cross product seams to pin consumer contracts.

Service-to-service integration remains over the existing authenticated HTTP interfaces. Product
migrations, organizations, memberships, sessions, databases and secrets remain separately owned.
Shared login does not synchronize product permissions. Agency customer identity remains scoped
according to its existing contracts. Source relocation does not change cookie scopes or callbacks.

## Target Agents integration

The [Agents target architecture](products/agents/docs/architecture/agent-platform-architecture.md)
separates the shared execution service from the standalone Agents product. Growth and Agencies
embed features through an authenticated execution API without requiring their customers to create
Agents-product accounts, memberships, or subscriptions. Product permissions, entitlements, and
workspace structures remain separately owned.

External agents access product MCP through OAuth or deliberately supported scoped keys. Embedded
product backends call the shared execution API. Executing agents call typed owning-product APIs
with destination-specific delegated authority. These are three separate contracts. Ordinary
product features operate independently; agent-powered features may depend on the shared service.

The standalone Agents implementation uses Keycloak 26.6.0, product-owned membership,
bounded execution grants, PostgreSQL admission and outbox, and a Restate business harness.
The harness includes ordered conversations, reviewed personal memory, pinned skills,
context compaction, bounded model/tool operations, version-pinned business subagents,
and optional isolated temporary Python analysis. Root budgets bound the entire task tree. The website FAQ uses the same harness
with optional capabilities disabled. Private PostgreSQL stores context and memory records;
S3-compatible storage holds large artifacts. It replaces protected KasiAi, hosting modes,
and the inherited Temporal backend. Growth
and Agencies integration and destination-token policy remain later work. Workspace execution
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
