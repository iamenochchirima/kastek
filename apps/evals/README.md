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

- **Environments** — recorded sandboxes and deployed API environments, their status, workspaces, agents, sessions and outcomes. **Create sandbox** provisions a local Agents environment or a Growth sandbox with its paired Agents runtime. **Connect API** records a deployed product reached through an application credential. Each card and detail page has a confirmed delete action; **Delete all** requires typing `DELETE`.
- **Configuration** — horizontal catalogue of the user-relevant agent configuration fields, their purpose, input values, required conditions and applicability across agent template archetypes. It links to sandboxes and is the reference for templates and dataset cases.
- **Sandbox detail** — tabbed Overview, Agents, Published, Sessions and Outcomes views. **Agents** creates and applies versioned agent configurations for Agents sandboxes; creating an agent or new version starts setup immediately. It can create the platform Assistant, customer-service agents, or custom agents with full advanced configuration overrides. Channels are excluded. **New agent** includes a template picker and a **Form / Table** toggle. Table view shows the same profile fields with summaries and keeps every value editable before creating. **Published** lists agents currently published in the product workspace and opens them in a chat page. Sessions link back to their conversation. The Overview tab holds version, provisioning, workspaces and the paired sandbox link. **Update sandbox** applies current code/schema and records a new sandbox version. **Restart runtime** restarts the recorded runtime; the service also self-heals stopped runtimes every 10 seconds.
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
- `POST /api/api-environments`
- `GET /api/sandboxes/:id/api-agents`
- `POST /api/sandboxes/:id/api-agents`
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

## API environments

**Connect API** records a deployed product reached through an existing Agents
application credential. It does not provision or own the deployment.

The form takes a name, base URL, organization ID, application ID and credential
secret. The client validates the credential with `GET /v1/agents`, writes the
secret to `.audit/api-environments/<id>/credential.json` at mode `0600`, and
records an environment with `profile = api` and `runtime.kind = api`. The secret
is never returned to the browser.

The application needs `agents:read`, `agents:manage` and `agents:publish`. Agent
creation uses the application API:

1. `POST /v1/agents` with the name, purpose and instructions.
2. `POST /v1/agents/:id/preview` to validate the configuration.
3. `PATCH /v1/agents/:id` with the full configuration and the returned
   `draftRevision`. The configuration carries `tools`, `model`,
   `sourceRevisionIds`, `memory` and `capabilities`.
4. `POST /v1/agents/:id/versions` to publish.
5. Record an Evals agent ref for the published version.

Deleting an API environment removes the stored credential and retires the
record; it does not change the deployment or its agents.

The same pattern is the intended path for a deployed Growth environment and,
when its runtime is defined, an Agency environment. A provisioned sandbox remains
the way to exercise product tools and platform behaviour.

