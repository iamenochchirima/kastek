# KasiTek monorepo migration plan

Status: Source consolidation complete in Growth `rewrite`, merged through PR 20. Deployment is explicitly deferred by the owner.
Owner: Enoch Chirima. Integration and verification: the agent executing each approved slice.
Created: 2026-10-15. Execution authorized by the owner in chat on 2026-10-15.
Destination: `Kasitek-Labs/kastek`, renamed from `kasitek-growth` on 2026-10-15 at the owner’s request.

## Outcome and scope

Bring Growth, Agents, Agency, and Labs into one Git repository with explicit product ownership,
local shared-package dependencies, reproducible builds, and independently deployable products.
Preserve current work, source history, product behavior, data ownership, and release recovery.

Use Growth's current `rewrite` line as the starting source for Growth, after auditing its
relationship to `main`. Do not rebuild the destination from Growth's older `main` or restore
previously extracted copies over the newer Agents, Agency, and Labs implementations.

The owner clarified on 2026-10-15 that this request is source consolidation only. Only Growth
is known to have been deployed. Deployment, hosting access and live rollout are not prerequisites
for completing this regrouping. Keep Growth `main` and existing deployment settings unchanged;
`rewrite` is the unified development line.

This program changes source organisation and delivery wiring. It does not combine databases,
authentication permissions, billing accounts, or deployment lifecycles. Building a shared payment
service, completing shared login adoption, redesigning interfaces, upgrading frameworks, and
rewriting business logic are separate work. Keep existing HTTP contracts and service credentials.

This file is the shared execution sequence. Once the split is approved, GitHub Issues hold scoped
acceptance criteria and dependencies; the Growth Project holds approval, assignment, and work
status. Link their IDs here after publication. Do not publish an issue split or mark work Ready
from this draft. The owner sets Ready under the existing Growth workflow.

## Observed starting point

Local inspection on 2026-10-15 found the following. Ahead counts use cached remote refs, not a
fresh remote audit. Recheck all values before implementation; they are preservation evidence,
not a live work queue.

| Repository | Selected local line and short SHA | Working tree entries | Ahead of cached tracking branch |
| --- | --- | --- | --- |
| Growth | `rewrite`, `380cd4da` | 1 modified entry | 95 |
| Agents | `main`, `2194504` | 98 modified, deleted, or untracked entries | 42 |
| Agency | `main`, `31dd0c1` | 117 modified, deleted, or untracked entries | 33 |
| Labs | `main`, `cffa658` | clean | 59 |

Growth also retains `main` at `e12c4d4c`. Its uncommitted change is the Core route fixture.
Agents and Agency contain active backend and UI changes. Agency's working tree includes a portal
move from Next.js files to Vite files, so its committed HEAD alone is not the desired current tree.
All three products consume Labs contracts through local `.tgz` artifacts; Growth and Agency also
consume Labs server support. These artifacts have source and integrity manifests.

The current Labs workspace includes shared packages and Analytics, but does not include its two
site packages. Growth and Agency have nested frontend workspaces and separate backend installs;
Agents has its own workspace. There is no single complete root install today.

Existing CI includes Growth documentation, release-version and manual observability workflows;
Agents backend and UI workflows; and the Labs Collector workflow. Agency has no tracked workflow.
Hosting configuration files exist, but live provider settings have not been inspected.

No tracked Cargo manifests were found in the inspected current trees. Some architecture and
external plan documents still describe Rust or earlier source splits. Reconcile those descriptions
with the selected source tree instead of resurrecting removed implementations.

## Target layout

Keep product internals recognisable in the first migration. Product-private packages stay with
their product. Only genuinely shared packages belong in root `packages/`.

```text
kasitek-growth/                         # GitHub name stays unchanged during migration
  products/
    growth/
      client/apps/client/
      client/packages/database/
      server/kasitek-core/
      scripts/
      docs/
    agents/
      src/
      migrations/
      test/
      client/apps/agent-platform/
      packages/mcp/
      scripts/
      docs/
    agency/
      client/apps/tenant-portal/
      client/packages/api-client-react/
      server/kasitek-tenants/
      docs/
  apps/
    labs-site/
    admin-site/
  packages/
    contracts/
    server-support/
  services/
    analytics/
  infra/
    identity/
    observability/
  scripts/                             # cross-product verification and orchestration
  docs/                                # platform architecture, operations, decisions
  .github/workflows/
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  AGENTS.md
  MONOREPO_MIGRATION_PLAN.md
```

### Source mapping and collision rules

| Current source | Destination | Migration rule |
| --- | --- | --- |
| Growth `client/`, `server/` | `products/growth/client/`, `products/growth/server/` | Keep relative structure inside each subtree. Fix scripts that cross the old root. |
| Growth product scripts and technical docs | `products/growth/scripts/`, `products/growth/docs/` | Keep Growth documentation sites here; distinguish platform policies from product guides. |
| Growth root instructions, standards and release scripts | root or product scope after review | Root rules cover all products; Growth-only rules become scoped instructions. Preserve the current release policy. |
| Agents complete reviewed source snapshot | `products/agents/` | Keep its backend package and UI package separate; preserve migrations and MCP package behavior. |
| Agency complete reviewed source snapshot | `products/agency/` | Include the reviewed portal conversion and partner identity work, not just the committed snapshot. |
| Labs `apps/`, `packages/`, `services/`, `infra/` | corresponding root directories | Import the selected Labs snapshot once; no parallel shared-package copies. |
| Labs scripts and `.railway/` | root platform scripts and `.railway/` | Resolve script-name collisions individually; preserve Collector deployment paths and tooling. |
| Repository-specific workflows | root `.github/workflows/` | Rename colliding workflows and update paths, checkout assumptions, caches and contexts. |
| Source READMEs, ADRs, runbooks and feature maps | product scope or platform `docs/` | Preserve distinct ADR histories and resolve relative links. Do not overwrite by basename. |
| Existing external shared-login, TypeScript and Agency plans | selected platform/product planning records | Inventory and explicitly move or link still-active records. Preserve superseded plans as history. |
| External `design/`, `designs/`, attached assets and experiments | individually reviewed | Not automatically included. Confirm ownership and distinguish source assets from generated output. |

Never flatten all READMEs, environment templates, `VERSION` files, or settings into one file.
Keep package names and existing service identifiers stable during relocation. Rename directories
only as mapped here; cosmetic renames inside products can follow separately.

## Product and workspace rules

- Products own their databases, migrations, memberships, sessions and business logic. Admin keeps
  its existing HTTP integrations. A shared login provider does not grant cross-product access.
- Shared packages expose explicit exports. Products must not import another product's private
  files or reach into its database. Add a dependency/import check to enforce this.
- Target one root pnpm workspace and lockfile for runtime apps and TypeScript packages. Use
  explicit package paths, including nested backend and frontend packages; exclude vendor trees,
  generated output and temporary import directories. Verify unique package names first.
- Use `workspace:*` for internal contracts and server support. Build their exported `dist` output
  before consumers. Preserve runtime dependency declarations and isolated production packaging.
- Keep current package names such as `@kasitek-labs/contracts` during this migration. Renaming the
  GitHub repository later must not implicitly rename package scopes or public MCP interfaces.
- Target the existing Node 24 and pnpm 10.30.1 baseline for application packages. Resolve exact
  patch pins against all packages before lockfile consolidation. Do not upgrade dependencies as
  incidental cleanup. Test frontend native install/build approvals explicitly.
- Documentation sites and Railway IaC may retain isolated installs initially. Inventory them as
  deliberate exceptions with frozen lockfiles and dedicated commands. The `.railway/` npm setup
  must not be forced into pnpm during an unrelated source move.
- Provide root commands to develop and verify each product separately and shared services on
  demand. Ordinary local development remains native. Collector's existing container-based CI is
  an explicit existing exception, not a reason to containerise the product development stack.

## Execution sequence and completion gates

Perform each slice only after its prerequisites pass. Each slice should have its own reviewable
commit or PR and verification record. Keep imports separate from dependency and runtime changes.

### 0. Preserve work and select source snapshots

1. Refresh remote refs read-only, inspect branches, open PRs, worktrees, tags and local-only commits.
   Audit Growth `main` versus `rewrite`; preserve any changes unique to either line. No force push,
   branch deletion, reset, or automatic promotion to `main`.
2. Save private Git bundles for all source refs and separately preserve tracked edits, deletions,
   and untracked source files. A Git bundle alone does not preserve the working tree. Verify the
   recovery copies can be restored in an isolated checkout.
3. Review and checkpoint the intended Agents, Agency and Growth edits in their source histories.
   Identify incomplete work explicitly. Do not commit everything indiscriminately or discard
   uncommitted changes to make an import easier.
4. Inventory ignored local settings, keys, databases, runtime directories and generated artifacts
   by path only. Keep necessary local recovery copies private and separate from source imports.
   Never commit credentials or copy `.git/`, `node_modules/`, `.env`, runtime state or builds.
   Inspect imported history for secrets as well as the current tree; stop an affected import for
   a deliberate remediation decision if sensitive history is found.
5. Record full source SHAs, source branches, selected worktree checkpoints, source mappings,
   backup locations and baseline verification in a private execution manifest. Capture baseline
   failures separately from migration regressions.

Gate: every intended source change has a recoverable checkpoint, all selected snapshots are
explicit, and recovery is tested. No source import may start while this remains uncertain.

Known baseline to recheck: Labs commit `cffa658` removed `assertNoDuplicateSerdeStructFields`,
while its JSON syntax test still imports it. The preceding session observed a successful build
and a failing test. Resolve the intended behavior in a separate reviewed fix before claiming a
green shared-package baseline; do not silence or remove the test to pass migration checks.

### 1. Establish the destination and relocate Growth

1. Use a clean isolated checkout rooted in the selected Growth `rewrite` snapshot. Leave the
   owner's active working directories available. Choose the integration branch under the current
   branch policy; preserve `main` and `rewrite` until their disposition is explicit.
2. Move Growth-owned source with Git moves into `products/growth/`. Separate root policies,
   platform release checks and root CI from product scripts and documentation sites.
3. Fix launch scripts, environment-file discovery, Prisma generation, TypeScript paths, UI builds,
   documentation source paths, route-fixture generation, fixture readers and local proxy paths.
4. Adapt current Growth workflows so the relocation alone remains verifiable before importing
   other products. Existing shared-artifact preparation may remain temporarily at this step.

Gate: Growth builds and its focused client/Core checks match the selected baseline. Root policy
and product instructions agree; no product behavior or database schema change is introduced.

### 2. Import Labs platform source and history

1. Import the reviewed Labs snapshot into a temporary prefix, preserving the original source
   commits as reachable ancestry through a non-squashed history merge. Then move selected paths
   to the target layout in a distinct relocation commit and remove the temporary prefix.
2. Apply the collision rules for platform docs, root config, scripts, CI, package settings,
   `.railway/` and root instructions. Record old-to-new paths and source SHA provenance.
3. Keep the existing shared package delivery working until the workspace replacement is ready.

Gate: source tree comparison matches the snapshot plus reviewed relocation edits. Full original
source SHAs remain reachable. Contracts, server support, Analytics, both sites, identity syntax
and Collector configuration receive focused checks. Do not squash away imported ancestry when
landing the import; agree a history-preserving merge method for the migration PRs.

### 3. Import Agents and Agency independently

1. Import each selected history through the same temporary-prefix method, with Agents and Agency
   in separate slices. Preserve original commit objects and record path provenance. Avoid
   rewriting or force-pushing any original repository.
2. Move source into `products/agents/` and `products/agency/`; carry product-specific config and
   instructions with it. Move workflows to the root with new path filters and working directories.
3. Repair root discovery, static asset locations, Vite proxies, portal serving/proxy behavior,
   Docker build contexts, environment resolution, migration readers and test fixture paths.
4. Preserve the current Agency Vite conversion and Agents working-tree features only through the
   reviewed checkpoints from phase 0. Do not reimplement them from old Growth copies.

Gate: each imported product matches its source manifest and passes its baseline build and
focused checks independently. No nested Git repository or unresolved temporary import remains.

### 4. Consolidate workspace dependencies and developer commands

1. Enumerate every package and its actual dependency edges. Include Growth database, Agency API
   client, Agents MCP/UI, Labs sites and Analytics. Resolve duplicate names and pnpm overrides.
2. Replace internal `.tgz` dependencies with workspace dependencies. Remove preparation scripts,
   pinned shared manifests and private source checkouts only after every consumer builds locally.
   Audit package `files`/exports and production packaging before retiring archive delivery.
3. Create the root workspace, lockfile, build ordering, filterable commands and explicit isolated
   tooling exceptions. Remove superseded lockfiles only as each install root is converted.
4. Check Prisma generation, code generators, migration assets, public files and static UI output
   from a clean clone. No build may rely on a sibling repository, old absolute path, or prebuilt
   `dist` left in the owner's machine.
5. Document each product's native development command, required dependencies, port allocation,
   environment template and health endpoint. Keep local secrets in product scope.

Gate: a clean root frozen install plus the documented exception installs can build every active
deployable. Root checks detect undeclared cross-product imports. Each product can be run alone
with only its documented runtime dependencies.

### 5. Rebuild affected checks and prepare deployment artifacts

1. Add CI selection for changed products and transitive consumers of shared packages. A change
   to contracts must test its consumers. Root lockfile/toolchain changes trigger the full relevant
   matrix; documentation-only changes use documentation checks.
2. Provide a stable aggregate required check so path filtering cannot leave branch protection
   waiting for a skipped workflow. Update required check names at cutover rather than assuming
   old checks cover the new paths.
3. Remove private Labs source token/checkouts from CI after workspace conversion is verified.
   Preserve necessary package publication separately for any confirmed external consumers.
4. Inventory live Vercel, Railway and other provider settings before modifying them. Record repo,
   branch, root directory, config path, build context, install/build/start command, watch paths,
   secret references, webhooks and previous artifact for every deployable.
5. Produce isolated artifacts for Growth Core/client, Agents API/gateway/workers/UI/MCP as
   applicable, Agency API/portal, Analytics API/workers, Admin, Labs website and Collector.
   Keycloak retains its own configuration and lifecycle. Do not bundle all services into one
   release or expose unrelated product secrets in a build context.

Gate for source consolidation: builds from a clean clone produce complete per-service artifacts. CI selection proves
that unrelated changes can skip safely and shared changes reach affected consumers. Hosted
configuration changes and deployments remain separately authorized actions.

### 6. Verify behavior and make Growth canonical

1. Update platform architecture, root/scoped agent instructions, local setup, feature-map links,
   release/runbooks and product docs. Mark old split instructions superseded; keep historical
   issues and ADRs intact with clear context. Inventory external active plans and repair links.
2. Confirm GitHub issues/Project items, ownership, permissions, branch rules and source links have
   one canonical home. Keep product acceptance criteria separate from this sequence.
3. Run the matrix below against isolated test data and dependencies. Compare the selected source
   baseline and destination behavior. Retain any pre-existing failure as an explicit blocker or
   reviewed exception; never report the whole migration green from build-only checks.
4. Freeze source edits briefly for final reconciliation. Incorporate commits made after the
   phase-0 snapshot or record an explicit freeze agreement. Verify no intended work is missing.
5. Review and land through the authorized Growth integration path, preserving imported history.
   Prepare staging artifacts first; change production source connections per service only after
   its rollout approval and smoke evidence. Keep previous tested artifacts available.
6. After source and hosted consumers have switched, mark old repos read-only or archive them only
   with explicit owner authorization. Keep local recovery copies until recovery is demonstrated.

Gate for source consolidation: one canonical development repository and branch, all selected
source and history preserved, and no required sibling checkout for builds. Growth hosting stays
on its existing source configuration. Fresh deployment of the other products is later work, not
a source-regrouping gate. Keep old repositories available as recovery copies until retired. Do
not delete them as part of this source-only request.

### 7. Repository rename completed

The owner explicitly requested `kastek` on 2026-10-15. The repository is now
`Kasitek-Labs/kastek`, with local folder `kastek`. Git origin and worktree metadata are updated;
old local paths are aliases for existing tools. Package scopes, service names, the `rewrite`
development branch, `main` and hosted settings are unchanged. The earlier proposed `kasitek`
spelling was superseded by the owner's exact requested name.

## Verification matrix

Use exact executable commands captured from the selected snapshots during phase 0, then record
their destination replacements in each PR. Do not treat these outcomes as completed checks.

| Area | Required evidence |
| --- | --- |
| Preservation | Restore bundles and working-tree checkpoints; compare selected source trees, file counts/hashes, reachable SHAs and path mapping. |
| Shared packages | Compile contracts/server support; focused JSON and contract checks; build all affected consumers against actual workspace output. |
| Growth | Core build/typecheck and targeted route/auth tests; generated route inventory parity; Prisma generation; client typecheck/build and sign-in/workspace path. |
| Agents | Backend and script typechecks, MCP build, relevant Vitest tests; UI typecheck/build/Studio tests; API health, gateway, worker and Growth bridge smoke. |
| Agency | API build and focused route/auth/partner tests; portal typecheck/build/server tests; partner login and workspace authorization denial. |
| Platform | Analytics build/registry and publisher smoke; Admin and Labs builds; Keycloak configuration validation plus selected login/logout checks. |
| Observability | Existing Collector config/redaction checks; telemetry arrival with service/release identities; API health with Collector unavailable. |
| Deployment | Per-service isolated artifact starts with its migrations/static assets; no sibling source or unrelated secrets; staging smoke and prior artifact recovery. |
| Documentation and CI | Both Growth documentation builds, moved links and instructions; dependency-aware CI selection, stable required checks and frozen installs. |

Database-backed and Temporal-backed checks use isolated resources. Source moves do not authorize
production migrations, sends, billing calls or live-user experiments. Preserve API paths, OIDC
callbacks, cookies, ports and service URLs unless a separately reviewed change requires otherwise.

## Rollback and release record

Before source cutover, rollback means abandoning the isolated migration checkout and restoring
the saved source checkpoints. Preserve the original repositories and local settings throughout.
After cutover, revert specific migration wiring commits or redeploy each service's previous tested
artifact and source connection. Do not hard-reset shared history or reverse unrelated product work.
No database migration is intended, so no data rollback should be necessary. Any discovered schema
change must be separated and governed by its own rollout and recovery plan.

| Release concern | Program decision |
| --- | --- |
| Change and owner | Source consolidation into Growth; Enoch owns approval and cutover. |
| Risk | High for preservation and delivery wiring; intended runtime behavior unchanged. |
| Affected surfaces | All listed products, shared packages, docs, identity/observability configuration and deployment automation. |
| Version and identity | Keep existing product/package versions during moves. Preserve Growth `VERSION` validation at platform scope; define product/artifact release mappings before cutover. Record source SHA, artifact digest and config revision per deployment. |
| API/schema changes | None intended. Preserve migration IDs, database ownership and externally visible contracts. |
| Rollout method | Sequential imports and verification, then independently authorized service cutovers. A feature flag is not applicable to file relocation. |
| Analytics | No new customer events. Verify existing producers and outboxes retain schemas, ownership and destination. |
| Logs and metrics | Preserve service names and release/correlation metadata; check Collector delivery and redaction. Observe health/errors/queue behavior during each cutover. |
| Documentation | Update root and scoped instructions, architecture, setup, feature-map links, CI/deployment runbooks and superseded source-split guidance in the relevant slice. |
| Validation | Phase gates and matrix above, with actual commands/results attached to each review. |
| Rollback | Recoverable source snapshots and per-service prior artifact/source configuration. |
| Post-release review | Set a dated owner review before cutover; check source dependencies, deploy failures, alerts and remaining consumers after each service switches. |

## Decisions to settle during execution

| Decision | Proposed default | Must be settled before |
| --- | --- | --- |
| Growth `main`/`rewrite` promotion | Preserve both; audit unique commits and use current `rewrite` as source. | Phase 1 |
| Active uncommitted product changes | Review and checkpoint complete intended working trees privately. | Any import |
| History import and merge policy | Non-squashed import with original commits as reachable parents and documented old paths. | Phase 2 |
| Exact workspace/tooling pins | Existing Node 24/pnpm 10.30.1 application baseline; documented isolated tooling exceptions. | Phase 4 |
| Existing baseline failures | Separate fix or explicit owner-reviewed exception with bounded impact. | Green verification claim |
| Hosting permissions and source-access scope | Verify live settings and retain least privilege per service. | Phase 5/cutover |
| External plans and design assets | Include only reviewed source and active canonical records. | Phase 6 |
| Repository rename and old repo retirement | Separate owner-authorized actions after successful cutover. | Phase 7/retirement |

## Planning verification and next step

This draft is based on local Git status/history, tracked manifests, workspace definitions, package
scripts, shared-artifact scripts, current workflows and Growth's architecture/release rules. A
read-only GitHub query found no open Growth issues; Project items returned earlier split work.
The initial planning checkpoint did not change source or hosting. Implementation is now published
in [draft PR 20](https://github.com/Kasitek-Labs/kastek/pull/20); the execution record below
identifies the completed local work and remaining cutover gates. No hosted settings have changed.

Execution update: source imports, workspace, local builds and all 15 GitHub checks have passed.
The preserved histories are merged into Growth `rewrite`, and the original Growth checkout
has been synchronized with the unified source.
The requested rename to `kastek` is complete. Deployment is deferred. See
[the execution record](docs/operations/monorepo-migration.md). Each
implementation issue should include its source/destination paths, prerequisite gate, exact
verification and recovery method. Keep issue cards assigned to `iamenochchirima` while working
solo. Do not treat the approved plan location as approval to merge, deploy, rename or archive.
