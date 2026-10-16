---
owner: engineering
last_reviewed: 2026-10-16
---

# Growth architecture

Growth is one product in the KasiTek monorepo. The [root architecture](../../ARCHITECTURE.md)
maps all products and shared services.

## Component map

| Path | Ownership |
| --- | --- |
| `web/` | Next.js UI, including campaigns, contacts, inbox, content, bookings, analytics, billing and Kāsiai integrations |
| `api/` | TypeScript Core API, provider callbacks, workers, action catalog and product adapters |
| `database/` | Growth Prisma database package |
| `scripts/` | Growth local development and maintenance tools |
| `docs/` | Growth features, technical documentation and ADRs |

Agents runtime and management source is under `../agents/`; Agency owns `../agency/`.
The central Admin and Labs website are in root `apps/`. Analytics is in `services/analytics/`;
shared interfaces and backend helpers are in root `packages/`. These remain separate runtime
owners. Growth retains its consumer integrations, publishers and outboxes.

## Runtime and dependency rules

Use the root Node 24/pnpm workspace and lockfile. Shared packages use explicit exports and
`workspace:*` dependencies. Never import another product's private runtime source or access its
database. Integration remains over supported authenticated HTTP and event contracts. Shared
login does not merge organization membership or product permissions.

See [local development](docs/internal/development/local-development.md) for environment and
verification commands. Source layout does not prove a hosted deployment or provider cutover;
see the [hosting record](../../docs/operations/hosting-cutover.md).

## Change boundaries

Change behavior in its owning package, verify affected consumers, and update current docs.
Record architecture decisions under `docs/adr/` when warranted. `CONTEXT.md` remains empty until
product terminology is agreed. Historical split plans retain their original context.
