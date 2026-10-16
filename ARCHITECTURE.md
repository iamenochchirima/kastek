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
| `products/agents/api/` | Agent API, gateway, Temporal workers, migrations and tests |
| `products/agents/web/` | Agents management UI |
| `products/agents/mcp/` | Local MCP bridge |
| `products/agency/api/` | Tenant API, migrations and workers |
| `products/agency/web/` | Partner and tenant portal |
| `products/agency/api-client/` | Private React tenant API client |
| `apps/admin-site/` | Privileged UI using Growth and Agency over HTTP |
| `apps/labs-site/` | Public Labs website |
| `packages/contracts/` | Shared transport and event contracts |
| `packages/server-support/` | Shared server implementation behind explicit exports |
| `services/analytics/` | Analytics ingestion, publishing, registry and query service |
| `infra/identity/` | Keycloak development identity configuration |
| `infra/observability/` | Collector configuration and deployment source |

## Dependency and data rules

Runtime product code may import its own private packages and explicit shared package exports.
It may not import another product's private source. `pnpm verify:boundaries` checks these imports;
integration tests may cross product seams to pin consumer contracts.

Service-to-service integration remains over the existing authenticated HTTP interfaces. Product
migrations, organizations, memberships, sessions, databases and secrets remain separately owned.
Shared login does not synchronize product permissions. Agency customer identity remains scoped
according to its existing contracts. Source relocation does not change cookie scopes or callbacks.

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
