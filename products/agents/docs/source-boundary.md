# Implementation boundary

Owner: Agents engineering. Last reviewed: 2026-11-12.

Agents is a fresh standalone product. Its API and business worker use the dedicated
`agents_platform` PostgreSQL schema. Setup loads the ordered SQL files in
`api/schema/` into a fresh database and checks their combined digest on subsequent
startup. Explicit setup accepts only recognized preceding digests for supported additive upgrades.
It rejects unknown schemas and does not import Growth state.

Shared errors, initiating principals and canonical request digests are defined in
`contracts/primitives.ts`; capability contracts do not import agent configuration to obtain them.
`contracts/channel.ts` owns the handoff-feedback snapshot schema and fixed receipt deadline, while
execution validates complete model-message groups. Support schedule calculations and aggregate
presence reads belong to the support capabilities; Inbox owns presence updates and waiting notices.

## Business workflow boundary

`contracts/procedures.ts` owns versioned definition references and durable progress contracts.
`contracts/procedure-definitions.ts` contains the first immutable playbook,
`after-hours-assistance@1`; `execution/procedures/store.ts` owns instance/revision/idempotency
storage. Schemas116/117 add procedure state and the independent human-assistance request domain.
`capabilities/procedure-tools.ts` exposes discovery, loading, lifecycle and support request tools
to the existing business model loop. Procedures grant no capability authority.

Per-agent `configuration.procedures` defaults to empty. The authenticated
`GET /api/organizations/:organizationId/agents/:agentId/procedures` catalogue powers
Behaviour → Tools → Workflows. Execution intersects selected accepted/current definitions with
trusted organization, agent, conversation and channel authority. Cross-agent visibility is denied.
The current runtime remains `product-capabilities-v15` / `AgentsBusinessRunV25`.

Inbox owns human requests, optional customer-evidenced contact preferences, historical customer notices,
assignment and speaking ownership. After-hours request tools save state without appending or enqueueing
a customer message. The agent publishes the conversational reply through the normal output path. A requested human can coexist with active agent replies;
staff takeover and explicit human-only choice fence those replies. Procedure completion checks
actual domain receipts and unresolved effects. Model claims, queue admission or a saved contact
preference cannot prove delivery, human response or a callback. The existing ownership-changing
handoff remains a distinct path for configurations without this opt-in.

[Business workflows](operations/business-procedures.md) records contracts and release limits.
Deployment and rollback are joint owner steps pending; neither these source boundaries nor
focused local checks establish production rollout or live-model acceptance.

## Private organization assistant

The assistant panel opens an ordinary organization business agent and its current member's private
phone links. New workspaces provision one customizable Assistant and its first published default
version in the organization transaction, so the panel opens chat directly when a model route is
available. Schema094 preserves deletion tombstones and offers explicit owner restore. Existing
organizations without an assistant opt in through setup; legacy drafts repair on first read.

Agents Ask AI and the Growth assistant share the launcher, modal panel, navigation, chat layout,
composer, settings, channels and conversation-library surfaces in `packages/ui/src/assistant`.
Product adapters supply transport, model selection, memory, task details and channel data. The
shared surfaces do not own product execution or authorization.
The normal editor can create a Content specialist and bind up to two permitted pinned business
versions. The existing Restate harness chooses delegation through its model tool, maintains root
budgets and returns a text draft without publishing into another product.

Schema095 extends the shared ingress/outbound queues with explicit member-purpose rows. Hashed,
ten-minute, single-use pairing challenges require a provider-observed private identity and separate
signed-in app confirmation. Member, organization, sender/chat, asset and connection generations
remain separate authority checks. Revoked routes never fall through to customer Inbox. The app can
continue the link's private conversation as the same human principal. Optional model task-status/cancellation tools use tool-directed programv2, current human grants and
same-agent prior roots; they return bounded statuses without transcripts. Versions1/3 retain their
pinned descriptors. Phone `/status` and `/cancel` use the same task lifecycle. Results and connected-tool reviews recheck current evidence, permissions
and link generation immediately before sending. Unknown sends are retained without blind retry;
WhatsApp results outside the permitted window remain in the app.

Private phone admissions are disabled by default and require
`AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS` on API and worker. The
[private assistant reference](operations/private-assistant.md) documents APIs, pairing, review,
recovery, threat model, rollout, analytics and rollback. The
[adapter conformance matrix](operations/channel-adapter-conformance.md) separates deterministic
transport evidence from provider acceptance.

Controlled evidence: API `organization-assistant`, `member-channels` and
`organization-assistant-runtime`, `member-channel-composition` and `task-control` tests cover PostgreSQL provisioning/identity, shared delivery,
actual native Restate specialist execution, phone/app continuation and revocation during child work.
Web `assistant.spec.ts` covers pairing, lifecycle, delivery states, specialist selection and responsive
light/dark layouts. Deterministic model/provider fixtures establish mechanics, not live-provider
conformance or model quality. Meta documentation verification, owner live acceptance and hosted
telemetry remain release prerequisites. No Growth integration or implicit protected KasiAI identity
is added.

## Native customer records

`/app/customers` exposes Enquiries, Contacts and Follow-ups. Real confirmed channel submissions
project transactionally into schema078 records. Validated human-support contact saves also
project into Contacts in the same transaction. Follow-ups reads the existing support requests,
including their reason, preferred contact, status, assignee, agent and original Inbox conversation.
Unconfirmed/rejected submissions, private operator tests and evaluation trials do not create
ordinary contacts. Original evidence remains in the enquiry/request store and Inbox reads.
The explicit `pnpm --filter @kasitek/agents backfill:support-contacts` command brings previously
saved support contact preferences into Contacts. It is repeatable and does not log contact values.
Website contact association uses deployment/session identity; messaging uses deployment/verified
sender identity. No email/phone matching or cross-channel merging occurs. Support projection fills missing
contact fields and preserves existing staff corrections; repeated saves do not increment revisions.

Membership-authorized APIs are under `/api/organizations/:organizationId/customer-records`:

| Route | Contract |
| --- | --- |
| GET `/followups` | Search support requests and filter by requested/human-owned/completed/withdrawn status; signed stable cursors, limit1–100. Returns contact and Inbox links without duplicating request state. |
| GET `/members` | Current staff eligible for assignment. Revoked assignees remain visibly former members until reassigned. |
| GET `/enquiries` | Search and filter by status, assignee, due date, agent, conversation or contact; signed stable cursors, limit1–100. |
| GET `/enquiries/:id` and `/enquiries/:id/activity` | Current and original fields, permitted source/booking references and paginated internal activity. An original submitted enquiry ID resolves its projected record. |
| POST `/enquiries` | Explicit manual staff record with `commandId` and bounded `fields`. |
| POST `/enquiries/:id/commands` | `commandId`, `expectedRevision` and a discriminated action. Claim, assign/unassign, status/reopen, due date, note, correction and contact link/unlink. |
| GET/POST `/contacts`; GET `/contacts/:id`; POST `/contacts/:id/commands` | Bounded search, explicit creation, linked enquiries and revision-checked correction. No merge or external synchronization. |

Commands retain stable receipts, reject stale revisions and recheck current membership/assignment.
Owners assign others and correct/link contacts. Staff claim unassigned work or update work they
own. Closed records require explicit reopen. Follow-up states are `new`, `in_progress`,
`waiting_on_customer` and `closed`. Due dates provide scheduled/overdue filters only. Internal
notes and activity remain staff-only; record edits do not send messages, alter Inbox ownership or
invoke booking effects. Source links recheck their existing destination permissions.

Schema079 adds immutable amendment links and pending-amendment uniqueness. Guided enquiry
setup enables `enquiry.submit`, `enquiry.read` and `enquiry.amend`. Customer reads and amendments
use exact trusted conversation/principal/trial scope. An amendment retains previous evidence,
requires exact confirmation through Chat/widget/channel review and projects onto the same real
customer record. Tool arguments cannot set tenant or participant authority.

Behaviour → Tools offers optional staff record search/update. Saved configuration, `records.read`
or `records.write` grants and current signed-in membership are all required. Materialization hides
these tools from channels, automations, subagents and evaluation trials; execution checks again.
Search returns bounded record fields/status/revision/due date, excluding notes and contact-directory
contents. Updates allow status, explicit reopening and due date only. Staff evaluation adapters
must use a disposable isolated organization and normal staff tasks; ordinary trial tasks cannot
browse native records. Owner cases are in `evaluation-adapters/harbor/cases/native-records.json`;
no model evaluations or live-provider acceptance were run for this implementation.

Explicit `setup:db` applies additive078/079 only from recognized prior digests. Restart API and
worker together. `AgentsBusinessRunV21` retains its identity because the additional review branches
are selected only by new optional tools absent from older immutable configurations. For rollback,
disable the tools/routes and revert executable code while retaining additive tables, original
receipts and schema checksum registrations. New Customers mutations emit bounded
`customer.record.command` structured logs with kind and record ID. Existing request context and
tool/task events carry correlation and outcome. Field values, contact details, notes and message
bodies are excluded. No external analytics producer, Collector configuration or notification worker
is added. Operational investigation uses record revisions/activity plus existing request/task IDs.

## Product scope and implementation gaps

Agent creation uses one customer-service offering with selectable question answering, support,
appointments and native enquiries. The guided flow saves progress on the server after each forward
step. A scoped session pointer resumes the same agent after reload; creation retries use a stable
operation ID. The setup progress card on the agent menu resumes or edits it. Saves use draft revisions and
internal snapshots. A stale save offers an explicit reload instead of overwriting concurrent work.

The optional Appointments step reuses Google/Microsoft service connections and the booking-policy
editor. Owners explicitly share a service calendar, choose allowed operations and select or create
a policy. Policy ID/digest and structured duration/hours/timezone reach the real booking tools;
free-text preferences cannot override them. Missing OAuth/server prerequisites and disconnected or
changed policies remain unavailable. Selecting bookings alone never grants calendar access.

Enquiry selection enables the native `enquiry.submit` capability with the configured fields.
The agent requests exact customer confirmation before saving. Tool arguments cannot choose the
tenant, agent, principal or conversation. The trusted executor stores that provenance, retains one
record per operation and returns a submitted receipt only after commit. Declined, expired, disabled
or revoked requests cannot create submitted records. Native confirmations work in direct Chat,
website chat and messaging channels through the existing durable review/ownership boundaries.
Submitted records appear in Inbox conversation details and membership-authorized GET
`/api/organizations/:organizationId/enquiries` and `/enquiries/:enquiryId`. Task-scoped review routes
are under `/tasks/:taskId/enquiries`; visitor reviews use the existing canonical customer-conversation
scope. These records are private. Contact fields do not verify identity. External CRM export and
Growth synchronization remain outside this implementation.

GET `/api/organizations/:organizationId/agents/:agentId/setup-readiness` reports saved model
metadata/credential availability, knowledge approval/public visibility, booking policy authority,
native intake and handoff capability, and actual selected-channel deployment state. It does not
call a model or certify live provider credentials. The review and Configure screens use this
projection. Channel actions preselect the agent, preserve authorization return context and reuse
website domains/customization/install snippets or messaging asset selection. Connected, paused,
unconnected and needs-attention states come from records rather than selected checkboxes.
Support hands off to the existing unassigned Inbox queue; free text does not create staffing rules.
Customer-service setup starts new support schedules with editable Monday–Friday 09:00–17:00
values and the browser timezone; saved schedules are preserved. Enabling a day inserts real hours,
not placeholder text. Time and timezone input is normalized before save; malformed, reversed and
overlapping periods remain invalid, with 24:00 accepted only as closing time. These are suggested
setup values, not inferred business facts. After creation, Behaviour → Human support
edits the schedule directly through the revision-checked Save changes action. Existing hours are
loaded without applying defaults; Set support hours explicitly initializes an absent schedule.
Both draft and published-configuration saves synchronize changed hours to the saved setup record
without regenerating instructions, tools or other setup fields. Explicit guided-setup submissions
retain their existing derivation rules. The General page groups settings with section dividers and
places setup status and connected-channel actions in a side panel on wide screens, stacking them
below the form on smaller screens. The saved schedule is
pinned to the agent configuration when published. When human support is selected in setup, its
`support.get_status_v2` tool returns whether the current time falls within that schedule, the next
opening when closed, and aggregate staff availability. It reports unknown when a schedule or
availability is not known, and never derives staff presence or response times from the schedule.
Website CORS preflight covers both the deployment metadata endpoint and its child routes, using
the same explicit publication-origin checks. Saved visitors can reopen or reload the embedded
widget with its authorization header; unrelated origins remain denied.
Website enquiry, confirmation and followup-preference reads retain visitor/session and conversation
authorization without charging the website write-rate budget. Message sends, confirmation decisions
and followup mutations remain rate-limited; normal widget polling does not exhaust those writes.
The Inbox lets a member explicitly select Available or Away. Availability expires after two minutes;
only the visible Inbox tab that selected Available renews its lease. Revoked members do not count,
and the tool never exposes individual staff identities. Previously published configurations keep
their pinned `support.get_status` tool and its original unknown-presence response.

Schema088 adds support presence. Deploy schema087 and schema088 in order before enabling the new
API and web code. Rollback disables the new code while retaining the additive schema and its
checksum registration. Staff availability is advisory and does not guarantee someone will reply.

Schema087 adds pending handoff receipts. New customer configurations use
`product-capabilities-v12` and `AgentsBusinessRunV22`. The worker registers
`AgentsHandoffReceiptV1` to settle a single acknowledgement or its factual fallback. The deadline
is five seconds from the committed request. Existing pinned configurations retain their original
immediate receipt. Pending receipts use current ownership, channel and evidence checks at
publication and dispatch. Attachment-origin waiting notices do not require the model handoff tool.

Release risk is high across the Agents API, worker, schema, Inbox and customer channels. Apply
087 and 088 in order, register the V22 and receipt workflows, and start matching API and worker
artifacts together. The structured `handoff_receipt_publisher_error` log and receipt states support
investigation without message bodies. No new analytics or Collector changes are introduced.
Controlled PostgreSQL, Restate and model-provider fixtures verify the new path; live-provider
acceptance and model behavior evaluation remain owner-run. To roll back, route new configurations
away from V22 and drain or suppress pending receipts before removing its worker. Retain the additive
tables and provider receipts. A production release ID, rollout and post-release review date are not
applicable until deployment is authorized.

Schema089 adds the `support_status_v1` execution purpose and immutable notice receipts. While a
conversation is `handoff_pending`, an eligible customer message can start `AgentsSupportStatusV23`.
The controller receives the message and current support facts, uses no tools, and returns either a
status reply or no reply. It allows one model call, at most 512 output tokens and 10 seconds, subject
to lower configured limits. Admission permits one active turn and three turns per episode in five
minutes; other messages remain visible to staff. A first-contact attachment episode can create a
customer- and deployment-scoped execution conversation for its first eligible status turn. Its
message-origin authority is checked against the committed handoff event and current channel policy;
it does not grant business tools. Human takeover, later visitor messages, channel revocation or
changed support facts fence publication and delivery. A previously published reply
remains readable after takeover or later messages while its source authority remains valid.

The release affects the Agents API, worker, Inbox and customer channels. Apply schema089 after
088, register `AgentsSupportStatusV23` with Restate, and start matching API and worker artifacts.
Existing model-operation telemetry records outcomes without message bodies; no new analytics or
Collector changes are introduced. Controlled PostgreSQL, Restate and provider fixtures cover the
website, Telegram and first-contact attachment paths. This extension requires no new schema or
analytics. Live-provider acceptance and model-behavior evaluation remain owner-run.
To roll back, stop new status admissions, drain or cancel outstanding status tasks, then remove the
V23 worker route while retaining the additive schema and receipts. A production release ID, rollout
and post-release review date are not applicable until deployment is authorized.

Schema090 adds operation-keyed recovery for uncertain reviewed customer HubSpot contact writes.
The worker scans uncertain or expired claimed receipts without calling the provider again. It
preserves an existing handoff receipt, or creates one only under current channel ownership and
authority. Inbox staff can see a redacted uncertainty notice even when customer delivery is not
authorized. Schema091 adds an owner-only read check against the exact reviewed contact. It records a separate
operation-bound, redacted observation: found means current details match, inconclusive means they
could not be confirmed, and unavailable means the check failed. It never retries the original write
or changes its uncertain receipt. Other staff and customers cannot initiate this check. There is no
notice dismissal action. Schema092 adds an operation-bound customer uncertainty update, separate
from the existing handoff receipt. Publication and queued delivery check the current handoff,
recipient, provider authorization and whether a matching contact was observed. Already visible
updates remain in conversation history while their original grant is not revoked. Provider delivery retains its existing unknown
outcome semantics; a check immediately before sending cannot recall an in-flight provider request.

Apply schema090, schema091 and schema092 before starting the matching API and worker. The `connected_uncertain_recovery_failed`
and `connected_uncertain_notice_failed` logs record bounded retry codes without customer content;
analytics and Collector changes are not
applicable. PostgreSQL, controlled provider and browser fixtures validate recovery, owner-only reads and visibility;
live-provider acceptance and model evaluations remain owner-run. To stop new recovery, set
`AGENTS_CONNECTED_UNCERTAIN_RECOVERY=false` on the worker and retain schema and receipts. Existing
v1 adapter files and pinned identities are unchanged. A separately versioned adapter with its own
customer-facing uncertainty receipt remains unimplemented; historical built v1 artifacts are not
available here to verify old deployed bindings. Production release identity, rollout and review date
are not applicable until deployment is authorized.

Schema075 stores setup; schema076 adds native enquiries and permits exact review prompts before
the single final assistant message; schema077 adds resumable progress and creation idempotency.
New guided setups start with no responsibilities selected and create a draft after at least one
responsibility is chosen. Saved drafts restore their existing choices.
Removing booking or enquiry responsibilities removes setup-owned authority using existing grant
revocation. Manually authorized source/tool bindings remain separate. For rollback, disable the
affected capability or deployment, revert application code and retain additive schemas/checksum
registrations and stored enquiry records. Do not replay uncertain external effects or delete data.
`AgentsBusinessRunV21` retains its identity: enquiry review steps run only for the new optional tool,
which older immutable snapshots cannot expose. No existing admitted journal gains those steps.

Focused engineering checks cover PostgreSQL persistence/confirmation/retries/authority, responsive
browser setup and connection context. Knowledge stages have a separate controlled actual
self-hosted crawl/parser/index proof. Existing Harbor ports and `cases/guided-setup.json` support
owner-run purpose/combined acceptance. This implementation does not claim live OAuth/channel
account acceptance or model evaluation results. Setup saves reuse `agent.configuration.saved`
structured logging; native task events record enquiry prepared/submitted IDs and counts, not fields
or message bodies. No new external analytics producer or Collector configuration is introduced.


Website knowledge import is available as an optional creation step and under
Training data → Import website. Owners can enter a bare domain, follow crawl progress,
select pages, inspect extracted Markdown, and import the selection as one knowledge candidate.
The next review shows the normalized candidate. **Approve and use** approves the revision, publishes
it for customer replies, and attaches it through the normal revision-checked agent configuration API.
Knowledge has no visibility split: an attached source is usable in every conversation with that agent,
including customer channels. Removing a source from customer answers is done by not attaching it, or by
deleting it. Closing or reloading resumes the exact persisted import and derives completion from its ready
revision, current approval, active source, and saved agent knowledge bindings. Withdrawn, unavailable,
failed and cancelled imports remain distinct and can be retried without reporting success.

Training data lists only the sources attached to the selected agent. Sources remain workspace-owned:
upload creates a workspace source, while **Pick from workspace** binds an existing approved source.
The workspace Knowledge page shows how many agents use each source. Deleting an agent detaches its
sources; it never deletes workspace knowledge. Deleting a source warns with the attached agent list
and detaches every agent before removal.

An owner can transfer an agent by email using schema148. The recipient signs in with the invited
address, chooses a workspace they own or administer, and accepts. Acceptance copies the current
published configuration and the attached source revisions into that workspace under new ids,
including sources, revisions, chunks, sections, embeddings and original/text objects. Copied
sources arrive approved and use the destination organization default model. Connected tools,
skills, procedures, delegation bindings, booking/report workflows and channel/support tools are
removed because they reference source-workspace credentials, bindings or agents. Model connections,
channels, domains, conversations, tasks, evidence and version history do not move. The source agent
and its sources remain unchanged, so old conversations keep verifying their citations. A pending
transfer freezes editing and deletion; cancel, decline and expiry leave no copies. The invitation
link expires after seven days and uses the existing Resend configuration.

Deleting a source removes it from every agent immediately, without a republish. A seven-day soft delete is
restorable; a forced delete also scrubs chunk content, removes sections and embeddings, and leaves a
tombstone (source id, title, digest, actor, timestamps). Content is scrubbed rather than row-deleted because
evidence references chunk and revision ids; no answer can use a deleted source because retrieval admits only
active, approved sources. An approved source that
is not attached offers **Use knowledge** without approving it again. Skipping website import leaves the
agent usable. The importer refreshes the saved draft before attachment to preserve other source/tool
bindings and uses the normal revision conflict check against concurrent edits.

The server-side Firecrawl v2 adapter supports local or Cloud origins through
`AGENTS_FIRECRAWL_URL` and a private `AGENTS_FIRECRAWL_API_KEY`. Schema074 stores organization,
agent and initiating account scope, provider origin/job identity, selected-page import identity,
leases and bounded progress. Routes are owner-only under
`/api/organizations/:organizationId/agents/:agentId/website-crawls`: POST starts a crawl, GET lists
or inspects it, POST `/:crawlId/cancel` stops it and POST `/:crawlId/import` submits selected pages.
The API dispatcher polls durable jobs. A lost start acknowledgement is recorded as uncertain
rather than submitting another external job. Read-only status failures have bounded retries.
Cancellation and revoked authority fence late results. Switching provider origins fails pending
jobs explicitly rather than sending their IDs to another provider; drain jobs before switching.

Crawls default to 20 pages at discovery depth 2, with two active crawls per organization and a
20-minute deadline. The current review contract accepts at most 100 pages/depth 10 and 10 MiB
of extracted Markdown; selected combined content must fit the existing 1 MiB text-source budget.
These are local product limits, not Firecrawl subscription credits. Pagination/oversized results
fail explicitly rather than silently approving a partial crawl. Sources retain page URLs in
Markdown. Candidate parsing, chunking, embedding, approval and agent configuration
continue through the existing knowledge system. A Firecrawl response is never approved knowledge.

Root URLs are public HTTPS with DNS/private-address checks. Results remain on the same hostname.
The pinned local Firecrawl fetch dispatcher blocks private socket destinations and private literal
redirects; its browser checks subrequests with local access disabled. No proxy is configured.
These upstream application checks are not a claim of network-level isolation for every future
engine/provider. Keep Firecrawl itself private and recheck egress protections before hosted rollout.
No authenticated crawling, AI extraction or external provider fallback is enabled. The local stack
and operator verification command are documented in `infra/firecrawl/README.md`.

The website widget restores Growth's original dark header, avatar, message bubbles, round launcher,
pill composer and expand/collapse controls while using current Agents sessions, canonical Inbox
messages and booking/intake confirmations. **Customize widget** is available under both
Connections → Website and the agent's Chat widget section. Its live preview supports custom
colour, title, greeting, avatar URL, position, window size, corner radius, launcher size/offset,
suggested messages and branding visibility. Appearance presets (Light, Minimal, Business, Dark)
fill the editor with a complete appearance; later edits override the preset. Presets are snapshots,
so updating a preset does not rewrite an already saved widget. An optional subtitle replaces the
status eyebrow in the header, and the theme switches the widget surface between light and dark.
Settings use current owner authorization and
optimistic appearance digests. Existing JSON settings receive recovered defaults; no schema
migration is required. Avatars permit HTTPS or local development HTTP and use no referrer.
The website widget shows one active conversation; the header has no conversation selector and no
new-conversation button. The active session and pending request survive reloads in the same browser
tab. When the conversation is resolved, or its session expires, the widget automatically starts a
fresh conversation; the visitor's unsent text is preserved. Previous conversations
remain in the staff Inbox. An expired session does not grant access to its earlier conversation.
Rejected sends retain their text and a separate visible error through background refreshes.
An unknown send outcome retains its original request key for retry. Model-configuration failures
show a temporary-unavailability message to visitors; owners configure the provider and default
model under Settings → Model providers. A connected website alone does not establish reply readiness.
The widget shows responding dots and elapsed seconds for the current automated turn. Visitor
message reads expose bounded response activity from the authorized conversation's current
ownership generation. Once acknowledged, timing runs from server message acceptance to the
published assistant message, including queue and tool time. The completed duration remains on
that reply as seconds only, such as `2s`, with an explanatory tooltip and accessible label. Human ownership, handoff, resolution and terminal failures stop the animation;
reduced-motion mode keeps a static indicator. After 60 seconds, the indicator says the reply is
taking longer than expected while the execution remains active; this does not imply cancellation
or failure. For an uncertain outcome the widget asks the visitor to check before trying again and
does not automatically resend the accepted message. Response activity does not expose task IDs or
private errors.
Assistant and staff replies render a limited Markdown subset: paragraphs, headings, emphasis,
code, lists, pipe tables and HTTP/HTTPS links. Tables keep their header and cell structure and
scroll within the message on narrow screens. The widget builds DOM nodes without interpreting raw HTML;
unsupported syntax remains text. Visitor messages remain literal. Rendering does not change
stored message bodies, model instructions or tool execution.
Audio recording and arbitrary file uploads remain unavailable and have no widget controls.

Website connection input accepts bare domains such as `kasitek.co.za` and stores the exact
HTTPS origin. Explicit HTTPS URLs and local HTTP development origins remain supported. Paths,
queries, fragments, embedded credentials and wildcard domains are rejected. Incoming visitor
Origin headers still require an exact allowed origin; normalization applies only during setup.

Standalone session bootstrap creates **My workspace** and its owner membership for an account
with no membership history. Concurrent requests reuse that workspace. Existing or revoked
memberships are not replaced. Additional workspaces remain an explicit Settings action.

Model-provider contracts and a reviewed JSON registry now exist under `api/src/contracts/`
and `api/src/adapters/models/`. Registry records cover thirteen providers. OpenRouter, OpenCode,
OpenAI, Anthropic, and Google have installed fixture-tested adapters. All registered profiles
have installed adapters. Installation does not claim live account verification. Shared messages no longer depend on
the business adapter's file. The running business loop uses accepted model bindings through
`execution/models/runtime.ts`; it does not select a deployment environment key or a fixed model.

Authenticated organization routes at `/api/organizations/:organizationId/model-providers`
now save labeled provider accounts, list public metadata, rotate keys, revoke access and
remove accounts. Only owners manage secrets. The existing encrypted vault keyring backs a
separate model-credential domain bound to tenant, connection, endpoint, protocol and revision.
Endpoint changes require a new key. Revocation removes encrypted key material and revokes use
grants; reconnecting does not revive those grants. Physical-call credential resolution checks
the exact consumer, model, role, provider definition and current revisions. It never consults
an environment key as fallback. Discovery and inference verification are separate actions;
new connections report `saved`, not verified inference.

Settings now lists multiple labeled model accounts with masked key entry, rotation/reconnection,
revocation/removal dialogs, model search/refresh and explicit paid tests. Tests send one short
generation request or a two-call local echo-tool round trip. Each physical request rechecks
authority. Exact-model receipts bind endpoint, protocol, model metadata revision and credential
generation. A stale in-flight test cannot verify a rotated key. Schema042 stores these receipts
and a revision-checked organization default. Choosing a default explicitly creates a service-use
grant; changing it does not revoke the grants of previously accepted work. The admission resolver
pins primary, compaction, and delegated role routes from saved metadata without network or
secret access. Admission stores those routes and their integrity digest atomically with the
root reservation and outbox command. An idempotent replay returns the original accepted task.
Changing the organization default affects new admissions; it does not redirect accepted work.
The chat model picker and Configure support an explicit account/model selection through the
existing background configuration-snapshot flow. Chat selection saves after any required impact
confirmation; it preserves conversation history and drafts. Unsaved Configure edits block chat
switching until saved or discarded. With the platform OpenRouter key configured, authenticated
owner workspace access initializes an included NVIDIA free model through the normal encrypted
connection, discovered catalogue and organization-default grant. Existing defaults and historical
included-provider revocation or removal prevent automatic replacement. Anonymous website requests
do not initialize accounts. Schema099 pins the included connection's permitted model independently
of catalogue edits and subsequent operator default changes. The included connection cannot be
repurposed to use paid models or another endpoint; owners add their own provider key for other
models. Generation still requires a saved connection and use grant, with no environment-key fallback.
Owner dependency views list affected agents,
schedules, defaults and active tasks before removal or revocation. Reconnection does not restore
old use grants. An explicit revision-checked Restore access action authorizes only the agent's
currently configured model IDs. Cached model reads for ordinary members are filtered to the
requested agent's current grants and the authorized organization default. Unrelated configuration edits cannot restore
a revoked model-use grant.

Model discovery uses each saved connection's endpoint, authentication placement and credential
generation. Its bounded server transport pins DNS addresses, rejects private destinations and
redirects, and rechecks current owner/connection authority before sending. Schema040 stores
tenant/connection/generation-specific catalogue snapshots with integrity digests. Rotation
invalidates cache selection; failed refresh does not delete a key or the previous snapshot.
An older refresh cannot overwrite a newer observation. Schema046 adds a persistent refresh
lease and retry state scoped to the exact credential generation. Refresh uses a 30-second
minimum interval; failures back off from 30 seconds to 15 minutes. Cached reads never perform
HTTP. The response exposes status, retry time and bounded failure code while preserving saved
metadata. Complete listings retain omitted models for display but mark them unavailable for new
admission. Saved selections are not replaced automatically. Native model listings that omit capacities
or modalities retain unknown values. Owners can add a manual model ID using reviewed metadata or explicit confirmed capacity declarations with source provenance. Declared tool support still requires an exact-model verification before tool execution. Curated providers require explicit model setup; partial
pages report incomplete discovery. Listing models does not verify inference or tool use.

`product/model-providers/setup-policy.ts` defines operator setup protections:

| Setting | Default | Reason and enforcement |
| --- | --- | --- |
| Catalogue response bytes | 2 MiB | Matches the existing bounded network reader's response ceiling. |
| Models per discovery response | 5,000 | Bounds normalization and persisted metadata; larger responses fail explicitly. |
| Catalogue freshness | 5 minutes | Controls metadata refresh only; never extends credentials or grants. |
| Discovery deadline | 30 seconds | Matches the existing network reader's setup deadline ceiling. |
| Setup test output | 256 tokens per call | Bounds the explicitly billable short verification; intersected with known model capacity. |
| Setup test request/response | 32 KiB / 256 KiB per call | Bounds the fixed prompt and local tool exchange, independently of normal generation. |
| Setup test deadline | 30 seconds total | Both tool-test calls share one setup deadline. |

These settings are validated constructor policy, not model context/output limits. The discovery
adapter receives explicit byte/item budgets and an injected transport; it cannot read ambient
credentials or issue its own fetch. Cached-model reads currently require the organization owner.
Stale snapshots remain available for display while refresh is a separate action.

The transport adapter uses pinned `@earendil-works/pi-ai@1.1.0` low-level streams for
Chat Completions, Responses, and Anthropic Messages. Google's GenerateContent protocol uses
`adapters/models/google-transport.ts`, a native REST streaming adapter with the same protected
fetch contract. All four protocols require an injected bounded transport. They disable retries,
validate output caps, reject repaired tool JSON, and distinguish missing usage from zero.
The adapters scope private continuation to provider, protocol, model, endpoint, and credential
revision. Google requests use the saved endpoint and credential header without ambient SDK
cloud-backend selection.
OpenAI-compatible stream failures can additionally retain a fixed SSE failure category and an
optional numeric error-envelope status or code. A bounded preparse observation passes original
bytes to the installed parser unchanged and preserves the diagnosis when the SDK emits an error or
throws while consuming it; it stores no raw frame, provider error message, header or reasoning in
ordinary diagnostics. Oversized or unexplained failure remains unclassified. See the
[runtime runbook](operations/shared-runtime.md#investigation).
Explicit HTTP503 responses remain `MODEL_PROVIDER_UNAVAILABLE` rejections if the error body is
interrupted after its status arrives. Bounded upstream SSE error envelopes with numeric status503 or
code503 have the same classification. Other interrupted or incomplete HTTP200 streams remain
uncertain; the transport never retries or changes routes automatically.

The pinned SDK receives instructions and tools through its leading system message. Actual
outgoing-body tests guard this contract. Anthropic's SDK base path is normalized while the
accepted endpoint stays unchanged. The CommonJS application loads this import-only dependency
through Node24's native VM loader, which emits an experimental warning.

Schema043 adds immutable `task_model_routes` and private operation-scoped native continuation.
The worker restores continuation only for matching accepted bindings and complete public
assistant/tool groups. Native reasoning and signatures remain in the private table, outside
ordinary transcript messages and Restate operation results. Persistence uncertainty does not
authorize another physical model request.

Discovery can enrich exact provider/model/API matches from the pinned bundled catalogue.
Live metadata takes precedence. Bundled fields retain registry provenance; they do not prove
account access or tool support. Generated zero prices remain unknown rather than free.
`execution/models/policy.ts` intersects explicit platform/product/tenant/agent allowances and
sourced model capacities. Unknown context/output capacity requires an operator attestation.
The compiler checks reserves and root/compaction relationships and pins its decisions in a digest.
No default numeric model limits are hidden in the compiler. Admission currently supplies
platform, product-grant, and saved-agent layers. The compiler supports a tenant layer, but no
separate tenant-policy management feature is implemented. Accepted policies govern the worker,
compaction, delegated allocations, and the root token and monetary ledgers. Invalid context,
reserve, or root-budget relationships fail admission instead of silently shrinking settings.

`infrastructure/model-network.ts` supplies a separate streaming fetch for generation. It pins
verified public DNS addresses, reauthorizes after lookup, sends only trusted credential headers,
enforces explicit body/response budgets and independent total/connect/idle/progress clocks,
and permits one physical request without redirects or retries. Semantic model deltas reset the
progress clock; heartbeat bytes only reset idle time. Its compiled CommonJS/native-adapter
path has a real HTTP fixture proof. The native Google adapter uses this same fetch port.

Context packing and compaction accept `ContextModelPolicy` with explicit model/counter revisions,
duration, capacities, message/tool/byte protections and a runtime-supplied counter. Serializable
snapshots pin the policy and omit the callback. The running path uses accepted model capacities
rather than the old Nemotron allowlist. Native continuation byte estimates contribute to context
packing without exposing the private content. Final native-payload preflight checks the accepted
input/context limits and the operation reservation before dispatch. The default counter estimates
serialized UTF-8 bytes; it is not a qualified universal tokenizer or a proof of a provider's actual
bill. Final preflight uses official OpenAI Responses, Anthropic Messages and Google
GenerateContent token-count endpoints for their reviewed official destinations. It counts the
prepared native input, including instructions, tool schemas and private continuation. Anthropic
reports an estimate. Counter failures stop generation; they do not fall back to a different
counter or account. Counting and generation each recheck current credentials, share the accepted
call deadline and keep separate bounded physical requests. Counter responses are capped at
64 KiB, an operator transport protection for the small count JSON response. Schema047 retains
only count, precision, revision and payload digest privately. It does not retain another prompt.

Schema100 adds immutable compaction jobs and compare-and-swap continuity checkpoints. A job freezes
complete message groups, their digests, the exact prepared model snapshot, source dependencies,
memory generation and base checkpoint revision. Original task, instruction and operation records
remain retained. `AgentsContextCompactionV1` processes a prepared background job independently of
foreground generation, using the same physical operation receipts, accepted compaction route,
current-authority checks and root allowances. It uses the existing background capacity class;
capacity notifications target the job's workflow key. One prepared background job per conversation
prevents competing speculative summaries. A newer checkpoint supersedes an older candidate, and
revoked or nonreducing output cannot replace the current summary. Appended complete groups and
directions remain outside that frozen prefix. Replaying the workflow uses its recorded model
receipt. Summary evidence derives from the exact frozen snapshot rather than later task evidence.
See [Context management](operations/context-management.md) for the launch/join contract and
operational checks.

Compatible/custom routes use the explicitly labeled serialized-byte estimate until a qualified
counter is installed. The estimator assigns one estimate unit per UTF-8 byte of the complete
prepared JSON payload. The accepted request-byte cap bounds that value; the input allowance and
context reserve can narrow it further. It does not estimate hidden provider prompt additions or
guarantee the provider tokenizer count. Providers can still reject context overflow, which is
reported without a hidden retry or model replacement. Sources: [OpenAI](https://developers.openai.com/api/docs/guides/token-counting),
[Anthropic](https://platform.claude.com/docs/en/build-with-claude/token-counting) and
[Google](https://ai.google.dev/api/tokens).

A finite `maxCostMicros` currently fails admission and dispatch with
`MODEL_COST_CAP_UNSUPPORTED`. Listed prices and approximate counters do not establish an
enforceable upper invoice bound. Token allowances and estimated monetary usage still work;
they are not presented as a strict spending guarantee. Scheduling groups model operations
by organization and accepted connection, independently of a deployment-wide environment key.

`execution/models/settings.ts` reads partial operator overrides from `AGENTS_MODEL_POLICY_JSON`.
The JSON object is strict: unknown fields, invalid values, and inconsistent effective limits fail.
These defaults bound service work. They do not describe every model's capacity. Model metadata,
execution grants, and agent settings can reduce the effective allowances.

| Operator field | Default | Purpose |
| --- | --- | --- |
| `contextTokens` | 262,144 | Service context ceiling, intersected with sourced model capacity. |
| `maxInputTokens` | 196,608 | Input ceiling with space left for output and safety reserves. |
| `maxOutputTokens` | 32,768 | Service output ceiling, also bounded by model and agent settings. |
| `safetyTokens` | 1,024 | Explicit context reserve; contributing layers retain the largest reserve. |
| `compactAtTokens` | 131,072 | Service compaction threshold; automatic mode preserves this headroom proportion inside the effective input allowance. An explicit saved threshold can reduce it. |
| `maxModelCalls`, `maxToolCalls` | `null`, `null` | Optional local agent count ceilings, cumulative for the coordinator across continued segments. |
| `maxRootModelCalls`, `maxRootToolCalls` | `null`, `null` | Optional shared work count ceilings, including specialists and compaction. |
| `maxDurationMs`, `maxWallDurationMs`, `maxCallDurationMs` | `null`, `null`, 120,000 | Optional shared active time and work wall lifetime; finite deadline for each physical model call. Approval waits use separate durable waits. |
| `maxInputBytes` | 65,536 | Raw user-input byte ceiling. |
| `maxRequestBytes`, `maxResponseBytes` | 2,097,152, 4,194,304 | Serialized native request and response byte ceilings. |
| `maxMessages`, `maxTools` | 256, 64 | Native request collection bounds. |
| `maxRootTokens` | `null` | Optional cumulative token allowance; finite execution grants remain binding. |
| `maxCostMicros` | `null` | No operator monetary cap. Finite caps are rejected until their price and token bound can be enforced. |

For example, `AGENTS_MODEL_POLICY_JSON={"maxModelCalls":32,"maxToolCalls":64}` changes only
the two local call ceilings; use `maxRootModelCalls` / `maxRootToolCalls` for a shared team ceiling. Null never removes another finite policy layer. New agent configurations use `context: {mode: "automatic"}`,
4,096 reply tokens, 16,384 raw input bytes, and a 120-second model-call deadline. Automatic context
uses the selected model's sourced window, subtracts the effective output and safety reserves, and
intersects the service, product and finite work allowances. The compiler records each derived bound.
Existing numeric context objects, including 8,192 / 6,144, remain explicit caps with unchanged
configuration digests. Publication does not infer that an older numeric setting was automatic.
Effective root grants can be smaller than the service allowance. The editor's Model limits section previews the effective
context, reply and root allowances from the full unsaved configuration. Its authenticated
`POST /api/organizations/:organizationId/agents/:agentId/model-policy` reads authorized cached
metadata without a provider request or an execution grant. Invalid previews preserve edits.
Input/output and compaction controls use the preview's effective bounds. Context defaults to
Automatic; selecting Custom limit exposes the finite input and compaction fields. New numeric
execution grants use the trusted service compilation ceiling for automatic mode and the saved input
cap for custom mode. Admission still intersects the selected route; accepted routes and narrower
renewal grants retain their original pins. New policy compilations use `model-execution-policy-v3`.

`adapters/models/model-control-profiles.json` records reviewed endpoint/model rules and official
sources for temperature, effort, reasoning budgets and thinking levels. Unknown models and custom
endpoints expose no unverified controls. Provider defaults remain the default selection. Manual
reasoning budgets must fit the accepted reply allowance. Admission, evaluation preparation and
schedule creation validate generation settings and pin their reviewed revision and digest beside
the model binding. Dispatch validates the pin and applies native fields before byte checks and
input counting. A changed controls revision rejects accepted settings rather than retargeting them.
OpenRouter dispatch removes SDK-inserted root reasoning controls before applying the accepted
settings. An omitted reasoning choice preserves the provider default instead of sending a
synthetic off value. Explicit reviewed effort settings remain explicit. Provider-native assistant
reasoning and signatures remain private and unchanged in continuation history.
Saving still uses background configuration snapshots.

The following inventory separates model facts from policy and transport protections. Paths are
relative to `api/src/`. These values are not vendor capacity promises.

| Rule and source | Classification and rationale | Configuration and verification |
| --- | --- | --- |
| Context, input and output capacities in `adapters/models/discovery.ts` and `model-metadata.ts` | Vendor metadata with per-field provenance. Missing context/output capacity blocks execution until sourced metadata exists. | Refresh the selected connection or supply owner-attested manual metadata. `model-discovery.test.ts`, `model-metadata.test.ts`, `model-execution-policy.test.ts`. |
| Every operator field in the defaults table above, in `execution/models/settings.ts` | Platform policy limits request size, work, root cost exposure and transport memory. The policy compiler takes the smallest ceiling and largest safety reserve. | Strict `AGENTS_MODEL_POLICY_JSON`; `model-execution-policy.test.ts`, `model-dispatch.test.ts`. |
| Agent defaults in `contracts/contracts.ts`: input16,384 bytes, output4,096 tokens, call120 seconds, automatic context | New configurations derive input capacity and compaction headroom at admission. Explicit numeric saved caps remain unchanged. | Saved configuration and the model-policy preview. `model-execution-policy.test.ts`, `model-controls.test.ts`, `configuration-experience.spec.ts`. |
| Optional grant root allowance; tenant defaults2 active roots and100,000 tokens/day | Product and tenant admission policy, independent of a model's advertised context. Existing tenant reservations bound accepted work; child and compaction work share the root. | `executionGrantSchema`, persisted `tenant_admission`, accepted product assertion or evaluation scope. `model-accounting.test.ts`, admission and runtime tests. |
| Cumulative task/root counters are exact nonnegative integers through9,007,199,254,740,991; per-operation and grant fields keep their own storage bounds | Persistence integrity, not an execution allowance. Unsafe totals fail rather than losing integer precision. | Schema098 and `execution/lifecycle/work-policy.ts`; `optional-execution-limits.test.ts`. |
| Adaptive delegation1–8 concurrent children per parent; positive or nullable depth; token/time allocations nullable; legacy bindings finite through12,000 tokens | V15 reserves each physical operation once and checks finite intermediate subtree ceilings. Explicit ancestor pins remain binding; delegation never increases parent authority. | `delegationBindingSchema`, published capability and execution grant; adaptive and optional execution tests. |
| Instructions8,000 characters, sources20, connected tools8, skills8; direct builtins are unique selections from the current `toolNameSchema` allowlist | Product configuration and authority collection bounds. Larger context does not increase capability authority. Full serialized content must still fit the accepted input policy. | `agentConfigurationSchema` and published program contracts. Configuration, publication and product-scope tests. |
| Model controls in `adapters/models/model-control-profiles.json` | Sourced vendor parameter rules, matched to endpoint, API and model. Manual budgets additionally fit the effective output reserve. Unknown routes expose provider defaults. | Reviewed JSON revision pinned at admission. `model-controls.test.ts`, `model-provider-conformance.test.ts`. |
| Catalogue2MiB/5,000 models, TTL5 minutes, refresh30 seconds, maximum backoff15 minutes and discovery30-second deadline | Setup transport/cache protections. These values bound provider setup separately from paid agent execution. | Injected validated `ModelSetupPolicy` in `product/model-providers/setup-policy.ts`. Store/discovery tests. |
| Explicit probe256 output tokens,32KiB request,256KiB response and30 seconds | Setup policy bounds an explicitly billable model/tool test. Actual model capacity can lower the output allowance. | The same `ModelSetupPolicy`; provider probe tests. |
| Counter response at most64KiB, additionally bounded by the accepted response limit | Transport protection for a small token-count document. Counter failure prevents generation. Native input counts and byte estimates retain separate precision labels. | `execution/models/dispatch.ts`, `adapters/models/input-count.ts`. Native counter success/overflow/failure tests. |
| Per-call deadline and connection/idle/progress timers | Transport protection within the original operation and task deadlines. Preparation and counting do not reset accepted execution time. Semantic progress is distinct from incoming bytes. Context preparation preserves whole-millisecond policies, including fractional seconds. | Accepted `maxCallDurationMs`, operation `started_at + reserved_ms`, task deadline and `infrastructure/model-network.ts`. Runtime elapsed-deadline and network timeout/cancellation tests. |
| Optional work wall lifetime defaultsnull; staff chat grants and renewals30 minutes | Work deadlines are distinct from authority expiry, active-operation time and finite physical call/queue deadlines. Renewal cannot extend a finite accepted work deadline. Older accepted tasks retain their original finite deadlines. | `maxWallDurationMs`, schema098 and admission; `optional-execution-limits.test.ts` and continuation/deadline tests. |
| Worker loop bounded by accepted `maxModelCalls`, including compaction | Platform execution policy. The operation ledger also enforces root call counts shared with delegated work. There is no independent 40-iteration ceiling. | `execution/business/business.ts` and `execution/lifecycle/execution.ts`; accepted-policy and operation-budget tests. |
| Capacity wait at most256 wake cycles; authority renewal and tool-authority retry at most8 attempts; child-result reconciliation at most400 checks with250ms between checks | Bounded durable control and recovery work. These guards do not grant model calls or reset task deadlines. | Fixed in `execution/business/business.ts`; scheduling, authority, delegation and runtime recovery tests. |
| Foreground compaction retains up to1 recent whole group; background compaction retains2 | Worker context-selection policy. The remaining prefix is summarized without splitting tool exchanges. Appended groups stay in the foreground. This does not change the accepted input or output allowance. | `prepareCompaction` and `context/background-planning.ts`. Context and compaction tests. |
| Tool names at most64 characters; model IDs512; provider IDs64; model and counter revisions128; endpoints2,048 | Contract and protocol identity protections, independent of token capacity. The Google parser additionally rejects more than1 response candidate. | `contracts/model-providers.ts`, `execution/context/context.ts`, `adapters/models/google-transport.ts`. Contract, context and native-adapter tests. |
| Native Mistral SDK timeout2,147,483,647ms | Adapter protection against a shorter SDK default. It cannot extend the accepted outer operation deadline or network timers. | `adapters/models/pi-transport.ts` and `infrastructure/model-network.ts`; compatible-provider conformance and network timeout tests. |

Context packing estimates the complete logical request, including protected instructions and tool
schemas. The final native count additionally sees provider envelopes and private continuation.
Serialized-byte estimates are estimates for unqualified tokenizers, not a universal upper bound.
Accepted request and response byte caps remain independent. The chat composer does not truncate
input at an unrelated character count. HTTP accepts a string within its128,000-byte JSON envelope;
admission then checks the saved and compiled input byte allowance. This distinguishes UTF-8 bytes
from characters. Oversized rejected drafts remain editable in the client. Estimated monetary usage is rounded
up in integer USD micros; the bigint storage ceiling is9,223,372,036,854,775,807. Unknown usage
retains its reservation until authoritative reconciliation and never becomes zero.

Schema044 replaces model-specific input SQL ceilings with PostgreSQL integer integrity bounds.
Schema051 introduced `model-bindings-v8` / `AgentsBusinessRunV18`; schema060 advances
new channel-aware work to `channel-customers-v9` / `AgentsBusinessRunV19`. Logical request and compaction digests require an explicit accepted
context policy. The obsolete Nemotron-only transport, blanket reasoning rejection and implicit
context fallback have been removed. Skill loading uses the accepted input/safety allowances and
the same counter with private continuation costs as ordinary context packing. Older task releases
require their matching worker; this worker does not replay them using changed request digests. Database startup still checks the complete schema digest; an older local
database is not silently upgraded by starting the application.

Focused PostgreSQL tests cover accepted selection, default changes, revocation, delegated route
inheritance, and native continuation. Controlled-provider tests with actual Restate workers cover
chat, tool rounds, compaction, and restart recovery. Responsive browser fixtures cover settings
and model selection through background configuration saves. These checks do not prove live model
quality or account access. Schema045 freezes an evaluation's accepted model routes and exact
per-root allocation. The authenticated `POST /api/organizations/:organizationId/agents/:agentId/model-preview`
returns the non-secret route snapshot and digest for the operator's scope. Trial preparation
requires that digest and allocation and rejects intervening default or metadata changes. Later
trial turns reuse the prepared snapshot, even if the organization default changes. Rotation or
revocation invalidates its authority rather than choosing another account. Ordinary execution
still resolves saved defaults at each new admission.

The external Harbor adapter requires prepared scope v2 with `model_routes_digest` and
`root_token_limit`. Recovery and exports must match those pins. Each exported task includes its
accepted model snapshot and digest; model calls and compaction receipts include the exact
binding and effective policy. Harbor verifies snapshot hashes, call-role identity and bounded
child inheritance. ATIF keeps that provenance. Private native continuation is not exported.
The adapter retains isolated trials, purpose-specific suites and authoritative outcome graders.
The reviewed xAI, DeepSeek, Mistral, Groq, Together, Fireworks, Moonshot/Kimi and Z.ai profiles
now use installed adapters. Controlled real-HTTP conformance covers their endpoint/authentication,
unsupported fields, private reasoning/tool continuation, refusal, truncation, unknown usage and
output caps. Mistral uses the pinned library's native parser and a thin wire conversion, preserving
native thinking chunks. Compatible routes retain provider-native thinking defaults; arbitrary SDK
reasoning options are rejected. These tests establish protocol behavior, not live model access.
Native fault fixtures cover401/402/403/404/429, malformed and truncated streams, cancellation
and late authorization revocation. They assert no hidden SDK retry or billing-route fallback.
Purpose acceptance uses actual PostgreSQL, Restate, EvaluationTrials and native HTTP fixtures on
OpenRouter, OpenAI Responses, Anthropic, Google and Mistral. Independent graders check approved
FAQ evidence/citations and canonical Inbox handoff. Booking cases on OpenRouter and Anthropic
check zero Calendar inserts before approval, a confirmed effect after approval, zero inserts on
conflict and zero duplicate effects on replay. Authenticated customer creation rejects research,
content and campaign offerings. Growth/Agencies campaign publishing remains unsupported; generic
research/read fixtures do not establish publishing outcomes.
Qualified counters for compatible routes and live multi-provider acceptance remain separate work.
No production or hosted capacity acceptance is claimed.

`api/test/model-purpose-acceptance.test.ts` writes a supported/unsupported matrix with authoritative
outcome evidence to `.audit/model-purpose-acceptance.json`. Run it with the isolated administrator
`AGENTS_TEST_DATABASE_URL` and `pnpm --filter @kasitek/agents exec vitest run test/model-purpose-acceptance.test.ts`.
The controlled browser fixture `api/test/model-provider-browser.ts` starts an owned database,
Restate container, API, worker and frontend. It drives provider setup, a native tool probe, model
selection/background saves, three chat/tool runs, model switching, rotation and revocation. It
requires installed Playwright Chromium and Docker. It never changes shared application accounts.
Run `pnpm --filter @kasitek/agents exec node --import tsx test/model-provider-browser.ts` with the
same isolated administrator connection. `AGENTS_LIVE_MODEL_ACCEPTANCE=1` instead selects the
explicit approved OpenRouter key and exact model for a live configured chat/tool path. Live calls
are opt-in and separate from the default controlled fixture. Set `AGENTS_LIVE_MODEL_ID` to an
explicitly selected current model; the fixture never chooses a replacement for a failed task.
Receipts retain exact requested and reported identities; evidence contains no keys, provider-native
thoughts or private continuation. On21 October2026, approved live OpenRouter acceptance passed
with `minimax/minimax-m3.1-flash:free`: the browser submitted a configured agent question, the
actual model requested approved knowledge search, the worker completed that tool, and a second
physical model call produced the final answer. Both private receipts retained the exact route and
reported identity. This route used explicitly labeled byte estimates. Other provider accounts were
not configured for that acceptance run. An earlier Nemotron request failed with `MODEL_UNAVAILABLE`;
its task was not retargeted. The controlled fixture separately passed the complete settings,
probe, switch, rotation and revocation journey.

Schema039 adds dedicated model connection, credential and use-grant tables. Setup retains its
fresh-database/checksum contract; existing databases are not silently rewritten. The routes
reuse `connection.lifecycle` telemetry with the bounded `model_provider` provider label.
Credential values and request/provider bodies are excluded. No new analytics event or exporter
configuration is introduced. Disable new routes/dispatch to stop setup; preserve non-secret
historical records for receipt attribution. No production rollout has occurred.

The [target product](architecture/agent-platform-architecture.md#standalone-agents-product)
offers mostly plug-and-play customer-service, FAQ, booking, and intake agents, with connected
customer channels and a shared staff inbox. Growth and Agencies own research, campaign, content,
and agency experiences using the shared execution backend. Shared runtime capability tests do
not establish those offerings in the standalone Agents catalogue.

The current application creates grounded FAQ or customer-service agents from the offering catalogue.
The chosen offering is stored on the agent. Offering names remain separate from execution programs.
The standalone Booking creation choice remains unavailable. Customer-service agents can explicitly
configure Google or Microsoft Calendar appointments, and other agents can open optional setup through Tools.
Agent execution presentation is shared with Growth through `@kasitek-labs/ui/agent`.
The standalone Chat, Activity and task-detail hosts use one product adapter for compact
operation rows, adaptive approach, public updates, output and specialist inspection. Running
and completed specialists open in the same read-only modal, backed by authorized task detail;
the dialog becomes full-screen on mobile. Closing it stops observation, not execution.
Public commentary comes only from completed primary-model public content accompanying tool
calls. Provider reasoning and raw tool payloads are excluded. Missing historical commentary
is not reconstructed. Operation metadata is bounded and cursor-paged; the interface can load
earlier activity. Source withdrawal removes protected content and current access is checked
while a specialist modal remains open. Customer timelines reuse plain message typography
without gaining runtime visibility. Controlled browser evidence is in
`web/test/chat-workspace.spec.ts`, `cited-passages.spec.ts` and `tool-reviews.spec.ts`;
these mocked transports do not establish live model acceptance.

Direct agent chat and principal-scoped conversation history are implemented. Customer website
messages have a separate canonical timeline with staff assignment, human takeover/replies,
resolution and explicit return to automation through the green **Return to Agent** action. Human-owned ingress does not admit model work.
Returning control admits only a new visitor message. Generation checks suppress late automated
output and fence subsequent operations, including inherited specialist authority.
The automation occurrence inbox below is an event deduplication mechanism, not a customer inbox.

Inbox conversation lists support newest-first (`updated_at DESC, id DESC`, the default) and
oldest-first (`updated_at ASC, id ASC`) using the existing tenant/activity index. Shared versioned
cursors retain the exact timestamp and identity and bind the workspace, actor, sort and filters; they do not look up mutable anchor rows. An activity change after the cursor
snapshot appears on a fresh list read.
The web queue refreshes its loaded window while visible, and selected conversations are reflected
in the URL. Owners can search and page through workspace members when assigning a conversation.
The conversation response includes the authorized assignee's display name even when that member
is outside the current picker page. Queue and staff timeline responses report whether the channel
binding is active; the interface identifies unavailable channels and disables new replies while the
server continues to check binding authority when commands are submitted. A saved template or
attachment reply whose acknowledgement was lost can still be retried with its original command;
this checks the existing outcome and does not authorize a new reply on a disconnected channel.

The Inbox queue includes the latest message preview, bounded to 500 characters. Assistant output
is checked against current evidence access before it is displayed. Customer names and record links
appear only when linked enquiries identify exactly one contact in the organization; otherwise the
interface uses an anonymous customer label. Search matches that customer name, the agent name, and
visitor or human message text. Search and all filters are bound to the cursor. The substring search
can scan message data; production-scale latency has not been benchmarked. Message candidates are
joined to conversations in the current organization before they can match the queue. Migration
`082_inbox_customer_identity.sql` adds the contact lookup index.

Staff and visitor timelines expose at most 100 messages per read. Earlier messages and Latest
messages replace the current page. Polling rechecks that page's current evidence policy; request
identity includes the conversation and selected page so delayed results cannot replace another
view. No unbounded browser history merge retains withdrawn output. `nextSequence` is the last
returned message for bounded `after` reads; `latestSequence` is the canonical conversation
watermark regardless of the selected page. `earlierBefore` identifies the next older page.

Visitor chat instances and pending-send storage bind both deployment and visitor token. Route
changes withhold the prior deployment's view while the new session initializes. A late send
acknowledgement from an unmounted session cannot clear another session's pending input.

Website, WhatsApp, Telegram, Messenger and Instagram use shared connection records and
canonical Inbox ownership. `adapters/channels/catalogue.json` declares installed handlers,
login modes and supported content. `product/channels/` owns connection lifecycle, provider
setup, durable ingress/delivery, approved WhatsApp templates and private staff attachment access.
The Connections channel catalogue is separate from model providers and business-system tools.
An installed adapter is not evidence that a live account passed provider acceptance.

Schemas052–061 add encrypted connection revisions, selected assets and agent deployments;
channel-neutral customer identity; ingress/outbound receipts; setup/session claims; website
appearance/pause; consent; and isolated external-runner fixture mappings. No Growth tables,
private runtime imports or legacy installation controllers are restored. Schema063 and
`contracts/execution.ts` identify `product-capabilities-v11` / `AgentsBusinessRunV21`;
schema063 advances the schema060 channel release. Changed durable product review branches
require the matching worker identity. Previously accepted releases retain their matching worker; startup never silently upgrades an older schema.

Non-website admissions use a verified `channel_customer` principal bound to the deployment and
canonical conversation. The same admission/model routing/root budgets, Restate loop, context,
public knowledge/skills, booking confirmation and ownership fences apply. No website session is
fabricated. Saved settings update future channel admissions without replacing the address,
customer thread or history. Accepted work retains its pinned model, snapshot and authority.

Raw-body signatures or connection-specific Telegram secrets precede JSON parsing. Verified
receipts and pending commands commit before webhook acknowledgement. Unbound or ambiguous
assets fail closed. Stable provider identities and request digests deduplicate ingress; Telegram
message IDs are scoped by bot and chat. A local receipt sequence orders each thread. Pending
ingress has bounded claims/backoff and a quarantined outcome after repeated failures. Media-only
messages request staff assistance without model admission; private media locators never enter
prompts. Captions can be processed as text without claiming image/audio understanding.

Human and automated messages enqueue durable segments in the canonical transaction. Claims,
current credentials, binding and ownership are checked before physical sends; no SQL transaction
spans provider HTTP. Provider acceptance is distinct from sent/delivered/read. Lost acknowledgements
and abandoned sending claims remain unknown and are never silently requeued. Assigned staff can
explicitly continue later messages without resending an unknown operation. The uncertainty and
actor decision remain recorded. Known provider429 rejections honor bounded retry guidance;
successful segments are not repeated. Delivery uses the existing worker maintenance lifecycle.

Telegram setup verifies bot identity, requires deliberate replacement of an existing webhook,
stores its generated secret privately and serializes setup mutations. A matching webhook URL
after a lost setup acknowledgement cannot prove its secret: health stays needs-attention until
an explicit acknowledged setup succeeds. Meta uses owner/session-bound one-use OAuth/signup
and selection tickets, explicit paginated account/number selection and server-side token custody.
Direct Instagram and Page-linked credentials stay distinct. Exact embedded-signup origins are
checked. Setup claims serialize connection and shared Page/WABA mutations across replicas.

Meta setup requires private `AGENTS_META_CHANNEL_PROFILES` records validated by
`metaSetupProfileSchema`, with reviewed app/API version, permissions, subscribed fields and
signup configuration. Redirect URI must equal the configured application origin plus
`/app/connections`. Telegram requires `AGENTS_CHANNEL_WEBHOOK_ORIGIN` and the existing vault.
No Graph version or provider key is guessed. Public callback paths are
`/api/channel-webhooks/telegram/:connectionId` and
`/api/channel-webhooks/:kind/:mode` for Meta profiles. Missing prerequisites remain unavailable.

Standard Meta replies use the latest verified customer-message time, not receipt/echo/takeover
time. WhatsApp out-of-window replies require a currently approved supported text template and
recorded customer opt-in. Template payload, exact rendered preview, category/consent revision,
ownership and credential revisions are revalidated before dispatch. Media/buttons templates are
explicitly unsupported. Direct Instagram Login can send a text-only staff reply with Meta's
`HUMAN_AGENT` tag within seven days only when the server profile records approved permission, the
replying human owns the active conversation, and a verified customer message exists in that
conversation. The policy result is rechecked before the physical request; a changed result
suppresses the send. Customer/tool requests cannot provide the tag. Automated acknowledgements,
waiting/status notices, Page-linked Instagram and Messenger never use this exception. Taking over
alone does not grant it. Telegram acceptance does not establish delivery/read. Instagram outbound
documents and reusable-ID sends remain unsupported; the installed protocol supports text and
image/audio/video URLs. Staff attachment access is authenticated, provider-scoped, bounded and
downloaded as an attachment; no public raw provider URL is returned. Optional speech/vision
backends are not supplied by this block.

Website presentation retains the working parent-origin Shadow DOM transport and canonical
visitor sessions. Growth's launcher, appearance, mobile and suggested-message presentation are
adapted without introducing another iframe/postMessage authority bridge. Appearance and pause
changes use an owner-authorized digest check. Pause fences new grants and current publication
checks, while staff history remains readable and unpause retains the same widget URL.

Google and Microsoft Calendar appointments use their own reviewed service policy rather than a
personal generic binding. The Tools catalogue exposes built-ins, native API and MCP integrations,
agent-specific recommendations, and current connection readiness. Custom MCP setup supports encrypted
keys, resumable OAuth, discovery, compatible tool selection, credential rotation, and disconnect.
Selection creates immutable executable bindings for operator runs. Endpoint discovery or OAuth alone
does not grant an agent access. Native API import previews OpenAPI operations or an advanced structured request editor and authentication
alternatives before explicit credential and operation selection. Generic writes require exact review.
MCP resources, fixed template instances and prompts use the same immutable bindings, execution
grants, controller, budgets, private receipts and evidence as connected tools. Exact URI/prompt
handles are selected explicitly; template values and the SDK-expanded URI are pinned together.
Resource URIs never become network or local filesystem destinations. Prompt activation requires
exact single-use approval; returned roles remain external tool-result data. Reviews show readable
target names and evidence records the actual RPC method. No prompt becomes an installed skill.
The bounded category/authority-keyed MCP descriptor cache has a maximum 30-second metadata TTL, explicit
uncached refresh, and pinned-schema/current-authority checks before each send. It does not claim
persistent change notifications. Live provider OAuth acceptance and verified generic provider
account identity remain separate gates.
Research/report acceptance fixtures prove execution behavior, not a standalone research product.
The runtime's reviewed personal memory does not imply a personal-assistant catalogue offering.

## Customer agent configuration

The customer editor has Tools and Skills catalogues with search, recommendations and explicit
draft selection. Skills include reviewed KasiTek procedures and private SKILL.md/ZIP package
imports, exact public GitHub commit/path imports, file previews, and exact-digest owner review. Complete packages retain immutable files,
source identity and content digests. Private imports require explicit draft selection. The curated Add action installs the official package
and selects its reviewed revision in the unsaved draft. Publication
and runtime loading reject unreviewed packages. Import, installation and review never execute scripts.
Package-based skills load names and descriptions first. Selected agents receive
`skills.activate` and `skills.read` with a separate `skill.read` grant. Activation
loads the complete reviewed root `SKILL.md` procedure within the current model budget.
The import limit is 64 KiB for that file; there is no separate 4 KiB runtime rejection.
If the complete procedure cannot fit, activation reports `SKILL_CONTEXT_LIMIT` without
silently truncating it. File reads require prior activation. Other package files are
reference data or executable text, never system instructions. Large reference reads
return UTF-8 byte ranges, completeness, exact package/file digests and `nextOffset`.
The model can recover later pages using the same reviewed file identity. Resource pages
are sized against the pending request and may be omitted or explicitly excerpted during later
packing; the visible range and next offset describe only the UTF-8 bytes actually supplied.
Compacted receipts identify loaded ranges separately and state that the corresponding content
may be excerpted or omitted. Complete active procedures remain mandatory. Durable load receipts
restore exact loaded ranges after compaction or worker replay. Reading a script never runs it.
Previously published version 1 skill tools retain their exact complete-file contract and limits;
new version 2 tools support paging. Legacy text revisions retain their existing eager loading.

New publications pin `tools.discover` and `tools.load` version3. The shared v15 runtime builds an
initial capability directory from the currently authorized direct catalogue, selected reviewed
skills and permitted specialists. Friendly titles, purpose, effects and exact load handles describe
available work; they do not grant permissions. Child-only commissioned tools remain outside the
parent's direct catalogue. External connection descriptions stay reference data rather than
privileged orientation. Measured budgets select eager/automatic schemas and directory details;
counts and omitted entries remain explicit, and large schemas remain recoverable through loading.

Version3 discovery supports explicit browse, ranked search, up to four purpose queries and stable
bounded pages. `matchedCount`, `returnedCount`, `complete` and `nextOffset` distinguish one page
from a complete inventory. Known safe handles from the directory can be loaded directly without
search. A successful load pins exact schemas across worker replay; `replace` discards earlier
optional selections. An oversized load returns `TOOL_SCHEMA_LIMIT` before a successful receipt,
so the model can request fewer schemas or replace the prior selection. Each invocation must match
a schema exposed in its accepted request and still authorized at dispatch.

Version1 retains exact alias/qualified-handle loading and optional digest preconditions. Version2
retains handle-only loading and its earlier discovery result shape and schema-selection policy.
Accepted request snapshots, descriptor digests and operation receipts are not rewritten by the
version3 directory or loading policy. Discovery and activation do not install adapters or bypass
current authority and reviews.

Growth's **Knowledge & skills** action uses the same native stores with a separate mapped product
feature scope. Schema103 records service/actor provenance instead of creating standalone accounts.
An owner/admin imports text/Markdown sources or portable/curated skills, reviews exact immutable
content and selects it in a later configuration action. Sources preserve raw-object custody and
normalized passage offsets; package review pins the complete digest. Selection publishes a new
v15 composition and immutable native source pins. Current resource policy and current feature
selection fence accepted work. The product-managed coordinator follows configured specialist
versions in new publications, with commissioned source ceilings pinned separately from direct
retrieval. Custom coordinators keep explicit version pins. Growth native uploads currently expose
plain UTF-8 text/Markdown only; no PDF/URL acquisition, sandbox, workflow or connection authority is
implied. The [Growth integration reference](growth-integration.md#knowledge-and-skills) defines
the signed commands and owner route checks. Selected sources or skills missing from the bounded
inventory are labelled unlisted; their status is unknown until checked separately.
Small runtime/recovery tools remain available independently of optional business schemas.
Tool-directed versions with selected skills and the separately enabled `sandbox.analyze` capability
also expose `skills.run`. The model alias is `skills_run`. Activation is required; loading script
source with `skills.read` is optional. Execution selects an exact reviewed `scripts/*.py` entry,
limited to 16 KiB, and records the package digest, script digest, revision and relative path.
The existing `python-analysis-v1` gVisor runtime stages the complete package read-only under
`/input/skill`. Reviewed sibling modules, package-root modules and packaged resources are available.
The entry runs with Python `-I -S -B`, a fixed wrapper and validated paths passed as arguments.
Package files and authorized artifact inputs share the existing 32-file and 4 MiB input limits.
Current `skill.read`, `sandbox.execute`, `artifact.read` and `artifact.write` grants are required.
Execution uses the original admitted resource-operation deadline and existing root budgets.
No host execution, injected credentials, network access or dependency installation is available.
Other languages and unavailable sandbox backends fail explicitly.
Script receipts and generated artifact dependencies retain the complete package digest through
compaction and continuation. Disabling or removing the package fences launch, later artifact access
and dependent execution. Normal finalization destroys the allocation; the independent reaper retains
cleanup responsibility after worker loss or failed cleanup.
This behavior uses `product-capabilities-v11` and `AgentsBusinessRunV21` with a fresh
schema through `038_skill_script_runtime.sql`. An older worker or database is not upgraded in place.
Skill update and rollback select one reviewed revision per publisher/source family. Requirements
recheck existing connections, permissions, and runtime access; they never grant capabilities.
Disabled or removed packages remain immutable records and lose current execution authority.
Skill requirements expose repair actions in the exact revision preview. Connection setup uses the
shared connector flow and returns to that same agent/revision. The owner explicitly chooses current
server-ready bindings, saves the draft, then adds the reviewed skill. Installation never selects a
connection or grants access automatically. Catalogue readiness refreshes after a saved draft revision.
Selected connected tools remain visible when their connection is revoked, expires or its permissions
change. Their status identifies the problem and offers the existing reconnect or configuration path;
the saved selection is not silently replaced. Skill requirement readiness counts a selected connection
only while that connection is active, unexpired and still matches the binding's policy revision.
Selected tools or skills missing from the returned catalogue remain removable as unlisted selections;
the editor does not claim they were revoked.
A Python runtime requirement opens contextual General Analysis configuration. This control also appears
when analysis is already enabled; the default FAQ form remains compact. Enabling analysis is a separate
explicit draft change for compatible tool-directed versions. The grounded program cannot enable it,
and the editor does not switch programs. Missing isolation backends still block publication.
Unknown runtimes remain unavailable. Personal-memory, specialist and report configuration remain
outside the customer editor; shared-harness acceptance provisions those capabilities through authenticated APIs.
Website publication permits only enabled, reviewed server-curated instruction packages with their
exact shipped digest. Private and repository packages remain operator-only. Generic personal
connection bindings remain unavailable to website visitors. Exact-confirmed HubSpot intake is an
explicit service-sharing exception, validated at deployment and every physical effect. Customer
contact lookup is denied. Google and Microsoft calendars use a separate pinned service policy. Operator chat can publish reviewed procedural skills and selected generic tools.
Customer creation loads the actual catalogue, sends the selected FAQ/customer-service offering and
keeps submission unavailable when catalogue loading fails. Website chat reads the canonical customer
timeline; prior browser output caches are discarded before current-policy reads.

The trusted channel-port acceptance uses normal native human grants and canonical fixture records
for specialist and approved-report takeover races. It proves inherited claim fencing and status-only
reconciliation of a provider-accepted report after takeover. Public website publication still rejects
delegation, analysis and report workflows; those tests do not establish an advanced website offering.

`AGENTS_INBOX_RECOVERY=1` enables `test/customer-inbox-recovery.test.ts` with a fresh database,
owned Restate instance and independent worker processes. It kills the worker during a model call,
then checks queued-root cancellation, stable invocation identity, conservative unknown-outcome
accounting, late-output suppression and canonical human context after restart. Returning control
admits only the next new visitor message; queued and human-owned messages are not replayed.
The controlled local provider records physical calls without external model requests.

## Native calendar and contact authority

Server-configured Google Calendar, Microsoft 365 Calendar and HubSpot connectors use a shared
OAuth/account lifecycle with an encrypted vault. Calendar providers share the booking workflow.
Owners explicitly select a writable calendar and opt into organization service sharing. A booking
policy pins that calendar, owner, policy revision, time zone, duration, notice, advance window,
and opening hours. Selecting a policy changes the agent draft; publication remains explicit.
The separate Booking creation offering remains unavailable. The [integration reference](mcp-integration.md#native-business-providers)
records provider configuration and authority boundaries.

Website proposals belong to the scoped visitor task and current conversation ownership generation.
Exact confirmation is a durable wait. Provider insertion starts only after current authority and
conflict checks. Staff takeover fences subsequent insertion even when a customer already approved.
Confirmed output uses the authoritative receipt. Unknown acceptance remains uncertain and requests
shared Inbox handoff only while the original automated ownership binding remains current. Existing
human ownership is preserved. Staff can inspect the selected conversation's appointment status and
request GET-only reconciliation; staff cannot approve or decline for the customer.
**Check status** uses only a leased provider GET for the deterministic event, never another insertion.
It does not rewrite the original uncertain task outcome. Active claims return `BOOKING_IN_PROGRESS`.
Public booking projections omit private task and provider event identities.

HubSpot contact intake uses exact principal-bound review. Website cards and messaging native
buttons show only the submitted fields. Verified messaging callbacks require the original sender,
thread, deployment and accepted prompt. Expiry, changed service sharing and staff takeover fence
the effect. Unknown contact creation requests Inbox handoff without replacing a human owner.

## Published execution and evaluation contracts

Trusted `grounded-conversation` and `tool-directed` program releases share the business loop.
Publication validates exact tool/workflow closure and saves a digest of the effective configuration,
program/runtime releases, context policies, tools and connected bindings. Admission saves that
composition on the task; workers validate it before further execution. Task bindings and published
compositions are immutable. Workspace programs remain unavailable. Google Calendar and Microsoft 365 Calendar implement bookings; availability still requires
the configured OAuth application and vault. HubSpot supports staff lookup and exact-confirmed
customer contact intake. Customer contact lookup remains unavailable.

Execution loading reads current task, version, and connected-binding records and validates their
schemas on every call. A private cache reuses only successful pure composition compilation for
identical validated configuration and full binding content, under the process's fixed compiler
and runtime contracts. It holds at most 128 entries and 4 MiB of serialized key/result content;
oversized entries bypass it. This byte bound does not measure JavaScript heap overhead.
Cached results and compiler descriptors are deeply immutable.
The worker still checks both saved task and root-version compositions on every load. Grants,
source policy, memory, channel ownership, execution availability, and authority decisions are
outside this cache. Cache keys contain configuration content and must never enter logs or
telemetry.

Reviewed report stages live in `workflows/report-delivery/program.ts` and retain digest-bound
approval, one dispatch claim and status-only reconciliation.

Built-in contract JSON schemas are generated once per fixed capability name and stored as
deeply immutable metadata. Their published digests are unchanged. This cache contains no task,
configuration, or live authority state. Operation admission, receipt persistence, and task
settlement read only immutable organization/root keys before locking, then reload and validate
the full execution under the original locks. Current authority and dependency checks still run.

The baseline business source release is `product-capabilities-v11` / `AgentsBusinessRunV21`;
explicit adaptive programv4 uses V24 as described below; accepted V23 work keeps its original handler. Initial setup requires a fresh
dedicated schema through `038_skill_script_runtime.sql`. Verification uses separate compiled artifacts and databases. Running older local
artifacts are not upgraded by setup or rewritten to accept the new schema.

Each operation journals its physical outcome and attempt identity before a separate durable step
persists its native receipt. Database retries replay the retained result without repeating provider
I/O. A crash before that journal acknowledgement remains uncertain. Receipt persistence verifies
the current attempt, terminal state, output and accounting; a conflicting existing receipt is never
upgraded to success. `AGENTS_OPERATION_RECOVERY=1` enables the actual worker SIGKILL and
PostgreSQL failure cases in `test/operation-journal-recovery.test.ts`.

Native evaluation trials require an authenticated operator, a dedicated unused agent and the exact
published composition digest. Trial preparation is idempotent. Tasks retain the server-validated
trial binding, a total allocation ceiling and isolated conversation/memory/artifact scope. Suites
must provision controlled external provider resources separately. Revocation fences further work
and requests cancellation; it does not claim an external call stopped. Lookups recover trial and
root identities after lost responses. Authorized native history export retains exact request,
response, evidence and branch records, with explicit coverage gaps.
Revoked or expired trials withhold private history content while retaining the export's
root identity and explicit coverage gaps.

`POST /evaluation-trials/:id/channel-session` binds the operator-owned trial to its published website
and allowed origin. It returns a normal opaque visitor token, derived using the independent
`AGENTS_LOGIN_RETURN_SECRET`; retries recover the same session. The server supplies trial authority
at ingress. Public callers cannot choose a trial UUID. `GET /evaluation-trials/:id/channel-history`
returns authorized canonical messages, ownership commands, delivery facts and native root IDs.
Operator task/history export for these visitor roots requires the exact trial owner, current
membership and matching server-side publication/session binding. Revocation expires the visitor
session; authorized audit metadata remains available with current-policy payload withholding.

The trusted `adapters/products/product-execution.ts` contract verifies signed short-lived product
assertions against an installed issuer/key and registered tenant mapping. Product actors
retain their own identities; admission does not invent an Agents account or membership. The current
contract consumer supports model replies and approved public knowledge only. Rich product tools,
private product records, delegated specialists, memory and sandbox scopes remain unavailable through
this product adapter until their resource contracts exist. These constraints do not limit the separate
shared harness acceptance fixtures. Agency's separate client-scoped ingress is described below;
production deployment remains separate.

Growth uses `product/integrations/growth-execution.ts` for private product conversations,
configuration, tasks, review UI and exports. Its product-owned manifest and four presets live in
Growth API `src/agents/manifest.ts`. Managed revision 5 publishes a `tool-directed@4` assistant
with three pinned same-business `tool-directed@3` specialists. Both compile immutable product bindings;
`execution/products/product-runtime.ts` routes calls and opaque reviews through installed product
ports. The shared loop has no Growth preset dispatch. Runtime clients and credentials are scoped
to each runtime instance; global descriptor registration cannot redirect another instance.

Origin authorization and destination authorization are independent. The Growth adapter checks
current originating business access before destination operations. Each binding pins origin and
destination product/tenant, mapping, policy, descriptor, manifest, installed handler and resource
ceiling. A tool selection, shared issuer or matching tenant string creates no cross-product grant.

An explicitly selected Growth conversation context is resolved through the signed `context.read`
action. The worker supplies its model-safe view and binds the reference, content revision and
recipient/provider audience in evidence. Current access and the view digest are rechecked before
replay, compaction, accepted-memory recall and delegated use. Post account and publishing-job fields
are excluded from the model view.

Growth exposes bounded workspace context/help, content discovery/read, WhatsApp campaign
discovery/read, explicit-range analytics and reviewed DRAFT creation through existing domain
services. Presets share tools. Exact operation authority and account scope govern draft writes,
not the preset name. Each read preserves its source/binding/revision through context, compaction,
history and later checks. The assistant uses the shared adaptive loop for discovery, concurrent
children, result inspection and revisions. Signed active instructions, authority continuation,
root cancellation and child review projections retain Growth's initiating actor and business.
Child authority intersects the root's product scope and current enabled specialist pin, with no
standalone Agents membership. Native knowledge bindings, skills, memory, sandbox,
workflows and external connections remain unavailable under the initial Growth product policy.
See [Product capabilities](product-capabilities.md) and [Growth integration](growth-integration.md).

Agency implements one signed `agency.workspace_agents.read` operation under product namespace
`agencies`. It reads real workspace-agent metadata using explicit destination-issued actor and
workspace mappings, exact grants and current Agency roles. It excludes configuration and message
bodies. Real PostgreSQL/API acceptance covers scoped reads and revocation. The shared-runtime
acceptance also covers published inline bindings, HTTP invocation, evidence revalidation and
independent runtime credentials. Agency staff now have a client-scoped product ingress and portal
assistant through the shared runtime, plus optional reviewed personal memory and explicit model
setup. Agents schema102 and Agency's client-scope migration preserve workspace/client/actor
identity in conversations, bindings, observations and memory. The UI uses the shared conversation
and specialist components. The initial business operation remains metadata read; voice, broader
business effects and client-customer access are not enabled by this integration. See
[Agency capability configuration](../../agency/docs/agent-capabilities.md) for trust, scope,
readiness, current evidence and release limits. Absent credentials/mapping/grants remain unavailable.

Growth's initiating user can export actual accepted composition, product bindings, model-route
pins, operations and source evidence through `GET /api/agents/tasks/:taskId/export`. Current access
can withhold evidence. The external Harbor adapter consumes supported native capture and optional
composition/manifest/model pins independently for each prepared configuration. It does not invent
ATIF records. Server-native Growth trial reservation/revocation is still unavailable. All evaluation
and grading runs remain owner-run. Existing deterministic browser/HTTP/Restate checks establish
engineering behavior only; they do not establish model quality or live provider compatibility.

Execution events persist `agent.observation.v1` metadata and an export intent atomically. Explicit
OpenTelemetry spans carry native scope, program, operation, attempt and usage identities, without
prompt bodies, tool arguments or credentials. The bounded publisher leases pending observations
across replicas and retries Collector failures independently of execution authority and accounting.
Configure `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` to enable export.
Local verification includes actual SDK export through the pinned Collector OTLP receiver, native
PostgreSQL replay/deduplication and outage recovery. This is not a hosted monitoring deployment.

### Metrics and local telemetry access

`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (or the common OTLP endpoint) enables the pinned SDK metric
exporter. SQL snapshot gauges report native task/operation states, operation usage, queue waits,
dispatch backlog/attempts, Inbox commands/deliveries, allocations, observation backlog and local
pool/lock waits. Labels contain bounded product, program, workload, kind, state, action and process
role values. Tenant, task, customer and connection identities are absent from metric labels.
Snapshots of shared database facts must use one replica or a max aggregation, never sum replicas.
Task/operation/command/usage counts use a rolling 24-hour window including older unfinished work;
completed duration and granted-wait percentiles use one hour. They are gauges, not lifetime counters.

`agents.dispatcher.phase.passes` counts completed dispatcher passes per replica, and
`agents.dispatcher.phase.duration_ms` records their wall time, including pool and network waits.
Their only labels are the five fixed phase names and `ok` or `error`. A successful phase means
its pass resolved, not that every task or provider operation succeeded. These counters and
histograms are process-local, unlike the shared database snapshot gauges.

Connection management emits metadata-only JSON lifecycle logs and separate root OTLP spans
through `observability/connection-telemetry.ts`. Connect, authorization/callback, discovery,
refresh, reconnect, rotation, selection/probe and disconnect records carry a fixed flow/outcome,
elapsed time and trace ID. Existing authorized row reads and mutation `RETURNING` values supply
connection, organization, policy revision and authorization generation when known. Credential
checks are separate from actual refreshes. These flows do not invent task/agent identities or
log URLs, scopes, provider bodies, callback data, credentials or customer text. Generic runtime
task observations retain agent/version/run/operation lineage and the resolved authorization
generation; explicit connected-result latency survives while the enclosing operation is active.

Control-plane export is best effort, with at most 64 pending span exports and a three-second
exporter timeout. It never acquires another database connection or awaits a log/export result
before settling business work. This differs from the durable task observation outbox.
`agents.connection.lifecycle.attempts` and `.duration_ms` are process-local attempt counters and
histograms with fixed provider/flow/outcome/failure-class labels, not authoritative effect counts.
The `agents.connected.provider.attempts` and `.latency_p95_ms` gauges derive from actual persisted
physical receipts over one hour, with bounded provider, phase and response/failure labels; legacy
profiles coalesce into one `other` provider. The [integration reference](mcp-integration.md#connection-observability)
links focused helper, actual OTLP receiver and PostgreSQL producer checks.

### Support lifecycle Analytics and release record

Agents emits the registered `agent.support.lifecycle@1` event through the existing transactional
Analytics outbox. Its attributes are limited to agent/version, one of the five customer channels,
bounded lifecycle action/outcome values, event time and an optional duration. Customer, conversation,
message, staff and contact identifiers, email addresses, summaries and message bodies are excluded.
Evaluation-trial conversations are excluded before enqueue. The `agent.support.lifecycle_events@1`
metric counts the event facts; `agent.support.response_time_ms@1` aggregates request-to-acknowledgement
and request-to-first-human-reply durations. Dimensions are agent, version, channel, action and outcome.

| Release field | Decision |
| --- | --- |
| Owner and risk | Agents engineering; standard risk. |
| Affected services | Agents API and worker; Analytics contract/metric registry. No customer-facing configuration changes. |
| Release identity | No release tag or deployment has been assigned. Source commits identify the local implementation; package `0.1.0` is not a production release. |
| API/schema | Additive Analytics event and metric registry entries. No Agents database migration; the existing Analytics outbox and ingestion envelope are reused. |
| Rollout | Publish the Analytics registry before deploying an Agents API/worker artifact that emits the contract. The existing optional `AGENTS_ANALYTICS_INGESTION_URL` and `AGENTS_ANALYTICS_INGESTION_TOKEN` enable delivery; without both, facts remain durably queued. |
| Logs and telemetry | No new OTEL signals, Collector revision or endpoint. Event payload redaction is enforced in the producer and verified by focused tests. Existing publisher failure diagnostics and exporter-disable controls remain in effect. |
| Documentation | Agents README and source-boundary map updated; no public API contract changes. |
| Validation | Analytics registry check/build, Agents typecheck, targeted support lifecycle/privacy tests, relevant Inbox/channel/follow-up tests and repository boundary check. Owner-run model evaluations and live-provider acceptance remain separate. |
| Rollback | Roll back matching Agents artifacts to stop new event production; preserve queued immutable outbox records for reconciliation. No schema rollback is needed. Handoff and accepted notification state remain unchanged. |
| Post-release review | Not scheduled because no deployment is authorized or assigned. |

### Requested and reported model identities

Native adapters emit a safe `modelIdentity` receipt with the exact requested model, a reported model
or `null`, and `same`, `different` or `unreported`. Chat Completions and native Mistral read the chunk
`model`; Responses reads `response.model`; Anthropic reads the starting message's `model`; Google
reads `modelVersion`. Reported names must be nonempty strings of at most 512 characters without
control characters or surrounding whitespace. Repeated reports must agree. Malformed or conflicting
reports make the physical outcome uncertain, with no hidden retry or execution of returned tools.

`different` records a provider's reported name. It does not establish equivalent capabilities,
pricing or permission to change the accepted route. The binding and private continuation's `model`
remain the requested ID. Omitted identities remain explicitly `unreported`. Native adapters always
produce a receipt; trusted test dispatch fixtures may omit it and receive an unreported receipt.

Schema050 adds the safe receipt and its digest to private model continuation records. The worker
validates it against the accepted requested model, persists it before returning completion, and
verifies its digest when restoring continuation. Safe operation results carry the same receipt;
private thoughts and signatures remain excluded. Existing immutable route snapshots retain endpoint,
connection/use-grant/credential revisions, adapter and policy identity for the physical operation.
The receipt is observational metadata, not a replacement model selection or a proof of exact billing.

### Model invocation observations

`observability/model-telemetry.ts` defines the strict `model.invocation` operational event schema.
The shared business loop wraps primary, delegated and compaction model calls inside their existing
durable operation. Each physical invocation emits one best-effort JSON record. Replaying a completed
operation does not invoke that wrapper again. This event is an attempt observation, not an invoice,
a durable usage receipt or a replacement for the task observation outbox. Abrupt process loss can
lose an event. The operations, cost reservations and private continuation tables remain authoritative.

The record contains accepted provider/protocol/model, any reported model and its explicit relation,
connection, route and policy digests, adapter
revision, runtime release, root/task/operation identities, bounded outcome/failure class and elapsed
time. It excludes URLs, keys, headers, prompt and response text, tool arguments, provider request IDs,
raw errors and private reasoning/continuation. Model and connection identities appear only in logs
and traces. OTLP spans share the root task trace and the native task parent. They use the existing
exporter and its 64-pending-export bound; no extra Collector, scheduler or HTTP instrumentation runs.

Typed model failures also retain the controlled failure code, actual observed HTTP status when
available, request-dispatched flag and fixed failure stage in `model.observed` and the invocation
record. The HTTP status is separate from the application's error status. SDK body-reader cleanup
and transport teardown cannot replace an initiating parser/provider failure with cancellation;
actual caller cancellation and physical read deadlines remain failures of their own. These fields
do not reconstruct details missing from older attempts and do not authorize an automatic retry.

Duration starts at the physical invocation wrapper and includes credential checks, private history
restoration and native input counting. First visible token time records the first nonempty public
text callback relative to that start. Hidden reasoning and tool-only output do not create a text
measurement. Missing observations have an explicit `unavailable` status and omit their numeric value.
The wrapper has no authoritative queue timestamp, so it reports queue time unavailable. Use the
existing durable `resource.capacity_granted` observations and `agents.capacity.*` gauges for queue
waits, including requests that never reach a model invocation.

When usage is observed, input/output totals and available cache-read, cache-write and reasoning
subsets are separate fields. Missing subsets remain absent. Listed model prices and the same
normalized accounting quote used by settlement produce a USD micro-cost estimate only when all
required price and usage components are known. The event labels it `estimate`; invoice adjustments
are outside this measurement. Unknown usage or pricing never becomes a zero-valued estimate.

| Metric | Meaning |
| --- | --- |
| `agents.model.invocations` | Process-local physical invocation attempts by fixed provider bucket, protocol, role and outcome. Unknown provider IDs use `other`. |
| `agents.model.duration_ms` | Wrapper elapsed-time histogram in milliseconds. |
| `agents.model.first_visible_token_ms` | Observed first public text delay; absent for tool-only output or no visible text. |
| `agents.model.queue_ms` | Reserved for authoritative per-invocation queue measurements; current producer emits no numeric samples. |
| `agents.model.observed_tokens` | Observed token counters with a fixed category label. Cache categories are subsets of input; reasoning is a subset of output. Do not sum every category into total tokens. |
| `agents.model.cost_estimate_micros` | Process-local sum of representable listed-price estimates, separate from authoritative cost settlement. |
| `agents.model.unavailable_measurements` | Counts absent token categories, usage, timing and cost observations by fixed measurement label. |
| `agents.model.quota_rejections` | Quota/budget rejections observed inside physical invocation. Admission rejections occur before this wrapper. |
| `agents.model.budget_roots` | Native snapshot count of unsettled roots by `budget=cost|tokens` and `state=available|saturated|unlimited`. Saturation means current reservations plus usage meet the accepted allowance. |
| `agents.model.unknown_cost_operations` | Native outstanding unknown-cost operation count across root accounts, including settled roots awaiting reconciliation. |

Invocation metrics have no tenant, task, connection, endpoint, route digest or model-ID labels.
They are best-effort process counters and histograms. Database snapshot gauges must use the existing
single-replica or max aggregation rule. Unknown-cost gauges derive from durable accounts, so exporter
restarts and replay do not reset or multiply the accounting facts. A root with remaining allowance
may still reject a proposed reservation larger than its headroom.

Operators should correlate model authorization failures with the saved connection and its current
use grant, then rotate/reconnect or explicitly restore access as appropriate. A 402 credit failure
requires funding the selected provider account. A 429 calls for reducing concurrency or waiting for
the provider limit to reset. Model-access failures require a model available to that account; context
failures require a smaller request or a compatible larger context allowance. Do not change a queued
run's accepted billing route to repair an error. Budget saturation requires reviewing root usage and
reservations before admitting new work. An uncertain invocation or unknown cost requires checking the
native operation and provider account before retrying; exporter loss does not authorize a retry.

These are operational events owned by the Agents service, not new Labs product analytics events.
The schema and bounded metric vocabulary are the analytics decision for this change. API and database
schema changes are not applicable. Existing OTLP endpoint configuration and Collector revision apply;
set `OTEL_SDK_DISABLED=true` or remove exporter endpoints to disable export. Structured metadata logs
remain enabled. Hosted retention, production alert thresholds and live provider telemetry acceptance
remain deployment gates. Focused redaction, bounded-label, real local OTLP receiver and PostgreSQL
snapshot tests verify this implementation without asserting production capacity.

Collection has a 1.5-second SQL deadline and a 15-second export interval. Failed collection emits
`agents.metrics.collection_failures`; it does not alter usage or task state. Export timeouts are
bounded and shutdown flushes before closing the database pool. Set `OTEL_SDK_DISABLED=true` to
disable both telemetry paths. Export failure never proves an operation failed or an effect retried.

For local inspection, use `infra/observability/otel-collector/config.local.yaml` with the Collector
image pinned by the acceptance fixture. Bind OTLP and health ports to loopback. The debug exporter
writes operational metadata to local container logs; restrict Docker/log access to the developer.
Rotate local logs at 10 MiB with three files and remove disposable Collector containers and `.audit`
artifacts within seven days after review. Durable native receipts remain in their isolated fixture
until teardown; this local policy makes no production retention claim. Do not add payload fields to
ordinary telemetry; content reads use the separately authorized history/evidence interfaces.

## Concurrency verification

The dispatcher uses bounded leased batch claims and parallel sends with durable task identities.
Operation capacity uses queued requests, generation-fenced permits and durable Restate wakeups;
a waiting request holds no provider permit or operation reservation. Native operation begin/finish
uses root/task fences. Admission and settlement retain the organization accounting lock. Shared
versioned cursor keys support replica reads. Numeric policies are finite operator configuration.

The [scaling contract](architecture/agent-platform-architecture.md#concurrency-targets-and-workload-definitions)
defines 1,000/10,000 concurrent business-execution targets. The controlled two-replica 1,000 profile
passes its frozen dispatch, child activation, per-tenant, status, and Inbox control thresholds.
It reaches 1,000 simultaneous model HTTP requests and correctly completes 1,000 roots and 100
children, with exact physical-call and effect receipts. Other traffic distributions and fault
profiles require separate results. Four- and eight-replica mixed 10,000-root tests
miss admission, queue, and drain targets within the declared connection budget. The 10,000 target
remains unmet. Queued roots and active provider operations are measured separately. Requirements,
versioned reports, and load acceptance remain in Linear.
Executor routing and physical recovery require their own independent-process acceptance.

## Internal module boundaries

Implemented code lives under `contracts`, `infrastructure`, `execution`, `capabilities`,
`workflows`, `adapters`, `platform`, `integrations`, `product`, and `composition`. Product identity, agent/version,
website deployment, and execution admission stores have separate implementations;
`product/agents/store.ts` composes their existing management interface. Execution
consumers use neutral record contracts and credential ports. S3 transport is separate
from memory/artifact authorization. Evidence policy and content writes are separate,
so authority checks do not depend cyclically on storage.

`pnpm verify:agents-modules` checks static imports, type imports, re-exports,
string-literal dynamic imports/requires, forbidden dependency directions and file
cycles. Contracts and infrastructure cannot import product routes or programs;
capability/workflow/runtime modules cannot import product implementations. `platform`
may use contracts, infrastructure, execution and observability, and cannot reach
product or integration implementations. `integrations` may use platform, and cannot
reach product implementations. `product` may use platform. Unsupported computed module
loading fails the check. Negative fixtures prove these checks reject forbidden edges
and cycles. Cross-product checks remain separate.

No accepted edges remain. The command keeps the accepted-debt mechanism and reports a
recorded edge that no longer occurs as stale so it can be deleted. Workspace
permissions moved to
`platform/access/permissions.ts`; product routes and integrations require them from
there. The serialized-payload token estimate moved to `contracts/serialized-tokens.ts`
and identity prompt composition to `execution/context/agent-identity.ts`; product
identity defaults remain in `product/agents/identity.ts`. Admission reads billing
entitlements through `execution/admission/entitlements.ts`; the Agents adapter lives in
`product/billing/billing.ts` and `PlatformStore` injects it. The credential-reflection
helper moved to `infrastructure/credential-reflection.ts`; the GitHub, MCP, Stash,
public-repository, remote-MCP, native-API and native-provider adapter releases were
bumped because their manifest path lists changed the executable digest.

Agent management HTTP handlers moved from composition to `platform/agents/http.ts`.
Composition passes the product store, creation operations, offerings data and the
avatar schema as ports, so the module depends only on `contracts` and
`infrastructure`. Paths and payloads are unchanged.

Task and conversation handlers moved to `platform/runs/http.ts`: lists, admission,
detail, events, evidence, artifacts, instructions, continuation, cancel, history
export, conversation read and conversation delete. Archive and restore remain in
composition because retention makes deletion irreversible. Evaluation trial routes
moved to `integrations/http/evaluation-routes.ts` and visitor website routes to
`integrations/http/website-routes.ts`; both receive product behaviour as ports.
Session, workspace, assistant, member-channel, connection-fallback and MCP review
routes moved to their own `integrations/http/` modules. Only the archive and restore
pair remains in composition.

Composition entry points are `api/src/composition/` and compile to
`api/dist/composition/`. MCP's bounded helper remains adjacent to its adapter under
`adapters/providers/`; schema loading remains relative to the API package schema.
Moving adapter source changes executable digests. Existing immutable bindings are
never rewritten: new acceptance uses newly discovered bindings and published versions
with matching source/compiled artifacts. A previously recorded receipt still resolves
before the live registry; unavailable old releases fail closed for new physical IO.
The current business workflow is `AgentsBusinessRunV21`, with harness release
`product-capabilities-v11`. Isolated verification preserves existing running owner services
and their original compiled artifacts.

The relocation smoke compiles into an ignored output tree rather than deleting a
running `dist` deployment. From the repository root, with a disposable-database-capable
local connection and private-storage settings in the private API environment:

```sh
pnpm --filter @kasitek/agents exec tsc -p tsconfig.json --outDir .artifacts/modular-dist
mkdir -p products/agents/api/.artifacts/schema
cp products/agents/api/schema/*.sql products/agents/api/.artifacts/schema/
node --env-file=products/agents/api/.env products/agents/api/test/modular-launch-smoke.cjs
```

The smoke owns a uniquely named database and child processes. It checks source HTTP
startup, compiled schema/HTTP/worker startup, an actual compiled isolated MCP helper
against a local fixture, cleanup entry initialization and adapter executable hashing.
It does not call a real model/provider or verify cleanup of a live allocation.

## Current modules

| Module in `api/src` | Responsibility |
| --- | --- |
| `contracts/contracts.ts` | Agent configuration, two execution kinds, grants, limits, and task states. |
| `product/identity/auth.ts`, `product/identity/auth-routes.ts`, `product/identity/auth-return.ts`, `infrastructure/config.ts` | OIDC signup/login, one-use safe return links, product sessions, identity configuration and backchannel logout. |
| `product/agents/store.ts` | Product composition facade for the identity, agent, deployment and admission stores. |
| `product/identity/identity-store.ts`, `product/agents/agent-store.ts`, `product/deployments/deployment-store.ts` | Membership and sessions, drafts and immutable versions, and website deployment bindings. |
| `execution/admission/admission-store.ts`, `execution/admission/authority-store.ts` | Shared task admission, root reservations, authority persistence and authorized conversation/event reads. |
| `contracts/programs.ts`, `execution/programs/composition.ts`, `execution/programs/publication.ts` | Trusted program policies, compatible capability/workflow closure and immutable published composition digests. |
| `capabilities/tool-contracts.ts`, `contracts/workflows.ts` | Validated capability inputs/results, authority and resource requirements, and exact workflow confirmation contracts. |
| `product/agents/discovery.ts`, `infrastructure/read-pages.ts` | Principal-scoped agent/conversation/task summaries and signed scope-bound read cursors. |
| `composition/app.ts`, `composition/server.ts`, `adapters/channels/website/widget.ts` | Management and website APIs, continuation, history deletion, progress, cancellation, and widget delivery. |
| `execution/lifecycle/execution.ts` | Current authority, task and operation identities, claims, receipts, and usage settlement. |
| `execution/business/business.ts` | Restate business controller, model and tool rounds, ordered turns, and compaction coordination. |
| `execution/models/runtime.ts`, `execution/models/persistence.ts`, `execution/models/dispatch.ts` | Immutable accepted model routes, private native continuation, current credential authority, and protected physical dispatch. |
| `execution/models/policy.ts`, `execution/models/settings.ts`, `execution/models/accounting.ts` | Effective limits, operator defaults, delegated allocations, root monetary reservations, and normalized usage settlement. |
| `adapters/models/pi-transport.ts`, `adapters/models/google-transport.ts` | Native model protocols and private continuation normalization. |
| `execution/business/model.ts`, `execution/context/context.ts`, `execution/context/continuation.ts` | Shared message validation, request estimates, scoped snapshots, complete message groups, and bounded execution checkpoints. |
| `execution/memory/memory.ts`, `product/agents/memory-routes.ts` | Personal memory candidates, authenticated acceptance, revisions, expiry, forgetting, source invalidation, and pinned skills. |
| `infrastructure/object-store.ts`, `execution/artifacts/artifacts.ts`, `execution/artifacts/task-artifacts.ts` | Private S3-compatible content, root/task provenance, explicit transfers, downloads, integrity and deletion. |
| `execution/delegation/delegation.ts`, `capabilities/tool-descriptors.ts` | Published specialist bindings, atomic child admission, bounded results and pinned adapter contracts. |
| `capabilities/sandbox/sandbox.ts`, `capabilities/sandbox/sandbox-executor.ts`, `capabilities/skills/script-runtime.ts`, `composition/sandbox-reaper.ts` | Isolated analysis and reviewed package scripts, immutable script provenance, durable resource/command identities, artifact export and independent cleanup. |
| `execution/lifecycle/dispatcher.ts`, `composition/worker.ts`, `composition/worker-security.ts` | Leased outbox delivery, runtime identity, cancellation reconciliation, request signatures, and worker lifecycle. |
| `execution/scheduling/capacity.ts`, `execution/scheduling/capacity-turns.ts`, `execution/scheduling/dispatch-claims.ts` | Durable resource queues, independent tenant turns, generation-fenced permits and bounded replica claims. |
| `workflows/report-delivery/program.ts` | Durable report review waits, exact dispatch and status-only reconciliation through the shared operation lifecycle. |
| `product/inbox/inbox-store.ts`, `product/inbox/inbox-routes.ts`, `composition/inbox.ts` | Staff authorization, assignment, customer history, ownership changes, human replies and delivery fencing. |
| `product/reporting/support-lifecycle.ts`, `product/customer-followup/notifications.ts`, `product/channels/channel-delivery.ts`, `product/inbox/support-waiting.ts` | Registered, organization-scoped support lifecycle facts committed with handoff, reply, wait, alert, follow-up and messaging delivery outcomes. Customer identifiers and content stay out of Analytics attributes and dimensions. |
| `observability/event-store.ts`, `observability/observations.ts`, `observability/connection-telemetry.ts`, `observability/model-telemetry.ts`, `observability/telemetry.ts`, `observability/metrics.ts` | Durable typed task observations, authorized reads, replay-safe export, separate metadata-only connection and model invocation traces/logs, bounded attempt metrics and native budget/unknown-cost gauges. |
| `product/connections/connections.ts`, `infrastructure/vault.ts`, `workflows/report-delivery/actions.ts`, `adapters/providers/report-delivery.ts` | Scoped encrypted credentials, exact report review, atomic dispatch claims and read-only receipt reconciliation. |
| `product/automations/automations.ts`, `execution/lifecycle/automation-authority.ts`, `product/automations/automation-runtime.ts` | Immutable owner authorization, occurrence inbox, shared admission and Restate UTC timers. |
| `contracts/capability-catalog.ts`, `capabilities/connected-tools/connected-catalog-store.ts`, `capabilities/connected-tools/connected-executor.ts` | Immutable selected tools, executable releases, issued handles and durable connected receipts. |
| `infrastructure/connected-network.ts`, `adapters/providers/github-adapter.ts`, `adapters/providers/stash-adapter.ts`, `adapters/providers/mcp-adapter.ts` | Bounded egress, anonymous/keyed native reads, scoped Stash text and isolated MCP SDK execution. |
| `capabilities/knowledge/knowledge.ts`, `product/agents/knowledge-routes.ts`, `capabilities/knowledge/ingestion-runtime.ts` | Private candidates, owner approval, revision policy and durable import stages. |
| `capabilities/knowledge/document-runtime.ts`, `composition/document-reaper.ts`, `capabilities/knowledge/source-objects.ts`, `execution/artifacts/execution-objects.ts` | Pinned no-network parsing/embedding, physical cleanup and object write/deletion intents. |
| `capabilities/knowledge/retrieval.ts`, `capabilities/knowledge/query-embedding.ts`, `capabilities/knowledge/knowledge-runtime.ts`, `execution/context/evidence.ts` | Scoped lexical/hybrid retrieval, passage references and transitive policy dependencies. |
| `adapters/providers/connector-registry.ts`, `adapters/providers/default-connectors.json` | Validated supported-connector records and installed-handler selection; metadata does not supply executable code. |
| `product/catalogue/`, `product/agents/skill-package-store.ts`, `capabilities/skills/` | Contextual catalogues, immutable skill imports, family revisions, exact review, requirements, and current installation authority. |
| `product/connections/remote-connections.ts`, `product/connections/api-connections.ts`, `capabilities/reviews/tool-reviews.ts` | Generic MCP/API onboarding, selected bindings, and exact tool approval. |
| `product/connections/provider-connections.ts`, `product/connections/provider-oauth.ts`, `product/connections/provider-services.ts`, `adapters/providers/`, `workflows/booking/` | Shared native OAuth, selected actions, explicit service sharing, calendar booking policies, exact contact confirmation and read-only reconciliation. |
| `composition/setup.ts` | Fresh database initialization and schema checks. |

The management client is in `web/`. It uses Geist and shared light and neutral charcoal dark
appearance tokens. Theme preferences remain in Settings. The agent workspace groups setup and
configuration, while Connections presents real available channels and business tools in a searchable
catalogue. Custom MCP setup opens a URL-first side panel. Provider marks do not imply availability.
The [visual references](../design/interface-concepts/README.md) are concepts; current server state
and authorization determine which actions the client can show. Its chat, configuration, management
and explicit website-publication paths share these APIs. Growth and Agencies retain independent
membership, permissions, and domain records. Embedded execution remains unavailable.

| User entry point | Current behavior | Verification |
| --- | --- | --- |
| `/` | Restored public landing with provider-backed signup and sign-in. | Public-entry browser tests and isolated actual identity signup/verification. |
| `/pricing` | Public plan cards and comparison from `GET /api/public/plans`, which returns only active customer-visible plans; paid plan calls to action route through signup to `/app/upgrade`. Canonical host is `https://agents.kasitek.co.za/pricing` and card selection supports mouse and keyboard. | Public pricing route plus plan-catalog response and browser checks. |
| `/app/inbox` | Searchable conversation queue with safe previews, a collapsed filter control with an active count, and a message workspace with customer, agent, channel, ownership, enquiry and appointment details. Authorized staff can assign, take over, reply, resolve and return conversations to automation; appointment recovery remains status-only. | `customer-inbox.test.ts`, `inbox-queue.spec.ts`, `inbox-layout.spec.ts`, `inbox-handoff-states.spec.ts`, `inbox-bookings.spec.ts`, and durable takeover/status acceptance. |
| `/app/analytics` | Inbox handoff and response performance for the current plan period: handoffs requested, median first human response, resolved conversations, unassigned conversations, handoff trend and channel breakdown. Requires `agents.feature.analytics`; the basic overview remains free. | Analytics route checks, Free/Starter denial and Growth+ browser acceptance. |
| `/app/overview` | Workspace-scoped customer conversation totals and daily activity, new enquiries, current pending handoffs, recent conversations and channel totals. Seven- and 30-day periods use UTC calendar dates; pending handoffs and recently updated conversations are current rather than period-limited. Evaluation-trial conversations are excluded. | `agents-overview.spec.ts`, `customer-inbox.test.ts`. |
| `/app/agents` | Searchable, paginated agent directory with configuration-status filters, selected-agent responsibilities, connected channels and latest customer-conversation update. Chat and configuration open from the selected agent; conversation history appears in its chat workspace. | `agent-entry-directory.spec.ts`, chat workspace and discovery regression suites. |
| `/app/agents/:agentId` | Chat, Activity, General/Tools/Skills/Channels setup, Website publication, Growth-managed Facebook Page/Messenger, Instagram and WhatsApp account selection, immutable skill selection, exact-revision requirement repair, contextual compatible Analysis access and optional pinned booking policy. Social channels reuse Growth account authorization and credential custody; Agents stores only a selected asset and revocable grant. | `catalogue.spec.ts`, `skill-requirements.spec.ts`, `bookings.spec.ts`, focused Growth grant/webhook checks, and actual API `catalogue-live.spec.ts` / `catalogue-execution-live.spec.ts`. |
| `/app/agents/:agentId/conversations/:conversationId` | Authorized history scoped to its original agent and principal, per-turn configuration snapshots, current-policy output and inline report review. | Scope/recovery browser regressions and PostgreSQL history tests. |
| `/app/customers` | Enquiry, contact and support follow-up lists with activity and authorized Inbox links. Desktop can show a selected record beside the list; smaller screens open the detail view. | `customer-records.spec.ts` and native record database checks. |
| `/app/tasks` | Paginated authorized root tasks, filters and conversation/review links. | Actual PostgreSQL collection tests and browser navigation checks. |
| `/app/settings` | Real account/workspace identity, workspace creation/switching, theme and sign-out. | Settings browser checks and theme tracking regression. |
| `/app/settings?section=billing` | Current plan, AI usage, invoices, checkout, cancellation and usage detail. New AI work stops when available credit reaches zero; usage warns at 80% and 100%. | Billing settings browser checks, billing-access tests and sandbox checkout verification. |
| `/app/settings?section=members` | Owner/admin/member role management, owner-managed per-member permission overrides, invitations with plan seat limits, pending-invitation counting and escalation guards. | Permission and override unit tests, Members HTTP tests, seat-limit tests and Members settings browser checks. |
| `/app/knowledge` | Upload text/PDF/HTML, import one public URL, inspect candidates, approve, adopt revisions and withdraw. | Actual compiled ingestion, crash recovery and responsive browser acceptance. |
| `/app/connections` | Restricted profiles, custom MCP OAuth and separate Tools/Resources/Templates/Prompts selection, native API preview/credentials/selection, and owner-managed Google/Microsoft calendars and HubSpot action/sharing setup. | Connection browser contracts, published controlled MCP/API execution and actual API/controlled Google browser acceptance; live Google OAuth remains pending. |
| `/app/automations` | Pin report versions, authorize UTC/event triggers, inspect occurrences and control future runs. | Actual Restate timer/event HTTP checks and scheduled-report fixture. |
| `/app/tasks/:taskId` | Authorized task detail, exact tool/report review, exact appointment confirmation, and status-only booking recovery. | `tool-reviews.spec.ts`, `bookings.spec.ts`, and real API booking confirmation. |
| External website widget | Separate tab-scoped conversations, exact two-step appointment confirmation, and Check status without event resend. FAQ widgets do not fetch bookings. | `widget-conversations.test.ts`; generated-script `website-bookings.spec.ts`; actual isolated Restate/PostgreSQL `booking-business.test.ts`. |

Inbox message inspection recognizes the two previously shipped grounded-conversation v1 program
descriptors when the remaining pinned composition still matches. It continues to check the saved
output, current authority and evidence policies. This does not make those releases executable.
Saving unchanged settings refreshes these known older releases through normal configuration and
channel validation, creating a new snapshot for subsequent messages. Widget send errors remain
visible across successful background reads until another send attempt or a conversation change.
The Inbox conversation gives messages the main pane; the Details control opens and closes the
customer and conversation details without resizing the thread.

The controlled `inbox-accessibility.spec.ts` checks keyboard selection, claim and takeover,
live-region updates, long unbroken names and message text, and sampled target dimensions at
1440px and 390px. Its 24px size check is a subset of [WCAG 2.2 target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html); it is not a
full conformance assessment. It verifies live-region markup and updates, not actual screen-reader
announcements.

Workspace members can delete an agent from General configuration. The membership-authorized
`DELETE /api/organizations/:organizationId/agents/:agentId` marks the agent deleted, revokes its
deployments and execution grants, and pauses its automations. It retains versions, conversation
history and customer records. Active or unsettled tasks and in-flight channel deliveries return
a conflict; the user can retry after they finish. Provider accounts remain connected. Deleted
agents cannot be restored through the interface. Migration `080_agent_deletion.sql` adds the
deletion marker.


### Shared agent activity

Owner conversations and task views use `@kasitek-labs/ui/agent` for messages, public activity,
context details and specialist modals. An inspected branch can open its own child's activity;
Back, close, reopen and reconnect observe existing task identities and do not submit work.
Growth and configured Agency execution use the same renderer through root-scoped product
observations. Current authority and evidence checks precede assignments, output and activity.
Restricted customer histories retain their published-message delivery boundary.

Task responses provide `observedAt`, nullable `elapsedMs` and nullable `finishedAt`. Wall time
starts at acceptance and ends at the native terminal task event, including queue, review,
authorization and descendant waits. It advances between observations while active, then freezes.
Later projection updates cannot extend a settled duration. Missing timing is omitted; context
capacity, model latency and active-operation usage remain separate measurements.
The safe runtime projection supplies the selected task's context, compaction state, model timing
and observed/accounted usage to standalone, Growth and Agency. `agentRuntimePresentation` owns
their shared scalar labels and unavailable values. `workElapsedMs` separately measures the original
logical request's acceptance through this task's current or terminal endpoint; a continued segment
or child can therefore differ from its own task duration. Missing origin timing stays null.

### Configuration activation

`POST /api/organizations/:organizationId/agents/:agentId/configuration` accepts
`configuration`, `expectedRevision`, optional `name`, and optional `confirmImpact`.
It returns `{agent,snapshot,deployments}`. Optimistic revision checks reject stale
editors. A save requiring channel or authority confirmation returns
`CONFIGURATION_CONFIRMATION_REQUIRED` before mutation. No-op saves reuse the current
snapshot. Invalid snapshots or unsafe public deployment settings roll back together.
Deployment IDs and origins stay stable. Evaluation-owned deployments do not advance.

Ordinary `POST /tasks` accepts `agentId` instead of `versionId`. Current snapshot
selection, grant creation and admission share the organization transaction lock with
configuration saves. A request may instead supply an explicit `versionId` for
product/evaluation tooling; supplying both selectors is invalid. Isolated evaluations
require explicit snapshots. New website connections omit `versionId` and use current
saved settings; the explicit publication contract remains available internally.

Existing conversations can span configuration snapshots. Their agent, tenant, principal,
channel session and human ownership boundaries remain fixed. Customer conversation
bindings remain immutable; each persisted task link proves its turn's snapshot.
Ordinary settings changes preserve accepted turns. Reduced authority revokes old grants,
and historical snapshots cannot mint removed permissions or larger budgets. Current
connection, source, skill and Inbox authority checks still apply to every operation.
Lower model or context budgets apply to future admissions. They do not revoke historical
grants or rewrite the accepted limits of existing turns.

### Chat navigation and recovery

Every available customer agent opens Chat. Configure contains General, Tools, Skills, and Website
sections with knowledge pins, optional appointments, package review, and explicit publication.
Developer and product fixtures configure specialists, analysis, reports, and personal memory through
authorized APIs. Save changes validates, snapshots and activates configuration atomically.
Numbered versions are internal provenance, not a normal client workflow. Existing conversations
use current saved configuration for their next turn; accepted turns retain their snapshot.
Retries recover the original task across saves without reserving another grant or budget.
Connection setup may persist an incomplete draft, which remains pending until Save changes.
The collapsed configuration history loads a prior configuration for a fresh validated save.

The selected agent's header opens Memory from Chat, Activity or Configure. It uses the shared
`AgentMemoryPanel` to inspect the current member's personal namespace, review exact candidates
with their assertion context/conflict state, correct accepted text and Forget records. Reads page
the native `/api/organizations/:organizationId/agents/:agentId/memory` route; mutations use its
existing candidate acceptance, revision-checked PATCH and Forget endpoints with stable operation
IDs. The account, organization and agent identify the panel scope. This entry does not expose
product-actor memory or change configuration, namespaces or grants. Saved memory enablement is
read-only here. Failed authorized reads clear both cached items and an open correction; visible
revalidation and current revision checks belong to the shared panel. No memory bodies are saved
to browser storage. `chat-workspace.spec.ts` covers this control journey with mocked transport;
native namespace and mutation authority remain covered by the API memory fixtures.

The global sidebar contains Agents, Tasks, Knowledge, Connections, Automations and
Settings. The agent/history pane is separate from the main conversation. Tablet
collapses global navigation. Mobile uses focus-managed navigation/history drawers
and keeps the composer in the visible workspace.

History discovery is principal-scoped and server-backed. Accepted conversation
links survive browser storage clearing. Unknown admissions retain their original
request key, input and version across ordinary navigation. New chat is blocked until
that unresolved admission is recovered. Navigation does not cancel accepted work.

History initially shows the latest bounded page. Older pages prepend without
changing the active turn. At most four detail reads run concurrently per fetched
page, so earlier report/artifact cards return after reload. Activity and inline
review use the same authorized task data as the standalone task page. Window focus,
visibility return and Refresh conversation reread current history. Evidence denial
and review-decision authorization failures hide cached derived content.

The composer accepts text. Enter sends, Shift+Enter inserts a line break, and IME
composition does not submit. Markdown rendering supports escaped text, headings,
lists, code and HTTP links without raw HTML or executable content. Knowledge file
imports remain a separate approved-source flow. General chat attachments and voice
are unavailable.

## Business execution

The technical categories remain `business` and `workspace`. The business harness
owns its model and tool loop. Restate 1.7.13 with SDK 1.17.3 coordinates durable
steps and recovery. Workspace execution remains unavailable until the separate
Lina adapter is implemented.

Each task pins an immutable agent version and harness release. An ordered
conversation turn uses authorized prior outcomes, selected knowledge, optionally
approved personal memory, pinned skills, and complete model/tool groups. Context
snapshots preserve request digests and source revisions in private PostgreSQL
records. Compaction is an identified model operation with its own budget and
recorded result. Large generated content uses private S3-compatible artifacts.
Context snapshots are not currently stored as S3 objects.

Selected tools include `knowledge.search`, `knowledge.read`, `memory.search`,
`memory.read`, `memory.propose`, `agents.delegate` and `sandbox.analyze`. Trusted code validates their arguments and scope. A memory
proposal creates a candidate. Only an authenticated management action accepts,
corrects, or forgets it. Publishing a skill creates an immutable revision; skill
text cannot install tools or grant permission.

Personal memory belongs to one verified human and agent. Embedded product memory has a
separate namespace containing the product, tenant, verified actor, agent and, for Agency,
the required client ID. Product scopes use the signed product mapping and do not create
standalone accounts. Missing actor/client scope fails closed. No automatic business-wide
memory is enabled; current business facts remain product records. Disabling product memory
fences accepted tasks' later retrieval and new proposals/acceptance, while authenticated
inspection, correction and Forget remain available.

A specialist can use its own memory namespace only when its parent and child configurations
enable memory, the binding explicitly commissions its memory tools and the actual parent grant
covers the derived memory operations. The parent's direct model catalogue may omit those child
tools. No parent memory is copied into the child. Human acceptance of exact saved specialist text
can permit recall in a later conversation of the same namespace; its reviewed transition preserves
the original brief dependency and current resource/provider checks without transferring the old
brief or source handles. Ordinary delegation inputs remain conversation scoped.

Context selection ranks relevant accepted records with a recent fallback. `memory.search`
returns marked previews, byte counts, exact IDs and an explicit next page; `memory.read`
recovers one complete current accepted record. Both preserve source evidence and current
scope. Accepted memory retains its assertion origin, freshness, current/hypothetical/unspecified
context, reported conflict state and `verified: false`;
acceptance is a persistence decision, not verification of a business fact. Current prompt
selection retains a namespace-generation fence. New evidence dependencies identify each
exact memory revision, so accepting an unrelated preference does not invalidate existing
record evidence. Correcting or forgetting an influencing record invalidates its derivatives.
Pending duplicate candidates cannot resurrect content suppressed by Forget.

Optional expiry suppresses retrieval and advances selection generations. Forget clears the
current body and records suppression digests. Private memory revisions retain full earlier content;
source conversations and immutable context/request records have separate retention. Deleting
conversation sources remains an explicit operation. None of these controls claims physical erasure
from those retained copies, earlier provider requests or backups. See the
[shared runtime operations runbook](operations/shared-runtime.md) for current retention, recovery
and disable/restore boundaries.

A minimal website FAQ uses this same controller with optional capabilities
disabled. Public visitors receive conversation-scoped context and approved public
knowledge. Personal memory, memory tools, generic personal bindings, and private or repository skills
are denied for website publication and execution. Exact reviewed server-curated instruction packages
and separately pinned calendar/HubSpot intake service policies have explicit public authority contracts.

Provider requests use the account and model accepted at task admission. Each task records
primary, compaction, and delegated role bindings with model metadata, credential revision,
use-grant identity, effective policy, and integrity digests. The worker rechecks current authority
before physical dispatch. An accepted route never silently switches accounts or models.
Compaction uses its accepted role policy, and children inherit the accepted delegated route
within their root allocation. Their configuration cannot introduce an unauthorized model route.

Input preflight uses the configured counter over the complete native payload, including private
continuation. The default estimates serialized UTF-8 bytes. Returned usage and finish reasons
remain distinct from estimates. Native reasoning can be retained privately for protocol
continuation, but ordinary assistant messages contain only public text and tool calls.

HTTP 401, 402, 403, 404 and 429 produce bounded authentication, billing, access,
availability and rate-limit error codes. Provider response bodies are not exposed
to users or logged. Other rejected requests and uncertain outcomes remain distinct;
uncertain generation is not retried automatically.

## Authorized discovery and history

Authenticated collection routes use explicit summary objects rather than task or
agent configuration records. All routes below are beneath
`/api/organizations/:organizationId`; each request checks current membership.

| Read | Response and order |
| --- | --- |
| `GET /agents/summaries?q=...` | `{agents,nextCursor}`; compact roster with latest immutable version, draft revision and unpublished-change state. Newest-created first, ID tie breaker. Optional trimmed `q` (maximum 120 characters) searches the complete roster by case-insensitive literal name substring before paging. The existing `/agents` management response is unchanged. |
| `GET /conversations?agentId=...&versionId=...` | `{conversations,nextCursor}`; `agentId` required, version filter optional. The exact human issuer/subject, Agents product, execution caller and agent scope must match. Activity descending, conversation ID tie breaker. |
| `GET /tasks?agentId=...&state=...` | `{tasks,nextCursor}`; optional agent/state filters. Root tasks only, newest-created first, task ID tie breaker. Human tasks require exact principal; automation tasks require a current owner membership and either that owner or the pinned occurrence reviewer. |
| `GET /conversations/:conversationId` | `{tasks,nextCursor,conversation}`; newest page of turns in ascending display order. Prepend subsequent pages to load older turns. Conversation metadata identifies the latest turn snapshot and task/turn IDs independently of the selected page; each task retains its own snapshot. |
| `GET /tasks/:taskId/events` | `{events,nextCursor}` in sequence order. Child reads require access through their original root. Reviewer-only access returns no events. |
| `GET /tasks/:taskId` | Existing detail response plus `eventsNextCursor`; accepts `eventsLimit` and `eventsCursor` for its embedded event page. |

Collections, conversation turns and standalone events accept `limit` (default 30,
maximum 100) and `cursor`. Cursors bind to the principal, workspace, route and
filters, including the trimmed roster search. They preserve a creation-time snapshot; later admissions appear on
refresh. State and authorization remain current, so revoked or no-longer-matching
records can disappear between pages. Timestamp keysets preserve PostgreSQL
precision and use deterministic ID ties. Cursors carry a key ID, issue time and bounded expiry.
Production replicas require the same versioned key set; old keys remain readable during rotation
until their accepted cursors expire. Development derives a stable key from its configured secret.
Expired or unknown keys return `INVALID_CURSOR`; clients refresh from the first page. Cursors
do not grant authority or preserve access after revocation.

Conversation summaries expose a plain-text title from the first authorized user
input, at most 100 characters with control characters replaced. Clients must render
it as text. Summaries contain no model output, report, source passages, credentials,
request keys or transcript previews. Deleted conversations are excluded from
collections; a retained direct history read masks the deleted input and output.
Reviewer-only task summaries include safe IDs, state, dates and permissions, with a
null conversation ID. They do not expose private inputs or delegated child records.
Subsequent detail and evidence reads retain current source-policy checks.

`test/platform-discovery.test.ts` uses a separate temporary PostgreSQL database and
actual HTTP requests to verify foreign principals, cursor misuse, tied timestamps,
version pins, snapshot admissions, revocation, reviewer metadata and more than 100
turns/events. It makes no model calls and does not change the owner's workspace.

## Admission, limits, and recovery

Admission atomically records the task, stable conversation sequence, root
reservation, and outbox command. Duplicate keys return the same authorized task;
changed payloads conflict. Model, tool, and compaction operations have separate
stable identities and receipts. A recorded result is reused after replay. An
unconfirmed model request becomes uncertain rather than generating another reply.

Root limits come from accepted execution policy. Policy v2 and later default local model/tool counts,
shared team counts, cumulative tokens and active time to null at the service layer. New standalone
grants have no cumulative token cap unless explicitly configured; persisted finite grants remain
finite. No service setting enlarges a finite grant. Nullable grants reserve each physical operation against the
organization quota rather than reserving an unbounded root allocation. Finite grants reserve their
accepted amount upfront. New configurations use automatic context, 4,096 output tokens and a
120-second call deadline. Older explicit numeric context settings remain binding. Work wall lifetime defaults to null through `maxWallDurationMs`, independent of optional
active-operation time. Explicit wall deadlines remain anchored to the original work across continuation. Known late completion charges actual elapsed time; an uncertain operation
consumes at least its reservation. Policy-v1 snapshots keep their aggregate counter semantics.
Organization scheduling defaults allow two accepted roots, two model operations, and four tool
operations in flight. `AGENTS_SCHEDULING_POLICY_JSON` configures these separate capacity limits.

The 100,000-token organization allowance applies to the UTC admission day.
Operations settle the original root reservation even after midnight. This is not
a separate physical-consumption cap for each later day. Uncertain operations
conservatively consume their reservation. Definitive rejection releases unused
usage. Settlement is idempotent at both operation and root level.

Earlier tool-directed programs use batch delegation. A coordinator can admit two version-pinned read-only business specialists with
explicit briefs and source subsets. Children use private conversation branches and
subdivide one root allocation; they do not consume new root slots or organization
reservations. Their current authority is also bounded by the root grant. A parent
waits for all admitted dependent children and identifies partial or uncertain results.
The model supplies only a published specialist binding ID and brief. It cannot
override that binding's allocation or source/tool scope. Trusted admission code
retains explicit narrowing controls.

A coordinator's `connectedToolBindingIds` selects its own model-facing tools.
Each enabled delegation binding separately selects tools from that specialist's
published version. Root grants and publication pins cover the unique union, at
most eight bindings. Selecting a specialist tool does not enable it for the
coordinator. The editor preserves specialist tool selections when a coordinator
removes its own selection, and disables unavailable connection tools.

Same-conversation history can retain an actually joined specialist's evidence
through explicit origin links. Original and current authority, pinned roles and
live source policies remain required. The history walk permits at most 32 origins.
Over-limit candidates are omitted before consumption; an over-limit dependency
already consumed by a task fails its current-policy check.

Optional analysis uses the verified local no-network gVisor Python profile.
The task owns stable allocation and command IDs; reconnect reads receipts/status.
Private artifact references survive resource destruction. An independent reaper
cleans expired and stopping-root resources. Root settlement retains ownership of
pending children and resources. See the runtime reference for setup and limits.

Cancellation records intent and blocks new work. It does not undo an accepted
effect or prove that a provider stopped. An uncertain outcome stays visible.
Runtime journals and workflows retain seven days. Outbox retries stop at 24 hours,
and settled tasks are not submitted again.

Memory changes and expiry invalidate future use through namespace generations
and dispatch checks. Conversation deletion tombstones its source history, cancels
open tasks, and invalidates linked memory. It does not physically erase old
revisions, completed provider requests, journals, or backups.

## Knowledge and connected evidence

Inline text, uploaded files and exact public HTTPS URLs use one private candidate
pipeline. `AgentsKnowledgeImportV1` owns acquisition, extraction, normalization,
chunking and local embedding. Approval does not follow from readiness or internet
availability. A refresh reserves a new immutable revision; versions and grants
pin approved revisions explicitly. The old scalar knowledge API is removed.

Imports allow 10 MiB raw, 1 MiB extracted text, 200 PDF pages and 1,000 chunks.
An organization has at most 200 active sources, 100,000 chunks and two physical
document/query allocations. A version pins at most 20 source revisions. Text,
Markdown, static HTML, text PDFs, JSON and CSV are supported; OCR, encrypted PDF, DOCX,
archives, authenticated crawling and browser rendering are rejected. JSON and CSV uploads are
normalized at admission into one Markdown block per item or row, using field labels and parent
values so a single passage carries its own context. The normalized Markdown is the retained source
body; the original structured file is not kept as a second raw object. Normalization runs before
the document profile, so the ordinary parse, chunk, embedding and approval path is unchanged.

The document profile runs no-network rootless gVisor with one CPU, 512 MiB,
no swap, 64 processes and a 60-second stage limit. Release manifests pin the
Node filesystem provenance, parser/tokenizer packages, BGE FP32 model and gVisor
bundle. Profiles preserve immutable artifact paths across preparation. Worker
recovery attaches to accepted allocation IDs and stored stage receipts.
Independent physical and object cleanup lanes remain responsible after worker
loss. Uncertain writes have tracked intents and repeated deletion tombstones. Connected/evidence/query
bodies also acquire durable object ownership before PUT. Raw-response links require current scope,
a started operation and a live intent row. Root and child settlement wait for query compute to be
confirmed destroyed; neither storage failure nor cancellation releases a physical slot early.

Evidence policy metadata stays available without S3. Bounded personal-memory citation
bodies stay in private PostgreSQL, so memory-only execution and withdrawal checks do
not depend on object storage. Knowledge source bodies and query-embedding receipts use PostgreSQL; connected bodies still require private S3.

PostgreSQL 17 with pgvector stores immutable chunks, full-text indexes and scoped
384-dimensional vectors. `lexical-v1` normalizes a natural-language query into English lexemes,
matches any of those terms and ranks the eligible passages. Additional words in a question do not
require every word to occur in a short source note. Tenant, published-version, selected-revision,
approval, visibility and current source filters apply before either retriever ranks candidates.
`hybrid-v1` uses
the explicitly pinned local BGE release, exact vector search and RRF (k=60),
at most 20 candidates per retriever and five results. Missing semantic runtime
fails visibly; there is no network embedding download or paid/lexical fallback.
The historical small English benchmark used the previous all-term lexical query and passed twelve held-out positives and three negatives
at 20,000 eligible chunks; measured warm end-to-end p95 was 1,325 ms. These results
do not establish current end-to-end performance, general answer quality or multilingual semantic
quality after the lexical correction. Lexical matching still requires shared terms; stemming does
not make it semantic retrieval. The semantic cutoff can miss paraphrases. Current PostgreSQL
runtime checks cover ordinary business questions, entity searches, exact passage provenance,
withdrawal and foreign-source denial. Controlled vectors verify the hybrid query path, without
claiming a new embedding-model quality benchmark. The website fixture verifies a reviewed FAQ
with explicit question coverage; it does not prove general retrieval recall.

Each actual retrieval/read operation issues span/hash/date-bound evidence IDs. Customer-visible text
removes the internal `[E…]` handles: the app renders numbered citations with matching source entries,
while the website widget and channel deliveries omit them. Stored task output and evidence records
retain the exact labels for validation, continuation and audit. Read-time projection applies the
same customer-visible cleanup before comparing a stored assistant message, so a cited reply stays
readable while withdrawn evidence still hides the message. Customer-channel instructions are
rewritten to remove internal source wording; the runtime also tells the model to continue the
existing conversation without re-greeting or restarting it, and never to mention approved
knowledge, an approved encyclopedia, or a knowledge base in customer-visible text.
Internal conversation titles are generated from the first user message through the agent's
authorized model route, bounded to 120 characters. Generation is best-effort; failures keep the
first-line fallback in the Conversations list.
Useful tail passages replace prefix context. A bounded continuation reads by
issued evidence ID and UTF-16 offset. Context snapshots persist exact model tool
definitions and selected evidence. Immutable dependency graphs preserve all
influences through history, summaries, specialists, memory proposals and artifacts,
including influences omitted from final citations. Delegated briefs retain their parent input
dependencies separately from the specialist's narrower direct read grants. Derived child
outputs and later memory reuse must still pass the original input policy checks. Shared ancestors deduplicate;
cycles, missing records and conflicting policies fail closed.

Source withdrawal, visibility changes, connection policy and Forget block future
consumption. Model/effect claims recheck current dependencies atomically. A final
answer cannot publish after its source is withdrawn during generation. A consumed dependency
invalidated by withdrawal or Forget ends the current task incomplete; a fresh turn can rebuild
current context without reusing the invalid history. Historical task state and receipts remain,
but current-policy API reads redact unavailable derived output. Browser recovery caches retain
accepted task identities and pending admission inputs rather than accepted transcripts,
derived answers or report bodies. Unsent composer text remains scoped to its account,
workspace, agent and version. Citations
must name supplied evidence; valid provenance does not prove factual entailment.
Report reviewers receive only the prepared report's cited passages. Owner and
visitor passage previews recheck current scope and expose no storage keys.

Connected tools use immutable selected aliases and server-issued public resource
handles. Every read consumes the same root operation budget; credentials stay in
the trusted transport. See [integration boundaries](mcp-integration.md) for protocol,
wire-request bounds and the pending authenticated provider acceptance.

Connected reads retain an immutable claim token and deadline derived from the original
operation, binding and task limits. A concurrent caller follows the live claim without
adopting it or sending another request. An expired or orphaned claim becomes uncertain;
expiry never authorizes another provider request. Attempt admission and result publication
check the token, state and database deadline atomically. Late physical receipts remain
facts, while late result publication is refused. Provider waits retain no transaction or
session-lock connection. Evidence checks inside an existing transaction use its client.

The outbox submits root workflows. Parent workflows submit specialists, while
ordered turns attach to the preceding canonical invocation. Duplicate root sends
resolve the workflow identity before binding it. A submission conflict is not
reported as cancellation.

## Connected reports and automation

`AgentsBusinessRunV21` (`product-capabilities-v11`) runs the trusted `report-delivery-v1`
workflow after the ordinary agent loop. Required stages select or create a private
report, validate its sources, prepare an exact action packet, wait for human
review, and deliver or reconcile it. A sandbox-enabled report must select one
actual exported artifact by its configured name. Other report agents can publish
their final output as an immutable Markdown artifact. The model cannot invoke
`report.deliver`, select destination URLs or supply credentials.

Connections belong to the organization and initiating account. They select a
server-configured ReportDeliveryHTTP destination/resource, scoped API key and
finite expiry. AES-256-GCM envelopes bind credentials to organization, connection
and credential revision. The keyring stays outside PostgreSQL. Rotation advances
the revision and invalidates pending reviews; old envelopes remain available for
read-only reconciliation of already claimed effects. Redirects are rejected.

The action packet binds immutable task/version/tool/workflow identities, exact
report bytes/digest, destination, connection revision, reviewer and expiry. Human
approval commits once. Dispatch atomically consumes that decision after rechecking
current membership, root authority, connection, report integrity and source fences.
An approval wait holds no provider slot or sandbox, but retains its nonterminal
root slot. Expiry is bounded by 24 hours, root deadline and connection expiry.
Manual approval can refresh an expired, unrevoked grant within its original scope.
One root can prepare one logical delivery. Cancellation before claim prevents the
write; cancellation after claim cannot retract an accepted delivery.

A claimed delivery sends at most one POST. Lost responses trigger bounded status
GETs using the original action identity. An independent reconciler continues
status inspection after task expiry/revocation without renewing write authority.
If no acceptance is observable, the effect stays uncertain; the system does not
promise eventual delivery or blindly resend. The protocol acceptance receiver in
`api/src/acceptance/` persists unique action IDs and receipts across restart. It is
a test destination, not a verified third-party integration. Action and receipt
records have no automatic deletion, exceeding the eight-day replay safety minimum.

Automations have an explicit owner, reviewer, pinned version, bounded input,
30-day maximum authorization and at most 20 accepted occurrences per UTC day.
Their principal remains `automation`; it is never replaced with the owner's human
identity. Each accepted occurrence atomically records its fresh conversation,
grant, task, original root reservation and outbox. Subagents and analysis subdivide
that same root. Personal memory and prior owner conversations are excluded; pinned
organization/agent procedural skills remain available.

`AgentsAutomationV1` uses Restate timers for one-shot UTC instants or anchored UTC
intervals of at least 60 seconds. Downtime coalesces to the latest eligible instant
with a bounded skipped-occurrence summary. At most one occurrence is active per
automation, including review waits; overlap and permission/quota blocks are recorded.
Each schedule revision also stores an immutable model-route snapshot in
`automation_model_routes`: provider/account and credential revisions, model metadata,
all three role bindings and effective policy. Creation and explicit edits resolve the
saved agent selection. Pause, resume and revoke copy the prior snapshot. Changing the
organization default does not retarget an existing schedule. Occurrences load that
snapshot through normal admission and compare its allowance with the new occurrence
grant. A rotated credential or revoked use grant records a blocked occurrence; no
fallback route is selected. Event retry still returns its original occurrence.

Pause stops future occurrences. Edits pin a new revision for future occurrences;
accepted tasks retain their original authorization. Revoke blocks fresh claims and
requests tree cancellation while existing effects remain reconcilable. Current owner
membership and original authorization expiry are checked at every operation.

Event automations use a revocable per-automation bearer key stored only as a hash.
The API exempts this authenticated endpoint from browser Origin checks; it does not
use cookies for event authority. Event IDs are limited to 128 bytes and data to
8 KiB. An ID plus identical content returns the same occurrence; changed content
conflicts. Event data cannot choose a version, connection, grant or workflow stage.
Keys are returned once; a lost key response requires explicit rotation.

The client exposes Connections, Automations and task details. A configured current
reviewer can inspect and decide an automation's exact report without assuming its
execution identity. Only the owner can stop the task. A reviewer can download the selected prepared report; other private artifacts remain owner-only.

## Verification and release limits

The [Agents verification skill](../../../.agents/skills/verify-agents/SKILL.md) reuses this document
as the current feature map. Its owned browser fixture verifies model-provider settings and
configured chat without changing shared accounts. Purpose-specific API verification uses the
existing model-purpose matrix. These paths do not certify unrelated channels or production use.

Focused PostgreSQL tests cover memory scope, candidate review, revision conflicts,
forgetting, expiry, source-history deletion, immutable skills, and dispatch locking.
Real MinIO checks cover signed private storage, integrity, lost-response recovery,
and deletion during an upload. The standalone SDK worker check verifies signature
acceptance and denial over HTTP2, including forged invocation requests.

Deterministic provider fixtures exercise model protocol, context, and failure
paths. They do not establish real model behavior. The current real-model browser journey verifies contextual follow-up, approved memory across
conversations, a completed memory.search tool receipt, pinned skills and correction/forget controls.
The website/widget journey and real Keycloak checks remain distinct acceptance paths. Worker signature
fixtures do not certify cluster key distribution or a production deployment.

Public repository reads require no external credential. Keyed Stash and GitHub acceptance remains separately opt-in. Model-chosen destinations, local-time cron/DST schedules, and Lina execution remain unavailable. The external Harbor adapter has controlled FAQ, specialist/research and reviewed-report acceptance; remaining suite criteria stay in Linear. Subagents require explicit published bindings; analysis also requires the pinned backend, resource controls and private storage.
Production rollout, secret management, durable log retention, monitoring, backups,
and signup-email delivery require separate verification. OTLP trace/metric export is explicit
configuration, with local Collector acceptance described above. Services also emit bounded
structured stdout diagnostics.

### Catalogue and booking release record

This record covers the earlier catalogue and booking implementation. Its V15 runtime and
schema038 identify that change; the current provider integration uses V16 and schema045
as described above. The catalogue acceptance evidence has not been rerun against every
new provider and does not qualify the provider integration.

| Field | Decision and evidence |
| --- | --- |
| Change | Contextual Tools/Skills catalogues, immutable package lifecycle and approved isolated Python execution, generic MCP/API selection and exact review, skill requirement repair with contextual compatible Analysis access, Google/Microsoft calendar policy, read-only availability, customer booking confirmation and HubSpot staff lookup/customer intake. |
| Owner | Agents engineering. |
| Risk | High: encrypted provider credentials, external writes, visitor identity, and durable recovery. |
| Affected services and surfaces | Agents API, business worker, PostgreSQL, management editor, Connections, task activity, website chat and generated widget. Messaging intake confirmations use the existing four provider adapters and canonical Inbox delivery. |
| Platform release version or ID | Runtime `AgentsBusinessRunV20` / `growth-products-v10`. Its predecessor is `AgentsBusinessRunV19` / `channel-customers-v9`. Canonical platform `VERSION` remains `0.1.0`; no production release tag or promoted deployment is claimed. Runtime, schema, and customer-created version identities remain separate. |
| API/schema changes | Fresh ordered schema through `062_native_provider_connections.sql`; 062 adds the shared native provider account/action lifecycle and authorization-attempt fences. Existing 028–038 add remote connections, skill packages/runtime/state, tool review, native API operations, Google OAuth/calendar policy, booking records, the V15 task default, immutable Google connector-definition pins, and immutable skill-script execution provenance. Setup validates the complete schema digest and does not migrate an existing owner database. |
| Rollout method | Explicit provider configuration, owner connection and service-sharing consent, exact skill review, draft selection, immutable publication, exact customer confirmation, and separately enabled isolated analysis for package scripts. Missing native-provider configuration is unavailable. The standalone Booking offering remains disabled. |
| Analytics and success criteria | Growth now emits registered command, review and confirmed-draft outcomes through its transactional outbox. Native connector fixture success criteria are one insertion per approved appointment/contact intake, zero pre-confirmation writes, no customer contact lookup, read-only calendars without reserve authority, correct current-policy denial, no insertion during status recovery, one sandbox command per admitted script operation, exact package provenance, current withdrawal denial, and resource cleanup. Growth outcome instrumentation exists; delivered production analytics and production alerting are not established. |
| Logs, metrics, dashboards, alerts | Existing bounded `agent.observation.v1` and task events include `tool.booking_availability`, `tool.booking_claimed`, `tool.booking_result`, and `tool.booking_reconciled`. Skill execution reuses bounded tool observations, native operation receipts and sandbox allocation/command status; schema038 records immutable package/script provenance. Metadata excludes credentials and full arguments. Collector revision and endpoint changes: not applicable; existing exporter configuration applies. Release identity is the accepted V20 composition. Bounded metadata projection provides the source-level redaction boundary. Production dashboards, alerts, retention, and hosted OTLP signal acceptance remain unverified. Disable the existing exporter to stop telemetry delivery without changing operation receipts. |
| Documentation | Current README, implementation/feature map, architecture, integration boundary, threat model, and runtime reference updated together. No new planning document. |
| Validation evidence | Actual isolated PostgreSQL/Restate/API/independent-worker booking acceptance in `api/test/booking-business.test.ts`; controlled signed OIDC/provider integration tests; actual API browser in `web/test/catalogue-live.spec.ts`; generated widget with controlled HTTP endpoints in `web/test/website-bookings.spec.ts`; responsive management/approval regressions. `skill-requirements.spec.ts` verifies connection repair, explicit binding adoption, compatible Analysis opt-in and grounded-program denial. `catalogue-execution-live.spec.ts` verifies published controlled MCP/API execution and real API skill requirement repair. Real gVisor package execution in `api/test/skill-script-runtime.test.ts`, existing independent-cleanup suite in `api/test/platform-sandbox.test.ts`, and published activation/script/final-answer acceptance in `api/test/platform-business.test.ts`. See coverage below. |
| Rollback or disable | Withdraw the booking policy or disconnect access to block future effects; disable/remove skill installations or rotate/revoke selected connections as applicable. Preserve immutable versions, receipts, original uncertain outcomes, key access, and accepted worker artifacts. Status recovery still requires current permitted authority. Do not downgrade a V15 task to an incompatible worker or reverse the fresh SQL in place. |
| Post-release review | At the first staging promotion and before enabling a live Google OAuth application. No production release date is assigned. Live provider registration/acceptance and model evaluations remain owner-run. |

The real isolated booking journey verifies a durable pending visitor proposal with zero insertion,
worker SIGKILL and a new process, the same accepted Restate invocation, exact scoped confirmation,
one provider event, and receipt-backed customer output. It also verifies cross-visitor denial,
Inbox takeover before insertion, explicit return with a new ownership generation, automatic handoff
for uncertain booking outcomes, and GET-only recovery by the scoped visitor or staff conversation.
Same-organization unrelated conversations expose no borrowed booking, and takeover after provider
acceptance preserves human ownership and the original uncertain operation. The provider and model are controlled HTTP fixtures.
The separate Google OIDC tests use a controlled signed issuer, not Google's live authorization system.

The actual API browser verifies curated/private package review and publication, same-family
revision comparison and lifecycle changes, native operation bindings, Google connection callback,
calendar selection and sharing, policy draft pins, and operator confirmation. Its external OAuth
navigation and Google HTTP responses are explicit fixtures. The generated widget tests use the
actual emitted script over HTTP with controlled public endpoints; they verify exact two-step
confirmation, expiry, status-only recovery, and stable focus at 1440, 768, and 390 pixels.
These layers establish local contracts, not a live Google calendar account or production readiness.

The separate five-case `catalogue-execution-live.spec.ts` browser suite uses the real API, vault,
fresh PostgreSQL database, private MinIO bucket, isolated Restate container and independent worker.
Its model, MCP/API providers and OAuth authorization server are controlled HTTP fixtures; no paid
model or live provider account is used. It verifies URL discovery and explicit selection, immutable
publication, normal chat execution with exact approval, credential replacement and reselection,
provider-expiry uncertainty, disconnect fencing, full-page OAuth cancellation and cross-tab consent,
and one-use callbacks. The skill case imports and reviews a package, returns from connection setup
to the exact revision, explicitly adopts bindings, saves, adds the skill and applies the configuration with Save changes.
Separate resource/template/prompt selections execute through that same normal workflow; template
values pin the exact URI. The final run passed five cases and checked seven completed private receipts
with seven successful approved provider invocations. The expired native credential produces an
additional denied HTTP request and an uncertain operation without a completed provider receipt;
discovery and OAuth traffic are outside this successful-effect count. The fixture cleans only its
own services and database.

Skill repair and typed MCP selection also have mocked transport regressions. Catalogue checks passed
thirteen cases. The final remote-picker and requirement-repair check passed fourteen cases, including
readable requirement labels, grounded-program denial, reloaded typed categories and disabled unsupported
tool/template rows with server-supplied reasons. Inventory rows cannot create executable bindings.
The repair and template forms were checked at 1440, 768 and 390 pixels. Compatible Analysis enablement
and grounded-program denial are browser contracts; real isolated Python execution is established by
the separate gVisor/Restate tests below, not by the controlled connection browser suite.

With `AGENTS_TEST_DATABASE_URL` configured for disposable database creation, the durable
booking acceptance runs from the repository root:

```sh
pnpm --filter @kasitek/agents exec vitest run test/booking-business.test.ts test/booking-workflow.test.ts test/google-calendar.test.ts test/google-calendar-connections.test.ts
```

Live Google consent and token refresh against a configured application, production credential
operations, hosted observability, and other channel/provider journeys remain separate gates.
MCP resources and prompts have separately selected execution scopes. Directory reads returning
unselected URIs, reserved template expansion operators and unsupported client capabilities remain
unavailable. Package import remains inert; explicit approved Python execution uses the existing isolated sandbox.

Approved package execution was verified with fresh disposable databases, a separate Restate container
and test allocation directories. The affected check passed 14 cases: five script authorization/execution
cases, seven real gVisor lifecycle cases, and two published skill/compaction cases. The Python case executes
a script larger than 4 KiB without a script-read call, imports reviewed helpers, reads packaged data,
exports a receipt-backed report and destroys its allocation. Withdrawal before guest launch prevents
execution; withdrawal afterward blocks artifact access. Typecheck, dependency-cycle checks and product
boundaries passed. These checks do not establish production sandbox availability or operational certification.

With the local isolated sandbox prepared and `AGENTS_TEST_DATABASE_URL` set for disposable database creation:

```sh
AGENTS_SANDBOX_VERIFY=1 pnpm --filter @kasitek/agents exec vitest run test/skill-script-runtime.test.ts test/platform-sandbox.test.ts test/platform-business.test.ts
```

## Coordination and replica configuration

The live dispatcher runs five independent bounded loops on its existing pool: root dispatch,
capacity grants, capacity notifications, controls, and reconciliation. Each loop has at most one
pass in flight. Successful root-dispatch and capacity-notification acknowledgements, and committed
capacity grants, rejections or expired-generation transitions, count as progress. Productive passes
in these three loops await `setImmediate` and continue with another bounded pass. Cursor movement,
skipped locks, rolled-back changes, unsuccessful reservations and HTTP responses without a native
acknowledgement do not count. Idle and failed passes wait one second. Controls and reconciliation
remain periodic. Slow maintenance does not prevent the next root batch from being claimed.
Shutdown wakes idle loops, checks stop after each yield and awaits every in-flight batch before
closing the pool. A batch drains its workers before throwing. The one-shot `dispatchTasksOnce`
entry still awaits all phases in order.
Dispatch rotation uses `scheduling_tenants`; capacity rotation and resource cursors use
`capacity_tenants`. Organization registration creates both rows atomically. Their locks are
independent, so maintenance of one turn cannot block or suppress the other scheduler.

Dispatch claims default to batches of 32, eight parallel sends, and 120-second leases.
Operators can set `AGENTS_DISPATCH_POLICY_JSON`, for example
`{"batchSize":128,"parallelism":32,"leaseMs":120000}`. The worker validates this setting
before opening its database pool or HTTP listener. Unknown fields, malformed JSON, and values
outside the bounds fail startup without echoing the configuration. Batch size is 1–128,
parallelism is 1–32, and lease duration is 30–300 seconds. This policy does not increase the
database connection budget. The controlled load fixture explicitly selects 128/32 through
the same loader; those results describe that profile, while an unconfigured worker uses 32/8.
Phase duration metrics include SQL and HTTP waits but exclude the idle backoff and the event-loop
yield between passes.

Claims use PostgreSQL row locks with `SKIP LOCKED`;
a durable tenant rotation selects bounded per-tenant candidate sets, so an older noisy tenant cannot bury a newly waiting tenant behind its backlog.
Stable Restate workflow keys deduplicate repeated sends after an uncertain response.
Only the current claim owner can persist the invocation binding. Terminal and
deadline sweeps are bounded to 128 rows; continuation publication uses leased claims.

`execution/scheduling/capacity.ts` provides persistent requests, sorted bucket
locks, provisional generation-fenced grants, active holds and a transactional
notification outbox. Operation admission must commit a waiting decision, wait for
its durable notification, then recheck authority before activating a grant.
Active or uncertain business-effect calls retain their holds until confirmed settlement
or explicit reconciliation. Uncertain model/compaction calls have a narrower local-capacity exception:
the capacity phase releases their physical slots after the persisted transport deadline, only with a
matching private model-continuation record proving the bounded dispatch path. This does not change
uncertain outcomes, token/time accounting or monetary reservations, and never retries the call.
Provisional grants may expire; an expired generation
cannot start a call. No provider wait holds a database transaction.
Each bucket has numbered permit slots with a unique bucket/slot constraint and
database-enforced immutable bounds. Compatible configuration locks and indexed
free-slot claims let independent operations reserve different slots concurrently.
Slot pools grow lazily in batches of at most 32; only pool growth updates its
separate frontier. A failed multi-bucket reservation rolls back all partial claims.
Release clears the matching slot owner and generation with its hold row. Queue
deadlines, provisional expiry and recorded grant delay use the database clock.
Only a promoted queued request publishes a capacity wakeup and grant observation.
Only the first insertion of a request can seek direct admission, which yields to older eligible
waiters across tenants. Replaying a waiting request returns its durable waiting decision.
Scheduled promotions use durable tenant rotation, then a cyclic resource class and provider
account turn. Classes are model, connected, local and generic. One class cursor and three provider
cursors per tenant record assigned opportunities. A failed reservation or crash after assignment
can consume an opportunity. This does not promise equal grants or a wall-clock service bound.

Fresh schema `021_scheduling.sql` derives class and account from exactly one native provider
bucket with a recognized class and 40 lowercase hexadecimal characters. Missing, malformed or
mixed provider keys map to one generic queue. Generated columns cannot accept caller overrides.
An insert trigger derives immutable organization identity from the task and a composite foreign
key enforces it. Tenant/class/account indexes support cyclic account seeks without grouping the
platform backlog. Scheduled predecessor checks use the selected tenant and exact resource queue,
including the single generic queue. Interactive requests use creation time; other workloads add
five seconds. Every grant still rechecks current authority, deadlines, generation and all shared
bucket limits before reserving slots atomically.

Each capacity sweep selects two independently bounded sets within its tenant rotation: the
due prefix for authority and expiry housekeeping, and waiting requests within the assigned
resource queues for promotion. Eligibility precedes the promotion ranking and cutoff. Availability
checks use only bucket keys referenced by the selected tenants' due requests. Availability means
an unowned slot or room to grow the slot frontier; the final atomic reservation rechecks it.
Expired provisional grants remain in housekeeping even when their own holds fill their buckets.
Housekeeping alone cannot promote valid waiting work. Deduplication preserves promotion intent
when both sets select a request. Expired provisional holds release their slots and requeue under
a new generation and the original deadline. A later pass can promote that generation. Replaying
an expired grant also returns waiting after this transition, without an immediate direct regrant.
The sweep deduplicates both sets, so it attempts at most twice its configured limit, 128 requests
at the default limit of 64. Candidate transactions run with at most four workers and at most half
the configured pool size, rounded down with a minimum of one. Errors are rethrown only after
all workers drain. When the pool allows at least two candidate workers, one blocked authority
check cannot serialize every unrelated candidate. Smaller pools retain serial sweeps. These
bounds add no database connections.
Candidate output limits do not bound all scan work. The due set still materializes selected
tenants' pending backlogs, and promotion ranking sorts the selected queues. Account seeks use the
queue index, but only measured workloads establish the total scheduling cost.

`AGENTS_SCHEDULING_POLICY_JSON` contains validated finite operator limits for
product, tenant, workload and provider capacity, queue depth, maximum waiting time,
root admission and daily token allowance. Replica policies must agree: requests
cannot rewrite existing bucket limits. Workload derives from accepted task and
operation metadata. Model provider grouping uses the accepted connection ID within its
organization. Connected tools group by their pinned
connection ID unless an operator supplies a verified connection-to-account map in
`AGENTS_PROVIDER_ACCOUNT_MAP_JSON`. Separate connections to the same external
account do not share a provider limit without that map.

`localProviderActive` optionally sets the deployment-wide bound for the existing local-provider
bucket. Without it, local operations use `providerActive`, preserving the configured fallback.
Model and connected-provider buckets still use `providerActive`. Local operations include
knowledge, memory, delegation admission, sandbox work, report preparation and built-in report
delivery; this is not a database-only limit. Product, tenant, class and workload bounds still apply.
All replicas must agree on existing immutable bucket limits. A mismatched request fails with
`CAPACITY_POLICY_CONFLICT`; requests cannot resize live buckets.
A queued operation has no operation record or active-time reservation yet. Its recorded capacity
and task deadlines continue to apply. After activation, its original execution timeout includes
pool waits and is never reset. A delegation operation releases its permit after child admission,
before the parent waits for child results.

The controlled load tool preserves its default `baseline` resource allocation. The explicit
`AGENTS_LOAD_RESOURCE_PROFILE=bounded-local` profile sets local-provider concurrency to 64
and, with four replicas, uses six API and eight worker connections per replica under an
80-connection declared budget. Its report counts the shared eight-connection driver/snapshot
pool once and the one-connection administrator pool once, alongside process pools and reserve.
The profile preserves arrival rates, operation delays, runtime CPU/memory limits, task deadlines,
queue thresholds and drain limits. A profile setting alone establishes no capacity claim.

List cursors use versioned keys from `AGENTS_CURSOR_KEYS_JSON` (an object of key ID
to a base64url secret containing at least 32 bytes) and `AGENTS_CURSOR_ACTIVE_KEY_ID`.
Production requires explicit keys. Development may derive a separate signing key
from the configured OIDC client secret; isolated tests use a test key. Replicas must
share keys. `AGENTS_CURSOR_MAX_AGE_SECONDS` defaults to 900 and permits 60–86400.
Rotation retains previous key IDs until their issued cursors expire, then removes
them. A cursor binds the principal, filters and snapshot; each read still checks
current authorization. Keys and cursor payloads must not enter logs.

Scheduling mechanisms alone do not establish capacity. The controlled 1,000 profile has separate
passing evidence; the 10,000 target remains unmet. Load records distinguish admitted, executing and waiting roots and
must report achieved counts and limiting resources separately.

`AGENTS_DATABASE_POOL_POLICY_JSON` declares the total database budget, reserve
and replica count/pool maximum for API, worker, dispatcher, cleanup, evaluation and
migration roles. Startup rejects declared pools whose combined maximum exceeds
the budget. `acquireTimeoutMs` defaults to 5000 and accepts a finite 100–120000ms
operator setting. It bounds waiting for a connection; SQL statement and query deadlines
remain 15 and 20 seconds. Embedded dispatchers reuse their worker pool. Separate deployments
must declare every replica; this is a configured connection allocation, not
automatic process discovery. Reapers and schema setup use the same role policy.

The controlled acceptance driver is `api/test/scheduling-load.ts`, with separate
API and worker fixture processes in `scheduling-load-process.ts`. It creates only
a uniquely named database/container and disposable principals, uses authenticated
HTTP interfaces and a local HTTP model simulator, and writes measurements under
ignored `.audit/`. `AGENTS_LOAD_FULL=1` runs the versioned `scheduling-workload.v3.json`
contract: 30 seconds of steady arrivals, a 10-second burst, then at most 120 seconds
of drain. It includes approved-source FAQ evidence/citations, memory tools, delegated
children, delayed report review and actual receiver receipts, plus canonical website
claim/takeover/reply/return and reconnect controls. Owned local object storage and a
pinned actual Collector supply evidence without using paid model providers.

`AGENTS_LOAD_ROOTS` accepts 100, 1000 or 10000; `AGENTS_LOAD_REPLICAS` accepts 1, 2,
4 or 8. `AGENTS_LOAD_SINGLE_TENANT=1` and `AGENTS_LOAD_NOISY=1` select the tenant
pressure cases. `AGENTS_LOAD_FAULT` selects duplicate-messages, worker-loss,
provider-throttle, collector-outage, lease-expiry or reconnect. A selected fault that
was not injected is reported as unmet. Expected uncertainty and provider failures
remain visible rather than being rewritten as completed outcomes.
The current manifest also grades each configured tenant's status and dispatch latency,
requires actual probe coverage, checks each control tenant, and audits canonical messages
after drain for stale-generation assistant deliveries. Fault reports retain injection and
restoration times and require native reconciliation within 30 seconds; worker-loss
uncertainty remains a separate outcome. Previous manifest results are not retroactively
claimed to meet these newer fairness and recovery criteria.
Root dispatch uses root outbox timestamps. Children use admission to first native operation as
a conservative activation bound, graded separately against 30 seconds. Every child requires a
sample except a confirmed cancellation before any native operation. A child that starts and is
later cancelled still counts. Legacy child outbox cleanup times are retained as ungraded
metadata because they include execution time. Bounded native phase records correlate admission,
context, capacity request/grant, notification, native operation, and physical request timestamps.
Physical model requests are matched to native operation/attempt identities by exact provider
response IDs and canonical serialized request digests. Fault fixtures additionally resolve the
unique native context digest before local dispatch; missing or ambiguous attribution fails.
Receiver verification compares action/task/root/artifact identities, approved payload and byte
digests, native receipts and actual POST audits. Equal aggregate totals cannot establish success.
Parsed Collector span/trace/observation identities and metric names are retained as bounded local
metadata before owned containers are removed. Verifier calibration rejects substituted effects,
stale attempts, repeated physical requests, unexpected failures and missing safety evidence.

`AGENTS_LOAD_BARRIER=operations` holds actual model HTTP responses until the
configured simultaneous active-operation target is reached or the finite hold expires.
It records actual nonterminal roots and active requests separately before release.
This is a separate concurrency dimension from steady mixed traffic. Restate profiles
are explicit TOML files; each run saves the server's actual dumped configuration.
The 10000 profile uses a 1536MiB Restate container with an invoker limit of 10000
and a 60-second database acquisition wait. Worker heaps are 1024MiB with fewer than eight
replicas. The eight-replica comparison uses 512MiB worker heaps, 256MiB API heaps, and requires
at least 8GiB available host memory before startup. Each API pool has one connection and each
worker pool has four, retaining the four-replica profile's 32 worker connections. Driver,
migration, and reserve allocations bring the eight-replica declaration to 54 connections.
All replica pools must fit the declared 60-connection budget. These local profiles do not establish
production sizing, high availability or real-provider limits. Reports retain executable
source hashes, pool/lock/resource measurements, all failures and missing dimensions.

Diagnostic CPU profiling is separate from acceptance. The following fixture command enables
internal inspector sessions on API0 and worker0 only, without a debugger port or heap snapshots:

```sh
AGENTS_LOAD_FULL=1 AGENTS_LOAD_ROOTS=10000 AGENTS_LOAD_REPLICAS=4 \
AGENTS_LOAD_DIAGNOSTIC_PROFILE=1 \
node --env-file=products/agents/api/.env \
  --import ./products/agents/api/node_modules/tsx/dist/loader.mjs \
  products/agents/api/test/scheduling-load.ts
```

Sampling starts 20 seconds into the workload and stops after 30 seconds, at a 1ms interval.
Profiles are saved under `.audit/agents-load-profile-<run UUID>/`. The run report's
`profiling.evidence` contains bounded query-family counts, totals, maxima, and histogram-based
latency bounds. It contains no SQL text or parameters. These client timings include response
handling and do not isolate database server execution time. The diagnostic snapshot omits the
120-second drain, retains unfinished outcomes, sets `diagnosticOnly=true` and
`acceptanceEligible=false`, and intentionally exits with code 2. It cannot qualify a load target.

Business operation admission returns a committed waiting decision without creating
an operation or reserving tokens. The workflow waits on a generation-specific
Restate promise and its fixed queue deadline. The notification handler checks the
native request, task and generation before resolving that promise. A queued
operation rechecks grants, ownership, source/memory policy and root limits before
activating its permit. Confirmed settlement releases its holds exactly once;
uncertain business-effect settlement retains them. Proven bounded model/compaction capacity is
reclaimed after its transport deadline through the normal capacity phase. Ordinary capacity waits do not poll every
250 ms. Connected-read reconciliation may separately retry its existing status
check with a bounded durable delay.

Built-in tool dispatch awaits asynchronous validation and converts schema failures to bounded
`TOOL_ARGUMENTS_INVALID` feedback. The agent receives guidance to clarify questionable inputs,
confirm suggested changes and describe only effects established by receipts; model wording is not
deterministically guaranteed. Contact email and phone formats are checked before saving.
Operation admission journal retries are bounded to three attempts; an unconfirmed admission is
reported uncertain. Human approval and authority waits retain their continuation behavior.
A database or worker outage can prevent settlement until service recovers.
Unexpected errors after operation admission settle as `OPERATION_OUTCOME_UNCERTAIN` rather than
blindly repeating a possible effect. Customer root tasks whose authority expires terminate instead
of waiting for an unavailable renewal. New customer turns have a deadline no later than their
existing grant expiry or an earlier configured wall limit. Cancellation may still be delayed if
the database, runtime or worker is unavailable; an adapter that ignores cancellation may finish
late, requiring reconciliation before retry. Other tasks without a configured deadline are not
generally bounded.
When the dispatcher records customer deadline cancellation, the website reports the reply outcome
as uncertain while cancellation continues. Late customer completion is fenced from publication;
already terminal results remain unchanged. Connected messaging channels use the separate
receipt-backed notice described below.

A known provider outcome is retained in the Restate journal before native receipt
persistence starts. The receipt step may retry three recognized PostgreSQL failures
locally, then Restate retries that durable step using the journaled outcome. It never
reissues provider I/O. The business loop accepts success only when the persisted
attempt, terminal state, output and accounting match. A conflicting terminal receipt
is preserved. A crash before the physical-result journal acknowledgement remains
uncertain; a worker crash after acknowledgement can recover the same known result.

Mutable task rows use PostgreSQL `FOR NO KEY UPDATE`. Task identity is immutable;
this mode still excludes concurrent writers while allowing FK `KEY SHARE` checks
from Inbox cancellation and typed-event inserts. Runtime authority checks take the
task writer lock before checking the current customer conversation. A stronger task
key lock would recreate the conversation/task foreign-key deadlock during takeover.

Reviewed-evidence projection reuses its current transaction connection for the task
manifest. It does not reacquire the pool while holding the organization fence. A
single-connection regression verifies the normal reviewer read and current grant
revocation rejection without weakening membership or source-policy checks.

Operation start/finish locks the execution root rather than the organization.
Admission and daily quota settlement retain their existing transactional fences;
`maxConcurrentRoots` and `dailyTokenAllowance` come from the validated operator
policy. A provisional permit cannot outlive task cancellation or settlement.
Root admission reads a tenant counter maintained transactionally by task-state
triggers. Children do not consume root slots, and repeated settlement cannot
release the same slot twice.
The scheduler checks conversation authority before taking request/bucket locks,
so a blocked ownership check does not block permit settlement.

Dispatcher routes are keyed by the accepted runtime release. Only explicitly
compatible releases may be claimed. Root submission, continuation, capacity wakeup
and cancellation use the corresponding workflow/ingress/admin route. The default
route serves the current release; unavailable releases remain pending for a
compatible deployment instead of repeatedly consuming a dispatch claim.

## Physical executor routing

Replica deployments configure `AGENTS_EXECUTOR_ROUTES` as a trusted JSON array of
`{id,url,key}` entries and `AGENTS_EXECUTOR_DEFAULT_ID` for new allocations. Keys contain at
least 32 characters and remain in private environment configuration. URLs require HTTPS, except
explicit loopback HTTP for local fixtures. Agents cannot supply routes or signing keys.
`AGENTS_SANDBOX_ENABLED=1` and `AGENTS_DOCUMENT_RUNTIME_ENABLED=1` retain their existing gates.
Without routes, the explicit local backend remains available for single-host development.
It does not qualify as recovery across hosts.

Run each physical host with `node --env-file-if-exists=.env --import tsx src/composition/executor.ts`
from `products/agents/api`, or its compiled `dist/composition/executor.js` entry. Set
`AGENTS_EXECUTOR_ID`, `AGENTS_EXECUTOR_KEY`, `AGENTS_EXECUTOR_JOURNAL_DIRECTORY` and
`AGENTS_EXECUTOR_PORT`. The default bind is loopback. A non-loopback deployment requires a private
TLS endpoint and restricted network access. Each host has its own persistent sandbox/document
cache directories and command journal. Preserve the journal across process restarts. A kernel lock
rejects a second process using that directory, and a durable database identity rejects rebinding
the same executor ID to a fresh directory. Replacing a machine requires a different executor ID.

Signed internal commands bind resource kind, allocation, owner, generation, command identity and
body. Physical handlers recheck current ownership around transitions. Native allocation records
and durable local command intents retain uncertain starts. Status, cleanup and receipt recovery
route to the recorded owner even when the caller has a different local directory. Expired leases
prevent starts but do not release uncertain physical capacity. `AGENTS_EXECUTOR_MAX_ACTIVE`
defaults to two allocations and accepts integers from one through sixteen. Short capacity
transactions finish before any systemd or runtime wait. Command bodies and responses are bounded
at 20 MB; metadata probes share bounded short-lived results.

Transfer requires the original host to prove the allocation stopped, then a generation CAS.
Transfer does not resume an old command on the destination. Stale start, status and cleanup calls
are rejected by the original physical handler. An unreachable original host remains uncertain;
local file absence and lease expiry do not authorize replacement. The bounded reaper also finds
expired owner claims created before native admission; it releases them only after the recorded
host confirms its physical unit is absent or stopped. Keep allocation directories,
command intents and the physical identity file until their uncertainty is resolved. The command
journal is private operational evidence and may contain bounded tool inputs/results. It is not
ordinary telemetry. Remove a disposable fixture's journal after review and teardown; production
journal archival/retention remains a deployment requirement.

`AGENTS_EXECUTOR_VERIFY=1` enables the independent-process acceptance in
`test/resource-executor-process.test.ts`. It uses actual rootless gVisor, distinct physical
executor directories, process death/restart, original-owner sandbox receipt recovery, document
parsing and remote cleanup, confirmed transfer, and stale physical-handler denial. It owns a
fresh database and temporary directories. Protocol tests additionally cover signed-body tampering,
lost acknowledgements, bounded capacity after lease expiry, physical launch/quiescence races and
rejected identity rebinding. Existing sandbox/document safety suites retain their real no-network,
resource-limit and pinned-profile checks. No guest helper/profile bytes changed in this routing
update. These bounded fixtures do not establish 1,000/10,000-root production capacity.

## Bounded native API response handling

The shared model accounting module uses integer micro-USD quotes and a root-owned
transactional ledger. Cache tokens are subsets of input, and reasoning tokens are
subsets of output. They are not charged twice. Missing usage or prices remain
unknown. A finite monetary cap requires a known upper reservation; uncertain
outcomes retain that reservation until explicit reconciliation. Schema041 removes
model-specific token/call SQL ceilings while keeping PostgreSQL integer integrity
bounds. Admission initializes the root ledger in the same transaction as accepted bindings.
Operation start reserves a price quote, and settlement records normalized observed usage or
retains explicit uncertainty. Listed-price estimates do not establish provider invoice totals.
No new model cost analytics or complete finite-cap qualification is claimed by this change.

Native API release `native-api-v2` consumes immutable response policies from the structured
request editor or the OpenAPI `x-kasitek-response` extension. Projection selects up to
sixteen named JSON Pointer fields. Optional cursor pagination and transient-status retries
require an explicit owner-attested GET read policy; default operations and reviewed writes
retain one physical request. The existing connected executor checks authority before every
request, stores private response pages and replays completed observations without resending.

Pages and retries share at most eight physical requests, a 30-second maximum within the
original operation deadline, and a combined 1MiB page-receipt budget. Retries accept only
429/502/503/504, honor bounded Retry-After, and never repeat transport uncertainty. Cursors
are values in a declared query parameter on the pinned origin. Repeated cursors fail; the
page limit returns explicit incomplete status and continuation. No secondary execution engine,
arbitrary fetch URL, executable projection expression or automatic write retry is introduced.

The API template extension and safe operation DTO are additive; schema038 already supplies
the immutable JSON storage. Adapter executable digests pin the new policy implementation.
Existing operation/physical-attempt events and private receipts provide durable runtime observability;
connection lifecycle logs/spans and receipt-derived provider metrics are described in the telemetry section above;
new analytics events, collector endpoints and infrastructure deployment are not applicable.
Verification combines controlled HTTP, isolated published-grant PostgreSQL execution and
mock-transport browser checks at desktop/tablet/mobile widths. Live provider compatibility
remains a separate gate. Disable or replace the selected binding to stop new admissions;
retain receipts and the accepted executable release for in-flight recovery.


## Website customer follow-up

Schema085 adds conversation-bound email preferences, verification/return challenge digests,
scoped session access, notification/read receipts and worker readiness observations. Website
follow-up is available through the generated widget and `/support/return/:deploymentId`.
The optional Agents-owned Resend sender uses `AGENTS_FOLLOWUP_RESEND_API_KEY` and
`AGENTS_FOLLOWUP_EMAIL_SENDER` on API and worker, with matching `AGENTS_PUBLIC_URL`.
New signup requires a matching worker observed within 45 seconds and a registered
`AgentsCustomerFollowupV1` Restate service. Missing credentials, stale worker observations,
configuration mismatch or an unavailable registry disable signup. Existing authorized preference
reads, verification, revocation and return exchange remain available after sender removal.

The verified preference authorizes human-reply notifications only. Message/revision identity
deduplicates intents; visible-message receipts suppress pending sends. A provider receipt records
acceptance, not delivery/read. Unknown sends are never automatically retried. A worker replay
waits for a fresh physical claim and marks a claim older than 60 seconds unknown without sending.
Rejected/unknown outcomes are exposed in authorized Inbox reads.

One-use return links expire after 30 minutes. Their secrets are stored as hashes and carried in
the URL fragment, then exchanged into a same-deployment visitor session bound to one canonical
conversation and current verified preference revision. Session recovery preserves the execution
conversation without replacing its original principal. The product-owned visitor-lineage port
authorizes differing principals only with exact tenant/agent/deployment/conversation and immutable
task-link checks. Current and origin return access are rechecked in admission, active authority,
historical evidence and completed-output reads. Source withdrawal, grant revocation and preference
revocation remain effective. No email-based identity merge or cross-customer access is allowed.

Validation uses `customer-followup-journey.test.ts` with actual app routes, PostgreSQL and the
Resend adapter against a controlled local HTTP mailbox; `customer-return-lineage.test.ts` checks
source revocation, cross-session/cross-customer denial and lost-claim recovery. The existing
challenge/adapter and website/return browser checks cover their separate boundaries. These checks
do not establish live mail delivery or model quality. New customer configurations allow one
bounded post-handoff acknowledgement, with a factual fallback if generation cannot be published.
Older pinned configurations keep their original receipt behavior.

Release risk is standard across Agents schema/API/worker, widget and return view. Apply schema085
before matching API/worker artifacts, then register the notification workflow. No new analytics
event names, Collector configuration or production deployment are introduced. Receipt states and
the existing structured publisher log identify operational failures without emails or message
bodies in logs. Stop new signup/sends by removing sender configuration; retain preference
revocation and scoped return routes. Preserve accepted/unknown receipts during rollback. Product
release tag, production rollout date and post-release review date remain not applicable until an
authorized deployment.

## Configurable product capability release record

| Field | Decision and evidence |
| --- | --- |
| Change and owner | Agents owns the shared composition/loop; Growth owns presets, domain tools and review effects; Agency owns metadata access. Configured capabilities drive model-directed execution. |
| Risk and surfaces | Standard, with permission and effect paths requiring negative/recovery checks. Agents API/worker, Growth API/UI, narrow Agency API and Harbor capture contracts are affected. |
| Runtime and schemas | `AgentsBusinessRunV21` / `product-capabilities-v11`. Agents schemas070–072 add generic review projections, trusted Growth publications/managed markers and the new-admission release default. Agency migration `20261023200000_product_capability_authority.sql` adds destination mappings/grants. No production tag/deployment is claimed. |
| Rollout | Apply recognized schema upgrades and install matching handlers/keys first. Publish Growth defaults revision2 explicitly for eligible managed defaults. Start/route new work on V21; retain V20 for its accepted tasks. Missing Agency transport/publication/mapping/grants is unavailable. |
| Analytics | Existing registered Growth command/review/draft outcomes apply. New customer Analytics event names are not applicable. No production outcome delivery or model-quality claim is made. |
| Logs and metrics | Existing operation/event/OTLP identities correlate product, binding, task, attempt and review/receipt. Agency logs bounded mapping/operation identities. Credentials, prompts and record bodies are excluded. New hosted dashboards, retention changes and production alert qualification are not applicable. |
| Documentation | Architecture, product capability reference, integration setup, feature map and release routing describe current contracts. Requirements and checklist status remain in Linear. |
| Validation | Focused deterministic composition/model-loop checks, signed destination/API and real PostgreSQL tests, shared Agency HTTP/runtime/evidence checks, affected builds and import boundaries. The controlled Agency test uses explicit origin fixture authority and actual destination migrations/roles/grants. No evaluations, graders or live model acceptance runs are included. |
| Rollback | Stop new admissions and select an installed compatible configuration for future turns. Disable service trust or revoke destination grants to stop more access. Keep accepted releases, immutable snapshots, exact receipts and uncertain outcomes. Do not rewrite old task releases, replay V20 journals through V21, or reverse tables used by accepted work. |
| Production follow-up | Production release date, deployment, customer communications and post-release review date are not applicable to this local implementation. |


### Knowledge storage cutover

Schema 093 stores knowledge source bytes and query-embedding receipts in PostgreSQL.
Extracted text and chunks remain available for active sources. Raw inputs and stage
receipts are retained for the seven-day durable replay window plus 15 minutes, then
removed by the cleanup worker. The document runtime is still required for parsing
and embeddings. Other private artifacts and connected-tool bodies still use S3.

For an existing installation, stop all API instances, workers, dispatchers and
source-object reapers, then apply the schema and run `pnpm --filter @kasitek/agents
backfill:knowledge` with the existing database and S3 settings. The command verifies
content sizes and digests, leaves S3 objects untouched and is safe to rerun. Do not
run old and new writers together during or after cutover. API, worker and cleanup
startup fail if available knowledge objects are missing from PostgreSQL. Keep a
database backup and the old bucket until cutover is verified.

Rollback to the old application requires restoring the pre-cutover database and
bucket together. Once the new application has written knowledge to PostgreSQL,
restoring the old application alone would lose those new writes; stop writers and
recover forward or perform a separately verified reverse export before rollback.
No S3 objects are deleted by the backfill.

Release impact: this is an additive schema and storage cutover, with the existing
release identity and cleanup logging. No new analytics or metrics are added. Run
schema setup and the verified backfill while writers are stopped, deploy the API
and worker together, then check import, preview, retrieval and cleanup before
removing any legacy copies. Model evaluations remain owner-run. The database and
bucket backup and reverse-export limitation above define rollback.


## Adaptive specialist coordination

New business publications use schema099 recursive lineage and
`product-capabilities-v15` / `AgentsBusinessRunV25`. Schemas096–098 retain progress, continuation and nullable execution policy. Accepted v13/V23 journals keep their handler. Existing versions 1–3 and their accepted task
journals remain pinned. It extends the ordinary Assistant and other authorized business agents;
it creates no privileged replacement agent or cross-product authority.

The model can discover a permitted roster (up to 32 published pins), start one/two focused tasks,
inspect or wait for selected child statuses, read a selected result in 4,096-byte UTF-8-safe pages,
follow up the latest terminal specialist turn in the same child conversation, and cancel a child.
Result offsets count Unicode code points. The coordinator may revise its approach after failure;
paging and historical failed children do not permanently force an otherwise supported root answer
to be partial. Native outcome and answer quality remain separate.

Configuration permits 1–8 concurrent children (default 2), an optional cumulative child-task
allowance (default null) and a repeated-unchanged-observation threshold of 1–8 (default 3).
Any explicitly configured specialist can commission a child. Positive depth limits count further edges
and `null` has no configured depth ceiling; every finite ancestor ceiling remains binding. Immediate-parent
source/connection/product ceilings, immutable lineage and work accounting apply at every edge. Subtree
cancellation leaves siblings active, and intermediate settlement waits for descendants. Customer-safe
configurations retain deployment/session identity without staff access. With no active child, equal recent requests and results trigger a replanning
observation before a further unchanged action pauses. Changed results count as progress, and
wait/progress inspection is excluded. This is not a general semantic progress judge. Nullable
specialist token/time scopes use bounded per-operation reservations; explicit finite scopes remain
binding. Permissions, quota, current authority and source/tool scope remain runtime constraints.
No hardcoded business routing sequence chooses a specialist.

Eligible terminal work continues through a new immutable segment, preserving `work_id`, receipts,
cumulative accounting, original deadline and the intersection of prior/current policy. Pending or
uncertain physical operations require reconciliation. Schemas097/098 add this lineage and exact
counters. Prior corrections stay in current input after compaction. A nonreducing compaction
sequence pauses; a bounded deterministic partial response can preserve eligible findings without
another model call. Current-source and citation checks still govern those findings.

Work records and queued authorized active-root instructions survive durable execution. Native
handles/revisions are confirmed metadata; plan prose stays untrusted after compaction. Child
history requires explicit same-root/version/member prior-task ancestry, excluding sibling/root
transcripts. An explicit selected result joins only that child's current evidence. Private phone
rollout remains independently allowlisted.

`agent.orchestration.lifecycle@1` adds aggregate lifecycle facts to the existing Analytics outbox;
private task and plan content stay within authorized native evidence. The
[operation reference](operations/adaptive-orchestration.md) records tool/API boundaries, rollout,
rollback, telemetry limits and the complete release record. The owner acceptance manifest/rubric
under the existing Harbor adapter is not a runnable evaluation or a reported quality result.
Controlled contract/provenance/Restate/browser checks establish only their recorded engineering
behavior. See [verify-agents](../../../.agents/skills/verify-agents/SKILL.md) for reproducible checks.


Adaptive specialist version pins include that agent's own selected reviewed skill revisions.
Current package review/state and delegated capability requirements are checked at coordinator
publication, discovery and child admission. Results retain exact consumed skill provenance;
coordinator evidence can use it only through a joined child result with the current matching
binding/version pin. Disabling an influencing package makes those results unavailable. No global
or cross-agent skill-ID intersection grants authority. `adaptive-specialist-skills.test.ts` exercises
actual package activation, source citations, exact result consumption and skill/source withdrawal.


Active v4 member-channel roots with delegation enabled receive subsequent verified
Telegram/WhatsApp text as queued instructions on the same root. Ingress identity deduplicates
updates and acknowledgment notices even after final-input closure. New messages after closure
start the next ordinary turn; legacy programs keep new-turn admission. App and phone updates use
the same scoped queue and serialized close gate. Context groups have stable per-instruction IDs,
load in bounded batches, and are excluded after incorporation/compaction rather than continuously
reappending all prior text. Native outcomes remain distinct from model-authored progress.

### Retained executable lineages

Ordinary adapter registration rejects a different digest or executor for an existing
release. Growth also installs source-frozen local branch variants through a separate
trusted registration path. Resolution uses the full adapter identity (ID, release and
manifest digest); a persisted manifest cannot install an executor. Hosted releases
3–8 retain their original handler sets and digests. The local projection-aware
release 6 remains executable only at its exact frozen digest, alongside hosted
release 6. New publication 12 selects projection-aware release 9. Runtime adoption
does not add or replace product operation assignments.

Growth publication 13 uses release 10 for structured connection and account reads.
Eligible existing agents receive derived versions that preserve their selected tools,
specialist ceilings and accepted task versions. Schema 116 records runtime-version
lineage without consuming the author's draft revision. Unsupported source lineages
are deferred; installation alone does not prove every feature was upgraded.

Ordinary task replies, activity and supported text artifact downloads apply a scoped
view of known internal references. Explicit authenticated technical exports retain
their native capture contract. Checks protect identified values, not all possible
secrets or transformed identifiers; legacy partial records and long histories have
the limits documented in the runtime and Growth integration references.

The standalone Agents API includes an opt-in inbound MCP endpoint. When enabled, it provides
organization-scoped OAuth connections and creation, configuration, knowledge, private-preview,
and reviewed website-activation operations. Private preview permits knowledge and discovery;
it does not exercise connected actions or delegation. Connection and review views are available
in the standalone client. A focused database test uses an MCP SDK client through the actual API
composition for OAuth, tool discovery, agent creation/configuration, private-preview admission and
website review. Restate preview completion is conditional on the test binary; live hosted-client
compatibility and serving rollout require separate evidence.
See [integration boundaries](mcp-integration.md#standalone-agents-mcp-server).
### Unavailable historical execution releases

Conversation planning omits a prior turn when its program, workflow or harness release is no
longer available. It records the omission reason and includes a bounded context notice so the
model can ask for missing information instead of inventing history. Current-task publication,
authority and release validation remain strict. This handles unavailable history; it does not
make an old executable release available or restore its customer-visible output.

This correction is rolled out to the local Agents API and worker through `dev:local restart`;
production is excluded. No API/schema migration, permission change, analytics event or new
alert is required. Existing omission codes and bounded context metadata provide diagnosis.
Validation covers the release-drift history regression, strict current-release rejection, build
and module boundaries, plus a same-conversation local check. Rollback restores the preceding
API/worker artifact; it does not modify stored tasks or conversation records.


Customer channel timeouts use platform-owned `customer_timeout_notices` receipts, not model output.
Migration 130 must be applied before API and worker rollout. The worker derives each notice from a
deadline cancellation event, original scoped turn and nonrevoked grant, and enqueues it on the same
active conversation and destination. It suppresses the notice when later conversation activity exists.
The channel worker revalidates receipt provenance, current ownership, connection revision and provider
policy immediately before send. Failed and unknown provider outcomes are recorded by the existing
outbox; an unknown acknowledgement is not automatically resent. The notice does not prove whether an
earlier external side effect happened. Database or dispatcher downtime can delay it.
