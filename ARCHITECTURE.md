# KasiTek source and runtime architecture

KasiTek uses a Git monorepo with independently deployable products. Source ownership is expressed
by product directories and shared package exports. Co-location does not grant cross-product
membership, database access or permission to call internal operations.

## Source owners

| Path | Responsibility |
| --- | --- |
| `products/growth/client/apps/client/` | Growth UI and product-side Agents integrations |
| `products/growth/client/packages/database/` | Growth Prisma database package |
| `products/growth/server/kasitek-core/` | Growth API, provider callbacks and workers |
| `products/agents/` | Agent API, gateway, Temporal workers, local MCP package and management UI |
| `products/agency/` | Tenant API, partner/tenant portal and private API client |
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

The original [Growth architecture](products/growth/ARCHITECTURE.md) and imported product docs
contain historical source-split context. For current repository ownership, this map takes
precedence. Existing ADR numbers retain their original product or platform scope.
