---
id: environments
title: Environments
sidebar_position: 4
owner: platform-ops
last_reviewed: 2026-08-26
---

# Environments

An environment is an isolated deployment context with its own configuration, credentials,
databases, queues, external integrations, and operational data. A GitHub Environment is a
deployment-control boundary; it does not create the runtime environment by itself.

## Environment roles

| Environment | Purpose | Data and credentials |
| --- | --- | --- |
| Local | Developer feedback and disposable integration tests | Local or explicitly non-production services only |
| Staging | Release candidate validation and smoke tests | Isolated staging databases, queues, domains, and provider credentials |
| Production | Customer traffic | Production-only credentials and data; deployment is gated |

Preview deployments can validate a branch or pull request, but they are not a substitute for a
shared staging environment when migrations, webhooks, queues, billing, or cross-service behavior
are involved.

## Staging requirements

Staging is ready only when it has:

- a stable deployment target and domain;
- separate databases and storage from production;
- separate credentials and webhook endpoints;
- the same service boundaries and required migrations as production;
- health, readiness, logs, metrics, and error visibility;
- a documented seed/reset strategy that cannot affect production;
- a release owner and an approval path;
- a tested route to promote the exact candidate artifact to production.

For observability, staging also requires a separate Collector service or process using the
staging private endpoint and staging-only variables. It must not share a production backend
credential or destination. The current repository profile uses the debug exporter for receipt and
context verification only; it does not provide durable retention. Use `OTEL_SERVICE_NAME`,
`OTEL_DEPLOYMENT_ENVIRONMENT=staging`, `KASITEK_VERSION`, `KASITEK_RELEASE_ID`,
`KASITEK_COMMIT_SHA`, and `KASITEK_ARTIFACT_DIGEST` as non-secret release metadata. Keep any
Collector transport or backend authentication in the GitHub/Railway staging secret store.

Configure GitHub's `staging` Environment with deployment rules and secrets only after the runtime
target exists. Selecting `main` as the allowed branch protects the deployment job; it does not
provision the server, database, domain, or service processes.

## Promotion rules

1. Build an immutable candidate from a reviewed commit.
2. Run migrations as an explicit job against staging.
3. Deploy the candidate to staging and run health, smoke, and release-specific checks.
4. Record the commit, platform version, artifact identifiers, migration result, and test evidence.
5. Promote the same artifact to production after approval.
6. Keep the previous artifact and migration rollback or forward-fix procedure available.

The current target release model is tracked in `docs/plans/active/CI_CD_RELEASE_PLAN.md` and the
canonical release identity is described in [Platform Versioning](./platform-versioning.md).
