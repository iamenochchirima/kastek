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
- **Sandbox detail** — tabbed Overview, Agents, Profiles, Sessions and Outcomes views. Product agents are listed from the sandbox workspace and can be opened in a chat page. Profiles create and apply versioned agent setup configurations for Agents sandboxes; creating a profile or new version starts setup immediately. Profiles can create the platform Assistant, customer-service agents, or custom agents with full advanced configuration overrides. Channels are excluded. **New profile** includes a template picker that fills the form from the file-backed preset catalogue. Sessions link back to their conversation. The Overview tab holds version, provisioning, workspaces and the paired sandbox link. **Update sandbox** applies current code/schema and records a new sandbox version. **Restart runtime** restarts the recorded runtime; the service also self-heals stopped runtimes every 10 seconds.
- **Agent chat** — Growth chats include a model picker. The selected model applies to new messages in that agent's conversations, matching the Growth product's feature-level model setting.
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
- `POST /api/sandboxes/:id/runtime/restart`
- `GET /api/sandboxes/:id/product-agents`
- `POST /api/sandboxes/:id/chat`
- `GET /api/agent-templates`
- `GET /api/sandboxes/:id/agent-profiles`
- `POST /api/sandboxes/:id/agent-profiles`
- `POST /api/agent-profiles/:profileId/versions`
- `POST /api/agent-profiles/:profileId/apply`
- `POST /api/sandboxes/:id/sync`
- `GET /api/sandboxes/:id/agents/:agentRefId/models`
- `POST /api/sandboxes/:id/agents/:agentRefId/model`
- `GET /api/sandboxes/:id/sessions/:sessionId/messages`
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
Agents runtime. Product-agent listing and chat use the sandbox owner session and
normal product APIs; Evals records session references and digests, while transcript
text stays in the product runtime. Delete stops the runtime processes, drops product
databases and removes local sandbox files. Deleting either half of a Growth pair
deletes both.
