# Agents end-to-end implementation

Updated: 2026-10-06.
Status: Core implementation complete for the current phase. On 2026-10-06, the user explicitly deferred remaining end-to-end verification and requested that functionality be in place. External checks below remain unchecked as deferred work, not implementation blockers or claims of successful live verification. The model system supports 11 providers; only OpenRouter has recorded live reply evidence.

## Current phase decision, 2026-10-06

- [x] Put the core paths in place: agent setup, provider selection and credentials, simple/durable execution, knowledge, approved tools, website publication, inbox management and retained Discord setup/delivery.
- [x] Reuse completed minimal build and behavior checks. Do not run further end-to-end checks in this phase.
- [x] Defer external provider/BYOK, Firecrawl and Discord live verification until the user requests it. Their unchecked items retain the exact future checks and setup requirements.

This completes the current implementation goal. Production rollout, hardening and
later platform-roadmap features remain separate work.

## External setup for deferred verification, audited 2026-10-06

The core local implementation is in place. The remaining unchecked items require
external setup: an authorized Discord bot/account, Firecrawl credentials, and other
model-provider credentials for live replies and the two-provider BYOK journey.
The 18:22 UTC credential metadata audit confirmed those are still absent. Do not
repeat completed local checks or invent additional implementation to fill this wait.
The OpenRouter credential blocker is resolved, and the real create/reply/reopen journey passed on
2026-10-05. On 2026-10-06, the API returned 200 from both `/health/live` and
`/health/ready`, including database readiness. The frontend, local identity endpoint
and Temporal UI also responded. These checks do not repeat worker execution acceptance.

- Other-provider live acceptance is credential-dependent. Only `OPENROUTER_API_KEY`
  is configured in the local Agents .env. Valid credentials for another provider
  are needed for that provider's actual reply and the two-provider BYOK journey.
  Continue provider-independent implementation while those checks remain pending.
- Cancellation, retry, reload recovery and stream reconnect passed on 2026-10-06.
  The checks exposed and fixed a missing cancelled-run Retry control, a reused
  transcript key, and missing active-run metadata during initial conversation load.
  Do not require all eleven provider keys before advancing.
- Frontend cleanup completed on 2026-10-06. Removed ten superseded creation and
  unused Next loading files after checking references. Retained workflow source. Website visitor API/SSE and the live inbox are now implemented locally; embedded browser message/reply, refresh, human takeover and return-to-agent passed. Widget interruption recovery also passed after its transient-error repair.
- The visible `authentication_expired` callback belongs to an old login transaction.
  Start a fresh login at `http://localhost:3100`; use that hostname consistently
  with the configured callback. It does not invalidate the recorded successful run.
  Attaching to the old Studio tab timed out, but a fresh tab recovered the existing
  signed-in session and completed the cancellation/retry/reconnect checks.
- Later calendar and messaging acceptance requires its own external setup.
  Google Calendar OAuth settings and Discord/WhatsApp credentials were absent
  from the local Agents .env during this audit. Inspect adapter requirements and
  available authorized test accounts when those stages begin. This does not block
  local execution, knowledge or website/inbox implementation.

Next order:

1. Stage 1 completed. Keep its focused checks as regressions for changes to execution.
2. Stage 2 checkpoint collision fixed. Simple/direct execution, API keys, ordering and durable wait/restart acceptance have passed. Tool-specific approvals remain in Stage 4.
3. Knowledge, internal calendar approval/replay, website API/SSE and inbox ownership/reconnect passed locally. Remote MCP discovery, health, immutable pin removal and approved transport now work. Reviewed MCP result projection and reference previews now pass through browser approval and a real separate-service response. Website/inbox browser acceptance found and fixed a missing continuation delivery address. The remaining tool/knowledge failure checks and connected local journey now pass. Continue actual external setup and live channel acceptance when credentials are available.
4. Await external setup, then perform only the outstanding normal live journeys.
   Reuse completed local checks. Do not claim live acceptance for absent credentials.

The user has removed remaining external verification from the current phase's
completion gate. Earlier dated checkpoints below preserve the scope and evidence
at the time they were recorded. Do not interpret deferred checks as passed.

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
| Agent creation, versions and playground | `src/http/app.ts`, `src/db/repositories/agent-deployment-repository.ts`, `client/apps/agent-platform/src/components/dashboard/studio/` | Created through the UI, received a completed real model reply, then reopened the saved conversation and run history after refresh |
| Model and execution | `src/model/`, `src/system/kasiai-models.ts`, `src/runtime/`, `src/temporal/` | Eleven provider adapters and independent credentials; each provider has its own live catalog path and preset fallback. Organization BYOK catalog lookup is scoped to the selected organization/provider credential. One real provider reply is verified through OpenRouter; replies from other providers remain unverified |
| Knowledge and tools | `src/knowledge/`, `src/memory/`, `src/capabilities/`, `src/integrations/catalog.ts`, `src/mcp/` | Manual/file/single-URL ingestion and agent-scoped retrieval verified. Internal calendar approval completed through Studio with a persisted created-event receipt. Remote MCP transport and explicitly reviewed result fields verified with a separate local service; external provider credentials remain pending |
| Customer conversations and handoff | `src/db/repositories/conversation-repository.ts`, `src/db/repositories/handoff-repository.ts`, `src/actions/`, `src/events/postgres-conversation-notifications.ts` | Local inbox takeover/reply/private notes/resolve/reopen verified; backend cursor replay and browser inbox recovery after API interruption verified; widget recovered after API interruption without a page refresh |
| Channel delivery | `src/channels/`, `src/discord/`, channel/deployment handlers in `src/http/app.ts` | Inspect each adapter and its provider prerequisites before enabling it |

See [current API boundaries](../../source-boundary.md). Extend the explicit browser
manifest only for the controls being enabled. Preserve organization scope, actor
permissions, same-origin mutations and server-held credentials. Customer website
sessions must use their own scoped admission, never the administrator's cookie
or a machine credential embedded in JavaScript.

## Stage 1: Finish the real Playground journey

- [x] Keep model execution provider-neutral. The Agents UI and runtime expose OpenRouter, OpenAI, Anthropic, Gemini, DeepSeek, GLM, Kimi, MiniMax, xAI, OpenCode Go and OpenCode Zen; each provider has its own adapter, key mapping and live catalog endpoint. OpenRouter is only the current workspace default.
- [x] Configure the chosen provider's credential for the local Playground reply. The OpenRouter key was found in Agents Lab, kept only in the ignored Agents .env, and accepted by OpenRouter's auth endpoint. Never require OpenRouter, reuse a different provider's key or silently switch providers. This proves OpenRouter only; other providers need their own credentials and live checks.
- [x] Verify the local API/database and Temporal server/worker by processing a persisted Playground run. Local namespace is `default` and queue is `kasitek-agents-initial-ui`.
- [x] Confirm local `CREDIT_BILLING_MODE=disabled`, the documented local skip-settlement mode. No production billing configuration or enforcement code changed.
- [x] Create a fresh agent through the UI, choose its model/instructions and pin the saved version to Playground. On 2026-10-05, created `E2E FAQ Assistant 2026-10-05` in a fresh local workspace, selected the OpenRouter `openai/gpt-4o-mini` model, and saved published v1. The provider is changeable in agent model settings.
- [x] Send a message and display an actual provider response with its recorded run status and progress. The prompt asked how long an office is open from 09:00 to 17:00; OpenRouter returned 8 hours, and the Temporal run completed with its model/response events persisted.
- [x] Persist and display an actionable missing-provider-key setup error without exposing credentials. Verified with a real local Playground run while OpenRouter was unconfigured.
- [x] Verify the client reads durable run status after an event stream ends and recognizes terminal completion without inventing an event. Focused `agent-run-stream.test.ts` passed.
- [x] Verify cancellation, safe retry, stream disconnect/reconnect and the final persisted outcome through the existing Playground controls. On 2026-10-06 cancelled run `4e2620a9-9093-498e-b8be-c3af5d271334`, retried it successfully as `52117df1-92ed-47f0-9cb4-c1f256eb5b08`, and refreshed during the retry. A separate run `c9d78c12-2278-4484-a535-4026083496c8` recovered after the local API process was interrupted/restarted, completed at event cursor 75, and displayed one prompt and one completion event.
- [x] Refresh and reopen the existing failed Playground conversation; its prompts, terminal status, setup guidance and durable run timeline remain visible.
- [x] After the successful provider reply, refresh and reopen the saved conversation; the prompt, answer, published version, completed status and persisted event history remained visible.
- [x] Finish the initial frontend acceptance and remove obsolete copied files only after confirming they have no retained consumers. Agent list/detail navigation and restored run history passed. Removed the old creation wizard and its exclusive helpers plus unused Next loading files; frontend build passed. Production proxy live acceptance remains a separate deployment check.

### Multi-provider support and acceptance

The current registry exposes OpenRouter, OpenAI, Anthropic, Gemini, DeepSeek, GLM, Kimi,
MiniMax, xAI, OpenCode Go and OpenCode Zen. No provider is required to configure or use
another provider's key.

- [x] Code-level coverage: every provider has a gateway adapter, a distinct managed-key
  environment name, provider-specific credential verification and catalog request, a response
  parser, and a provider-specific preset fallback. When a managed provider key is configured,
  its models are discovered independently; unavailable or unconfigured providers keep their own
  preset entries. Focused checks pass in `test/model-adapters.test.ts`,
  `test/opencode.test.ts`, `test/credential-verification.test.ts`,
  `test/model-credential-failure.test.ts` and `test/kasiai-models.test.ts`.
- [x] Add saved-credential catalog discovery for KasiAi Models. The API resolves the reference
  within the authenticated organization and provider, returns model metadata only, and does not
  cache BYOK results across credentials. The preference update checks selected models against
  the same provider credential. `test/model-catalog-route.test.ts` covers workspace isolation;
  `test/browser-agent-routes.test.ts` covers read-only browser access for viewers.
- [ ] Verify organization BYOK through the browser: add and select credentials for two
  different providers, confirm each is saved with its provider, and reject mismatched
  provider/key pairs.
- [ ] Run and record a real Playground reply for each provider using its own valid credential.
  A successful call through one provider does not prove any other provider works.
- [x] Expand model discovery beyond OpenRouter. Each of the 11 providers now has an independent
  catalog endpoint and normalizer; saved organization credentials can retrieve that provider's
  live list without sending the key to the browser or sharing a cache entry. Provider catalogs
  whose upstream response cannot be read retain provider-specific preset models.
- [x] Keep the OpenCode Go/Zen picker aligned with the gateway's actual wire support. Those
  catalogs mix Chat Completions, Responses, Anthropic Messages, Gemini and System One models.
  The gateway now routes the first four protocols by provider and model family; typed System One
  models and unclassified IDs stay out of the chat picker. See the [OpenCode Zen model
  endpoints](https://opencode.ai/docs/en/zen/) and [OpenCode Go model endpoints](https://opencode.ai/docs/go/).

Mocked provider responses verify catalog parsing, OpenCode protocol filtering and credential
isolation. Real upstream catalog and completion checks remain pending until provider credentials
are configured for the run.

The real create → test → reply → reopen journey is now verified for OpenRouter.
Stage 1 cancellation, safe retry, reconnect and frontend cleanup are verified.
The missing-key setup error is also verified. Additional
provider and two-provider BYOK live checks remain credential-dependent acceptance;
they do not block Stage 2. Claim a provider as live-verified only after its own real
reply. No mocked reply counts as live acceptance.

## Stage 2: Make simple and durable execution usable

- [x] Trace the existing direct and Temporal paths. `src/invocation/immediate-read.ts` supports immediate read-only capability execution, while `src/http/server.ts` dispatches model runs into `src/temporal/workflows.ts`. The shared harness/provider/tool policy runs in `src/temporal/activities.ts`; its current production model slices defer tool execution to the workflow. Stage 2 must reuse those execution dependencies rather than treating the immediate capability path as a complete direct agent runtime.
- [x] Expose a clear agent execution setting and persist it in version/deployment configuration. Studio Runtime settings save `simple` or `durable` in the version, which is applied by pinning the version to Playground. Typed specs and version input validation reject unsupported values. Simple execution does not require a Temporal workflow.
- [x] Connect bounded direct execution for Playground and authenticated API invocation, with recorded messages/outcomes, deadlines, token/tool limits and cancellation. `SimpleRunExecutor` reuses the existing execution activities/harness with direct tool execution, the shared provider adapters and lifecycle. It provides per-run abort signals and a deadline capped at five minutes; existing runtime budgets remain authoritative. Real Playground and scoped internal-token REST replies passed with `TEMPORAL_ENABLED=false` in the API process, plus real Playground cancellation. Self-service installation API credentials and their real invocation journey are also verified below.
- [x] Reconcile abruptly interrupted simple runs after their saved deadline. Startup and periodic checks record one interrupted failure, preserve terminal results and release the conversation lease. Real API interruption/restart acceptance passed on 2026-10-06. Simple requests are not resumed automatically.
- [x] Preserve conversation ordering and allow unrelated conversations to progress independently. Real simple-run acceptance completed a short response in chat B while chat A was still running; a second message in busy chat A returned 409, then a later accepted turn recalled its earlier test code. Saved chat remains separate from Temporal orchestration state.
- [x] Keep Temporal for durable waits/retries/approvals. Show queued, running, waiting and terminal states from backend records. A real workflow wait survived worker stop/restart, resumed through Studio Send event, received a provider reply and completed in Temporal. The browser alias enforces workspace admission; mismatched wait keys return 409. Retained tool-specific approval execution and its interactive acceptance remain Stage 4 work.
- [x] Provide scoped API invocation credentials and readable request/error examples without exposing model-provider credentials. Agent Settings creates copy-once hosted installation keys with expiry and revocation. Explicit `/api/v1/agent` aliases reuse Playground admission/execution, check run/conversation installation scope, and revalidate keys during streams. Real key → message → reply → revoke acceptance passed on 2026-10-06; examples and ordinary errors are documented in README.
- [x] Fix the conversation-less internal `/v1/runs` compaction checkpoint failure. Migration 181 scopes identical source evidence to its installation, run and turn; retries still deduplicate. A real standalone API run returned a model reply, and the original long-input reproduction committed its checkpoint before deliberate cancellation.

Normal check: invoke the same simple agent through Playground and its API; verify
a limit/cancellation and two independent conversations. Run one durable wait,
restart its worker and resume it. Direct runs must report interruption accurately
rather than promise automatic recovery.

## Stage 3: Connect knowledge from setup to answers

- [x] Expose the existing source list/create/read/delete and manual text-ingestion controls through scoped Agents browser routes. A signed-in workspace member created, saw and deleted a temporary FAQ in the agent detail screen.
- [ ] Finish website crawl ingestion and progress acceptance. File and single-page URL ingestion passed local acceptance through the real Knowledge UI; unsupported files return 422 and URL fetch failures now report an actionable 422. The Firecrawl website journey still requires a configured crawler.
- [x] Show source readiness in Knowledge, including processing/failure/empty states and whether search is semantic plus keyword or keyword-only, with indexed section count when available.
- [x] Surface actionable ingestion errors and verify that sources are attached to the intended agent. Invalid-file and URL errors are readable; rejected uploads clean up their newly created empty source. Uncertain uploads retain their source for inspection. Agent/workspace source isolation passed. Conversation history, memory and knowledge have separate controls.
- [x] Verify retrieval uses the selected agent's permitted sources and appears in recorded execution evidence. Uploaded FAQ acceptance recorded its exact chunk in the retrieval step and excluded another agent and workspace.
- [x] Reuse the existing file/storage/index path. The FAQ file uploads through multipart, stores extracted text and indexes in PostgreSQL without an object-storage dependency for this path. Deletion removes the source and derived chunks from retrieval.
- [x] Add website ingestion after text/file ingestion works; expose crawler/provider requirements and actual progress. Crawl start/status/cancel endpoints and source polling are connected. Source status now retains provider page counts and displays them. Empty completed crawls fail explicitly. Live Firecrawl acceptance remains the unchecked item above.

Normal check: upload a small FAQ, ask a question answered by it, inspect retrieval
evidence, then delete it and confirm it is no longer retrieved. Verify another
workspace cannot read the source. Check one invalid upload/ingestion error.

## Stage 4: Connect one useful tool and its approval flow

- [x] Inspect the existing catalog, grants and credential adapters; enable their required browser endpoints with existing permission checks. Explicit aliases cover catalog, integration setup, grants, connectors and approval groups. Member/viewer, session and cross-origin checks passed.
- [x] Replace pending connection controls for the selected tools with real connection status, credential setup and per-agent grants. Remote MCP exposes health, saved credential reference, reviewed results and per-version enable/remove controls. Calendar uses the existing internal workspace adapter. Other integrations remain explicit and require their own setup; no Growth shared account is implicitly connected.
- [x] Connect one existing calendar/booking adapter using a dedicated test calendar; verify its provider/OAuth requirements first. The internal calendar passed real approve, reject, replay and readback. Google OAuth is not configured, so no Google Calendar acceptance is claimed.
- [x] Connect one external REST or MCP tool through the existing adapter path and versioned agent configuration. MCP setup, healthy published pins, browser approval and a real separate-service call passed. Publishing a discovered provider version now requires explicit result-field review. Only reviewed scalar JSON fields reach the model; the raw result stays redacted. Browser approval displayed reference COBALT-MCP-739, and the completed run reported its confirmed status.
- [x] Enable approval requests and rich-response UI interactions needed by these tools. Calendar approval previews and approve/reject controls are connected. Browser approval completed one real internal-calendar action; calendar rejection passed without a write. Its stale attempt-state defect was fixed and a fresh real rejection saved failed/APPROVAL_REJECTED. Remote MCP reference preview and reviewed result acceptance now pass; richer platform/ui-interactions remain outside this browser slice.
- [x] Display recorded tool attempts, receipts, failures and uncertain results. Calendar and remote MCP approval outcomes have durable records. Direct ungranted calls fail with actionable TOOL_NOT_GRANTED and no proposal or effect. Final summaries now retain deferred tool evidence. Successful-write replay did not duplicate the calendar event; uncertainty remains explicitly distinct from completion.

Normal check: retrieve availability, approve one real test booking/action, and see
the resulting receipt in the UI. Deny an ungranted tool. Show a failed or uncertain
action accurately and confirm retry does not repeat a known successful write.

## Stage 5: Publish a website agent

- [x] Inspect the retained website deployment/widget source and identify any missing agent-owned pieces before implementing replacements. The UI is retained in Agents, but backend routes, assets and visitor/deployment storage still belong to Growth Core. Agents needs its own scoped implementation; do not forward administrator cookies or depend on Growth's database.
- [x] Connect publish/deployment controls to a pinned version and a website connection with allowed origins and scoped visitor sessions. Verified independent live installation, origin admission and expiring hashed visitor capabilities.
- [x] Deliver an embeddable widget and a local sample website separate from the management app. Browser message/reply, refresh/continue, human reply and private-note isolation passed. After an actual API interruption, the widget showed a readable unavailable error and recovered without a page refresh. Final recovery check 741 returned 37 credits per month. Transient stream errors retry, bounded fetch lifetimes prevent stalled proxy reads, and periodic history reload catches missed replies with message-ID deduplication.
- [x] Keep draft and live versions distinct. Published v1 remained pinned after draft v2; management pause/resume changed backend state and paused visitor messages were denied.
- [x] Persist customer/channel identity and message ordering in Agents so the inbox sees the same conversation. Visitor messages use the existing customer conversation repository; replay returned the same message/run IDs.

Normal check: install the widget on the sample website, send a visitor message,
receive a real reply, refresh and continue. Verify a disallowed origin fails,
a draft edit leaves live behavior pinned, and pausing suppresses new agent replies.
This stage authorizes local verification, not a production deployment.

## Stage 6: Make the Agents live inbox operational

- [x] Reuse conversation/history/live-event and handoff handlers under scoped human browser admission. Explicit aliases enforce workspace roles and same-origin mutations; visitor capabilities remain separate.
- [x] Replace the pending Inbox screen with live list/history, agent/channel/status/search/assignment filters, existing unread projection and self-assignment/unassignment. Lists currently cap at 200; arbitrary teammate reassignment and per-teammate unread tracking are later improvements.
- [x] Connect human reply, private notes, resolve/reopen and takeover/return-to-agent controls. Browser journey and persisted ownership events passed.
- [x] Enforce one reply owner. Queued-reply regression failed before the fix and passed afterward; local publication serializes with takeover. New visitor messages persist without creating agent runs during takeover. Private notes stayed out of visitor history. External in-flight sends cannot be recalled.
- [x] Show persisted delivery states without inventing provider confirmations. Human retry regression failed before the fix; repeated known-successful writes now return the same message ID. Another teammate and another workspace were denied.
- [x] Reconnect inbox subscriptions from replay cursors and reload missed messages without duplication. Backend interrupted-stream acceptance passed with an offline ownership change and replay cursor 742 → 744. Browser inbox recovered after the actual local API process was stopped and restarted; one Recovery check 740 prompt and its sent reply appeared in persisted history and the inbox. Widget recovery is tracked separately in Stage 5.
- [x] Record working command/event contracts in `docs/source-boundary.md`. Growth remains a later API/event consumer; no Growth edits or shared database access.

Normal check: visitor message → agent reply → teammate takeover → human reply
visible in the website widget → resolve/reopen → return to agent. Confirm a second
viewer updates, reconnect catches up, private notes remain internal and another
workspace is denied.

## Stage 7: Connect the first existing messaging channel

- [ ] Choose the retained Discord or WhatsApp adapter based on available source and an authorized test account. Record any external credentials/approval blocker.
- [x] Enable retained Discord connection setup and agent-scoped channel status/error controls. Scoped channel read/create/pairing/disconnect aliases admit members and deny viewer mutations, foreign origins and ingestion endpoints. The browser setup dialog passed a rejected-token check without creating a connection. Its screen reads Agents channels, offers status refresh, reports gateway status separately from token verification and does not call Growth’s /api/connections. Provider credentials stay server-side. A valid bot/account and live channel acceptance remain unchecked below.
- [ ] Connect inbound acceptance, webhook authenticity where applicable, duplicate handling and outbound delivery to the same Agents conversation/inbox ownership.
- [ ] Verify agent and human replies through the real channel, including takeover and a visible failed delivery.
- [x] Keep Telegram, Facebook and Instagram explicitly pending until their own adapters and provider requirements are verified. Agent connection buttons are disabled with pending guidance; their inherited backend source is retained.

Normal check: one real incoming message and reply, one repeated delivery without
duplication, and one human takeover/reply through the channel. An unavailable
provider account blocks this stage, not unrelated completed stages.

## Completion and normal checks

Current user priority: core implementation with minimal normal checks. Reuse passed evidence. Do not repeat broad suites, add exhaustive provider tests, or begin hardening in this phase. Remaining external live and end-to-end checks are deferred by explicit user instruction and do not gate completion of this implementation phase.

- [x] Record source changes, exact startup instructions, required external setup and short outcomes at each stage. README includes the local process commands; the dated checkpoints distinguish implemented local behavior from unverified external acceptance.
- [x] Run typing/build and focused lint for changed code. Backend build, frontend type check and production build, focused frontend lint and the small regressions for changed core behavior passed. Existing successful checks were reused; no broad hardening suite was added.
- [ ] Verify the relevant browser journey and one normal failure before enabling its controls. Screens must expose real readiness and errors.
- [x] Remove unused copied modules after their useful replacements work. Ten superseded creation/loading files were removed and the frontend checklist updated; broader platform phases remain separate.
- [x] Demonstrate the connected local journey: sign in → create/configure → answer from knowledge → perform an approved tool action → publish website chat → manage it in the inbox. The same customer-service agent completed FAQ retrieval, browser-approved MCP lookup, independently pinned website publication, website FAQ answer and inbox takeover/reply delivery.
- [ ] Demonstrate the chosen messaging adapter separately using an authorized Discord test bot/account.

Broad hardening, load tests, Kubernetes, production rollout, a full visual workflow
builder, additional social adapters and billing expansion follow later stages.
Our own filesystem personal runtime stays active in its [separate plan](PERSONAL_AGENT_RUNTIME_PLAN.md).
Growth consumes the working inbox APIs/events through platform phase 6B; shared
login alone does not grant cross-product conversation access.

## Simple execution checkpoint, 2026-10-06

- Playground v2 of the local FAQ fixture saved `executionStrategy=simple`. A real
  OpenRouter run `15c9c79a-8618-41ba-8e4f-594db6077db3` answered 12 × 7 with 84.
  API readiness reported Temporal disabled, and Temporal reported no workflow for
  that run ID. Run events, response and terminal output were saved.
- Real simple cancellation reached cancelled for run
  `3a24f4de-57cb-4875-b6be-9630a5657c05`.
- Authenticated REST `/v1/runs` accepted run
  `c4db6467-4390-4f6e-9800-7eeab283242c` with `durable=false`; it completed with
  `executionStrategy=simple` and answered 15 + 9 with 24. This uses a locally
  signed internal token with only runs:write/runs:read, not a self-service public key.
- The REST check exposed row-lock/RLS incompatibility in version snapshot admission.
  Under the actual scoped runtime role, locking version plus snapshot returned zero
  rows, while locking only version returned one. Admission now locks the version
  pin and reads the immutable snapshot without an UPDATE-dependent row lock. No
  grants or RLS policy changed. The subsequent real REST run passed.
- Simple runs use per-run cancellation/deadline signals, common admission/session
  lease handling and the existing budget/tool permissions. A durable wait requires
  durable mode; pending approval/handoff state is cancelled before recording that
  failure. Graceful process shutdown records interruption rather than resuming it.
- Focused checks cover separate cancellation signals for concurrent runs, deadline
  expiration without a late success, refusal of durable waits, strategy validation
  and HTTP dispatch without Temporal. Backend/frontend compilation and the production
  UI build are the ordinary checks for this slice.
- The API's normal Temporal-enabled startup was restored after the isolated check.
  Channel entry points are not yet connected to the simple dispatcher; add that
  when implementing website/messaging delivery.
- Real independent conversations and a durable wait surviving worker restart
  are now verified. Self-service scoped API credentials are implemented and their
  real REST journey is verified below.
  A conversation-less large-context REST check also hit `memory_checkpoint_blocked`;
  investigate checkpoint scope before claiming complete public API acceptance.
  Abrupt process-loss reconciliation is implemented. Startup and periodic checks
  consider only runs with persisted simple dispatch evidence and elapsed deadlines
  plus a 30-second grace. The existing locked terminal write preserves concurrently
  completed outcomes, records the interruption and releases the conversation lease.
  Requests are never restarted automatically. On 2026-10-06, interrupted a real
  running simple request `ef3f5113-d2b0-4a55-98b1-244fc83fb575` with an abrupt
  API stop. After restart and its saved two-minute limit plus grace, it recorded
  exactly one `SIMPLE_EXECUTION_INTERRUPTED` failure and released the session lease.
  A second reconciliation found zero overdue runs and made no duplicate changes.
  A subsequent request in the same conversation completed as
  `7b269d7a-a699-4b03-b993-985b6b01bc06` with the real answer "9 times 8 is 72."
  Five focused execution/reconciliation tests and backend compilation passed.


## Hosted API key checkpoint, 2026-10-06

- Agent Settings exposes hosted API key creation, expiry, usage metadata and revocation.
  Keys are separate from provider vault secrets and external-connected installation
  credentials. Only a SHA-256 hash of each randomly generated 256-bit secret is stored.
  Plaintext is returned once, kept only in UI memory, and omitted from key lists.
- Keys use the creating workspace member's identity and one custom hosted installation.
  Revocation, expiry, installation pause/disable, and creator membership revocation or
  downgrade deny new requests. Browser requests cannot use this server credential.
  Run and conversation lookups enforce the installation scope before shared handlers.
- Public messages require a saved conversation or `createNew=true`; they use the same
  message admission, session and dispatch path as Playground. Model overrides and
  other internal endpoints are not exposed by these keys. This public path avoids
  the conversation-less internal REST scope problem recorded above; that internal
  large-context path still needs investigation.
- Real acceptance created key `f95f1283-0d63-4581-860a-71be9d584aa4`, admitted simple
  run `8fd7d8d8-ca5c-47cc-b088-548ea0f1cc45` in a fresh conversation and received
  "6 times 7 is 42." Revocation returned 204 and the next request returned 401.
  Both local test keys were revoked. No secret was printed or persisted in test files.
- Browser inspection confirmed the controls and revoked usage records in Agent
  Settings. Ten focused route/browser admission tests, backend compilation,
  frontend typecheck and production build passed. Migration 180 was applied only
  to the local Agents database on port 55434. Production migration is separate.


## Conversation and durable-wait checkpoint, 2026-10-06

- Chat A run `ee00e7ff-1878-4533-8610-83e90187ff57` requested a long FAQ guide.
  Chat B run `01ed351e-afab-4c1b-8609-0ab6d671bb1b` completed with "13 plus 4
  equals 17" while A remained running. A concurrent new message in A returned
  409 `conversation_busy`. After A completed, follow-up run
  `1a244c98-27c8-40a9-97bf-e64188e1cbae` recalled "cobalt" from its saved history.
  The temporary installation API key was revoked after this check.
- Durable fixture run `c754ae44-6179-4ec4-9943-f99a5c01ae87` paused at the
  workflow's `acceptance.continue` wait. Stopped the local worker and verified the
  persisted run still awaited that event. Restarted the worker, opened the same
  run in Studio and sent its event through the browser control. The shared model
  runtime returned "The answer is 12." Temporal independently reported
  `WORKFLOW_EXECUTION_STATUS_COMPLETED` for the same workflow.
- Connected the retained Studio event control to an explicit browser route with
  membership/write/origin checks. A wrong event key now returns 409 before any
  signal. Updated waiting/queued labels to read saved run status and corrected
  readiness to recognize the version's `modelProvider`, matching runtime selection.
  The real browser changed from a false credential blocker to Ready.
- A second browser-created run `e6430993-0895-4f01-9525-7ee79a2a6b6c` displayed
  "Waiting for an event" with the event control. Cancelled it through Studio and
  verified its terminal cancelled state. The completed first response remains saved.
- Focused external-event rejection and browser permission checks passed, as did
  backend build and frontend typecheck. The local API and restarted worker remain
  running. Tool-specific approvals, knowledge, website deployment, live inbox and
  messaging acceptance are still required; this checkpoint does not finish the goal.

## Resumed implementation evidence, 2026-10-06

- Root cause of the standalone checkpoint failure was organization-wide evidence
  deduplication. Two runs with the same empty evidence digest and boundary collided
  despite different owners. Migration 181 adds installation/run/turn identity to
  that uniqueness boundary. Both repositories resolve replays within the same
  ownership boundary; RLS and scope validation remain in place.
- Eight memory-capture database checks passed, including concurrent replay,
  independent runs/turns and recovery. Backend compilation passed. Standalone
  run `288f6515-2f91-4782-b162-709328ea4147` completed with "2 plus 3 equals 5."
  The original long-input reproduction `e91c61b0-3881-4ab3-8ad2-2cc268fcb801`
  committed its memory checkpoint and was deliberately cancelled afterward.
- Uploaded a temporary FAQ through the live multipart API. Run
  `dfc4c69e-f458-4c98-bd20-1d06fdc57671` answered its exact price and support
  code, and its retrieval step recorded the uploaded chunk. Another workspace
  returned 404; another agent excluded that source. An unsupported upload returned
  422. Deleted the temporary FAQ and verified it no longer appeared in retrieval.
- A local HTTP fixture verified single-URL ingestion. Its missing-page reproduction
  originally returned a generic 500. The endpoint now returns 422 with the actual
  fetch error and a stable `knowledge_url_ingestion_failed` code. Existing indexed
  content is preserved when a refresh fetch fails.
- Debug reproduction scripts and local evidence are kept in the ignored
  `.artifacts/` directory. No temporary instrumentation was added to production
  code. The goal remains active; website crawling, tools, website deployment,
  live inbox and messaging acceptance are still outstanding.

## Calendar approval and website ownership checkpoint, 2026-10-06

- Connected retained integration/tool controls to explicit browser endpoints and
  added workspace permission and same-origin admission checks. OAuth start is a
  browser POST, retaining the internal GET handler. Viewers can read setup state
  but cannot grant tools or approve actions.
- Calendar previews now show bounded title, source, start/end, timezone and
  location fields when supplied. Secret fields remain excluded. Studio loads the
  conversation belonging to its selected run instead of showing an earlier chat.
- Approved run `116fd602-5a2a-4ded-9bd9-b5a303888d4d` through the browser.
  The calendar tool completed and the model confirmed its result. Independently
  verified exactly one active event `5ed5bf24-0ee8-4f95-9d06-2ab4fa77552e`,
  titled Local approval acceptance, on 2026-10-07 from 10:00 to 10:30 UTC.
  No external calendar or attendees were used. Google Calendar setup, rejection,
  duplicate-write acceptance and external REST/MCP remain unchecked.
- Knowledge exposes crawler readiness and disables website crawling when
  Firecrawl is unconfigured. File and single-URL support continues to work without
  Firecrawl; a real website crawl is still pending its provider configuration.
- Added Agents-owned website deployment storage and scoped management routes.
  Creation atomically pins a separate live installation and website channel,
  independent of Playground. Website scope keys identify individual deployments,
  allowing separate websites to be paused independently. Release mode is pinned.
- Local runtime-role database acceptance created deployment
  `a197d7c9-d5d3-4489-9101-36fc027f63e4`, with source installation
  `e15bd3a5-b863-4891-8929-9bba9e113303` and live installation
  `a0e09f3c-e8f1-4a15-83ef-952899024191`. The live installation retained
  published v1 after draft v2 was created. Pause/resume changed backend state;
  another workspace could not list it; partial appearance updates retained the
  other settings. Migration 182 applied only to local Agents PostgreSQL.
- Visitor admission, embed assets, saved history and scoped live streams now work locally. Real run `d59e0a10-191c-4b9d-94a4-d6bae1518b73` answered “Cobalt Lantern costs 37 credits per month.” Disallowed origins and invalid visitor tokens failed; replay did not duplicate the message or run.
- Live-stream run `4393ee08-8c40-4c25-8d83-9c8f48814849` delivered the same correct answer. Reconnecting from cursor 2 produced no duplicate messages; saved history contained two messages. This streams completed messages, not model tokens.
- The management browser showed the existing deployment, enabled Copy embed, and successfully paused/resumed it. The separate sample website renders the widget. Browser automation could not submit inside the cross-origin iframe, so full browser visitor acceptance remains unchecked; the real visitor HTTP/SSE journey passed.
- Fixed two live execution defects: undefined optional limits overwrote runtime defaults, and canonical session transcripts omitted newly assembled instructions/knowledge. The runtime regression failed before its fix; the real visitor pricing journey failed before the context fix and passed afterward.
- Migrations 182/183 applied only to local Agents PostgreSQL. Forty focused route/runtime checks, backend compilation, frontend typing and production build passed. Evidence scripts and scoped results are in ignored `.artifacts/website-*-smoke.ts` and `.artifacts/website-*-evidence.json`. No production publication.
- The formal goal remains active. Next work is the live inbox and human takeover, followed by remaining tool and external-provider/channel acceptance. Missing external credentials do not block local implementation.

### Live inbox checkpoint, 2026-10-06

- Real visitor run `1e8da9bb-4e96-4b47-86f5-3729e5c18430` answered 37 credits.
  Conversation `38b07d84-a3c7-4d67-a481-b2ef626d5d60` was taken over in the
  browser. Human message `a945f7e0-3f0e-4417-9991-3d9f2891d648` reached the
  visitor history; Private acceptance note 739 was saved only in teammate history.
- Browser resolve/reopen/return passed. Repeated successful reply returned one
  message `5aa7d8a7-a626-4267-9fa5-c7ae8fb7cb25`. Foreign-workspace read/takeover
  and another actor's human reply were denied. Proof: ignored
  `.artifacts/inbox-control-evidence.json` and `.artifacts/inbox-live-evidence.json`.
- Found/fixed three real defects: queued automation remained claimable after takeover;
  inbound customer messages were discarded during human ownership; outbound receipts
  overwrote human retry keys. Original live regressions failed before fixes and passed
  afterward. Claim/publication ownership also has three focused regression tests.
- Corrected inbound conversation `37e0dda4-7dae-4e17-bbb6-fbb12fa6996a` persisted a
  new visitor message exactly once during takeover, returned no agent run, and safely
  replayed the same message. Debug reproduction scripts are ignored `.artifacts`.
- Second browser viewer received the saved note through live list updates. Full
  interrupted-stream cursor acceptance remains unchecked. Widget visitor browser
  submission is still unverified due to the cross-origin iframe automation limitation.
- Focused browser admission, channel ownership, handoff repository/consent checks
  passed (26). Backend compile, frontend typing/build and focused Inbox lint passed.
  No production deployment, remote push or branch change.
- Goal remains active. Remaining work includes external REST/MCP acceptance, calendar
  rejection/failed-write checks, embedded widget browser acceptance, inbox reconnect
  acceptance, then the first messaging channel with an authorized test account.


### MCP and reconnect checkpoint, 2026-10-06

- Added explicit member/same-origin browser aliases and agent Tools controls for
  remote MCP provider setup, discovery, health, version publication and Playground
  pin changes. Credential input references a server-held saved credential.
- Fixed approval revalidation missing reviewed MCP registrations/allowlist entries.
  Its focused HTTP regression reproduced 403 before the fix and passed afterward.
  Fixed deferred tool activities loading no MCP tools on a fresh worker. Each
  activity now loads the run version's healthy published pins, and dispatch rejects
  a stale cached tool when its pin is no longer effective.
- Run `93636349-1104-4e59-80ee-ffd6132b2226` was approved in Studio and completed.
  A separate localhost MCP service recorded exactly one `lookup_booking` request
  for synthetic reference COBALT-MCP-739. The model acknowledged execution but
  could not report the status because the retained manifest redacts `result`.
  Transport works; useful MCP result projection and bounded approval selectors
  remain implementation work. Do not weaken redaction indiscriminately.
- Browser health check and pin removal passed. Removal produced version
  `3253ed7a-8367-44ce-b2f4-f2a6770c2f61`; previous version
  `d6776f88-f995-43b8-8362-d4c71a83b55b` retained its pin. The fixture's current
  Playground intentionally has no MCP pin after this removal check.
- Inbox stream disconnected after takeover at cursor 742, then replayed the offline
  return-to-agent event at 744 with no earlier cursor or duplicate. Saved ownership
  was agent_active. Full browser interruption acceptance remains unchecked.
- Calendar replay run `da158f61-5094-44d2-8938-dcf122aed516` was approved in
  Studio. It returned the existing event `5ed5bf24-0ee8-4f95-9d06-2ab4fa77552e`;
  the scoped database check still found exactly one active event.
- Twenty-nine focused browser-admission/approval checks, backend compilation and
  focused MCP UI lint passed. Debug scripts and evidence remain ignored under
  `.artifacts/`. No remote push, deployment or branch changes.
- Goal remains active. Continue reviewed MCP preview/output,
  browser reconnect/widget acceptance, then channel setup. Real Google/Firecrawl,
  additional model-provider and messaging acceptance require their own credentials.

- Calendar rejection run `9aae92ca-ba59-4b87-8f44-b73db370cc6d` completed with
  a rejected-action answer. The scoped event check remained exactly one prior
  event. Found a separate persistence defect: workflow-synthesized rejection
  results reach the transcript but the invocation remains awaiting_approval.
  Fix terminal attempt persistence in `commitToolBatch`; do not claim this saved
  timeline is correct yet. No provider invocation was attempted for the rejection.

- Fixed that rejected-attempt persistence defect in `commitToolBatch`. Workflow
  rejection/unselected/invalidated/cancelled/expired results now persist failure,
  not-executed effect receipts and an idempotent failure event before transcript
  commit. Fresh run `09ccc6bf-52de-4675-86e1-cb6a2b4c5daf` completed with
  saved tool status failed and APPROVAL_REJECTED. The calendar still held exactly
  one prior event. Backend compilation passed after this fix. Earlier local debug
  runs retain their historical stale invocation state; no blanket data rewrite.

## Reviewed MCP and website browser checkpoint, 2026-10-06

- Provider revision 3 reviewed `reference,status` before publication. Run
  `7823d93e-249c-433b-aa6f-20328dfb61fa` passed through browser approval,
  called the separate MCP fixture and answered that COBALT-MCP-739 was confirmed.
  Its saved output retains the raw result as `[REDACTED]` and the two reviewed
  scalar fields separately. Canonical tools mentioned in the instructions are
  prioritized within the model tool budget, after grant/readiness filtering.
- Website browser conversation `ad1aa08b-fa6b-4f7c-bc7a-1c03e1fce620`
  answered the indexed monthly price, restored its history after refresh,
  displayed a teammate reply and excluded the private note. Resolve/reopen and
  return-to-agent controls passed. The first continuation exposed a missing
  external conversation address. A fresh continuation after the fix saved a
  sent reply with the same channel binding and customer address. Old failed
  attempts remain as actual history.
- Inbox recovered its history after an actual API process interruption. The
  widget showed “Website chat unavailable” on an attempted send while the
  API was stopped. Its stream could remain stalled behind the local proxy;
  bounded stream lifetime and periodic authoritative history reload now
  complement transient-error retries. The repaired browser recovered without refresh and displayed the reply to
  Final recovery check 741 once. The full widget item is now checked.
- Focused browser admission, website route, handoff and channel checks passed
  26 tests. Backend compilation and frontend typing passed. No production
  deployment or external messaging-account connection occurred.

## Discord setup checkpoint, 2026-10-06

- Enabled the existing Agents-owned channel endpoints under browser membership
  and same-origin checks. Existing scope grants never include channels:ingest.
- Removed the channel screen’s Growth connections request and enabled its
  retained Discord setup dialog. Shared social-account linking and other
  messaging buttons stay pending. Connection refresh reads actual stored
  gateway state; saving a verified token is distinct from a connected gateway.
- Browser submission of an intentionally invalid test token returned
  “Discord bot token could not be verified” and kept the setup dialog usable.
  No real bot/account was connected and no external chat was sent.
- Remaining live setup requires a dedicated authorized bot/account and the
  retained gateway process. See README for local startup. A screenshot is
  saved under .artifacts/discord-setup-error-browser.jpg.

## Calendar readback and failure cleanup checkpoint, 2026-10-06

- Actual calendar readback exposed PostgreSQL Date values becoming empty objects during redaction. Date serialization now preserves ISO timestamps while attendee and secret fields remain redacted. Run `c80b1a33-dc01-491f-86f7-53dfcf3cf5d6` read the approved 10:00–10:30 UTC event, proposed no write, and answered with that interval.
- The resumed model slice previously saved zero tool calls and empty used-tool evidence after a completed batch. Run evidence now includes this run's persisted terminal attempts and cumulative checkpoint count, without adding that cumulative total again to the next checkpoint. The same real calendar read saved one tool call and `kasitek.calendar.list` in provenance.
- Direct call to ungranted `kasitek.email.search` saved actionable `TOOL_NOT_GRANTED`, with no tool proposal or effect. Browser run detail displayed the error on `fd45b6b8-ee7e-4a70-bdf5-acefaef85992`. Built-in internal calendar tools are automatically available to active hosted installations; an allowedTools list is additive, not a deny-list. The calendar fixture's instruction to read only does not revoke its built-in write capabilities.
- Invalid PDF upload returned a readable 422 in the browser. Newly created sources are removed only for confirmed 413/422 failures before indexing. Uncertain failures retain the source. Empty sources say no indexing result is recorded. A scoped source/chunk check confirmed rejected test uploads left no empty source.
- Backend build and 12 focused checkpoint, Date-redaction and reviewed-MCP checks passed. No broad hardening suite was added. Proof is in ignored local `.artifacts/calendar-read-evidence.json`, `calendar-ungranted-evidence.json` and `knowledge-failure-evidence.json`.

## Connected local journey checkpoint, 2026-10-06

- Reused customer-service agent `fdf406a4-0245-4cc5-a455-ee97ed82197d`. Its agent-scoped FAQ produced 37 credits and support code COBALT-CONNECTED-746, with the exact source chunk recorded in retrieval evidence. The FAQ contains no confirmed booking status.
- In the same Playground conversation, run `9c8628a4-b9b5-460b-8f8c-274e6322eeaa` requested a booking lookup. Browser approval displayed the requested reference. The separate local MCP service returned a reviewed confirmed result, and the completed run retained one tool call and the tool name in provenance.
- Published website deployment `1bfcd49a-2082-4e75-b84a-2a338eb8e9f7` pins version `3d3a61b9-f00b-47ce-a6f0-da2fdd45ba64` in a separate Live installation. The real embedded browser answered the FAQ from the same agent's source. Inbox conversation `cfdd2787-921d-460b-9bc5-7649caa925ca` displayed that reply, allowed teammate takeover and delivered the teammate's reply back to the widget.
- Proof: ignored local `.artifacts/connected-journey-evidence.json`. Backend build, frontend type check, focused detail-page lint and 12 related regression checks passed. Existing recovery, rejection, replay, private-note and isolation checks were reused.
- Core local functionality is usable. Remaining external acceptance requires a configured crawler, an authorized Discord bot/account, and additional provider credentials for BYOK/live provider checks. Google Calendar OAuth was unavailable; the internal calendar acceptance is complete. No production deployment or external messaging acceptance is claimed. The full formal goal remains active.

## Core wiring audit checkpoint, 2026-10-06

- Website source polling previously discarded returned page counts. Status polling now persists provider-reported counts, and the source row displays processed/total pages. A provider reporting completion with no readable pages now returns a failed source and readable error. Two focused route checks passed; they verify local handling, not a live Firecrawl service.
- Inbox teammate Discord replies previously fell through to Growth delivery. They now select the conversation's own active Discord bot by channel key, resolve its server-side credential and call the retained Discord adapter. The existing delivery attempt records success/failure. Agent replies and handoff acknowledgements already had native Discord paths. Two focused success/failure checks and the backend build passed. Actual external Discord delivery remains unverified without an authorized bot/account.
- Credential metadata audit found the OpenRouter managed key configured, no other provider or Firecrawl keys, no Google OAuth settings, no active saved model/channel credentials in the acceptance workspace, and only website channel connections. The audit records presence/counts only, never secret values, in ignored `.artifacts/external-setup-audit.json`.
- README now includes exact local API, worker, frontend and Temporal startup commands, the non-secret local settings, and external crawler/Discord requirements. Existing Labs identity and PostgreSQL setup are prerequisites owned by their respective services.

## UI-added knowledge to website checkpoint, 2026-10-06

- Knowledge setup had an unconnected single-page path and created new sources scoped only to Playground. The UI now offers Add page using the retained bounded URL ingestion endpoint. Full website Crawl remains a separate crawler-backed action.
- New manual, file, page and crawl sources created in agent knowledge setup are agent-scoped. The existing workspace/agent checks remain enforced. Conversation memory is unchanged. This allows an independent published website installation to retrieve the same agent's authored knowledge. Previously installation-scoped fixture sources were not silently copied or widened.
- Through the real browser, Add page indexed `examples/website-chat/faq.txt`. Its source and chunks have null installation scope and the correct agent/workspace. Published website run `698ece9e-9c67-45d4-8c38-255510bad531` retrieved that exact chunk and answered 14 days and COBALT-PAGE-748. A missing page returned a readable HTTP 404 ingestion error and left no empty source. This proves URL setup through the UI to a real model answer in the published website, without a crawler key.
- Frontend typing, production build and focused detail-page lint passed. Reused the existing ingestion backend; no new suite or additional provider tests were added. Local proof is `.artifacts/page-knowledge-evidence.json`. Live full-site crawling and real messaging still require their own external setup.
