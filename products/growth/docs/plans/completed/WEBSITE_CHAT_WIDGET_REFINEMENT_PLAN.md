---
title: Website Chat widget refinement
status: Complete
owner: KasiTek frontend and Core
last_updated: 2026-08-31
---

# Website Chat widget refinement

## Objective

Give the embedded Website Chat a polished, recognizable chat layout that works well on
desktop and small screens, while keeping the existing appearance settings and message/audio
transport compatible.

## Scope

### Included

- Rework the Core-rendered widget header, message area, composer, footer, and launcher.
- Use the existing deployment appearance values for colour, position, dimensions, radius,
  offset, title, welcome text, avatar URL, and branding visibility.
- Add accessible icon controls for close, expand, audio, attachment, and send.
- Keep the dashboard appearance preview aligned with the live widget.

### Excluded

- Database or API schema changes.
- New user-configurable content fields or a new analytics event.
- Changes to the Website Chat authorization, session, delivery, or audio contracts.

## Context and constraints

- The live widget is an HTML frame and loader string in `server/kasitek-core/src/controllers/website.rs`.
- The appearance editor and preview live in `client/apps/client/src/components/dashboard/agents/agent-website-chat-appearance-page-client.tsx`.
- Existing user customization and anonymous transport behavior must remain intact.
- The widget must use application controls only and remain keyboard accessible.

## Implementation plan

1. [x] Inspect the current implementation and affected boundaries.
2. [x] Rebuild the Core widget shell and composer without changing its transport contract.
3. [x] Align the dashboard preview with the live layout.
4. [x] Update supported user documentation for the visible widget behavior.
5. [x] Run lint, type, Rust, and targeted runtime checks and record the result.

## Release record

Change: Visual and interaction refinement for the embedded Website Chat.

Owner: KasiTek frontend and Core.

Risk: low.

Affected services and user surfaces: Core Website Chat loader/frame; client Website Chat appearance editor and preview.

Platform release version or release ID: to be recorded at release; no release identity is assigned in this workspace.

API/schema/migration changes: not applicable.

Feature flag or rollout method: not applicable; compatible client/Core deployment.

Analytics events and success metrics: no new event; success is a passing build, accessible controls, and visual parity between live frame and preview.

Logs, metrics, dashboards, and alerts: not applicable; no new failure mode or server lifecycle event.

User, API, internal, and operational documentation: updated `docs/public/docs/workspace/domains-and-branding.md` with the available appearance values and widget controls.

Validation evidence: `cargo fmt --check`; `cargo test -p kasitek-core controllers::website::tests --lib` with 5 passing tests; extracted loader/frame JavaScript syntax check; client `tsc --noEmit`; edited-file ESLint; `git diff --check`; `next build --webpack` with all routes generated successfully. The default Turbopack build was also attempted but remains blocked by an environment-level `Operation not permitted` process/port panic.

Rollback or disable plan: redeploy the previous client/Core artifacts; no data rollback is required.

Post-release review date: not applicable for this low-risk visual change.

## Notes and blockers

The default Turbopack production build cannot run in this environment. The webpack production build passes on the same source state.
