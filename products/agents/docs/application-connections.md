# Application connection access

Application credentials do not automatically grant access to a member's connected account.
An owner who controls a connection can enable access for applications in their workspace through
`PUT /api/organizations/:organizationId/connections/:connectionId/application-sharing` with
`{ "enabled": true, "policyRevision": 1 }`. The matching GET endpoint reports the current state
and revision. Both endpoints require the connection owner to have `credentials.manage`.

Sharing applies to read operations assigned to an agent, and only while the application's key,
agent assignment, connection owner, connection, selected resources, and pinned connection policy
remain authorized. Reviewed writes are not yet available to application runs. Disabling sharing or
changing the connection policy removes access, including access to previously acquired evidence.
Provider connections must also be explicitly shared as an organization service.

The connection owner remains the credential custodian; the run records the application as its
principal. The connection credential stays on the server and is never passed to the model.
