# Evals client

Read-only client for the evaluation control plane in `services/evals/`. It shows
sandboxes, workspaces, agent references, interactive sessions and saved outcomes.
The browser never receives the operator token; the client server proxies the
control-plane API.

It does not own product data, agent configuration, chat endpoints or a local
evaluation database.

## Run

Start the evaluation service and the persistent sandbox first, then:

```sh
export EVALS_API_URL=http://127.0.0.1:4600
export EVALS_OPERATOR_TOKEN=<operator-token>
pnpm --filter @kasitek/evals dev
```

- Web: `http://127.0.0.1:5175`
- Client API: `http://127.0.0.1:4321`

For a production build:

```sh
pnpm --filter @kasitek/evals build
pnpm --filter @kasitek/evals start
```

## Pages

- **Sandboxes** — recorded sandboxes, their status, and workspace, agent, session and outcome counts. **Create sandbox** provisions a local Agents environment or a Growth sandbox with its paired Agents runtime.
- **Sandbox detail** — version, provisioning progress, workspaces, agent references, sessions, outcomes and the paired sandbox link.
- **Sessions** — interactive sessions across sandboxes.
- **Session detail** — task references, states and transcript digests.
- **Outcomes** — saved business results across sandboxes.

Transcript text and customer records stay in the product runtime. The control plane
stores identifiers, digests and states, not copies of the transcript.

## API

The client server exposes:

- `GET /api/health`
- `GET /api/sandboxes`
- `POST /api/sandboxes`
- `GET /api/sandboxes/:id`
- `GET /api/sessions`
- `GET /api/sandboxes/:id/sessions/:sessionId`
- `GET /api/outcomes`

All routes proxy to `services/evals`. `EVALS_OPERATOR_TOKEN` is required by the
server; a missing token returns a clear `503` instead of exposing an unauthenticated
control plane.

Creating a sandbox requires the local provisioner configuration on the service:
PostgreSQL database-create access, Growth Prisma migration privileges, local
S3/MinIO credentials, a running Restate admin endpoint, Docker socket access and
signed Growth/Agents keys. The dialog creates a real isolated environment. It is not
a record-only form. Growth creates a Growth database/API/workspace plus a paired
Agents runtime.
