---
id: documentation-maintenance
title: Documentation Maintenance
sidebar_position: 6
owner: engineering
last_reviewed: 2026-09-28
---

# Documentation Maintenance

Documentation is part of the feature, API, migration, and operational change. The source file is
the record; generated site output is disposable build output and must not be committed.

## Ownership

| Record | Default owner | Update trigger |
| --- | --- | --- |
| GitHub Issue and [Growth Project](../../agents/issue-tracker.md) | Issue proposer for requirements; `iamenochchirima` for approval and assignee; implementer for progress | Scope, acceptance criteria, dependency, blocker, assignee, or work state changes. Only the owner approves `Ready`. Reconcile the issue and Project after merge. |
| Pull request | Implementer | Every implementation change: link the issue when one exists, state affected and unaffected records, and attach verification evidence. Review and release decisions stay with the PR. |
| `docs/features/README.md` | Engineering owner of the user-facing feature | Shipped behavior, entry point, or verification path changes. Record current behavior, not a proposed feature. |
| `ARCHITECTURE.md` and `docs/internal/architecture/` | Engineering owner of the affected system | Component boundary, data ownership, security, or integration design changes |
| `docs/internal/development/` | Engineering owner of the development workflow | Toolchain, repository layout, local setup, or verification command changes |
| `CONTEXT.md` | Product/domain owner | The owner settles a domain term or changes its meaning; do not add guessed vocabulary |
| `docs/adr/` | Decision owner | A hard-to-reverse architectural decision needs its context and trade-off recorded |
| `docs/public/` | Engineering owner of the supported user or API surface | User behavior, public configuration, or public contract changes |
| `docs/internal/operations/` | Release or platform owner | Environment, release, versioning, observability, or deployment changes |
| `docs/internal/runbooks/` | Service owner or on-call owner | Incident procedure, dependency, credential, migration, or recovery changes |
| `docs/internal/contracts/` | Owning service team | API, event, webhook, MCP, or integration contract changes |
| Approved multi-PR program plan, when one exists | Program owner | A dependency, scope, or verification rule changes; move it to `docs/plans/completed/` when finished. Ordinary task progress belongs in the issue and PR. |

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

- issue requirements or blockers and Project work status;
- current feature-map behavior, entry points, and verification paths;
- architecture, domain terms, and ADRs;
- public behavior or API documentation;
- internal architecture or developer workflow;
- migration and contract documentation;
- analytics event and metric documentation;
- logging, metrics, dashboards, alerts, and runbooks;
- release notes and version metadata.

Write `not applicable` when the area genuinely does not apply. Do not leave it blank.
Link the updated records and give evidence for claims about running behavior. If an existing
record contradicts the code or cannot be verified, identify the gap before requesting review.
Do not silently rewrite approved requirements to fit an implementation.

## Canonical-source rules

- Current technical behavior belongs in `docs/internal/` or `docs/public/docs/`.
- Current user-facing paths and verification starting points belong in the single feature map at
  `docs/features/README.md`.
- Requirements and blockers belong in the GitHub Issue. Approval, assignee, and work status
  belong in the Growth Project. The PR holds implementation and verification evidence.
- Task execution detail belongs in the issue or pull request. Use a separate program plan only
  for dependent work spanning several changes.
- Completed plans belong in `docs/plans/completed/`.
- Historical, superseded, strategy, roadmap, and go-to-market material belongs in
  `docs/archive/legacy/` unless it is deliberately re-approved as a current technical reference.
- Do not link live documentation to an archived plan as if it were a current source of truth.

The documentation build workflow attempts to build both Docusaurus sites when documentation or
documentation policy changes. It does not check whether prose matches product behavior. The
release process defines the change rule, but no repository PR template or records-freshness CI
check currently enforces it. The owning service still supplies the technical content and evidence.
