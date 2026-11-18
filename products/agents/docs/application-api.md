# Application API

An authorized workspace owner can create an application in **Settings → Applications**, or use
`POST /api/organizations/:organizationId/applications` with selected agents and the `agents:read`
scope. The response
contains an application credential once; store it securely. The database stores only its hash.
The management endpoints require a signed-in workspace owner with `credentials.manage`.

Send the credential as a bearer token to `GET /v1/agents`. The response contains only the
application's selected, active agents. Issue another credential with
`POST /api/organizations/:organizationId/applications/:applicationId/credentials`, then revoke
the old credential at `POST /api/organizations/:organizationId/applications/:applicationId/credentials/:credentialId/revoke`.
Revoke the whole application at `POST /api/organizations/:organizationId/applications/:applicationId/revoke`.
Credential responses are not cached and secrets are not returned by the application list.

This is the first read-only application operation. Application run and configuration access,
per-plan API entitlement and agent assignment changes are not yet
implemented. MCP OAuth permissions are separate from these credentials.
