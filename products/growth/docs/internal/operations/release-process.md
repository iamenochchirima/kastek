---
id: release-process
title: Feature and Platform Release Process
sidebar_position: 2
owner: platform-ops
last_reviewed: 2026-09-29
---

# Feature and Platform Release Process

This is the canonical process for deciding whether a feature or platform change is ready to
release. It covers product changes, APIs, database changes, integrations, background workers, and
operational changes.

`docs/archive/deferred-plans/CI_CD_RELEASE_PLAN.md` remains the implementation backlog for CI/CD, environments, deployment,
and rollback automation. This document defines what a release must contain; it does not claim that
the automation already exists.

## Release record

Every non-trivial change should have these fields in its pull request, feature plan, or release
record:

```text
Change:
Owner:
Risk: low | standard | high
Affected services and user surfaces:
Platform release version or release ID:
API/schema/migration changes:
Feature flag or rollout method:
Analytics events and success metrics:
Logs, metrics, dashboards, and alerts:
User, API, internal, and operational documentation:
Validation evidence:
Rollback or disable plan:
Post-release review date:
```

For a small change, explicitly write `not applicable` rather than leaving a release concern
unreviewed.

## Required lifecycle

### 1. Plan

- [ ] Define the user or operational outcome and the owner.
- [ ] Classify the risk and identify affected services, data, integrations, and permissions.
- [ ] Define success metrics, failure signals, rollout scope, and rollback conditions.
- [ ] Decide whether a feature flag, migration, compatibility period, or support communication is
      required.

### 2. Build

- [ ] Implement the change with unit, integration, or end-to-end coverage appropriate to its risk.
- [ ] Review API, database, queue, provider, and configuration changes for backward compatibility.
- [ ] Validate authorization, privacy, error handling, accessibility, and responsive behavior where
      relevant.
- [ ] Add migrations as controlled, repeatable release steps. Avoid destructive changes in the
      same release as the code that first stops using the old data.

### 3. Measure and observe

- [ ] Define analytics events for meaningful user outcomes, with an owner and a documented schema.
- [ ] Reuse the Analytics contract and registry system instead of adding undocumented event names.
- [ ] Add structured logs for important lifecycle events, failures, retries, and external calls.
- [ ] Include enough context to investigate the event: service, environment, release, request or
      correlation ID, route or job, outcome, and bounded error code.
- [ ] Confirm that logs do not contain credentials, tokens, full message bodies, or unnecessary
      personal data.
- [ ] Add or update dashboards, alerts, and runbooks when the change creates a new failure mode.

For server-side observability changes, the release record must also identify the Collector
configuration revision, OTLP endpoint environment, service/release identity, signal validation,
redaction evidence, and exporter-disable or rollback action. A debug exporter is verification-only
and does not satisfy production retention or alerting requirements.

### 4. Document

- [ ] Update public documentation for user-visible behavior that is actually available.
- [ ] Update API or integration documentation for contract changes.
- [ ] Update internal architecture, configuration, migration, or operational runbooks as needed.
- [ ] Add release notes or a changelog entry for customer-visible changes.
- [ ] Mark temporary, preview, or unsupported behavior clearly and assign a review or removal date.

### 5. Identify and version

- [ ] Record the platform release version or release ID.
- [ ] Record the commit SHA, service artifact versions, migration versions, and configuration
      revision used for deployment.
- [ ] Use SemVer for the platform release: patch for compatible fixes, minor for compatible
      features, and major for breaking changes.
- [ ] Keep platform release versions separate from API contract versions, database migration
      versions, protocol versions, and customer-created agent versions.
- [ ] Do not call a package's default `0.1.0` value a production platform release until the
      release identity and tag are defined.

### 6. Release and verify

- [ ] Run the relevant lint, type, test, build, migration, and smoke checks.
- [ ] Deploy to staging or an equivalent isolated environment when the change is standard or
      high risk.
- [ ] Verify health, readiness, authentication, integrations, analytics delivery, and logs using
      the release identifier.
- [ ] Promote the exact tested artifact to production rather than rebuilding from an untracked
      source state.
- [ ] Roll out gradually when the feature or failure mode justifies it.

### 7. Close

- [ ] Monitor adoption, errors, latency, queues, provider responses, and support reports after
      release.
- [ ] Compare results with the success criteria and record any follow-up work.
- [ ] Remove temporary flags, compatibility code, and one-off instrumentation when their removal
      conditions are met.
- [ ] Update the documentation or release record with the final outcome.

## Repository enforcement

The process becomes reliable when it is enforced at several levels:

1. `AGENTS.md` requires agents to read this process and account for release impact in their plan.
2. The pull request author records release impact and an explicit `not applicable` decision
   where a concern does not apply. No repository PR template currently enforces this.
3. CI should validate the mechanical parts: tests and builds, analytics registry changes,
   migration safety, documentation links, version metadata, and release artifact identity.
4. Branch protection and code ownership should require the appropriate engineering, product,
   data, and operations review for higher-risk changes.
5. A release owner should approve the staging and production gates and remain responsible for the
   post-release review.

The checklist is a decision record, not a reason to require a full production ceremony for a
one-line copy change. Risk determines how much evidence is required.

## Current repository baseline

This snapshot records the gaps that need follow-up work:

| Area | Existing foundation | Missing or incomplete |
| --- | --- | --- |
| Release process | `docs/archive/deferred-plans/CI_CD_RELEASE_PLAN.md` contains a detailed target CI/CD and deployment model. | It is still marked draft/not started, and there is no general PR release gate. |
| Platform versioning | The canonical `VERSION` file, read-only validator, and CI tag check now exist; Agent versions are also a product-domain concept. | Release tags, runtime version metadata, artifact manifests, and promotion/rollback automation are still missing. |
| Logging | Growth, Agency, and Labs Analytics use server-side OpenTelemetry and Collector profiles. The Agents reset emits bounded structured stdout; its previous exporters were removed with the inherited runtime. | A durable destination, retention, access control, dashboards, alerts, and hosted staging evidence are still missing; browser telemetry remains out of scope. |
| Analytics | Labs owns the Analytics service contracts, registries, and metrics; Growth retains product-owned event producers and outboxes. | Feature work is not required to declare its events and success metrics, and analytics readiness is not a general release gate. |
| Documentation | Public and internal Docusaurus sites now have separated current source trees, plan/archive boundaries, source-of-truth rules, and generated-output cleanup. | Per-document owner/review metadata and the remaining content-by-content stale-document audit still need to be completed. |
| CI/CD | Growth's Analytics-specific workflow was removed with Analytics source ownership; workflows remain repository-specific. | Cross-repository CI, staging deployment, production promotion, release metadata, and tested rollback workflows are not checked in. |
| Rollout | The CI/CD plan describes desired staging, approval, and rollback behavior. | There is no shared feature-flag, canary, rollback, or post-release monitoring standard implemented across services. |

## Recommended follow-up order

1. Create the first staging-tested platform release tag and add runtime release metadata, then add
   a canonical artifact manifest.
2. Complete the hosted staging evidence for the OpenTelemetry foundation, then choose log storage,
   retention, dashboards, and alerts in a provider-specific plan.
3. Make analytics part of the feature definition of done by requiring event contracts, metric
   ownership, privacy review, and a dashboard or query for important outcomes.
4. Rebuild documentation as a separate workstream: inventory every source document, mark each as
   canonical, active, superseded, or archived, assign owners, remove tracked generated output,
   and add link/build checks.
5. Implement the CI/CD phases in `docs/archive/deferred-plans/CI_CD_RELEASE_PLAN.md`, starting with general pull-request CI
   before deployment automation.

Do not solve the documentation rewrite, observability implementation, and deployment automation
as one undifferentiated feature. The release process should govern those workstreams while each
has its own implementation plan and verification evidence.
