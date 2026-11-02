---
title: Growth agent execution
owner: engineering
last_reviewed: 2026-11-01
---

# Growth agent execution

Growth owns the Agents workspace, the general assistant launcher, user membership, business
permissions, attached records, and saved business results. Shared Agents execution owns its own
tenant mapping, configured features, conversations, tasks, model calls, evidence and artifacts.
Growth users do not need a standalone Agents account or membership.

The browser calls Growth's authenticated /api/agents routes. Growth signs the complete
versioned command and calls the shared product API through agents/client.ts. The destination
action API verifies a separate Agents worker signature and rechecks Growth membership, feature
permission and attached context. Neither backend reads the other product's database.

The shared schema is packages/contracts/src/growth-agents.ts. Growth's api/src/agents/ owns the
browser routes, current scope resolver, business reviews and domain effects. Changing this
contract requires matching client, API and worker artifacts.

## Configuration

The optional service values are listed in api/.env.example. Configure the shared API origin,
Growth's signing key and issuer, and the public keys/issuer permitted for destination actions.
Private keys never enter browser configuration. Model credentials and permitted defaults belong
to protected execution configuration, with explicit Growth use grants and tenant usage attribution.
The [integration setup](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/growth-integration.md) lists both signature directions,
exact browser origins, managed-model provisioning, and tenant/model disable controls.

Ordinary Growth startup and business APIs do not require Agents. An unavailable execution service
produces an unavailable agent state. It must not start a separate local model loop or replace
missing tasks with empty counts. Workspace summary leaves its retired agent counters null;
the new Agents endpoints own agent activity.

## Business effects

Content suggestions remain proposals until the user reviews the exact final fields and selected
publishing account. Growth owns the durable review and draft-save receipt. The shared task retains
the corresponding operation reference. A changed proposal, record or authorization cannot reuse
an old approval. Saves use Growth's ordinary content service and retain the initiating actor.
Workspace context includes a bounded product guide resolved from Growth's current page/capability
map. It filters navigation and agent actions by current feature entitlement. The guide is private
product evidence and changes the context revision when its allowed capabilities change.
A lost acknowledgement is reconciled from the original operation before another save is considered.
Recovery also checks an approved review for a previously committed draft, including after approval
expiry, because its outer review transaction may have rolled back after the domain save.

Current campaign context refers to Growth's WhatsApp campaigns. It does not create a generic
social campaign model or authorize publishing, scheduling, recipient changes or campaign launch.

## Product outcomes

Growth owns the registered `growth.agent.command@1`, `growth.agent.review@1` and
`growth.agent.draft_saved@1` events. Command acknowledgements count creation, turn admission and
cancellation results. Review transitions and confirmed saves enqueue facts in the same Growth
transaction as their durable state. Stable identities deduplicate retries and recovered receipts.
The existing analytics publisher delivers the outbox independently of agent execution.

Facts contain bounded feature, conversation, task, review and result identifiers. They exclude
briefs, draft contents, credentials, user identifiers and retired installation/hosting fields.
An accepted turn is an admission outcome; it does not establish a successful model result.
Growth engineering owns product outcome counts and `kasitek.operation.duration` for bridge latency.
Agents engineering owns task success, queue age and native root token/cost accounting. Hosted
alert thresholds and model quality acceptance remain operator and owner work.

## Customer channels

Customer website and messaging automation belongs to standalone Agents deployments. Growth keeps
its normal human Inbox, provider receipt handling, campaign opt-out and calling services. Growth
does not forward inbound WhatsApp, Facebook or Instagram messages to a second agent responder.
The old Telegram callback proxy, personal pairing, installation management and widget transport
are removed.

The Labs website uses a configured Agents publication URL and deployment UUID. Its allowed origin
must include the actual Labs website. Missing or invalid configuration shows a contact fallback.
Growth retains /api/quote-requests and /api/waitlist independently.

## External clients and operations

Growth's `api/src/operations/` owns the canonical operation catalogue, schema validation,
current credential/membership/entitlement policy, exact reviews, bounded observations and domain
dispatch. External MCP (`POST /mcp`), canonical REST (`/v1/operations`) and embedded signed
`operation.invoke` actions use that execution path. Internal execution supplies verified user and
workspace context directly; it does not make an MCP network request or gain additional scopes.
Typed content, customer, inbox, booking, campaign and template REST aliases dispatch the same
operations. Authorized personal fields have the same visibility on each transport; provider
credential-shaped fields are recursively removed.

`api/src/oauth/` implements Growth-owned public-client OAuth authorization-code flow with PKCE
S256, consent against the existing verified Keycloak session, dynamic registration and validated
HTTPS client metadata. Opaque token digests are stored in additive `GrowthOAuth*` tables.
Connections bind user, organization, client, granted scope and exact `${publicApiUrl}/mcp` audience.
The resolver rejects other resources; REST accepts this explicitly supported Growth resource too.
Refresh rotation is serialized per connection, and refresh replay revokes its family. User and
workspace membership are rechecked at admission and before dispatch. No machine bearer falls
back to an accompanying browser cookie.

The four operation scopes are `growth:read`, `growth:draft`, `growth:publish` and `growth:manage`.
Legacy Developer keys retain `api:read` reads and `api:write` drafts; write does not imply publish
or destructive authority. Non-read operations require a durable review tied to the exact JSON
payload, request identity, credential and resource snapshot. The browser review is
`/operations/reviews/:id`; approval alone does not run the effect. Only an approved matching
resume can claim execution. Completed receipts return their recorded result; unknown outcomes
require reconciliation. A continuation carries no new authorization and only reads an unchanged
bounded observation. Staged media controls do not publish content.

**Developers → MCP** displays the configured endpoint and current user's workspace connections,
with individual revocation. Browser logout preserves independent connections. Verified Keycloak
backchannel `sid` deletes that browser session only; subject-wide revocation and successful
account-wide logout revoke delegated grants as well. Invalid identity signals cannot revoke a
connection. Old installation JWTs remain rejected.

See [agent access operations](../operations/growth-agent-access.md) for controlled migration,
feature flags, verification and rollback. This implementation supports its catalogue; it does
not establish that every UI action has an agent operation or that every social provider has
passed live acceptance.

The central admin Operations page retains Growth webhook recovery and support access. Retired
remote runtime projections and operator commands are removed. Shared execution monitoring belongs
to its owning service; the Growth admin cannot acquire that authority through an old proxy.

## Verification boundary

Use isolated state for browser-to-Growth-to-Agents-to-worker checks and inspect authoritative
Growth records. Direct adapter tests and mocked routes do not prove that full path. Purpose
evaluations and live provider acceptance remain owner-run. Source changes do not enable a hosted
deployment, reset an owner database or apply the obsolete widget-table removal migration.

The [shared architecture](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/architecture/agent-platform-architecture.md)
defines execution categories and authorization responsibilities. Current shared runtime support
is recorded in its [source boundary](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/source-boundary.md).


## Shared conversation and specialist inspection

Growth and standalone Agents render execution through `@kasitek-labs/ui/agent`. Growth route, dock and mobile hosts share `AgentConversation`; contextual content, campaign, analytics and Inbox launchers retain their existing context and use that same conversation. The shared package owns messages, safe Markdown, composer interaction, compact tool/subagent rows, chronological activity, context disclosure, reading position and the responsive subagent modal. Product adapters retain sessions, current permissions, transport, exact reviews, source resolution and execution commands.

`GET /api/agents/tasks/:taskId/activity` and its `/live` companion read a purpose-built current-authority projection. An optional `childTaskId` must belong to the authorized root tree. A separate `operationCursor` pages safe own-task operation history independently of event replay. The browser does not use execution exports to inspect specialists. Tool detail contains authorized metadata, not arbitrary arguments/results or private reasoning. Public progress comes from retained assistant content accompanying tool calls; missing historical content remains unavailable.

Opening a running specialist observes its assignment, public updates, tool metadata and output in the same conversation body. Close releases observation only; it never cancels or restarts work. Descendants, when supported by runtime policy, navigate within one modal. Mobile uses a full-screen modal. Scope changes and authoritative access/evidence withdrawal clear protected messages, sources, activity and cached history. Terminal observations cannot regress to running when delayed frames arrive. Visible settled history periodically rechecks current access; source restoration requires a newer authorized observation.

Context capacity remains separate from task completion and usage allowances. Diagnostics and history remain available on demand. Execution completion does not establish factual accuracy or delivery; business actions still require their native review and receipt. Customer histories reuse plain message content without receiving internal task visibility.

Verification: shared package tests, Growth agents browser suite and focused `playwright.shared-agent-ui.config.ts` cases cover compact rendering, current-policy withdrawal, replay, operation paging, nested mobile dialogs, tool/context disclosure, keyboard behavior and scroll/focus restoration. Actual in-app model trials are distinct from deterministic fixture evidence. See [shared UI release record](../operations/shared-agent-ui-release.md).
