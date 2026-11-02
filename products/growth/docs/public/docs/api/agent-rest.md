# Agent access to Growth REST

Growth REST, external MCP and internal agents share one operation catalogue and guarded
execution path. Use `GET /v1/operations` to discover the operations currently available to your
credential and `POST /v1/operations/{operation}` to invoke one. The body is the operation's
business arguments, with optional transport controls `_requestId`, `_previewId`, `_reviewId` and `_continuation`.

Authenticate with a delegated [Growth OAuth token](./mcp-integration.md), a scoped workspace
Developer API key, or the normal Growth user session. OAuth access tokens must have been issued
for the configured Growth MCP resource; tokens for other products or resources are rejected.
Developer API keys are created in **Developers → API Keys** with explicitly selected scopes; rotation preserves those scopes. Send bearer credentials in the
`Authorization` header. Browser session writes additionally require Growth's exact Origin.

The current workspace membership, entitlements, credential status and operation scope are
checked at execution. `api:read` keys permit reads; `api:write` permits requested private content draft/media writes and reviewed internal record changes and does
not grant publication. Use the explicit `growth:*` scopes for other operation classes.

Authorized content writes execute directly with a stable `_requestId`, current authority,
validation and durable receipts. This covers drafts/media and public/destructive content actions.
No separate Growth human approval or MCP card is required. Other writes retain exact user review.

Optionally invoke `content.actions.preview` before an action:

```json
{
  "action": "content.posts.publish_batch",
  "input": { "postId": "saved-post-id" },
  "requestId": "publish-request-001"
}
```

The result includes `preview.previewId`, exact copy/media/account/timing details and readiness.
Previewing does not contact providers or execute the action. To use that frozen snapshot, submit
the unchanged action input with `_previewId` and the same `_requestId`. A changed or expired
preview is rejected. Calling the action without a preview validates its current snapshot instead.
This shared execution boundary covers all seven platforms without adding provider capabilities.

Do not retry an uncertain outcome with a fresh identity. Read receipts through
`GET /v1/operation-reviews/{id}`. Large results return bounded JSON chunks; repeat unchanged
arguments with the returned continuation value in `_continuation`.

[Public API v1](./public-v1.md) documents the typed aliases and legacy headers. All operation
availability depends on the configured deployment flags; this documentation does not claim that
a hosted environment has been enabled. The former installation-token exchange and retired
Agents gateway are unsupported.

## Update published Facebook text

Use `content.posts.update_published` with `postId`, `content` and `expectedUpdatedAt` from
the current post. This requires `growth:publish` and current validation. It updates the text or
caption of the existing confirmed Facebook post, retaining its external identity. Add
`removePhoto: true` to detach its single image with the same revision checks. Omit the flag to retain
media. Replacement and additional media are unsupported.
Only Facebook-only posts are supported. A stale revision or changed account requires a fresh
read. Reuse the same request identity to reconcile an uncertain result; never publish a
replacement as an edit.
