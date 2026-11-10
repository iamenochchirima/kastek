# Evals client

Client for the evaluation control plane in `services/evals/`. It shows sandboxes,
workspaces, agent references, interactive sessions and saved outcomes, and can
provision a local sandbox. The browser never receives the operator token; the
client server proxies the control-plane API.

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

- **Sandboxes** — recorded sandboxes, their status, and workspace, agent, session and outcome counts. **Create sandbox** provisions a local Agents environment or a Growth sandbox with its paired Agents runtime. Each card and detail page has a confirmed delete action; **Delete all** requires typing `DELETE`.
- **Sandbox detail** — version, provisioning progress, workspaces, agent references, sessions, outcomes, the paired sandbox link and a confirmed delete action.
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
- `DELETE /api/sandboxes/:id`
- `DELETE /api/sandboxes` with `{"confirm":"DELETE"}`
- `GET /api/sandboxes/:id`
- `GET /api/sessions`
- `GET /api/sandboxes/:id/sessions/:sessionId`
- `GET /api/outcomes`

All routes proxy to `services/evals`. `EVALS_OPERATOR_TOKEN` is required by the
server; a missing token returns a clear `503` instead of exposing an unauthenticated
control plane.

Creating a sandbox requires the local provisioner configuration on the service:
PostgreSQL database-create access, Growth Prisma migration privileges, local
S3/MinIO credentials, a running Restate admin endpoint, Docker socket access,
signed Growth/Agents keys, and a non-production billing service with sandbox plans
and `EVALS_BILLING_SANDBOX_URL`/`EVALS_BILLING_SANDBOX_SECRET` configured. The dialog creates a real isolated environment. It is not
a record-only form. Growth creates a Growth database/API/workspace plus a paired
Agents runtime. Delete stops the runtime processes, drops product databases and
removes local sandbox files. Deleting either half of a Growth pair deletes both.
