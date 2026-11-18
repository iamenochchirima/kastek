# Application API

An authorized workspace owner can create an application in **Settings → Applications**, or use
`POST /api/organizations/:organizationId/applications` with selected agents and key scopes. The response
contains an application credential once; store it securely. The database stores only its hash.
The management endpoints require a signed-in workspace owner with `credentials.manage`.

Send the credential as a bearer token. The available scopes and operations are:

- `agents:read`: `GET /v1/agents` lists the application's selected, active agents.
- `runs:start`: `POST /v1/runs` starts a run with `{ agentId, message, requestId, conversationId? }`.
  Reuse the request ID to retry the same request.
- `runs:read`: `GET /v1/runs/:taskId` returns the run state, public activity, and available result.
- `runs:control`: `POST /v1/runs/:taskId/instructions` queues `{ instruction, requestKey }` and
  `POST /v1/runs/:taskId/cancel` requests cancellation.

An application can only access its own runs for currently assigned agents. Runs are bound to the
initiating key, whose revocation stops further execution. Conversation continuation currently
requires the same key; support for continuing after key rotation is pending. Account-owned connected
tools do not acquire a member's authority through an application key.

Issue another credential with
`POST /api/organizations/:organizationId/applications/:applicationId/credentials`, then revoke
the old credential at `POST /api/organizations/:organizationId/applications/:applicationId/credentials/:credentialId/revoke`.
Revoke the whole application at `POST /api/organizations/:organizationId/applications/:applicationId/revoke`.
Credential responses are not cached and secrets are not returned by the application list.

Application agent-configuration access, per-plan API entitlement, agent assignment changes, and
streaming are not yet implemented. MCP OAuth permissions are separate from these credentials.
