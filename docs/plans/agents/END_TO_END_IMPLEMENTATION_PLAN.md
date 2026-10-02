# Agents end-to-end implementation

Updated: 2026-10-02.
Status: Next implementation slice. Checklist items are uncompleted until their actual journeys are verified.

## Outcome

A user signs in, creates an agent, supplies knowledge and an authorized tool,
tests it, publishes it to a website, and manages its customer conversations in
the Agents inbox. A simple agent can use bounded direct execution; a durable
agent can wait for approval and resume through Temporal. After website chat,
connect one existing messaging adapter and verify the same conversation flow.

This checklist implements bounded portions of the [platform delivery plan](AGENT_PLATFORM_DELIVERY_PLAN.md).
That plan remains the platform roadmap. Finish the remaining real-response
acceptance in the [initial frontend checklist](FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md)
as stage 1 here; do not repeat the completed Vite, shell or login migration.
Work one stage at a time. Reuse working backend code and existing Growth-style
components. Source availability alone does not establish a working feature.

## Existing foundation and source references

| Area | Starting source | Current evidence |
|---|---|---|
| Login, workspace, browser admission | `src/http/platform-login.ts`, `src/http/browser-agent-routes.ts`, `src/identity/` | Local login, membership, selection and logout verified |
| Agent creation, versions and playground | `src/http/app.ts`, `src/db/repositories/agent-deployment-repository.ts`, `client/apps/agent-platform/src/components/dashboard/studio/` | Creation, saved settings and playground version selection verified; real response pending |
| Model and execution | `src/model/`, `src/runtime/`, `src/temporal/` | Existing runtime; current development model credential is missing |
| Knowledge and tools | `src/knowledge/`, `src/memory/`, `src/capabilities/`, `src/integrations/catalog.ts`, `src/mcp/` | Backend source exists; relevant browser controls remain pending |
| Customer conversations and handoff | `src/db/repositories/conversation-repository.ts`, `src/db/repositories/handoff-repository.ts`, `src/actions/`, `src/events/postgres-conversation-notifications.ts` | Existing implementation to reuse; complete live inbox unverified |
| Channel delivery | `src/channels/`, `src/discord/`, channel/deployment handlers in `src/http/app.ts` | Inspect each adapter and its provider prerequisites before enabling it |

See [current API boundaries](../../source-boundary.md). Extend the explicit browser
manifest only for the controls being enabled. Preserve organization scope, actor
permissions, same-origin mutations and server-held credentials. Customer website
sessions must use their own scoped admission, never the administrator's cookie
or a machine credential embedded in JavaScript.

## Stage 1: Finish the real Playground journey

- [ ] Resolve the owner's credential choice: reuse approved development credentials or configure separate backend credentials. Never put keys in chat, frontend bundles or Git.
- [ ] Start the API, database, client, Temporal server and worker using the existing documented setup. Confirm queue/namespace and billing mode; production credit enforcement stays intact.
- [ ] Create a fresh agent through the UI, choose its model/instructions and pin the saved version to Playground.
- [ ] Send a message and display the actual model response, recorded run status, progress and ordinary provider errors.
- [ ] Verify cancellation, safe retry, stream disconnect/reconnect and the final persisted outcome using the existing controls.
- [ ] Refresh and reopen both the conversation and agent detail; retain messages, selected version and visible run history.
- [ ] Finish the initial frontend acceptance and remove obsolete copied files only after confirming they have no retained consumers.

Normal check: one real create → test → reply → reopen journey, one cancellation,
one reconnect and one ordinary provider/setup error. No mocked reply counts as acceptance.

## Stage 2: Make simple and durable execution usable

- [ ] Trace the existing direct and Temporal paths. Reuse the common harness, provider adapters, admission and tool policies rather than creating a second runtime.
- [ ] Expose a clear agent execution setting and persist it in version/deployment configuration. Simple execution must not require a durable workflow for every message.
- [ ] Connect bounded direct execution for Playground and authenticated API invocation, with recorded messages/outcomes, deadlines, token/tool limits and cancellation.
- [ ] Preserve conversation ordering and allow unrelated conversations to progress independently. A saved chat is separate from durable orchestration state.
- [ ] Keep Temporal for durable waits/retries/approvals. Show queued, running, waiting and terminal states from backend records.
- [ ] Provide scoped API invocation credentials and readable request/error examples without exposing model-provider credentials.

Normal check: invoke the same simple agent through Playground and its API; verify
a limit/cancellation and two independent conversations. Run one durable wait,
restart its worker and resume it. Direct runs must report interruption accurately
rather than promise automatic recovery.

## Stage 3: Connect knowledge from setup to answers

- [ ] Enable the existing source list/create/read and text/file ingestion controls through scoped Agents browser routes.
- [ ] Connect Knowledge and agent setup to source readiness, ingestion errors, agent/source attachment and deletion. Keep conversation history, memory and knowledge distinct in the UI.
- [ ] Verify retrieval uses the selected agent's permitted sources and appears in recorded execution evidence.
- [ ] Reuse the existing file/storage/index path; identify any missing storage dependency before accepting uploads. Deletion must remove access to derived retrieval data.
- [ ] Add website ingestion only after text/file ingestion works; expose crawler/provider requirements and actual progress.

Normal check: upload a small FAQ, ask a question answered by it, inspect retrieval
evidence, then delete it and confirm it is no longer retrieved. Verify another
workspace cannot read the source. Check one invalid upload/ingestion error.

## Stage 4: Connect one useful tool and its approval flow

- [ ] Inspect the existing catalog, grants and credential adapters; enable their required browser endpoints with existing permission checks.
- [ ] Replace pending connection controls with real connection status, credential setup and per-agent grants. Optional Growth tools must remain explicit integrations.
- [ ] Connect one existing calendar/booking adapter using a dedicated test calendar; verify its provider/OAuth requirements first. Prefer the retained Google Calendar adapter if it is usable.
- [ ] Connect one external REST or MCP tool through the existing adapter path and versioned agent configuration.
- [ ] Enable approval requests and rich-response UI interactions needed by these tools. Review proposed action details and show the actual approved/rejected outcome.
- [ ] Display recorded tool attempts, receipts, failures and uncertain results. Preserve deadlines and duplicate protection; never report an unconfirmed booking as completed.

Normal check: retrieve availability, approve one real test booking/action, and see
the resulting receipt in the UI. Deny an ungranted tool. Show a failed or uncertain
action accurately and confirm retry does not repeat a known successful write.

## Stage 5: Publish a website agent

- [ ] Inspect the retained website deployment/widget source and identify any missing agent-owned pieces before implementing replacements.
- [ ] Connect publish/deployment controls to a pinned version and a website connection with allowed origins and scoped visitor sessions.
- [ ] Deliver an embeddable widget and a local sample website separate from the management app. Connect actual messages, streamed replies, conversation continuity and visible delivery errors.
- [ ] Keep draft and live versions distinct. Editing the draft must not silently change the website agent; pause/resume must use backend state.
- [ ] Persist customer/channel identity and message ordering in Agents so the inbox sees the same conversation. No duplicate conversation store in the widget.

Normal check: install the widget on the sample website, send a visitor message,
receive a real reply, refresh and continue. Verify a disallowed origin fails,
a draft edit leaves live behavior pinned, and pausing suppresses new agent replies.
This stage authorizes local verification, not a production deployment.

## Stage 6: Make the Agents live inbox operational

- [ ] Reuse conversation/history/live-event and handoff handlers under scoped human browser admission. Keep visitor, teammate and machine identities distinct.
- [ ] Replace the pending Inbox screen with live conversation list/history, agent/channel/status filters, search, unread state and teammate assignment.
- [ ] Connect human reply, private notes, resolve/reopen and takeover/return-to-agent controls to existing backend commands.
- [ ] Enforce one reply owner. Takeover must suppress stale queued agent replies; private notes must never be delivered to customers.
- [ ] Show only supported pending/sent/failed/provider-confirmed delivery states. Preserve retry safeguards and channel restrictions.
- [ ] Reconnect live subscriptions from replay cursors and reload missed messages without duplication. Keep the backend authoritative across viewers.
- [ ] Record the working command/event contracts for later Growth integration. Do not modify Growth or introduce shared database access in this slice.

Normal check: visitor message → agent reply → teammate takeover → human reply
visible in the website widget → resolve/reopen → return to agent. Confirm a second
viewer updates, reconnect catches up, private notes remain internal and another
workspace is denied.

## Stage 7: Connect the first existing messaging channel

- [ ] Choose the retained Discord or WhatsApp adapter based on available source and an authorized test account. Record any external credentials/approval blocker.
- [ ] Enable connection, agent binding and health/error controls for that adapter. Keep provider credentials server-side.
- [ ] Connect inbound acceptance, webhook authenticity where applicable, duplicate handling and outbound delivery to the same Agents conversation/inbox ownership.
- [ ] Verify agent and human replies through the real channel, including takeover and a visible failed delivery.
- [ ] Keep Telegram, Facebook and Instagram explicitly pending until their own adapters and provider requirements are verified.

Normal check: one real incoming message and reply, one repeated delivery without
duplication, and one human takeover/reply through the channel. An unavailable
provider account blocks this stage, not unrelated completed stages.

## Completion and normal checks

- [ ] Record source changes, exact startup instructions, required external setup and short outcomes at each stage.
- [ ] Run typing/build and focused lint for changed code. Reuse targeted tests for changed behavior; add a small regression only when warranted.
- [ ] Verify the relevant browser journey and one normal failure before enabling its controls. Screens must expose real readiness and errors.
- [ ] Remove unused copied modules after their useful replacements work. Update the frontend checklist and the corresponding platform items without marking broader phases complete.
- [ ] Demonstrate the connected journey: sign in → create/configure → answer from knowledge → perform an approved tool action → publish website chat → manage it in the inbox; demonstrate the chosen messaging adapter separately.

Broad hardening, load tests, Kubernetes, production rollout, a full visual workflow
builder, additional social adapters and billing expansion follow later stages.
Our own filesystem personal runtime stays active in its [separate plan](PERSONAL_AGENT_RUNTIME_PLAN.md).
Growth consumes the working inbox APIs/events through platform phase 6B; shared
login alone does not grant cross-product conversation access.
