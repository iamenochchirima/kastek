# Implementation Plans

This directory contains temporary execution material. Active plans are not part of the public
documentation site. Selected Agent Platform plans are intentionally mounted in the internal
Agent Platform plan UI for implementation review.

## Directories

- `active/`: work currently being implemented or verified.
- `agents/`: agent-platform architecture plans and research that are not currently being
  implemented.
- `analytics/`: analytics product, metric, and architecture plans and research that are not
  currently being implemented.
- `completed/`: plans whose work is complete or superseded, retained for history.
- `templates/`: reusable planning templates and execution formats.

## Plan lifecycle

An active plan should identify its owner, status, scope, target outcome, dependencies, and
verification evidence. When its work is complete:

1. Update the status and record the final evidence.
2. Link the current implementation or technical documentation.
3. Move the file into `completed/`.
4. Remove it from active navigation and references.

Exploration and research belong in a scoped planning directory such as `agents/` or `analytics/`.
Move the relevant execution plan and checklist into `active/` only when implementation is
approved and underway.

Do not add future product strategy, sales material, or roadmap content to this directory. Those
belong in a separately approved planning area or the legacy archive.
