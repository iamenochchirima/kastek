# Sandbox workspace bootstrap

The evaluation provisioner needs a fresh Agents sandbox with one owner and one
workspace before it can be used. This is a product-owned operator command, not a
normal customer API.

```sh
AGENTS_DATABASE_URL=<fresh-database> \
AGENTS_BOOTSTRAP_EMAIL=owner@example.local \
AGENTS_BOOTSTRAP_WORKSPACE_NAME="Acme support" \
node --import tsx src/composition/bootstrap-sandbox.ts
```

The command creates or reuses the account by issuer and subject, creates the
workspace with an owner membership and organization assistant, creates a session,
and prints one JSON object:

```json
{
  "accountId": "...",
  "organizationId": "...",
  "organizationName": "Acme support",
  "session": "...",
  "expiresAt": "2026-12-09T20:00:00.000Z"
}
```

`AGENTS_BOOTSTRAP_ISSUER` must match the sandbox API's
`AGENTS_OIDC_ISSUER_URL`. The evaluation client stores the session in a local
`0600` owner-session file; the control plane stores only the workspace reference.

This is a bootstrap path for isolated evaluation sandboxes. It does not replace
normal sign-in or membership management.
