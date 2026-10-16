# Compact product directory restructure

Owner: Enoch Chirima. Approved in chat on 2026-10-16.

The source consolidation is complete. This follow-up gives the three product directories a
consistent layout while retaining product databases, sessions, permissions, API contracts and
independent deployment lifecycles.

## Package mapping

All paths are relative to the repository root.

| Previous path | Current path |
| --- | --- |
| `products/growth/client/apps/client/` | `products/growth/web/` |
| `products/growth/client/packages/database/` | `products/growth/database/` |
| `products/growth/server/kasitek-core/` | `products/growth/api/` |
| `products/agents/client/apps/agent-platform/` | `products/agents/web/` |
| `products/agents/packages/mcp/` | `products/agents/mcp/` |
| Agents backend package and its `src/`, `test/`, `migrations/`, `scripts/` | `products/agents/api/` |
| `products/agency/client/apps/tenant-portal/` | `products/agency/web/` |
| `products/agency/client/packages/api-client-react/` | `products/agency/api-client/` |
| `products/agency/server/kasitek-tenants/` | `products/agency/api/` |

Agents `docs/` and `examples/` remain at the product root. Product scripts and docs remain with
Growth and Agency. `apps/labs-site/`, `apps/admin-site/`, shared `packages/`, `services/analytics/`,
`infra/`, `designs/`, root tooling and isolated documentation sites retain their locations.
Empty nested workspace wrappers are retired; the root workspace is the application install owner.
Historical plans, import provenance and old ADR source paths remain historical references.

## Release decisions

- Change: move existing source packages and update path consumers and current documentation.
- Risk: standard. Relative paths in builds, CI and checked-in deployment configuration can break.
- Affected services and surfaces: Growth, Agents and Agency package locations and their consumers.
  User routes and runtime contracts remain unchanged.
- Platform release version or release ID: not applicable to this source-only change. `VERSION`
  remains unchanged; a future release records its deployment commit and artifact identity.
- API/schema/migration changes: not applicable. Existing migrations move with their package;
  this work does not apply migrations or change their content.
- Feature flag: not applicable. Rollout is the source change and updated build paths.
- Analytics events and success metrics: no event changes. Success means root workspace boundary
  checks and affected builds resolve packages at their new locations.
- Logs, metrics, dashboards and alerts: not applicable; runtime instrumentation and service
  identities remain unchanged.
- Documentation: root and product maps, setup commands and current source references updated.
  Public product behavior and API documentation need no behavioral release note. The feature map
  only receives source-path corrections; user entry points remain unchanged.
- Deployment: explicitly deferred. No hosted settings or services are changed by this work.
  Provider-side source roots and configured build commands must be checked before a future deployment.
- Rollback: revert the restructure change, restoring previous paths, workspace declarations and
  path consumers together. No database rollback is needed. Preserve unrelated local edits.
- Post-release review date: not applicable until a deployment is scheduled.

## Validation evidence

Verified locally on 2026-10-16 with Node 24 and the root pnpm workspace:

- Frozen install passes after recreating dependency links for relocated packages. Locked package
  resolutions and dependency snapshots are unchanged.
- Shared contracts/server-support, Growth API/web, Agents API/web/MCP, Agency API/web, Analytics
  and Admin production builds pass. Growth database generation and canonical route checks pass.
- Shared tests pass with 24 passed and one database-dependent skip. Growth targeted route checks
  pass with 11 tests. Agents deployment/MCP/capability checks pass with eight tests; script
  typecheck, Studio/stream tests and health checks with the Collector unavailable also pass.
  Agency portal server test passes.
- Agency API route census still reports the existing extra `POST /api/partner/auth/activity`
  route. The same failure reproduces against the original pre-restructure source. This change
  does not alter the route or its fixture.
- Product import boundaries, release-version validation, workflow YAML parsing, shell syntax,
  relevant local Markdown links and whitespace checks pass.
- Both Growth documentation builds were attempted but could not start because their isolated
  dependencies are absent locally, resulting in `docusaurus: not found`. Link checks passed;
  documentation production builds remain unverified.
- Source accounting covers 3,090 baseline files: 3,002 unchanged, 86 edited, and two retired
  wrapper manifests preserved privately. No baseline source file is missing. This includes
  concurrent Labs work, whose files were left in place. An independent agent checked source
  accounting and unchanged lockfile resolutions; ignored runtime state is outside that audit.
- Database generation was used for the web build. The existing tracked generated-source baseline
  was restored afterward so this move does not include an unrelated generated-client refresh.
  Root `build:growth` and `build:all` regenerate the database client before compiling consumers.

Detailed local command logs and preservation evidence are under ignored `.audit/restructure-*`.
No production database migrations, hosted configuration changes or deployments were performed.
