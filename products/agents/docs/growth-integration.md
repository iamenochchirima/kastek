# Configure Growth agent execution

Owner: Agents engineering. Last reviewed: 2026-10-31.

This setup connects Growth's Agents workspace and general assistant launcher to the shared
business worker. Managed defaults revision 5 uses `AgentsBusinessRunV24` / `product-capabilities-v14`
for the adaptive assistant and retains `AgentsBusinessRunV21` / `product-capabilities-v11` for direct specialists. Growth users keep their
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

The approved Growth publication is owned by `src/agents/manifest.ts` in Growth API.
Defaults revision `5` includes its four presets, operation manifest and explicit optional-capability
policy. Agents persists this publication and validates it against the installed adapter. An operator
can run `upgrade-defaults` to queue the new managed revision. Repair preserves customised
configurations, disabled features, model selections and revoked tenants; accepted turns retain
their old configuration. An unsupported optional capability remains denied even if requested in
configuration. See [Product capabilities](product-capabilities.md) for the shared contract.

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
focus without replacing current resource authorization. Reads return bounded continuation and
versioned citations so several records can influence one result.
For record reads, an omitted or empty `continuation` requests the initial page, matching the
published tool schema. Nonempty cursors remain authenticated to the actor, operation, resource
and revision; malformed or foreign cursors do not become initial-page requests.

Growth assistant and Content can prepare an editable draft for exact staff review and save one
account-bound `SocialPost` in `DRAFT` state. Current operation permissions authorize the save;
the agent's name is not proof of write access. Growth owns account checks, exact approval and the
stable domain receipt. A lost acknowledgement reconciles that same operation before another save.

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

The in-app conversation shows bounded work progress and specialist status. Signed
`tasks.instructions` queues idempotent updates against an active authorized root;
`tasks.continue` renews active authority or creates an immutable linked segment for eligible terminal
work. The work identity, prior receipts, cumulative usage and original deadline remain; continuation
does not increase an accepted finite allowance or reconcile unknown effects automatically.
Cancellation reaches the whole task tree. Reopening reads persisted work and queued instructions.
Reviewed child effects remain exact single-use approvals, projected into the initiating root's UI.
Draft-only requests return text in chat. Publication and sending remain unavailable.

Growth's installed policy disables native knowledge bindings, skills, memory, sandbox,
workflows and external connections until their product custody/principal authority is installed.
External web research, automatic publishing, campaign launch and arbitrary writes are unavailable.
Standalone customer-channel agents retain their own deployments and Inbox path.

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

Growth still has no server-native evaluation-trial reservation/revocation contract. Configure and
discard the isolated environment through owner-run setup. Each preset or custom composition can
have an independent purpose suite. Adapter checks do not run evaluations; all evaluations and
graders remain owner-run. Production rollout, hosted retention and alert qualification remain
separate from this implementation.


## Apply or roll back the execution release

Apply recognized Agents additive schemas 070–072 with the explicit setup command before enabling
new admissions. They store generic review projections, trusted Growth publications and managed
configuration markers. Adaptive execution additionally requires schemas096–098. Register V21, V23 and V24
workers and install current product handlers before publishing defaults revision `5`. The Growth
manifest and product policy revision are `5`; the installed HTTP adapter remains release `2`.
Exact revision 2 publications remain supported for accepted work and persisted setup retries.
Unknown schema digests remain rejected. Schemas097/098 store logical work lineage, nullable
allocations and exact counters. Retain earlier schema registrations and accepted policy snapshots.

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
