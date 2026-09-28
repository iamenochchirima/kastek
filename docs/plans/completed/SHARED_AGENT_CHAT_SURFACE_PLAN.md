# Shared agent chat surface

Status: in_progress
Owner: Codex

## Outcome

Use one canonical chat message renderer, runtime telemetry bar, and composer contract in the main KasiAI chat, Studio/Playground, and agent test chat. Surface-specific controls remain slots around the shared chat rather than separate renderers.

## Scope

- Extract the rich main-chat message behavior into reusable agent chat modules.
- Share the runtime telemetry row and details panel.
- Keep the composer fixed while messages scroll inside a bounded region.
- Migrate Studio/Playground and the agent test panel without changing backend contracts.
- Migrate the main chat onto the same renderer and layout seam.
- Remove duplicate renderers after each consumer is verified.

## Non-goals

- No backend/API, memory, or runtime persistence changes.
- No execution graph redesign.
- No native browser dialogs.
- No unrelated worktree cleanup.

## Release record

Change: shared frontend chat surface and interaction rendering
Owner: Codex
Risk: standard
Affected services and user surfaces: client main chat, Studio/Playground, agent test chat
Platform release version or release ID: not applicable for this local implementation batch
API/schema/migration changes: not applicable
Feature flag or rollout method: not applicable; client-only surface migration
Analytics events and success metrics: not applicable; no new user outcome event introduced
Logs, metrics, dashboards, and alerts: not applicable; no server-side lifecycle added
User, API, internal, and operational documentation: this plan; update public/internal docs only if the final behavior changes documented usage
Validation evidence: pending focused lint, TypeScript, build, and manual responsive checks
Rollback or disable plan: revert the consumer migration commits; backend contracts remain unchanged
Post-release review date: not applicable until a release is scheduled

## Execution checklist

- [x] Audit current main, Studio, test-panel, composer, media, authorization, and telemetry implementations.
- [x] Read client and release-process instructions.
- [x] Add shared message-list module.
- [x] Add shared runtime telemetry module.
- [x] Add shared fixed-height chat surface module.
- [x] Add shared run-activity status module with progress, event chips, spinner, and activity link.
- [x] Migrate main chat.
- [x] Migrate Studio/Playground.
- [x] Migrate agent test panel.
- [x] Remove duplicate renderers and unused helpers.
- [x] Run focused lint/type/build checks (ESLint, `tsc --noEmit`, `npm run build`, `git diff --check`).
- [ ] Run responsive/manual behavior checks in an authenticated browser session.

## Verification evidence

- Focused ESLint passes for all six changed client modules.
- Client TypeScript check passes.
- `npm run build` passes with Next.js static generation for all routes.
- `git diff --check` passes.
- Browser verification remains pending because no browser tab/session is currently available in this environment.
- [ ] Commit coherent batches without unrelated files.
