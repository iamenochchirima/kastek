# Railway account migration plan

> Parked on 2026-09-28. This document is preserved for reference, not an active execution queue.
> Confirm the migration's current owner and state before acting on it.

**Status:** Parked (previously Active)

**Owner:** Platform operations

**Last updated:** 2026-09-28

## Objective

Recreate the KasiTek Railway deployments in a second account, migrate persistent data, and cut over the public domains after validating the new services. Keep the source deployment available as the rollback target until the new deployment is accepted.

## Scope

### Included

- `KasiTek Prod` Railway project: services, configuration, databases, Core volume, domains, and deployment settings.
- `KasiTek Staging` project if confirmed by the owner. It currently has one service and no active deployment.
- Service health, database integrity, private networking, provider integrations, and public endpoint validation.

### Excluded

- Other Railway projects in the source account (`Hodlhouse`, `extraordinary-caring`, `BookVault`, and `MAD Services`).
- Vercel frontend deployment, except configuration changes required to point it at the new backend.
- Railway's project ownership transfer flow. The owner reports that it does not work for this move.

## Current source inventory

Source account: `kasiteklabs@gmail.com`, workspace `My Projects`.

| Project | ID | Observed state |
| --- | --- | --- |
| KasiTek Prod | `f50f522f-cad6-45c9-a1d1-65cd0df1589f` | 13 services; 12 successful deployments; `core-analytics-publisher` stopped with `NEEDS_APPROVAL` |
| KasiTek Staging | `54c742e2-6356-4d08-8f6c-4289fb9632a5` | One `kasitek` service; no active deployment, domain, or volume |

Production services: `core`, `tenents`, `agents-api`, `agents-worker`, `MCP-Gateway`, `analytics-api`, `analytics-worker`, `core-analytics-publisher`, `otel-collector`, `core-db`, `tenents-db`, `agents-db`, and `analytics-db`.

Production persistent volumes: four Postgres volumes mounted at `/var/lib/postgresql/data` and `core-volume` mounted at `/data`. The Postgres volumes currently report about 272 MB, 781 MB, 158 MB, and 275 MB in use; Core reports about 84 MB. These are live volume sizes, not database export sizes.

Production custom domains: `api.kasitek.co.za` on Core port 4000; `api-tenants.kasitek.co.za` on Tenents port 8090; `agents.kasitek.co.za` on MCP Gateway port 4200. Railway-generated service domains also exist for Core, Tenents, MCP Gateway, and the Collector.

The CLI reports 439 variable entries across production services, including inherited values. This count does not distinguish secrets from reference variables. No values are recorded in this plan.

## Implementation plan

1. [x] Inventory source projects, services, deployment states, domains, volumes, and variable counts without exporting secret values.
2. [ ] Confirm the destination Railway account or workspace, access method, subscription, and whether `KasiTek Staging` is included.
3. [ ] Capture the source service settings, GitHub sources, variable definitions and references, database versions, volume contents, and external integration dependencies in a secure local migration manifest. Do not commit credentials or exports.
4. [ ] Recreate staging and production projects and services in the destination. Configure private networking, variables, build/start settings, domains pending cutover, and volumes.
5. [ ] Export and restore the four databases and `/data` contents. Validate row counts, schema versions, media files, and application access. Plan a final sync or write pause for the production cutover.
6. [ ] Deploy the same repository commit and verify readiness, authentication, workers, telemetry, integrations, and data flows in the destination.
7. [ ] Cut over custom domains and any frontend/provider callbacks that depend on the backend URLs. Monitor errors and queues. Keep the source running until the rollback window closes.
8. [ ] Update the current Railway topology and operational runbooks, record release evidence, then move this plan to `docs/plans/completed/`.

## Verification and release record

**Change:** Manual Railway account migration.

**Risk:** High. Four production databases, a Core data volume, worker processes, secrets, and public domains are affected.

**Affected services and user surfaces:** All KasiTek Railway services; browser and integration traffic through the Core, Tenents, and MCP domains.

**Platform release version or release ID:** Record the deployed commit, `VERSION`, migration revisions, and destination deployment IDs at rollout.

**API/schema/migration changes:** None planned. Confirm database schema versions and apply any required migrations before traffic cutover.

**Feature flag or rollout method:** Parallel destination deployment, data sync, then DNS/domain cutover. Define the production write pause after measuring export and restore time.

**Analytics events and success metrics:** No new events. Verify existing ingestion, worker queues, and API success rates after cutover.

**Logs, metrics, dashboards, and alerts:** Verify each destination service's logs and Collector transport. Record the Collector configuration revision and telemetry endpoint.

**User, API, internal, and operational documentation:** Update `docs/internal/operations/deployment-topology.md` and related runbooks to match the destination. Public documentation is not applicable unless endpoints change.

**Validation evidence:** Record service deployment states, database restore checks, health endpoints, authentication, callbacks, worker processing, analytics delivery, volume files, and DNS resolution.

**Rollback or disable plan:** Keep source deployments and data intact. If destination checks fail, direct traffic back to the source domains and reconcile writes made during the cutover window before retrying.

**Post-release review date:** Set after the production cutover.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Destination | Which Railway account or workspace receives the deployments, and how will this session access it? | User | Pending |
| Staging | Include the currently undeployed `KasiTek Staging` project? | User | Pending |
| Data consistency | Define the write pause or final sync for production databases and Core volume. | Platform operations | Pending |
| External systems | Verify GitHub integration, DNS ownership, OAuth/provider callbacks, Vercel variables, and Temporal Cloud access. | Platform operations | Pending |

## Notes

The checked-in deployment topology describes staging and production as environments in one project. The live Railway account currently has separate `KasiTek Prod` and `KasiTek Staging` projects, each with a `production` environment. Update the topology after confirming the destination layout.
