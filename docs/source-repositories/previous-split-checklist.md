# Repository split checklist

Work on one move at a time. Keep validation local and focused. Skip broad test suites.

## Done

- [x] Set `publish = false` for all five shared Rust crates in Labs and pin Agency to the private Labs Git tag. Labs PR #13.
- [x] Move the OpenTelemetry Collector source and deployment files to Labs; remove the duplicate Collector source from Growth while keeping Growth's telemetry producers. Labs PR #14 and Growth PR #12.
- [x] Keep the Labs website in Labs and remove its app, workspace entries, scripts, and docs from Growth. Growth PR #19.
- [x] Remove the Labs-owned Analytics service and shared crate copies from Growth; point Growth Core at the private Labs crate tag. Implemented on local Growth `rewrite` in commit `86740456`; `cargo metadata`, focused Core `cargo check`, shell syntax, and path checks passed. Not yet promoted to Growth `main`.
- [x] Remove the tenant API, portal, and portal-only React API client from Growth while keeping Admin's Agency HTTP integration. Confirmed in tracked Growth `rewrite`; focused Core and client lockfile checks passed earlier. Ignored local environment/build artifacts remain untouched.
- [x] Move the Agents backend, gateway, workers, migrations, and management UI into Agents; remove their implementation and launch wiring from Growth while keeping the product-side chat, client, and Core bridge. Consolidated changes are in Agents `main` at `69c1386`; the local build/typecheck passed before promotion.
- [x] Move the Admin UI into Labs; remove its Growth app, scripts, and workspace lock entries. Confirmed its old direct-Prisma message route had no in-repo caller, kept Core/Agency HTTP calls, and passed Admin typecheck/build before source removal.

## Remaining

### 3. Branch cleanup

- [x] Growth branch audit and cleanup: only `main` and `rewrite` remain locally and on the canonical remote; code changes were preserved in Growth or the Agents working tree.
- [x] Labs, Agency, and Agents branch audit; removed redundant canonical branches after checking where their commits survive.
- [x] Reduce canonical branches to `main` plus at most one active working branch: Growth 2, Labs 1, Agency 1, Agents 1.

Agency's source relocation, Agents' platform, and the consolidated Labs work are in `main`.
Growth's `rewrite` still holds work not promoted to `main`.

### 4. Promote one surviving branch at a time

- [x] Promote the Agents feature branch to `main` by fast-forward, then delete its redundant branch. Its API and UI Actions jobs failed before a runner started; local checks were used.
- [x] Merge Labs PR #15 into `main` after the user's explicit merge request; remove the now-merged feature branch. GitHub Actions could not start runners, so prior local checks were used.
- [x] Keep Growth work on `rewrite` as directed; both `main` and `rewrite` remain, with no extra branches.

Minimal checks:

- [x] Review branch-only commits before removal.
- [x] Confirm every retired branch's change survives in the owning repository's `main` or surviving active branch.
