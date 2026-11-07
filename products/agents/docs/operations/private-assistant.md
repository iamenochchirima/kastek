# Private organization assistant

Owner: Agents engineering. Reviewed: 2026-10-30.

The organization assistant is an ordinary business agent. Schema094 records its lifecycle identity;
it adds no authorization. New workspaces create one Assistant draft in the same transaction as
organization membership. Repeated setup preserves customizations. Deletion leaves the marker;
an owner explicitly restores the same definition from the assistant panel setup. Restoration does not revive
revoked grants, channels or automations. Existing organizations use **Set up assistant** explicitly.

Configure a model, instructions, approved knowledge and permitted tools through the normal editor.
**Create specialist** creates an ordinary business definition, initially named Content. Save its
configuration, then select its published version under the assistant's Specialists. Explicit
`tool-directed` version 4 configurations support up to 32 pinned bindings, configurable concurrent
children and bounded follow-ups at depth one. Earlier program versions retain their existing
batch delegation. See [adaptive orchestration](adaptive-orchestration.md). The catalogue checks the parent's
actual model route, child allocation and permitted source/tool scope. Updating a specialist does not
silently update a pin. A text draft remains private to its requesting member; saving to Growth or
publishing content is not implemented by this feature.

## Enablement and linking

Deploy matching API, worker and web code with schema094 and schema095; adaptive orchestration
also requires schema096 and its V23 worker. `setup:db` recognizes
exact preceding schema checksums; do not bypass its rejection of unknown databases. No historical
installation migration or unrelated database change is required.

Private phone admissions are disabled by default. Set `AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS` to
an explicit comma-separated list of pilot organization UUIDs in both API and worker. `*` enables all
organizations and is intended for controlled fixtures, not initial rollout. Customer channels remain
independent. Model accounts, channel credentials and the existing channel vault require normal setup.
Each organization owns its selected Telegram bot or WhatsApp number and retains one webhook owner.
No central shared bot/number is provisioned.

A signed-in member opens Assistant and chooses a verified connection. The app creates a random
32-byte challenge, stores only its SHA256 digest and expires it after ten minutes. A member may
create at most five challenges in ten minutes. Send `/pair TOKEN` to that connection's private chat,
then confirm the displayed provider identity in the signed-in app. Telegram `/start TOKEN` is also
accepted. The challenge is consumed before ordinary ingress persistence and never enters a transcript,
application log or Analytics payload. Confirmation, expiry, sender/chat, asset, member and connection
revisions are checked independently. Group chats, forwarded claims and usernames grant no access.

A link has its own new private conversation. Linking does not import an existing app transcript.
**Open conversation** continues that exact conversation in the app as the same human principal.
Other members, organizations, customer Inbox and specialist child branches do not share that history.
Optional **Task status** and **Cancel tasks** tools let the model inspect or cancel earlier work
belonging to the same human and agent. They expose at most ten IDs/statuses/timestamps, no transcript
or output, and deny customer/automation/evaluation/child tasks, other members and other agents.
The tools use the new tool-directed program version 2; versions 1/3 retain their pinned descriptors.
Current membership, selected tools and grant operations are required again at execution. Cancellation
records an idempotent request and does not undo completed effects. Use `/status` or `/cancel` for
the current active request on that phone link; cancellation records intent,
while the runtime settles the root and children. Existing app task controls also remain available.

For an active adaptive v4 coordinator with delegation enabled, subsequent Telegram/WhatsApp text
queues additional instructions on the same durable root. It uses the current verified link and
returns **Instructions queued** through the normal outbox. Corrections over 4,000 characters or
beyond the 32-instruction root limit receive a durable rejection without creating work.
Duplicate ingress cannot queue the
instruction twice, including after the root closes input. Once input closes, new text starts the
next conversation turn. Earlier programs retain their normal new-turn behavior. `/status` and
`/cancel` retain their existing meaning; exact-effect approval buttons are separate.

## API contracts

All routes require the existing authenticated session, origin checks and current membership under
`/api/organizations/:organizationId`.

| Route | Behavior |
| --- | --- |
| GET `/assistant` | Lifecycle state, ordinary agent and latest saved version. `configured` means a snapshot exists; it is not a live provider health claim. |
| POST `/assistant/repair` with `{}` | Owner-only explicit creation/restore. |
| GET `/agents/:agentId/specialists` | Same-organization latest and currently pinned versions, bounded allowed capabilities and current readiness reasons. |
| POST `/agents` with `name`, `configuration`, optional `operationId` | Explicit ordinary business definition. Guided customer-service creation retains its existing contract. |
| POST `/tasks/:taskId/instructions` with `instruction`, `requestKey` | Queue an authorized active v4 root update; request keys are idempotent. Finishing, cancelled, stale or foreign work is denied. |
| GET `/member-channels` | Current member's links, bounded delivery states, eligible connections and rollout enablement. No provider credentials. |
| POST `/member-channels/challenges` with `connectionId` | Returns a one-time displayed token and expiry; never retrieve it later. |
| POST `/member-channels/:linkId/confirm` with `{}` | Confirms that member's unexpired provider-observed identity. |
| DELETE `/member-channels/:linkId` | Revokes that member's link/generation, associated grants and pending sends. |

## Delivery, review and recovery

Schema095 extends the existing `channel_ingress` and `channel_outbound` queues with an explicit member
purpose. Private records do not require customer deployments or customer messages. Purpose constraints,
scoped foreign keys, event digests, leases and the existing physical-send fence remain authoritative.
A previously private sender retains a tombstone after unlink or connection replacement and cannot
fall through into customer admission. Unlinked senders retain the ordinary customer path only when an
explicit customer deployment exists. Unrecognized private interactions do not become model instructions.

Model planning uses the existing Restate business harness. Human membership and link generation are
rechecked for root/child operations, reviews and outbound sends. Accepted work stays pinned; later
configuration authority reductions still apply through ordinary grant/source revocation. Results pass
the same current-evidence and delegated-input checks as app inspection before physical delivery.

Acknowledgment, waiting status, review prompts and terminal results have separate stable notice keys.
Each text segment has a durable send claim and outcome. A lost acknowledgment is **unknown**, never a
blind retry. Known 429 rejections use existing bounded cooldown retries. Accepted segments survive later
failure. Receipts match connection, provider message and recipient and advance monotonically. Provider
acceptance is distinct from sent/delivered/read. Authenticated late receipts continue to update
existing delivery facts after unlink or private-feature disablement; they never restore task access. Native task completion does not prove phone delivery. Incomplete drafts carry an explicit incomplete
status. Failed or uncertain work never forwards an optimistic model completion claim, and pending
approval prompts are suppressed after the task becomes terminal.

Connected-tool reviews identify the operation, connection, destination and exact arguments. Buttons
are accepted only for the current member/chat, root, link generation, pending digest and expiry, after
an accepted matching prompt. Telegram also binds the callback message ID. Invalid callbacks receive
an unavailable acknowledgment. Oversized reviews and other existing review kinds continue in the app.
WhatsApp interactive prompts are bounded to 1024 characters. Free text uses a verified inbound event
within 24 hours; delayed results outside that window remain available in the app with suppressed
phone delivery. This feature does not invent template consent or send unapproved templates.

For unknown delivery, inspect the app result and ledger. Do not resend the unknown segment. Unlink
and explicitly pair again if a new conversation is needed. Reconnect/replaced credentials invalidate
old links and require a new challenge and confirmation. Membership removal and connection revision changes transactionally revoke links and queued authority.
Restoring membership or reconnecting never reactivates the old phone link; pair again explicitly.

## Threat model

Provider authentication proves transport origin, not membership. Challenge theft creates at most a
pending identity requiring signed-in confirmation. Cross-asset challenges, replay, expired challenges,
group senders, wrong actors, stale revisions and removed memberships fail closed. Link generations
prevent queued results and approval callbacks from reaching a stale phone identity. Explicit private
routing precedes customer processing, including revoked-route tombstones. Specialists inherit no provider credential,
other-member transcript, personal-memory namespace or arbitrary parent history. Parent-selected
briefs remain derived inputs and retain their original evidence fences. Root budgets,
source fences, current tool permissions and one-level delegation are enforced by the shared runtime.

## Release record

- Change/owner/risk: organization assistant and verified private phone access; iamenochchirima; high.
- Services/surfaces: Agents API, worker, web; ordinary editor/chat, private linking, Telegram/WhatsApp.
- Release identity: platform VERSION remains 0.1.0 for this local change. Use the implementation commit
  as `KASITEK_RELEASE_ID` when preparing a separately approved pilot artifact. No tag or deployment
  occurs here. Schema094/095 add lifecycle and purpose records. Existing V21/V22 task workflow identities
  remain because no durable workflow sequence changes; new admissions use existing human execution.
- Analytics: `agent.assistant.lifecycle@1` records provision/restore, link challenge/pending/confirm/revoke,
  admission and completed phone tasks in the existing transactional outbox. Existing native root outcomes
  and delegation observations retain task/child measurements. Compare confirmed links with successful
  tasks; first success is the earliest completed task, not an acknowledgment. Sender/account/link IDs,
  message bodies, arguments, tokens and credentials are excluded from exported attributes.
- Logs/metrics: existing request/task/root/child/ingress/outbound IDs, queue reasons and authority error
  codes support investigation. Monitor quarantined ingress, suppressed/unknown outbound, queue age,
  failed children and pairing-rate rejection. No Collector routing change, new dashboard or alert
  deployment is made. Hosted telemetry delivery remains a pilot prerequisite.
- Documentation: this API/setup/recovery/threat reference, source-boundary feature map, architecture
  and adapter conformance matrix describe the implementation. Public marketing navigation: not applicable.
- Validation: controlled PostgreSQL18/pgvector0.8.7, native Restate1.7.13, deterministic model/provider,
  authenticated HTTP and light/dark responsive browser fixtures. Live-provider/model acceptance is
  owner-run and separate. Handler restart replay is covered; full in-flight Restate server crash recovery
  is not established by that check. The current official WhatsApp Business Messaging Policy confirms the reply window. Complete Meta
  technical/API-version conformance remains unverified after HTTP429 developer-documentation responses.
- Rollout: app first, then an explicit organization allowlist for Telegram and WhatsApp. Before enabling,
  owner verifies provider documentation/settings, real pairing/delivery, model behavior and telemetry.
- Rollback: clear the member allowlist on API/worker, revoke active links through normal unlink before
  reverting the UI, and retain additive tables/checksums/audit/results. Stop new private admissions and
  suppress future sends; reconcile any in-flight unknown effects without replaying them. If reverting to
  code that lacks schema095 purpose handling, stop shared channel workers first and reconcile all member
  queue rows before restart. Do not run older customer-only drain logic on member-purpose rows.
- Billing/package/model-price changes, infrastructure replacement and other-product integration:
  not applicable. Production rollout, post-release review date and merge remain owner decisions.

## Local verification evidence

The implementation checkpoint passed 237 joined API, database, protocol and runtime assertions
across 18 files. Final review corrections passed 56 focused assertions, all 13 real
PostgreSQL/Restate runtime cases including actual browser operation, and 19 responsive browser
scenarios. Terminal-result and stale-review fencing additionally passed 38 member-channel checks. These runs
overlap; the counts are not an additive total. API/web production builds,
focused web lint, Analytics registry validation, product import boundaries and platform version
validation passed. Screenshots and command output remain ignored under `.audit/` and web
`.artifacts/`, including `private-assistant-final-runtime.log`, `private-assistant-final-ui.log` and
`organization-assistant-browser/`.

Standards review found no documented-rule breaches; its duplicated rollout-policy concern was
fixed with a shared neutral helper. Spec review identified Meta profile revalidation, late receipt
identity and model task controls; subsequent review confirmed those fixes, including receipt replay
across re-pairing and preserving incompatible product programs. No unresolved actionable finding
remains in that review. These reviews do not certify provider acceptance.

The stricter `verify:agents-modules` command still reports baseline cross-layer imports and a
contracts dependency cycle present before this change. The affected import diagnostics are in
Agency/Growth adapters, support status, channel contracts and contextual handoff. Product-level
`verify:boundaries` passes. Do not describe the strict module check as passing or hide it when
preparing a release. A first concurrent regression run also hit fixture cleanup-hook timeouts;
the serial rerun passed. The final sources do not increase those fixture timeouts.
