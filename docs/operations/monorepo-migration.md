# Monorepo migration execution record

Updated 2026-10-15. Source migration is implemented on `codex/monorepo-migration` in a Growth
worktree. This record does not establish hosted cutover or permission to delete old repositories.

## Preserved source

Growth, Agents, Agency, Labs and the discovered Designs repository were saved as private Git
bundles and source-working-tree archives before imports. Each bundle was verified and its selected
snapshot fetched into a bare recovery repository; restored tree IDs matched. Ignored local
settings have separate private recovery archives. Secrets and runtime state were not imported.
The original working directories and their uncommitted changes remain untouched.

All original HEADs and selected snapshot commits remain reachable through non-squashed imports.
[Provenance](../source-repositories/imports.json) lists full SHAs and original file counts. Growth
`rewrite` contains its `main` history. The source-accounting check accounts for every selected
file; retired files are old lockfiles, nested workspace declarations and archive-preparation
metadata superseded by the root workspace. Current path and build edits are reviewable in Git.

The non-Git workspace `plans` records were copied to `docs/programs`, original design references
to `designs/source-references`, and the old split checklist to `docs/source-repositories`.

## Dependency reconciliation

Existing lockfile resolutions were merged before installing the root workspace. Internal contracts
and server support now resolve through `workspace:*`; consumers no longer build archives from
sibling checkouts. Nested application workspaces/lockfiles are removed. Documentation sites retain
isolated Node 22 frozen installs with `--ignore-workspace`; Railway IaC retains npm.

The merged graph exposed incompatible React types, PostgreSQL types and Fastify declarations.
Root overrides align React types to 19.2.14/19.2.3, PostgreSQL types to 8.23.1 and Fastify to 5.12.5.
Fastify 5.12.5 was already selected by Growth and Agency; this updates Agents from its locked
5.11.3 within its declared compatible range. Shared and product builds passed after alignment.
Existing third-party peer-range warnings remain visible during installation.

A separate prerequisite fix restores the exact removed shared duplicate-JSON-field validator.
Growth, Agency and Analytics call this export. Its original tests and API checks are retained.

## Verification

Evidence is saved locally under ignored `.audit/`, including the decision trail
`.audit/monorepo-migration.tsv`, source-accounting report and full build/test logs.

| Check | Result |
| --- | --- |
| Root workspace install | Passed; final frozen install confirmed lockfile consistency |
| Internal and public documentation sites | Both isolated Node 22 production builds passed |
| Shared contracts and server support builds | Passed |
| Growth Core, Agents, Agency and Analytics backend builds | Passed |
| Growth, Agents, Agency, Admin and Labs frontend production builds | Passed, including TypeScript checks |
| Growth route check | Passed; 45 Growth pages generated |
| Shared tests | 24 passed; 1 database check skipped |
| Growth broader no-database suite plus focused relocation reruns | 110 passed; 59 skipped; 4 existing failures |
| Agency broader no-database suite | 11 passed; 13 skipped; 3 existing failures |
| Analytics broader suite plus import rerun | 23 passed; 15 skipped; no remaining failures |
| Agents descriptor and MCP checks | 7 passed |
| Agents Studio/stream and Agency portal-server checks | Passed |
| Isolated Agents production package | Passed; local dependency imports, worker/API/gateway entrypoints and 175 SQL migrations present |
| Workflow YAML and affected-selection cases | Passed |
| Product import checks | Passed; negative checks reject side-effect imports and private package dependencies |
| Native login, database and hosted end-to-end paths | Not accepted by build-only checks; isolated runtime verification remains outstanding |
| Docker image build/start | Not run; Docker daemon unavailable |

All seven remaining Growth/Agency functional test failures were reproduced on the untouched
original sources. Growth's four failures use mocks without `request.routeOptions`; Agency's
three concern route-fixture coverage, transport status and JSON authentication status. These are
existing product issues, not waived green checks. Original and migrated outputs are recorded in
`.audit/verification-baseline-failures.log` and `.audit/verification-builds.log`.

Prisma generation is required before building Growth. It exposes source-schema/generated-client
drift already present at the source snapshot. Verification-generated files were restored after
builds so this migration does not silently include unrelated generated changes.

## Release and cutover state

No customer behavior, API route, schema migration ID, cookie scope, event schema, database
ownership or production service name was intentionally changed. Existing platform VERSION remains
at the root; per-product source, secrets and deployment lifecycles remain independent. Rollout is
per-service, using the exact verified artifact and its recorded configuration revision. New customer
analytics events and feature flags are not applicable to source relocation.

See [hosting cutover](hosting-cutover.md) for provider inventory and recovery requirements.
The current Vercel token was rejected with HTTP 403; the accessible Railway account did not list
the KasiTek projects. No hosted settings were changed. Required-check protection, source
connections, runtime credentials and provider webhook/OIDC bindings still require live inventory.

Do not delete or archive the old repositories now. Complete provider access, source publication,
required-check configuration, isolated runtime/staging acceptance, per-service cutover and final
source reconciliation first. Keep old deployment artifacts and private recovery bundles available.
Repository rename remains a later separately controlled step.

## Independent evidence review

A separate agent reviewed ancestry, tree IDs, original private hash manifests, workspace settings,
CI and source accounting. It found incomplete import checks and relocated documentation command
and ignore rules; these were fixed and rechecked. No further material structural blocker was
reported. This was an evidence review, not live product or hosted acceptance. The local decision
trail was checked against tool output and saved artifacts rather than an inaccessible transcript.
