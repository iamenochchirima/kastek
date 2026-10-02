# Agents frontend

React, TypeScript, Vite and React Router. Public marketing pages and the dashboard use separate layouts in one deployment. App colors, typography, density and UI primitives retain the Growth design system.

## Local startup

Use Node 22.12+ on the supported 22 line, or Node 24. Install dependencies from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @kasitek/agent-platform dev
```

Open http://localhost:3100. Copy .env.example to .env.local if the Agents API uses a different address. AGENTS_API_PROXY_TARGET is read by Vite only; it is not exposed as a browser environment variable. Use localhost consistently with the shared provider's local passkey configuration.

The frontend needs the standalone Agents API on `127.0.0.1:4100` and the shared
login provider. Configure the backend's own root `.env` with its database and
OIDC settings before starting it. See [platform login setup](../../../docs/architecture/platform-login.md).
From the repository root, run the API in a separate terminal:

```sh
pnpm dev:api
```

For playground execution, the retained runtime also needs a Temporal server and
worker. Set `TEMPORAL_ENABLED=true`, the server address, namespace and task queue
in the backend `.env`, then start the worker in another terminal:

```sh
pnpm dev:worker
```

API and worker must use the same queue/namespace. Configure a model-provider key
in the backend environment only. The default enforced credit-billing mode needs
the Growth credit service for platform-funded model calls. An isolated development
test can explicitly use `CREDIT_BILLING_MODE=disabled`; this skips credit charging,
while normal run limits still apply. The frontend does not select billing mode or
provide credentials. Production billing defaults remain enforced. Starting the UI
alone does not establish that execution is ready.

## Routes and state

- / is the public landing page; /login and /signup enter backend-owned shared login.
- /app is the authenticated shell, with agent screens under /app/agents, /app/studio and /app/playground.
- Existing /agents and /studio bookmarks redirect into /app.
- /onboarding creates or selects a permitted workspace before agent screens load.
- Settings shows the account/workspace and provides logout. Team administration,
  Knowledge, Connections, Usage and Inbox retain pending states. Personal deployments are labelled planned under Agents and have a separate
  explanation page at /app/agents/personal.

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

## Editing and testing a saved agent

Open the agent in Studio, edit Behavior/Runtime settings and save a draft. Select
**Use version in Playground** to publish and pin that version for testing. Saving
alone does not change the playground installation. Studio requires the selected
version to match the playground before sending a message, and also checks runtime
readiness. Live promotion/rollback controls are pending in this initial frontend.
