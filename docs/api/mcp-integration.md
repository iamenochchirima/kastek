# KasiTek MCP integration

The hosted endpoint is `https://agents.kasitek.co.za/mcp`. It is a Streamable HTTP JSON-RPC
transport backed by the stateless gateway. The gateway forwards no credentials into prompts and has
no database or Temporal ownership.

1. Exchange a copy-once installation credential at `POST /v1/installation-tokens/exchange` with
   `{"secret":"...","audience":"mcp"}`.
2. Send the resulting short-lived bearer token to `/mcp` with the JSON-RPC `initialize` request.
3. Include the installation id in `params.installationId` for `tools/list` and `tools/call`.
4. Use the returned manifest schemas to build arguments. The installation's effective grants filter
   discovery and calls; denied or unavailable tools return a structured JSON-RPC error.

The Agent Platform owns runs, approvals, effects, and audit records. A tool call never receives
direct database access. External-effect calls require their declared approval and are represented by
an idempotent effect receipt; ambiguous provider outcomes are surfaced for reconciliation rather
than blindly retried.

For clients that support it, `/.well-known/oauth-protected-resource` and
`/.well-known/agent-installation-jwks.json` publish protected-resource and signing-key metadata.
The local stdio bridge should forward the same JSON-RPC messages to the hosted endpoint rather than
implementing a second capability registry.
