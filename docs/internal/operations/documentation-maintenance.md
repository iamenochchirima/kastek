---
id: documentation-maintenance
title: Documentation Maintenance
sidebar_position: 6
owner: engineering
last_reviewed: 2026-08-25
---

# Documentation Maintenance

Documentation is part of the feature, API, migration, and operational change. The source file is
the record; generated site output is disposable build output and must not be committed.

## Ownership

| Area | Default owner | Review trigger |
| --- | --- | --- |
| `docs/public/` | Engineering owner of the supported user or API surface | User behavior, public configuration, or public contract changes |
| `docs/internal/architecture/` | Engineering | Runtime boundary, data ownership, security, or integration design changes |
| `docs/internal/development/` | Engineering | Toolchain, repository layout, local setup, or developer workflow changes |
| `docs/internal/operations/` | Release or platform owner | Environment, release, versioning, observability, or deployment changes |
| `docs/internal/runbooks/` | Service owner or on-call owner | Incident procedure, dependency, credential, migration, or recovery changes |
| `docs/internal/contracts/` | Owning service team | API, event, webhook, MCP, or integration contract changes |
| `docs/plans/` | Plan owner | Every implementation update; move to `completed/` when finished |

If a document has no obvious owner, assign one before merging the change. A team or service name
is sufficient; a person is not required.

## Freshness

- Review public behavior and API references whenever the supported behavior changes.
- Review operational runbooks after every incident, migration, provider change, or deployment
  change.
- Review architecture and development references when their referenced boundary or workflow
  changes, and at least every six months while active.
- Review release, versioning, and environment references at least quarterly while the release
  system is changing.
- Add a `last_reviewed` date and owner to a document when it is created or materially updated.
- A review confirms that the document is still correct; it does not mean every future plan is
  complete.

## Change rule

For every non-trivial feature or platform change, the pull request must make an explicit decision
for each applicable area:

- public behavior or API documentation;
- internal architecture or developer workflow;
- migration and contract documentation;
- analytics event and metric documentation;
- logging, metrics, dashboards, alerts, and runbooks;
- release notes and version metadata.

Write `not applicable` when the area genuinely does not apply. Do not leave it blank.

## Canonical-source rules

- Current technical behavior belongs in `docs/internal/` or `docs/public/docs/`.
- Temporary execution detail belongs in `docs/plans/active/`.
- Completed plans belong in `docs/plans/completed/`.
- Historical, superseded, strategy, roadmap, and go-to-market material belongs in
  `docs/archive/legacy/` unless it is deliberately re-approved as a current technical reference.
- Do not link live documentation to an archived plan as if it were a current source of truth.

The documentation build workflow validates both Docusaurus sites on changes to documentation or
documentation policy. The pull request template and the release process enforce the change rule;
the owning service still supplies the technical content and evidence.
