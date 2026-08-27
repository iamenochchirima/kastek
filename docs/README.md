# KasiTek Documentation

The repository separates current technical documentation, public product documentation, temporary
plans, and historical material.

## Documentation areas

- [`public/`](public/): user-facing and public developer documentation.
- [`internal/`](internal/): current architecture, development, operations, contracts, and runbooks.
- [`plans/`](plans/): active and completed implementation plans and checklists.
- [`archive/`](archive/): retained historical material that is not an active source of truth.

## Source-of-truth rules

- Current system behavior belongs in `internal/` or `public/`, depending on the audience.
- A plan must not be used as a substitute for technical documentation.
- A completed plan records historical execution; it does not define current behavior.
- Public documentation describes supported behavior only. Planned or placeholder behavior belongs in
  `plans/` or `archive/`.
- Generated Docusaurus output is build output, not documentation source.

Feature work should update the relevant living documentation in the same pull request whenever the
feature changes user behavior, APIs, data contracts, operations, or developer workflow.
