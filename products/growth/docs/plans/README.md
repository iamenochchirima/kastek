# Implementation Plans

This directory retains planning material and reusable templates. GitHub Issues track current
work; pull requests carry the implementation and verification record. A separate durable plan is
optional for a multi-PR program with dependencies, not the default task queue.

## Directories

- `active/`: redirect notice only; do not start new work from old plan files.
- `parked/`: preserved plans removed from the working queue. Their contents are historical until
  explicitly reviewed and reactivated.
- `analytics/`: analytics product, metric, and architecture plans and research that are not
  currently being implemented.
- `completed/`: plans whose work is complete or superseded, retained for history.
- `templates/`: reusable planning templates and execution formats.

## Working convention

For ordinary work, use the issue for scope and a short checklist during implementation. Record
the final behavior, tests, and remaining gaps in the pull request. When a multi-PR program needs
a durable plan, link it from the tracking issue and identify ownership, status, dependencies,
and verification evidence. When that program is complete:

1. Update the status and record the final evidence.
2. Link the current implementation or technical documentation.
3. Move the file into `completed/`.
4. Remove stale navigation and references.

Exploration and research belong in the owning product's Stash project or a scoped Growth planning
directory such as `analytics/`. The current Agents architecture and implementation plan live in
the Kasitek Agents Stash project. The repository keeps the [architecture summary](../../../agents/docs/architecture/agent-platform-architecture.md)
and [implementation status](../../../agents/docs/source-boundary.md).
Do not move a parked plan back into active use simply because a related task resumes; reconcile
it with the current issue and code first.

Do not add future product strategy, sales material, or roadmap content to this directory. Those
belong in a separately approved planning area or the legacy archive.
