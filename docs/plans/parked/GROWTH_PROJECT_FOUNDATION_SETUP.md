# Growth project foundation setup

> Parked on 2026-09-28. This document is preserved for reference, not an active execution queue.
> The GitHub Project access gap recorded below still needs an explicit follow-up.

**Status:** Parked (previously Active)

**Owner:** Engineering

**Last updated:** 2026-09-28

## Objective

Set up the project instructions, reference documents, skills, and issue-tracking entry points
needed for agents to work on KasiTek Growth without depending on this playbook or guessing which
legacy document is authoritative. Success means a fresh agent can find the current repo map,
coding standards, feature map, local development guide, installed workflow skills, and approved
issue-tracking process.

## Scope

### Included

- Keep the owner-requested root `CONTEXT.md` empty until domain language is agreed.
- Add a current `ARCHITECTURE.md`, `CODING_STANDARDS.md`, `docs/adr/README.md`,
  `docs/features/README.md`, and `docs/agents/issue-tracker.md`.
- Update the root `README.md` and `AGENTS.md` with the new product direction and direct links.
- Install only the selected project-local skills: `enoch-mode`, `show-me-your-work`,
  `code-review`, `to-spec`, and `to-tickets`. Do not install `triage` or `retro`.
- Configure the Growth GitHub Project and issue workflow only where current permissions and
  already-approved decisions allow it. Reuse an existing suitable Project.
- Verify the files and skill discovery paths, and record any remaining external setup blocker.

### Excluded

- Moving or deleting any application, service, package, documentation, or data.
- Rewriting, reconciling, or cleaning up existing legacy documentation.
- Changing product runtime behavior, APIs, schemas, analytics, telemetry, deployments, or
  credentials.
- Creating a new organization-owned GitHub Project before checking for an existing Growth board.
- Changing existing label meanings or marking issues Ready as part of setup.

## Context and constraints

- The repository is currently a monorepo with multiple client apps, Agent Platform code, and
  several server services. Its intended direction is a standalone Growth product, with other
  product components extracted in later, separately approved work.
- Current code locations can be documented as observed facts. Final product ownership for
  transitional areas must be marked unresolved rather than inferred.
- The root `CONTEXT.md` was cleared at the owner's direction. Do not repopulate it with generic
  terminology or implementation notes.
- Existing development and release guides remain in place. This setup links to them rather than
  duplicating or rewriting them.
- GitHub Issues are the selected work-item tracker. The CLI currently lacks the Project scope, so
  organization Project inspection and updates may require an authentication refresh.

## Implementation plan

1. [x] Inspect the root instructions, release process, planning template, project layout, and
   selected playbook practices.
2. [x] Add the foundation documents and update the root README and AGENTS.md without changing
   existing application code or legacy docs.
3. [x] Install the selected skills at project scope and inspect their copied files and references.
4. [ ] Inspect the Growth GitHub Project and issue workflow. Apply only changes already within
   the owner's approved scope; record decisions still requiring the owner.
5. [x] Verify local links, skill discovery, route/source references, and setup completeness.
   Keep the unresolved Project permission and fresh-session check visible below.

## Verification

- [x] Confirm every linked setup document exists and every internal Markdown link resolves:
  30 local links checked across the setup documents.
- [x] Confirm `CONTEXT.md` remains zero-length (`wc -c` returned `0`).
- [x] Confirm Codex discovers each selected project skill and each copied skill has its required
  references and scripts: five project skills discovered; 14 local links checked across their
  Markdown files.
- [x] Confirm the feature map points to real routes and the current local development guide:
  checked the representative client route files/directories and the guide link.
- [ ] Confirm the issue tracker file documents the actual GitHub repository, Project URL/statuses,
  and only verified commands and permissions. The Project URL/statuses still need Project access.
- [x] Confirm the exact `ready-for-agent` label exists without changing any current issue.
- [ ] From a fresh agent context, confirm `AGENTS.md` routes the agent to these files without this
  playbook. Record any fresh-session check that cannot be performed here.
- [x] Runtime, API/schema, analytics, structured logging, dashboards/alerts, release version,
  rollout, and rollback: not applicable. This is documentation and project-local agent setup;
  it changes no deployed behavior.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Product scope | Treat this repo as the future Growth product; defer extraction of other code to separately approved work. | Project owner | Agreed direction |
| Domain context | Keep root `CONTEXT.md` empty until the owner establishes project terminology. | Project owner | Agreed |
| Work tracker | Use GitHub Issues and GitHub Projects for Growth work. | Project owner | Tracker selected; Project setup pending inspection/permission |
| Ready label | Created the exact label required by the selected `to-spec` and `to-tickets` skills. An issue still requires the owner-approved Project `Ready` state to start implementation. | Engineering | Complete |
| Project board | Reuse an existing Growth board; if none exists, confirm before creating an organization-owned Project. | Project owner | Pending Project access and inventory |

## Release record

```text
Change: Project foundation and agent workflow setup
Owner: Engineering
Risk: low
Affected services and user surfaces: Repository documentation and project-local agent skills only
Platform release version or release ID: not applicable
API/schema/migration changes: not applicable
Feature flag or rollout method: not applicable
Analytics events and success metrics: not applicable
Logs, metrics, dashboards, and alerts: not applicable
User, API, internal, and operational documentation: README.md, AGENTS.md, ARCHITECTURE.md,
  CODING_STANDARDS.md, docs/adr/README.md, docs/features/README.md,
  docs/agents/issue-tracker.md
Validation evidence: 30 setup-document links and 14 copied-skill links resolve; five skills
  discovered by the Skills CLI; representative feature-map route paths exist; CONTEXT.md is empty;
  ready-for-agent label and existing issue inventory confirmed with gh. Project and fresh-session
  checks remain pending.
Rollback or disable plan: Revert this setup change; no runtime or data changes are made
Post-release review date: not applicable
```

## Notes and blockers

- The current `gh` token does not include `read:project` or `project`. On 2026-09-28,
  `gh project list --owner Kasitek-Labs --format json` failed with a missing `read:project`
  scope. Project inventory and configuration cannot be verified until access is available.
- The exact `ready-for-agent` label now exists. Issue #2 was left unlabeled.
- Project-local skill sources are pinned in `docs/agents/skill-sources.md`: Enoch's skills at
  `d7788e4bfa3cff880b43cc236b0523a800a62586` and Matt Pocock's skills at
  `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`.
- The Skills CLI has not yet been verified to support the selected `code-review` skill's
  parallel sub-agent workflow in this agent environment. Do not claim that review execution has
  been tested merely because the skill is installed.
