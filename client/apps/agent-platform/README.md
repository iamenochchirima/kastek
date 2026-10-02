# Agents frontend

React, TypeScript, Vite and React Router. Public marketing pages and the dashboard use separate layouts in one deployment. App colors, typography, density and UI primitives retain the Growth design system.

## Local startup

Use Node 22.12+ on the supported 22 line, or Node 24. Install dependencies from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @kasitek/agent-platform dev
```

Open http://localhost:3100. Copy .env.example to .env.local if the Agents API uses a different address. AGENTS_API_PROXY_TARGET is read by Vite only; it is not exposed as a browser environment variable. Use localhost consistently with the shared provider's local passkey configuration.

## Routes and state

- / is the public landing page; /login and /signup enter backend-owned shared login.
- /app is the authenticated shell, with agent screens under /app/agents, /app/studio and /app/playground.
- Existing /agents and /studio bookmarks redirect into /app.
- /onboarding creates or selects a permitted workspace before agent screens load.
- Settings shows the account/workspace and provides logout. Team administration,
  Knowledge, Connections, Usage and Inbox retain pending states. Personal deployment is planned.

The session loader uses GET /api/auth/me from the standalone Agents backend. Local
password login, workspace onboarding, dashboard access and logout are verified.
The initial /api/agents facade now uses real session/membership admission and the
existing Agents backend handlers. Agent creation, Studio reopening after refresh
and workspace listing are verified. Other inherited integration endpoints still
need review. Vite does not manufacture a session or inject service credentials.
With an absent backend, protected routes display a connection error. Actual model
execution and streaming/history acceptance remain unverified.

## Normal checks

```sh
pnpm --filter @kasitek/agent-platform typecheck
pnpm --filter @kasitek/agent-platform build
pnpm --filter @kasitek/agent-platform test:studio
pnpm --filter @kasitek/agent-platform lint
```

Production output is dist/. Use preview for a local build check, not production hosting. The production host must serve dist assets, fall back to index.html for frontend deep links, and proxy /api to the Agents backend before that fallback. Preserve cookie headers and stream responses without buffering. Missing /api routes must remain API errors, not return the frontend HTML. The local Vite dev/preview proxy forwards paths unchanged.

See the [frontend checklist](../../../docs/plans/agents/FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md) for progress and remaining integration work.
