# Agents frontend

React, TypeScript, Vite and React Router. Public marketing pages and the dashboard use separate layouts in one deployment. App colors, typography, density and UI primitives retain the Growth design system.

## Local startup

Use the root Node 24/pnpm workspace. Install dependencies from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @kasitek/agent-platform dev
```

Open http://localhost:3100. Copy .env.example to .env.local if the Agents API uses a different address. AGENTS_API_PROXY_TARGET is read by Vite only; it is not exposed as a browser environment variable. Use localhost consistently with the shared provider's local passkey configuration.

The frontend needs the standalone Agents API on `127.0.0.1:4100` and the shared
login provider. Configure the backend's `products/agents/api/.env` with its database and
OIDC settings before starting it. See [platform login setup](../docs/architecture/platform-login.md).
From the repository root, run the API in a separate terminal:

```sh
pnpm dev:agents-api
```

For playground execution, the retained runtime also needs a Temporal server and
worker. Set `TEMPORAL_ENABLED=true`, the server address, namespace and task queue
in the backend `.env`, then start the worker in another terminal:

```sh
pnpm --dir products/agents/api dev:worker
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

## Production frontend container

Build the dedicated frontend image from the repository root:

```sh
docker build -f products/agents/web/Dockerfile -t kasitek-agents-ui .
docker run --rm -p 3100:8080 \
  -e AGENTS_API_UPSTREAM=http://api:4100 \
  --network your-private-network kasitek-agents-ui
```

Use the API's address on your private container network. The default is
`http://api:4100`; it must resolve when Nginx starts. Set a scheme, hostname and
optional port only, with no path or trailing slash. An HTTPS upstream uses SNI
and verifies its certificate against the container's CA bundle. Do not expose the
backend directly to browsers. The frontend image contains built static assets and
the proxy configuration, with no backend environment files or model credentials.
`AGENTS_API_UPSTREAM` is a server setting and is not embedded in browser JavaScript.

The hosting edge must provide public HTTPS. Set the backend's public frontend
origin, `AGENTS_PUBLIC_URL`, to that public domain. Register its
`/api/auth/callback` URL with the identity provider. The proxy preserves Host,
Origin and cookie headers; backend
session and same-origin checks remain responsible for admission. It does not
rewrite the configured login redirects or relax authentication.

The [Nginx configuration](hosting/default.conf.template) serves frontend deep links,
returns 404 for missing fingerprinted assets and forwards API paths unchanged.
It disables response buffering and proxy retries. The five-minute upstream read
timeout measures silence between reads, so live events must keep the connection
active. Verify the real run stream and reconnect behavior when model credentials
are configured. `pnpm preview` remains available for local build inspection;
there is no production `vite preview` start script.

See the [frontend checklist](../docs/plans/agents/FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md) for progress and remaining integration work.

## Editing and testing a saved agent

Open the agent in Studio, edit Behavior/Runtime settings and save a draft. Select
**Use version in Playground** to publish and pin that version for testing. Saving
alone does not change the playground installation. Studio requires the selected
version to match the playground before sending a message, and also checks runtime
readiness. Live promotion/rollback controls are pending in this initial frontend.

The playground model picker changes only the saved conversation's model. **Use
agent model** clears that override and follows the agent version. Readiness checks
use the conversation selection; changing providers does not configure credentials.
