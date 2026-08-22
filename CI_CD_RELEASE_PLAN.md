# KasiTek CI/CD and Release Plan

**Status:** Draft / Not started

**Owner:** KasiTek engineering

**Last updated:** 2026-08-22

## Objective

Establish a repeatable release process that validates changes in CI, deploys an isolated
staging system, and promotes the exact staging-tested release to production with approval,
health checks, migration safety, and rollback support.

Success means that a production release is traceable to a commit, uses environment-specific
configuration, can be observed during rollout, and can be rolled back to the previous
application artifact without guessing which code was deployed.

## Scope

### Included

- GitHub branch protection, environments, secrets, and Actions workflows.
- Staging and production infrastructure boundaries.
- CI for the Next.js client, Agents services, Rust services, database packages, and route checks.
- Deployment ordering, migrations, smoke tests, release metadata, and rollback.
- Domains, callback URLs, provider credentials, and operational readiness checks.

### Excluded

- Product feature work unrelated to release reliability.
- Replacing the current hosting provider without an explicit infrastructure decision.
- Creating a permanent `staging` or `develop` branch unless a later operating need justifies it.
- Moving application secrets into source control.

## Current repository context

- No `.github/workflows` deployment pipeline is currently checked in.
- The repository contains the Next.js client, Rust Core, Rust tenants service, Agents API,
  Agents worker, and Agents gateway.
- `scripts/run_local_stack.sh` starts the local multi-service stack and documents the service
  boundaries used during development.
- Node is pinned to `22.12.0` in `.nvmrc`; the Rust Core toolchain is pinned to `1.88.0`.
- Core exposes health endpoints, and Agents exposes `/health/live` and `/health/ready`.
- Agents has a Dockerfile; deployment definitions for the other production services still need
  to be made explicit.
- Database changes have more than one owner: Prisma migrations, Agents SQL migrations, and
  tenants migrations.
- Existing strategy documentation names Railway and GitHub Actions, but neither the hosting
  topology nor the Actions workflows are fully codified in this repository.

## Target release model

```text
feature/*
    │
    ▼
Pull request ── CI checks (no deployment secrets)
    │
    ▼
protected main
    │
    ▼
Build immutable release artifacts
    │
    ▼
Deploy staging ── migrations ── health checks ── smoke tests ── QA
    │
    ▼
Promote the same artifacts
    │
    ▼
Production approval ── deploy ── health checks ── smoke tests
```

Branches represent code changes. GitHub Environments represent deployment targets. Do not
introduce a long-lived staging branch for the initial release process.

GitHub Environments can hold environment-specific secrets, restrict deployment branches, record
deployment history, and require approval before a deployment job runs:

- [GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges/en-your-repository/managing-protected-branches)

## Configuration checklist

### 1. Hosting decision

- [ ] Confirm whether Railway is the staging and production target.
- [ ] Document the deployment method: host-native GitHub deployment or prebuilt artifact/image
      promotion.
- [ ] Define the service inventory and public/private boundaries for each environment.

If Railway is confirmed, create separate staging and production resources for the client, Core,
tenants, Agents API, Agents worker, and Agents gateway. Do not share databases, Redis, Temporal
namespaces, storage buckets, or provider credentials between environments.

### 2. GitHub repository settings

- [ ] Protect `main` and disable direct pushes.
- [ ] Require pull requests and required CI checks before merging.
- [ ] Dismiss stale approvals and require approval of the latest reviewable commit.
- [ ] Create the `staging` GitHub Environment.
- [ ] Create the `production` GitHub Environment.
- [ ] Restrict staging deployment jobs to `main`.
- [ ] Restrict production deployment jobs to approved release tags or `main`.
- [ ] Require a production reviewer during the initial launch period.
- [ ] Configure workflow permissions to default to read-only.
- [ ] Add workflow concurrency so a newer deployment cancels or supersedes an older pending
      deployment for the same environment.
- [ ] Add Dependabot or an equivalent dependency update process.

GitHub Environment secrets should contain deployment credentials and workflow-only values. Runtime
application secrets should remain in the hosting provider's environment secret store.

### 3. Environment resources

Create independent staging and production instances of:

- [ ] PostgreSQL.
- [ ] Redis or other queue/cache services.
- [ ] Temporal namespace and credentials.
- [ ] Media/object storage.
- [ ] Logs, metrics, and error-reporting destinations.
- [ ] Test and live provider integrations.

Staging must not use production customer data or live payment/provider credentials. If realistic
data is required, create a sanitized staging copy with an explicit refresh procedure.

### 4. Domains and external configuration

Choose and document stable domains, for example:

```text
staging.kasitek.co.za
staging-api.kasitek.co.za
app.kasitek.co.za
api.kasitek.co.za
```

- [ ] Configure DNS and TLS for each public service.
- [ ] Configure `FRONTEND_URL`, `ADMIN_FRONTEND_URL`, and API origins per environment.
- [ ] Configure session cookie, CORS, and allowed-origin rules.
- [ ] Register separate Google OAuth callback URLs.
- [ ] Register separate Meta webhook and embedded-signup URLs.
- [ ] Register separate Paystack webhook URLs and test/live keys.
- [ ] Register Telegram and Twilio webhook URLs where enabled.
- [ ] Configure the MCP and REST gateway URLs exposed to external clients.
- [ ] Keep the current development tunnel separate from the production ingress path.

### 5. Runtime configuration

Core production/staging configuration includes `ENVIRONMENT`, `DATABASE_URL`, `FRONTEND_URL`,
`ADMIN_FRONTEND_URL`, `SESSION_SECRET`, `AGENTS_API_URL`, internal authentication/delegation
keys, provider credentials, payment mode, and public API URL.

Agents production/staging configuration includes `NODE_ENV`, `AGENTS_DATABASE_URL`, Temporal
settings, `AUTH_MODE=hmac`, `INTERNAL_AUTH_SECRET`, model-provider credentials, installation
signing keys, credential encryption keys, Core URL, and Core delegation keys.

The client needs environment-specific API origins, application URL, access mode, Meta settings,
and external agent gateway URLs.

- [ ] Create a non-secret variable inventory for every deployable service.
- [ ] Create a secret inventory without recording secret values in this document.
- [ ] Verify production startup rejects missing security-critical values.
- [ ] Verify staging uses test credentials and a distinct Temporal namespace/task queue.

## Repository implementation plan

### Phase 1 — CI baseline

- [ ] Add `.github/workflows/ci.yml` for pull requests and pushes to `main`.
- [ ] Pin Node to `.nvmrc` and use the repository's pnpm version.
- [ ] Run `pnpm install --frozen-lockfile` for the client workspace.
- [ ] Generate Prisma clients before client builds.
- [ ] Run client lint, route checks, and production build.
- [ ] Install Agents dependencies with its lockfile.
- [ ] Run Agents tests, TypeScript build, and MCP build.
- [ ] Run Rust formatting, Clippy, and workspace tests with the pinned toolchain.
- [ ] Add migration validation against disposable test databases where practical.
- [ ] Upload useful build/test artifacts for failed runs.

### Phase 2 — Deployment definitions

- [ ] Add explicit build/deploy definitions for the client, Core, tenants, Agents API, worker,
      and gateway.
- [ ] Define health and readiness probes for every long-running service.
- [ ] Record the commit SHA and service version in deployed metadata/logs.
- [ ] Add deployment concurrency and timeout rules.

### Phase 3 — Staging deployment

- [ ] Add `.github/workflows/deploy-staging.yml` triggered after `main` passes CI.
- [ ] Build immutable artifacts tagged with the commit SHA.
- [ ] Run migrations in a dedicated, serialized migration job.
- [ ] Deploy services in dependency order.
- [ ] Wait for readiness endpoints before running smoke tests.
- [ ] Run critical staging flows: login, session persistence, dashboard load, Core API access,
      agent readiness, and one representative customer workflow.
- [ ] Publish the staging URL and deployment SHA to the GitHub deployment record.

### Phase 4 — Production promotion

- [ ] Add `.github/workflows/deploy-production.yml` with a protected `production` environment.
- [ ] Promote the exact staging-tested artifact rather than rebuilding from source.
- [ ] Require manual approval for the initial release period.
- [ ] Run backward-compatible migrations before application rollout.
- [ ] Deploy with a defined order and health-check gate.
- [ ] Run production smoke tests that do not mutate customer data unnecessarily.
- [ ] Record the release tag, commit SHA, migration versions, and operator approval.

### Phase 5 — Rollback and operations

- [ ] Keep the previous deployable artifact available for rollback.
- [ ] Document rollback commands and ownership for every service.
- [ ] Test rollback in staging.
- [ ] Test database backup restore in staging or a disposable environment.
- [ ] Define how failed migrations stop the rollout.
- [ ] Add uptime checks for public app/API/gateway endpoints.
- [ ] Add error tracking and alert routing for failed deploys, readiness failures, auth failures,
      queue/worker failures, and webhook failures.
- [ ] Add a release runbook and incident rollback runbook.

## Required migration rules

- [ ] Prisma migrations use the deployment-safe migration command, not development-only schema
      pushes.
- [ ] Agents SQL migrations run once with an explicit migration lock.
- [ ] Tenants migrations run as a controlled release step.
- [ ] Schema changes are backward-compatible with the previous application version during rollout.
- [ ] Destructive changes require a separate deprecation and data-retention decision.
- [ ] Every production migration has a backup/restore verification path.

## Verification gates

### Pull request gate

- [ ] Formatting, lint, type checks, tests, route checks, and builds pass.
- [ ] No secrets are exposed to untrusted pull-request jobs.
- [ ] Required status checks are green on the latest commit.

### Staging gate

- [ ] All services are healthy and report the expected release SHA.
- [ ] Migrations completed successfully.
- [ ] Authentication and session cookies work on the staging domain.
- [ ] Core-to-Agents authentication works.
- [ ] Temporal worker and gateway are ready.
- [ ] Critical smoke tests pass.
- [ ] Manual QA has a clear staging URL and release identifier.

### Production gate

- [ ] Production approval is recorded.
- [ ] The release matches the staging-tested artifact.
- [ ] Production migrations are complete.
- [ ] Health and smoke checks pass.
- [ ] Rollback artifact and operator are known before rollout.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Hosting | Is Railway the final staging and production host? | KasiTek engineering | Open |
| Deployment model | Host-native deployment or prebuilt artifact/image promotion? | KasiTek engineering | Open |
| Domains | What are the final staging, API, admin, and gateway hostnames? | KasiTek engineering | Open |
| Production approval | Who approves the initial production deployments? | KasiTek engineering | Open |
| Preview environments | Do PRs need isolated pre-merge environments? | KasiTek engineering | Deferred |
| Observability | Which error tracking, uptime, and alerting providers will be used? | KasiTek engineering | Open |

## Immediate next action

When release work resumes:

1. Confirm the hosting target and service topology.
2. Create staging and production resources with separate data/integration boundaries.
3. Protect `main` and create the GitHub Environments.
4. Record environment URLs and variable names without recording secret values.
5. Implement Phase 1 CI before adding deployment workflows.

Do not merge deployment automation until staging can be deployed, health-checked, smoke-tested,
and rolled back using a known release artifact.
