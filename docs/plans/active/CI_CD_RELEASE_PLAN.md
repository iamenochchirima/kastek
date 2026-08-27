# KasiTek CI/CD and Release Plan

**Status:** Draft / Not started

**Owner:** KasiTek engineering

**Last updated:** 2026-08-24

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

## Staging account and credential inventory

This inventory describes what must exist before staging can exercise the real release path. It
does not contain secret values. Store deployment credentials in the GitHub Environment where the
workflow needs them, and store runtime application secrets in the staging host's secret manager.

### Environment boundary

| Environment | Provider resources | Webhook policy |
| --- | --- | --- |
| Production | Existing live resources and credentials | Production apps, bots, numbers, and callback URLs only |
| Staging | New test/sandbox resources and staging-scoped credentials | Stable staging callback URLs only |
| Local development | Local services, fixtures, replayed webhooks, or disposable test resources | A developer tunnel must never be the staging or production callback target |

For providers with one active webhook or callback, create a separate provider app, bot, number,
or subaccount for staging. Do not point one provider app at production, staging, and a local
tunnel at the same time.

### Core staging resources

- [ ] Create a separate staging host/project and service credentials for the client, Core,
      tenants, Agents API, Agents worker, and gateway.
- [ ] Create `staging.kasitek.co.za`, `staging-api.kasitek.co.za`, and any staging admin or
      gateway hostnames; configure DNS, TLS, CORS, cookies, and callback origins.
- [ ] Create separate Cloudflare tunnel/ingress credentials for staging. Keep the current
      development tunnel separate from both environments.
- [ ] Provision isolated staging databases and connection strings:
      `DATABASE_URL`, `KASITEK_TENANTS_DATABASE_URL`, `AGENTS_DATABASE_URL`, and
      `ANALYTICS_DATABASE_URL` where Analytics is enabled.
- [ ] Provision staging Redis and analytics Redis where enabled: `REDIS_URL` and
      `ANALYTICS_REDIS_URL`.
- [ ] Create a staging Temporal namespace, task queue, and API key. Do not reuse the production
      namespace or worker credentials.
- [ ] Create a staging media/object-storage bucket or volume and separate access credentials.
- [ ] Create separate staging logs, metrics, uptime checks, and error-reporting destinations.

### Staging-only generated secrets

Generate new values for staging; never copy production values:

- [ ] `AUTH_SECRET` / `SESSION_SECRET`
- [ ] `INTERNAL_AUTH_SECRET`
- [ ] `AGENTS_CREDENTIAL_ENCRYPTION_KEY`
- [ ] `SOCIAL_TOKEN_ENCRYPTION_KEY`
- [ ] `WHATSAPP_TOKEN_ENCRYPTION_KEY`
- [ ] `PUBLIC_WEBHOOK_ENCRYPTION_KEY`
- [ ] Agent installation and Core delegation signing keys
- [ ] `AGENT_GATEWAY_SHARED_SECRET` and Core-to-Agents internal tokens
- [ ] Analytics ingestion and metrics tokens
- [ ] `WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY`
- [ ] Separate staging MCP, REST, and Developer API keys

### Provider accounts and applications

#### Authentication and email

- [ ] Create a separate Google OAuth client for staging with staging origins and callbacks:
      `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (or the `AUTH_GOOGLE_*` aliases).
- [ ] Create a staging Resend API key and sender identity:
      `AUTH_RESEND_KEY`, `RESEND_FROM_EMAIL`, and, preferably, a staging mail subdomain.
      Staging mail must not use the production customer list.

#### Meta, WhatsApp, Instagram, and Threads

Meta callbacks and webhooks are app-specific. Create a separate staging Meta Developer app and
test assets, even if they live under the same Meta Business account:

- [ ] Staging Meta App ID and secret: `AUTH_META_APP_ID`, `AUTH_META_APP_SECRET`, and
      `NEXT_PUBLIC_META_APP_ID`.
- [ ] Staging embedded-signup configuration: `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID`.
- [ ] Staging webhook verification token: `AUTH_META_WEBHOOK_VERIFY_TOKEN`.
- [ ] Test WhatsApp Business Account, phone number, message templates, Facebook Page, and
      Instagram professional account.
- [ ] Staging OAuth, webhook, uninstall, and data-deletion callback URLs.
- [ ] If direct Instagram Login is enabled, create staging
      `AUTH_INSTAGRAM_APP_ID` / `AUTH_INSTAGRAM_APP_SECRET` credentials.
- [ ] If Threads is in the release scope, create a staging Threads app/test account with
      `AUTH_THREADS_APP_ID` / `AUTH_THREADS_APP_SECRET` and staging callbacks.

#### TikTok

- [ ] Create a separate TikTok Developer app for staging.
- [ ] Obtain `AUTH_TIKTOK_CLIENT_KEY` and `AUTH_TIKTOK_CLIENT_SECRET`.
- [ ] Register the staging OAuth callback and `/api/webhooks/tiktok` endpoint.
- [ ] Create or designate a staging creator/sandbox account and configure the required posting
      scope (`video.upload` for sandbox upload or `video.publish` for approved direct publishing).

#### Agent channels

- [ ] Create a staging Telegram bot from BotFather; configure its webhook through
      `TELEGRAM_WEBHOOK_BASE_URL`.
- [ ] Create a staging Discord application/bot and a staging test server. Keep its bot token and
      Gateway configuration separate from production.
- [ ] Use the staging channel connections in the dashboard; do not copy production channel
      credentials into the staging database.

#### Calls and billing

- [ ] If calls are in the release scope, create a Twilio staging subaccount or isolated test
      setup with a test number, API credentials, TwiML App, and staging voice/browser callbacks:
      `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`,
      `TWILIO_API_KEY_SECRET`, and `TWILIO_TWIML_APP_SID`.
- [ ] Use Paystack test mode only: `PAYSTACK_MODE=test`, `PAYSTACK_TEST_SECRET_KEY`, test
      customers, and a staging webhook URL. Do not use live payment credentials in staging.

#### Model and knowledge providers

- [ ] Create a staging-scoped or budget-limited model-provider key for the configured provider,
      normally `OPENROUTER_API_KEY` (or the corresponding OpenAI, Gemini, Anthropic, or other
      provider key).
- [ ] Create a staging-scoped Firecrawl API key and usage limit: `FIRECRAWL_API_KEY`.
- [ ] Revoke and replace any Firecrawl key that has been pasted into chat or another non-secret
      channel before putting the replacement into staging.

#### Optional social publishing providers

Create these only when the provider is part of the release test scope:

- [ ] LinkedIn staging app/test account: `AUTH_LINKEDIN_CLIENT_ID` and
      `AUTH_LINKEDIN_CLIENT_SECRET`.
- [ ] X staging app/test account: `AUTH_X_CLIENT_ID` and `AUTH_X_CLIENT_SECRET`.
- [ ] Bluesky staging OAuth key pair: `AUTH_BLUESKY_OAUTH_CLIENT_KEY_ID` and
      `AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY`.

### Local development policy

- [ ] Use webhook fixtures, replayed provider events, or disposable developer apps for local
      testing whenever possible.
- [ ] If a live local callback is required, create a disposable dev app/bot and dev tunnel; do
      not move the shared staging webhook back and forth.
- [ ] Keep staging and production data, provider tokens, encryption keys, payment credentials,
      and OAuth clients isolated.

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
