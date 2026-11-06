# Configure Growth agent execution

Owner: Agents engineering. Last reviewed: 2026-11-03.

This setup connects Growth's Agents workspace and general assistant launcher to the shared
business worker. New managed defaults revision11 uses `AgentsBusinessRunV25` / `product-capabilities-v15`
for the assistant and specialists. Older accepted work keeps its exact runtime identity. Growth users keep their
existing business membership. They do not sign into standalone Agents or supply the worker's service credentials.

## Prepare the services

1. Follow [Agents local setup](../README.md#start-locally) to prepare its dedicated database,
   encrypted credential keyring, API, worker and registered Restate deployment.
2. Apply Growth's ordinary database migrations through its existing release process. The review
   store uses `GrowthAgentReview` and the existing `analytics_outbox`. Keep schema changes separate
   from starting the processes. This setup does not reset a Growth database or import legacy state.
3. Start Growth's API and web application through [Growth local development](../../growth/docs/internal/development/local-development.md).
4. Set Growth API `FRONTEND_URL` and Growth web `GROWTH_WEB_ORIGIN` to the same exact browser origin,
   for example `http://localhost:3000`. Set web `CORE_API_BASE_URL` to its Growth API origin.
   The active-business route rejects missing or mismatched origins.

Use the same scheme, hostname and port throughout the browser session. `localhost` and
`127.0.0.1` are different browser origins.

## Configure independent service keys

Create two RSA keypairs outside the repository. Store private keys only in server secrets.
Use SPKI public PEM and PKCS8 private PEM. Preserve PEM newlines in secret-manager values or
quoted multiline entries in private environment files.

For Growth commands, set these values in Growth API configuration:

```dotenv
AGENTS_PRODUCT_API_URL=http://127.0.0.1:4100
GROWTH_AGENTS_SIGNING_PRIVATE_KEY="<Growth command private PEM>"
GROWTH_AGENTS_KEY_ID=growth-v1
GROWTH_AGENTS_ISSUER=https://growth.kasitek.co.za
GROWTH_IDENTITY_ISSUER=https://growth.kasitek.co.za/identity
```

In Agents API and worker configuration, install the corresponding verifier:

```dotenv
GROWTH_AGENTS_PUBLIC_KEY="<Growth command public PEM>"
GROWTH_AGENTS_KEY_ID=growth-v1
GROWTH_AGENTS_ISSUER=https://growth.kasitek.co.za
GROWTH_IDENTITY_ISSUER=https://growth.kasitek.co.za/identity
```

`GROWTH_IDENTITY_ISSUER` identifies Growth's verified internal `User.id` namespace. Keep it
separate from the OIDC issuer that authenticates the human session. Growth derives the actor
and active business on the server. The browser cannot choose an actor in a service command.

For destination actions, configure the second keypair in Agents API and worker:

```dotenv
GROWTH_PRODUCT_API_URL=http://127.0.0.1:4000
AGENTS_PRODUCT_ACTION_PRIVATE_KEY="<Agents action private PEM>"
AGENTS_PRODUCT_ACTION_KEY_ID=agents-v1
AGENTS_PRODUCT_ACTION_ISSUER=https://agents.kasitek.co.za
```

Install its verifier in Growth API configuration:

```dotenv
AGENTS_PRODUCT_ACTION_PUBLIC_KEY="<Agents action public PEM>"
AGENTS_PRODUCT_ACTION_KEY_ID=agents-v1
AGENTS_PRODUCT_ACTION_ISSUER=https://agents.kasitek.co.za
```

Both directions bind the signature to the complete request digest and a short expiry. The command
endpoint is `POST /internal/v1/products/growth/commands`, with audience `agents-product-api` and
subject `growth-api`. Capability calls use `POST /internal/agents/capabilities`, audience
`product-capability-actions` and subject `agents-worker`. Origin eligibility and existing product
lifecycle/review calls retain `POST /internal/agents/actions` with audience `growth-agent-actions`.
The shared runtime checks originating Growth access separately from each destination operation.
Production service URLs require HTTPS.

To rotate verifier keys, use `GROWTH_AGENTS_PUBLIC_KEYS_JSON` or
`AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON` with `kid` to public PEM entries. Keep an optional feature
configuration control key in `GROWTH_AGENTS_CONTROL_PUBLIC_KEYS_JSON`; its separate private key
never belongs to the Growth browser service. Restart matching services after configuration changes.

## Automatically provision organisation defaults

Growth records a durable setup job in the same transaction as each organisation and owner
membership. The setup worker creates Growth assistant, Research, Content and Campaigns through
an independent signed provisioning API. Existing organisations enqueue missing setup on their
first authorised bootstrap request or through the bounded operator backfill below.

Apply Growth migration `20261023170000_growth_agent_setup` before deploying the API or worker.
Run Agents `setup:db` to apply the exact supported additive schema upgrade. Unknown schema
checksums remain rejected; do not reset an existing database to work around a mismatch.

Create an independent RSA provisioning keypair. Configure Growth API/worker with:

```dotenv
GROWTH_AGENTS_PROVISION_PRIVATE_KEY="<provisioning private PEM>"
GROWTH_AGENTS_PROVISION_KEY_ID=growth-provision-v1
GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_ID=growth-default
GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_REVISION=1
```

Configure Agents API with the matching verifier and explicit managed model profile:

```dotenv
GROWTH_AGENTS_PROVISION_PUBLIC_KEYS_JSON={"growth-provision-v1":"<public PEM>"}
GROWTH_MANAGED_MODEL_PROFILE_JSON={"id":"growth-default","revision":"1","providerId":"<installed-provider>","modelId":"<approved-model>","credentialRef":"GROWTH_MODEL_DEFAULT_API_KEY"}
GROWTH_MODEL_DEFAULT_API_KEY=<protected-provider-key>
```

The profile is trusted operator configuration. `credentialRef` names a protected Agents environment
secret, never a field accepted from Growth or its browser. Set provider, model and limits deliberately;
there is no implicit fallback key or automatic model substitution. Credentials enter organisation-scoped
vault custody and product use grants. Existing valid defaults and explicit revocations are preserved.
A profile revision change requires an explicit operator upgrade rather than a retry.

Provisioning uses `POST /internal/v1/products/growth/provision`, audience
`agents-product-provisioning`, subject `growth-provisioner`. Its full request digest covers the
organisation and target revisions. User execution and general configuration credentials cannot
invoke it. Agents checks current Growth eligibility at `POST /internal/agents/provisioning-check`,
with audience `growth-agent-provisioning-lifecycle`, subject `agents-provisioner`, and the existing
Agents action signing key. Both service origins and action verifier configuration remain required.

Run the existing API workers, or start a dedicated Growth worker with
`KASITEK_PROCESS=growth-agent-setup-worker`. If `KASITEK_DISABLE_BACKGROUND_WORKERS=true`, the
API does not deliver setup jobs; start the dedicated worker explicitly. No model inference runs
as part of provisioning. Discovery validates provider metadata; live-model acceptance and evaluations
remain owner-run.

From `products/growth/api`, with the intended protected environment profile, use:

```sh
node --import tsx scripts/agent-setup.ts status
node --import tsx scripts/agent-setup.ts backfill 100
node --import tsx scripts/agent-setup.ts retry <organisation-id>
node --import tsx scripts/agent-setup.ts cancel <organisation-id>
node --import tsx scripts/agent-setup.ts upgrade-defaults <organisation-id>
```

Backfill only inserts missing setup jobs. Retry preserves the job's original target and operation
identity. Cancel fences the source job; it does not revoke already accepted conversations or
replace the independent Agents tenant-control operation. Missing or invalid configuration becomes
blocked. Transient failures use bounded retries; exhausted attempts remain visible for repair.
Provisioning validates that each saved model route still has its matching active credential. A
revoked or missing credential blocks repair instead of being silently replaced.

The approved Growth publication is owned by `src/agents/manifest.ts` in Growth API.
Defaults revision `14` includes its four presets, current callable operation manifest,
optional-capability policy and per-preset delegation graph. Agents persists this publication and
validates it against the installed adapter. The Assistant can use Research, Content and Campaigns;
Content and Campaigns can commission Research for focused evidence work. Research is a leaf. An operator can run
`upgrade-defaults` to queue the new managed revision. Repair preserves customised
configurations, disabled features, model selections and revoked tenants; accepted turns retain
their old configuration. An unsupported optional capability remains denied even if requested in
configuration. See [Product capabilities](product-capabilities.md) for the shared contract.

### Growth defaults and content projection

Growth defaults revision `14` uses installed adapter release `11`; revisions `2`–`13` retain their
registered publication and adapter identities. Revision `14` publishes the current Growth operation
catalogue and adds the shared reference contract. Each preset keeps its own permitted operation set.
It carries forward the delegation policy introduced in revision `12`; that policy removes default
depth, task-count and per-child token/time ceilings, while current grants, ancestor limits, the
two-child concurrency setting and each preset's product/tool authority still apply. It does not
change public HTTP schemas, the Growth product database schema, effect handling, or
`AgentsBusinessRunV25`. No Growth Analytics event or new structured log, metric, dashboard, or alert
is added; those release concerns are not applicable.
The shared model-result boundary applies the same safe view to retained revision `6`–`9` bindings
that already expose the canonical post read operations. Revisions `6`–`8` pin adapter releases
`3`–`5`; revision `9` pins release `6`.
Older accepted work keeps its permission and native receipt; only private fields in the model-facing
read result are removed.

### Internal references and recipient output boundary

Growth's internal shared-agent endpoint builds bounded `connections.list` and `content.accounts.list`
views before transport. It keeps names, public social handles, platform, status, permitted
capabilities and continuation while omitting unrelated provider metadata. Public platform account IDs
remain available in the typed model view for an explicit Page ID request.

The Agents product adapter changes the native connection/account selector into a random opaque
reference before the result enters model context. References are scoped to the Agents conversation,
human principal, Growth tenant and resource type. Draft channel selections and connection status
updates resolve only their declared selector fields on the server. Growth still receives the native
ID and checks current operation authorization, organization and record state; the reference grants
no authority. Native Growth reviews, access custody, digests and receipts continue to use native IDs.
This applies to retained as well as current Growth operation bindings. The current adapter release
11 also declares post, media, template, connection and account selector fields for model-facing
results and authorized follow-up inputs. Compatible active Growth bindings from retained
publication revisions `2`–`13` are cloned onto the new adapter during normal tenant setup; custom
drafts, permissions, accepted tasks, native receipts and review payloads remain unchanged. An
unsupported or changed binding is deferred rather than widened. There is no Growth database
migration or change to its direct REST contract. Replayed operation history uses the same model view
and scopes references to the original task lineage.

Ordinary assistant replies, activity, subagent output, history and supported text/JSON artifacts use
the shared Agents recipient projection. It removes known runtime and tool-result IDs, scoped handles,
redaction markers and unsafe link targets while preserving user text, public handles and legitimate
business references. It uses a trusted display name for an issued product reference where available.
An explicit request for a platform ID permits only the provider ID, never a colliding internal value.

Release impact: Growth API/worker publication revision 14 and Agents API/worker adapter release 11;
Agents schema132 stores scoped references. No Growth database migration, public HTTP schema change,
analytics event, new structured log/metric, dashboard or alert applies. No platform release ID is
assigned in this local change. Validation uses focused handle, projection, publication, binding
rollout, typecheck/build checks, and one local normal prompt if the owned fixture is available.
Production rollout is outside this scope. Keep the additive schema on rollback; retain the
projection-aware runtime until any accepted task containing these references settles. Never route a
handle to a product as if it were a native identifier.

#### Managed defaults revision 14 release record

Release record: risk is standard; Growth API/worker, Agents API/worker and managed Growth feature
versions are affected. Publication revision changes from `13` to `14`; adapter release changes from
`10` to `11`. Compatible published bindings upgrade during normal tenant setup; managed-default
changes remain an explicit owner action. No feature flag, analytics event, Growth schema migration,
structured log, metric, dashboard or alert change applies. Rollback retains publication `13` and
prior adapter registrations; accepted tasks and native receipts remain readable. Documentation is
updated here and in the feature map. Focused evidence is recorded with the implementation; hosted
rollout and post-release review are not performed in this local change.

Revision5 changes the product-owned working instructions and specialist descriptions. The assistant
owns clarification, relevant evidence gathering, useful specialist assignments and final synthesis.
It asks for essentials that materially affect the work, accepts user-supplied facts without demanding
stored confirmation, and keeps implementation identifiers out of ordinary replies. This guidance
has no keyword router, required specialist order or mandatory delegation for simple work. Revisions2–4
remain registered with their original publication identities for accepted bindings. Revision5 keeps
revision4's null cumulative specialist scopes, current permissions and exact draft reviews.

The operator status reports state counts, attempts, pending age and completed setup duration.
Structured `agent.setup.*` logs include organisation/operation/generation and safe failure codes.
OpenTelemetry records `growth.agent_setup.backlog`, transition counts and setup duration through
Growth's existing telemetry. Provisioning does not add customer Analytics events or expose keys,
prompts or private profile data in telemetry.

Growth shows all four defaults during setup and refreshes pending/running state with bounded polling.
A completed setup still requires current membership, entitlements, a healthy runtime and any
operation-specific account or context. Setup must not silently grant publishing or campaign rights.

The manual `setup:growth-model` command remains available for explicit operator model changes.
Automatic repair does not overwrite those settings. For rollback, disable setup delivery first and
retain the additive tables and queued jobs. Apply service configuration/schema before enabling
workers. No production deployment is implied by this local setup.

## Check the available work

All four presets can discover and read permitted content, WhatsApp campaigns and business context,
and query analytics with an explicit range/timezone where the reporting gateway is configured.
They share one model-directed loop; the model chooses its tools and order. Attached records give
focus without replacing current resource authorization. Reads return bounded continuation.
Source-backed reads provide versioned citations; canonical operation results retain access scopes
without claiming content-version citations. Several records can influence one result.
For record reads, an omitted or empty `continuation` requests the initial page, matching the
published tool schema. Nonempty cursors remain authenticated to the actor, operation, resource
and revision; malformed or foreign cursors do not become initial-page requests.

Selected canonical draft operations can prepare an exact staff review and save a `SocialPost` in
`DRAFT` state before a social account is connected. The accepted legacy `draft.prepare` contract
still requires its explicit account selections. Current operation permissions authorize the save;
the agent's name is not proof of write access. Publishing and scheduling separately require an
authorized connected destination. Growth owns account checks, exact approval and the stable domain
receipt. A lost acknowledgement reconciles that same operation before another save.

The assistant discovers its three pinned, same-business specialists and chooses direct work,
parallel or sequential delegation, result inspection and focused revisions through the shared
adaptive loop. The specialist definitions remain ordinary published Growth agents. There is no
topic routing table or mandatory research/content/campaign sequence. Revision4 specialist bindings
use null cumulative token/time allocations and reserve the next bounded physical operation. Two
children may run concurrently. Explicit finite published bindings remain bounded; a request cannot
enlarge those grants. Child model/tool operations, compaction and actual token/time usage remain
part of shared work accounting. Legacy delegation retains its finite 12,000-token binding ceiling.
Publish compatible workers before new admissions and retain their support for accepted pins.

Derived child authority requires the admitted root, the same initiating principal and business,
an enabled pinned specialist, and product capabilities within the root's exact scope. Equivalent
bindings may have different publication-local IDs; comparison retains organization, descriptor,
adapter, policy, limits and destination authority. It never matches by operation name alone.
Current checks fence disabled specialists and withdrawn evidence, including already joined results.

The Growth feature response includes selected specialist names and their configured, disabled or
unavailable state. Configured means the pinned version and enabled product mapping exist; it is
not a model, tool or live-provider health claim. Authorized Growth owners and administrators also
see whether each specialist has memory enabled and whether the current Assistant definition can
pass it through. Memory is available to the Assistant only when both definitions enable it and the
pinned binding includes memory tools. This status reports current configuration; it does not grant
memory access. Other members do not receive specialist configuration in bootstrap. A disabled
specialist does not make the coordinator's own chat unavailable. Direct knowledge and skill
failures report their specific category.

Each agent's chat readiness checks the saved model selection, current connection and use grant,
model metadata, and the matching active credential revision, endpoint and protocol. Revoked and
missing credentials are reported separately. Selected knowledge and skills are checked against
their current product authority. These are saved configuration checks; they do not contact the
model provider or establish its current health, quota, or acceptance of a future request.

The in-app conversation shows bounded work progress and specialist status. Signed
`tasks.instructions` queues idempotent updates against an active authorized root;
`tasks.continue` renews active authority or creates an immutable linked segment for eligible terminal
work. The work identity, prior receipts, cumulative usage and original deadline remain; continuation
does not increase an accepted finite allowance or reconcile unknown effects automatically.
Cancellation reaches the whole task tree. Reopening reads persisted work and queued instructions.
Reviewed child effects remain exact single-use approvals, projected into the initiating root's UI.
Draft-only requests return text in chat. Explicit publication, scheduling and supported published-post
edits use canonical Growth review, commit, receipt and reconciliation operations.

Growth selects the canonical operation executor from the signed, installed descriptor's exact
`growth.operation.<operation>@<revision>` handler identity. Publication policy revisions govern
authority and optional capabilities; they do not choose a different operation transport. Agents
uses those validated handler identities when reading canonical reviews. Retained legacy draft
bindings keep their original review store and exact task version.

Canonical reads still declare `evidence: none`. The shared worker requests an internal `access-v1`
observation, and Growth records the authorized resource scope before chunking the result. Agents
stores the exact receipt separately and carries the scope and narrowed product/provider audience
through retained context. Growth rechecks current membership, operation entitlement and captured
resource access before reuse. An old canonical read without a product access record is unavailable;
an unrelated unjoined specialist does not block the parent. These access checks do not establish
current content revisions or citations. Growth reviewed writes retain the exact native review and
effect receipt, while the model and retained operation history receive only a confirmed state and
opaque review reference. The separately negotiated `effect-status-v1` scope rechecks current
membership, operation access, the exact saved review and the original recipient/provider audience.
It does not authorize the private review body or the returned business record. The execution export
withholds that raw effect result and reports partial tool-result coverage. Untracked older effect
results are unavailable to model context. Authorized task controls and exact review-decision
verification use a separate status-only path, so they do not reveal the private result or make it
available to the model.
Other reviewed-write adapters need an installed versioned model projection before they are callable.

The embedded media-transfer preparation response uses `access-v1` with the exact transfer owner,
tenant, active state and expiry. Once the transfer fails, completes or expires, its earlier upload
details are unavailable to later model context. Growth's direct transfer endpoints are unchanged.

The product applies a 131,072-reference bound to one read scope and the existing 2 MiB source-result
limit. Repeated reads of the same scope in one task share an evidence dependency, while distinct
scopes and retained scopes from other tasks count toward the 1,024-dependency manifest bound.
This is a context/evidence capacity limit, not a configured model-call or tool-call allowance.

Revision9 supports separately selected native knowledge, reviewed skills and verified actor memory.
Sandbox, workflows, enquiries and external connections remain unavailable in Growth.
External web research, automatic publishing, campaign launch and arbitrary writes are unavailable.
Standalone customer-channel agents retain their own deployments and Inbox path.

## Knowledge and skills

Owners/admins open **Knowledge & skills** on a feature card. Knowledge imports accept bounded
UTF-8 text or Markdown; PDF and URL acquisition are not exposed by this Growth path. The existing
native source store retains raw custody, immutable normalized revisions and passage offsets.
Imports remain candidates until the owner approves the exact revision. Skill imports accept
portable `SKILL.md` files, package ZIPs and the installed curated catalogue. A curated import also
requires an explicit package-digest review before selection. Skill requirements must match the
feature's actual configured permissions and installed runtimes.

The selection action publishes a new immutable feature version with approved source pins and
reviewed skill revision IDs. It preserves instructions, model selection, memory and delegation
configuration. The product-managed assistant follows its explicitly configured specialist
versions in a new version, retaining child-only source ceilings without adding those sources to
its own direct retrieval selection. Custom coordinators retain their pinned bindings. Every
retrieval/activation rechecks current product ownership and selection as well as the native
source/skill policy; removing a selection or withdrawing content fences old accepted work.
Skill catalogue loading uses the accepted task and current Growth authority; Growth users do not
need a standalone Agents account or membership to use selected reviewed skills.

Open inventories and file previews recheck current access and resource state every five seconds
while visible. A failed read clears cached resource content. Rechecks preserve unsaved selection
and its original configuration revision; a concurrent configuration change requires an explicit
refresh before saving. Closing a resource dialog restores its opener when it is still available.

Browser routes are under `/api/agents/features/:featureId`: `GET resources`, `GET resources/preview`,
`POST sources`, `POST sources/review`, `POST sources/state`, `POST skills`, `POST skills/review`,
`POST skills/state` and `POST resources/select`. Mutation bodies carry stable `requestId`s.
Selection carries `expectedRevision`; source/skill state changes carry `expectedGeneration`;
source approval identifies the immutable revision and skill review identifies the package digest.
The corresponding signed operations are `resources.list`, `resources.preview`, `sources.import`,
`sources.review`, `sources.state`, `skills.import`, `skills.review`, `skills.state` and `resources.select`.
Growth verifies the active human, business membership and owner/admin role before signing. Agents
derives native feature scope from that signed product mapping and independently rechecks current
origin access. No browser-supplied actor, native organization or feature-agent identifier is trusted.

Schema103 records nullable standalone importer/reviewer IDs paired with exact product-service
provenance. Exactly one identity kind is required. No customer Agents account or membership is
created. Configuration remains optional; importing/reviewing does not automatically select a resource.
`growth.agent.command@2` records resource mutation outcomes, feature ID and bounded failures without
source bodies, skill contents or human subjects. Existing source/skill mutation receipts retain the
exact review and state history. `test/product-resources.test.ts` exercises native import, explicit
review, selection, actual retrieval and activation, foreign-feature denial, revocation and
custom-runtime repair in a fresh owned database.
The focused `growth-shared-ui.spec.ts` resource case verifies a mobile preview's withdrawal and
permission-loss redaction, preserved unsaved selection, revision conflict and closing focus with
controlled HTTP responses. It does not establish live provider behavior.

## Disable or restore execution

Set `GROWTH_CONTROL_TENANT_ID` and one operator action in private configuration, then run:

```sh
pnpm --dir products/agents/api control:growth
```

Use `GROWTH_CONTROL_ACTION=tenant.disable` to fence new work and reads, revoke execution grants,
and request cancellation of active task trees. Exit code `2` means cancellation needs another
pass. Rerun the same action. An already committed Growth effect remains recoverable.

Use `tenant.enable` to allow future tenant access. It does not revive revoked grants, old runs or
credentials. Use `model.revoke` to clear Growth-managed credential envelopes, use grants and its
model default. Reprovision explicitly with `setup:growth-model` before new work can run.
These operations use operator database authority and have no browser endpoint.

## Inspect outcomes

Managed defaults select the optional `artifact.create` tool for new agent versions. Existing
unchanged product-managed configurations receive one immutable version update when tenant setup
runs; customized, disabled or unpublished-draft configurations are left unchanged. Later tool
removal is not automatically reversed. Configure private S3-compatible storage for both Agents API
and worker. Without it, the worker omits the file tool from its callable catalogue. Growth shows
actual task files and downloads them through its authenticated bridge. The same task, actor,
product membership, source, audience and exact-byte checks apply on both sides of storage reads.
Specialist activity projects only files produced by the selected child. A child-modal download
carries both the authorized root and exact child task identity; the bridge checks their lineage
and the selected file producer without joining the child's content into the parent model.
File output is neither a Growth business record nor an external delivery.

Growth engineering owns the three registered `growth.agent.*` event contracts and the existing
transactional Analytics outbox. Count accepted `conversations.create`, `turns.submit` and
`tasks.cancel` acknowledgements separately from rejected or unavailable commands. Count exact
review decisions and confirmed saved drafts from their dedicated events. Stable record identities
deduplicate retries. Admission counts do not establish successful agent results.

Use Growth's `kasitek.operation.duration` for the service bridge and Agents'
`agents.operations.duration_p95_ms`, `agents.capacity.oldest_wait_ms` and `agents.usage.tokens`
for execution health. Inspect native task, operation and root model accounting for tenant-level
success, failure and known or unknown costs. Ordinary traces and product facts exclude private
briefs, contents and keys. Configure the existing Analytics publisher to deliver queued outcomes.

## Verify the integration

The engineering journey uses the actual built Growth UI and BFF, authenticated product HTTP,
PostgreSQL and Restate. Only dashboard identity and model responses are controlled fixtures.
It checks Growth-only identity, two turns, quick access/history, API/worker restarts, exact
reviewed draft readback, signed pagination, concurrent configuration, private downloads and
withdrawn evidence. Adaptive cases also exercise three specialists, a specialist revision, product
reads by child tasks, steering, authority renewal, cancellation, disabled specialists and root review
isolation. It creates and removes its own databases and Restate runtime.

With local PostgreSQL administrator access supplied privately as `AGENTS_TEST_ADMIN_URL`,
Docker and Playwright Chromium available, run from the repository root:

```sh
pnpm --filter @kasitek-labs/contracts build
pnpm --dir products/growth/web build
pnpm --filter @kasitek/agents exec vitest run test/growth-product-http.test.ts
```

When Docker is unavailable, `AGENTS_TEST_RESTATE_BINARY` may identify an owned official Restate
1.7.13 executable. The same suite starts a separate loopback native runtime and removes its data
and database afterward. It must not use the running user's application database. Computer-use
checks with normal sign-in and a live model remain separate from these controlled cases.

Browser evidence is saved under `.audit/growth-agent-real-browser/`. A passed deterministic
journey establishes engineering behavior, not model quality or live provider compatibility.

The optional [Growth Harbor mode](../evaluation-adapters/harbor/README.md#growth-product-mode-owner-run)
prepares owner-run cases through normal Growth HTTP with one isolated business and staff session
per trial. `GET /api/agents/tasks/:taskId/export` returns the initiating user's currently authorized
native capture through the signed `tasks.export` command. Captures contain actual accepted
composition/product bindings, model-route pins, operations and evidence coverage. Harbor checks
optional expected composition, manifest and model-route digests and converts supported native
records to ATIF without inventing missing calls or results. Oversized, withheld or unsupported
capture remains explicit.

This endpoint is an explicit technical export, not the ordinary agent transcript. It includes
model inputs and tool observations, including internal references. The product checks the current
actor, task and evidence access, but it does not guarantee that arbitrary historical input or
tool text contains no credentials. There is no link to this export in the ordinary Growth agent UI.

Growth still has no server-native evaluation-trial reservation/revocation contract. Configure and
discard the isolated environment through owner-run setup. Each preset or custom composition can
have an independent purpose suite. Adapter checks do not run evaluations; all evaluations and
graders remain owner-run. Production rollout, hosted retention and alert qualification remain
separate from this implementation.


## Apply or roll back the execution release

Apply recognized Agents additive schemas 070–072 with the explicit setup command before enabling
new admissions. They store generic review projections, trusted Growth publications and managed
configuration markers. Current execution additionally requires schemas096–106. Register V25 and
install current product handlers before publishing defaults revision `11`. The Growth manifest
and product policy revision are `11`; the installed HTTP adapter is release `6`. Revision `10` remains
available on release `6` for accepted work.
Exact revision 2 publications remain supported for accepted work and persisted setup retries.
Unknown schema digests remain rejected. Schemas097/098 store logical work lineage, nullable
allocations and exact counters. Retain earlier schema registrations and accepted policy snapshots.

Schema106 stores the context explicitly selected when a Growth turn is admitted. Older tasks keep
the value unset; they do not acquire a later conversation selection. A continued task copies its
prior selection. Apply the additive schema before starting the matching API and worker.
The selected-context evidence dependency is recorded in accepted snapshots and inherited work.
Keep a worker that understands it available until those tasks settle or are reconciled, including
after an API rollback. Do not remove the column while accepted tasks depend on it.

Keep the V20 worker and its original `growth-products-v10` artifacts for already accepted V20 work.
Route or drain that work on its pinned release. Do not point an existing journal at V21. Rollback
stops new admissions and restores a compatible installed selection for future turns. Preserve
accepted snapshots, review/effect receipts and uncertain results; additive tables are not a reason
to reinterpret older tasks. These are operator release requirements, not an automatic deployment.


Growth defaults use the configured `AGENTS_MODEL_POLICY_JSON` input and compaction allowances,
intersected with discovered model capacity at admission. Service execution policy v2 defaults local
`maxModelCalls` / `maxToolCalls`, shared `maxRootModelCalls` / `maxRootToolCalls`, cumulative
`maxRootTokens`, active `maxDurationMs` and work wall `maxWallDurationMs` to null. Null means no cap for that optional allowance;
it never removes another finite policy layer. Call deadlines, request/context/output capacity,
concurrency, authority expiry and organization quota remain finite and independent. Work without an
explicit wall allowance has no implicit24-hour stop; old accepted finite deadlines remain binding.

A finite root allowance reserves its allocation at admission. A null root allowance reserves only
the next bounded physical operation against organization quota. Set
`AGENTS_SCHEDULING_POLICY_JSON.dailyTokenAllowance` for the authorized workload. Per-operation
settlement charges actual known usage or retains conservative charges for uncertainty; replay does
not charge twice. Continued segments retain cumulative local/shared usage rather than resetting
counts. Old accepted v1 policies retain their prior shared-counter semantics. The earlier private
pilot's 48-call override is not required by the new default and does not silently alter saved grants.
Strict monetary-cap and provider token-counter qualification remain separate acceptance gaps.

Managed default provisioning also derives initial context/output ceilings and the compaction threshold
from the selected managed-model snapshot. This allows smaller models without changing explicit saved
limits or weakening the policy compiler. Workers refresh trusted publication metadata for the task's
tenant on every handler entry, including replay, so a publication installed after worker startup is
available without treating a process-local registry fill as a journaled business operation.

Empty optional discovery search/status strings mean no filter, matching the published list schema. Nonempty invalid statuses, malformed cursors and foreign-scope handles remain rejected.


## Selected conversation context

Growth's workspace guide revision4 describes current product prerequisites. Draft text can be
written, revised and saved before connecting a social account; publishing and scheduling need an
authorized connected destination. The guide describes optional actor/agent memory with exact
user review. It does not select tools or grant action permission. Current installed bindings,
product permissions and exact effect reviews still govern execution.

A new Growth turn records the user's explicit workspace, content, campaign or analytics selection
as a task-pinned reference. An implicit workspace is not treated as a selection. The worker reads
that reference through Growth's signed `context.read` action and puts the returned model-safe view
in the coordinator's context. The reference itself grants no authority; Growth rechecks membership,
feature entitlement and record access for the read. Content-post views omit publishing account and
job fields. A specialist receives selected-record details only when the coordinator includes them
in its assignment.

The evidence graph binds the selected reference and returned content revision to the product, actor,
conversation and permitted provider audience. Replay, compaction, explicitly reviewed memory and
delegated work re-read the current Growth view and compare its digest. A changed record or revoked
access makes that evidence unavailable. Canonical Growth operations whose descriptors do not
provide versioned-source evidence retain their separate access-receipt behavior.

The context label shown in the conversation comes from the preflight response. New tasks do not
list preflight records as sources; only source-backed observations can populate the source list.
There is no new analytics event or exporter. Existing task and model failure records apply; no
additional metric, dashboard or alert is introduced. Validation uses an owned database, the
controlled Growth HTTP/Restate worker fixture and an owner-authorized in-app smoke. Hosted rollout
remains unverified.

## Live execution reporting

Growth chat reads an optional version1 runtime projection from each authorized task. The projection
uses the current root and independently authorized same-principal specialists. Context figures come
from the latest persisted context snapshot and accepted model policy. They are estimates, not a
provider token count. The model window, input ceiling, output/safety reserves, compaction threshold
and completed compactions remain distinct. Accounted usage includes conservative settlement;
provider-observed input/output usage is shown separately with its observed-call coverage.

Conversation reload and task-list reads project each page with at most four concurrent task reads,
while preserving turn/page order. Every task still receives its current authorization check, and
assistant output is included only after its current evidence check. This keeps a page of work from
serially consuming the Growth API's request timeout without weakening per-task access checks.

`GET /api/agents/tasks/:taskId/live` delivers server-sent `task` and `events` observations through the
Growth origin. The connection checks current Growth membership, active organization and Agents
task authority on each observation, and closes on access changes. Event cursors retain the existing
actor/tenant/task scope. A bounded connection lease reconnects from its cursor; terminal event pages
are drained before closure. Disconnecting a viewer never cancels execution. Existing task/event
reads remain the recovery path after interruption and on reload.

The runtime timeline exposes bounded operation labels, agent names, states and durations. Its
context/usage projection excludes prompts, tool arguments/results, credentials and private model
reasoning. Native `model.observed` events retain only scalar timing observations under an idempotent
operation key. Recording is best effort and cannot change a model outcome. First-visible-token
timing is unavailable for older calls or missing observations; queue timing is not currently
measured. No zero or estimated timing substitutes for missing measurements.

Each task projection carries an observation timestamp independent of its execution `updatedAt`.
The client uses it to reject stale stream/poll responses. Withdrawing evidence removes the runtime
projection, assistant output, source references and results. Conversation reads apply the same
evidence check; stale responses cannot restore hidden content. A later authorized observation can
restore visibility without rewriting execution history.

### Shared conversation activity and specialist observation

The product command `tasks.observe` and Growth's session-owned
`GET /api/agents/tasks/:rootTaskId/activity` return a bounded public observation of the root or
an authorized descendant selected by `childTaskId`. This is a purpose-built read projection;
it does not use the evaluation export. Every descendant lookup verifies root ancestry, product,
organization, initiating principal, enabled feature, conversation availability and current task and
evidence authority. A child identifier alone grants no access. Missing or withdrawn child activity
is unavailable, including its derived assignment and output.

The observation contains task state and assignment, safe operation metadata, public updates,
event history, and separate event and operation cursors. `cursor` advances durable events;
`operationCursor` loads older own-task operations. Operation pages retain native timestamp precision
and scope cursors to the actor, tenant, root and inspected task. The runtime summary remains a
bounded active-first overview; the paginated operation history is the inspection path. Tool inputs
and raw results are not part of this projection. Unsupported detail remains unavailable.

`GET /api/agents/tasks/:rootTaskId/activity/live` emits `observation` frames and uses the same
membership checks, bounded lease, disconnect cleanup, terminal-event draining and backpressure
rules as the task stream. Closing an observer never cancels execution. Reopening reads current
history and current authority. The UI must invalidate every in-flight history and live request
when authority is withdrawn so an older response cannot restore protected content.

Public updates are normal assistant message text accompanying tool calls in completed primary
model receipts. They are persisted action preambles, not private provider reasoning or
reconstructed summaries of arbitrary tool bodies. They are bounded, guarded by current evidence,
and excluded from customer-delivery projections and deleted conversations. Models that emit no
public preamble have no such update; native activity still remains visible. Partial token streaming
is not fabricated. The root task DTO also carries these optional updates.

Standalone Agents retains its own authorized task detail API. It exposes the same public-update
projection and bounded safe operation history with `operationsLimit`, `operationsCursor` and
`operationsNextCursor`. Reviewer-only task views do not expose this history or child transcripts.
No execution policy, model selection, quota, schema migration, runtime version or product
membership changes are required for these read projections.
