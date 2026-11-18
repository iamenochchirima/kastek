# Application API

An authorized workspace owner can create an application in **Settings → Applications**, or use
`POST /api/organizations/:organizationId/applications` with selected agents and key scopes. The response
contains an application credential once; store it securely. The database stores only its hash.
The management endpoints require a signed-in workspace owner with `credentials.manage`.

Send the credential as a bearer token. The available scopes and operations are:

- `agents:read`: `GET /v1/agents` lists the application's selected, active agents.
  `GET /v1/agents/:agentId` opens one assigned agent with the published version a run would
  use. An unassigned agent returns `404`.
- `runs:start`: `POST /v1/runs` starts a run with `{ agentId, message, requestId, conversationId? }`.
  Reuse the request ID to retry the same request.
- `runs:read`: `GET /v1/runs/:taskId` returns the run state, public activity, and available result.
- `runs:read`: `GET /v1/runs/:taskId/events` streams the same public run snapshot as server-sent
  events. Each connection starts with a current snapshot, followed by changed snapshots. Reconnect
  with the same bearer authorization to get the latest snapshot; this does not replay every change
  or stream model tokens. The stream ends when the run settles or access becomes unavailable.
- `runs:control`: `POST /v1/runs/:taskId/instructions` queues `{ instruction, requestKey }` and
  `POST /v1/runs/:taskId/cancel` requests cancellation.

An application can only access its own runs for currently assigned agents. Each run is bound to the
credential that started it, and revoking that credential stops work it still has in flight.
Conversation history belongs to the application, so a replacement credential can continue the
conversation and read its prior turns.

Application keys do not gain a member's connected-account access. A connection owner can share a
read-only connection with applications in the workspace through
[application connection access](application-connections.md).

Issue another credential with
`POST /api/organizations/:organizationId/applications/:applicationId/credentials`, then revoke
the old credential at `POST /api/organizations/:organizationId/applications/:applicationId/credentials/:credentialId/revoke`.
Revoke the whole application at `POST /api/organizations/:organizationId/applications/:applicationId/revoke`.
Credential responses are not cached and secrets are not returned by the application list.

Change the assigned agents with `PUT /api/organizations/:organizationId/applications/:applicationId/agents`
and `{ "agentIds": [...] }`. An empty list removes all assignments. Removing an agent stops further
execution and access for its existing application runs.

The agent and version identity is available through `agents:read`. The agent's full
configuration and per-plan API entitlement are not yet implemented.
MCP OAuth permissions are separate from these credentials.
