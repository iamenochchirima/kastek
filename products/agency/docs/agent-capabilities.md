# Agency product capabilities

The shared execution product namespace is `agencies`; the installed operation
namespace is `agency.workspace_agents.read`.

Agency exposes `POST /internal/agents/capabilities` for the installed
`agency.workspace_agents.read` operation. It returns permitted workspace-agent
IDs, names, statuses and timestamps from `workspace_agents`. It excludes agent
configuration, conversations and message bodies. Existing browser metadata APIs
retain their session and workspace behavior.

## Service trust and destination authority

The caller is the Agents worker, authenticated with an RS256 JWT. Configure
`AGENTS_PRODUCT_ACTION_ISSUER` and either `AGENTS_PRODUCT_ACTION_PUBLIC_KEY` or
`AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON`, a key-ID to PEM mapping. The optional
`AGENTS_PRODUCT_ACTION_KEY_ID` selects the single-key ID, default `agents-v1`.
The audience is `product-capability-actions`, subject is `agents-worker`, and
`requestDigest` is SHA256 of the complete canonical JSON invocation. Tokens
require `iat`, `exp` and `jti`, with a maximum 120-second lifetime. No request can
supply a key URL, service endpoint or executable handler. Missing service trust
returns unavailable. The Agents client uses its separately configured Agency
service URL and signing key. These credentials never enter model context.

A valid service signature authenticates the caller. It does not grant access to
an Agency workspace. Agency owns two tables introduced by migration
`20261023200000_product_capability_authority.sql`:

- `product_capability_mappings` maps an exact origin product, origin tenant and
  actor issuer/subject to an existing Agency workspace and tenant user. The
  invocation's `originTenantId` and destination `tenantId` are separate fields. A client-scoped
  mapping also pins `originClientId` separately from the destination `clientId`; a destination client
  never supplies or replaces the originating client's authority.
- `product_capability_grants` pins the mapping, operation, binding ID/digest,
  manifest/descriptor digests, handler and policy revision to an explicit
  allowlist of agent IDs. Each mapping and grant has expiry and revocation state.

Legacy workspace metadata grants remain trusted destination-admin operations. The client assistant
uses a separate owned setup path. After checking the current staff session, client ownership and
assignment, Agency requests the exact shared binding and records its own mapping and grant.
`shared_agent_client_setups` preserves that binding and explicit disablement. Retry repairs expiry
and the allowed metadata IDs; it never restores revoked mappings or grants, and rejects a stored
grant whose binding digest conflicts with the published binding.

For client-scoped setups, `enabled=false` is an immediate authorization fence, including for tasks
accepted before disablement. The Agents worker's origin-authorization check and Agency's metadata
authorize/read/evidence checks all require the enabled setup. The setting does not revoke its
mapping or grant, remove accepted tasks or command receipts, or retry an operation whose effect is
unknown. Re-enabling the setup restores authorization only; task execution and effect reconciliation
remain governed by their existing receipts and lifecycle state. First-time setup still bootstraps
from an active Agency staff session before the setup row exists.

`registerAgencyProductCapabilities` installs only the signed HTTP adapter. Configuring its URL
and key does not create customer membership, publish a capability or authorize a business record.
API and worker construct the shared product runtime independently of Growth configuration. Each
runtime owns its clients and credentials. New Agency work uses the immutable publication stored
in `product_capability_publications`, loaded before inspecting or executing its accepted version.

Every call checks the mapping/grant, active workspace, active mapped tenant user,
workspace membership and current `AGENT_ROLES` from the existing Agency domain:
owner, admin, automation_manager or support. Mapping a user from another
workspace fails. A grant cannot expose an agent outside the destination
workspace even if its ID is present in the allowlist. The metadata and checks
share one database snapshot.

## Read and later use

The invocation uses the shared `ProductCapabilityInvocation` contract. The
operation accepts `agentId`, `after` and `limit`; arbitrary input keys fail.
Pagination uses stable IDs and returns `next`. The maximum requested page is 50,
and pages shrink to the descriptor's existing response byte ceiling with a
continuation cursor. Names/statuses are bounded metadata projections.

The `authorize` control checks current destination authority. Each read returns
versioned source observations. Before later model use or delegation, the shared
harness must use `evidence` control with the source ID and revision. Agency checks
current authority, agent scope and the authoritative metadata revision again.
Revoked grants, role changes, disabled workspaces, disabled client setups, removed records and
changed metadata fail this check. Reading metadata does not launch an Agency agent.

## Client assistant

Staff open **Assistant** from a client detail page, at `/clients/:id/agent`. The page uses
`@kasitek-labs/ui/agent` for messages, composer, public updates, tool activity, context, elapsed time
and nested subagent modals. Opening a modal is observation only. The metadata-only default has no
specialist roster. Delegation is available only when separately selected and authorized in a
compatible definition; the interface never invents a child to demonstrate activity.

The conversation list and each transcript load 20 items at a time. **Older conversations** follows
the conversation-list cursor; **Earlier messages** prepends the next older turn page in chronological
order. Cursors remain scoped to the authenticated actor, workspace, client and feature. When a user
pages backward, list and transcript polling pause so the visible pages remain on one cursor snapshot;
readiness and active task observation keep revalidating. Tool activity retains observed operation identities and **Earlier activity** follows the scoped
operation cursor for a root or inspected descendant. Repeated pages are deduplicated; switching
conversation/client, closing an inspected branch or losing evidence/access discards its held pages.

The composer follows the task's current steering permission. Paused authorization and stopping
states do not accept new instructions through the UI. **Continue** appears only when the task
reports it available, renews/resumes the accepted work through `tasks.continue`, and preserves the
request identity when delivery is not confirmed. The page reloads the resulting task observation;
continuation does not repeat the original message as a new turn. A page-read error offers a refresh that
starts a fresh cursor chain. Losing authority clears both query-cache data and locally held pages.

The browser calls Agency's authenticated `/api/clients/:id/agent` readiness endpoint and
`/api/clients/:id/agent/commands`. The backend supplies the verified actor, workspace and client;
the browser cannot choose another principal. Staff require `AGENT_ROLES`, plus an active client
assignment unless they are a workspace owner/admin. Client-customer portal sessions and API keys
do not become staff execution sessions.

Agency sends versioned signed commands to `/internal/v1/products/agencies/commands` on Agents.
Commands cover readiness, conversations, turns, steering, stop/continue, observation and reviewed
memory management. Each command has a stable request identity. Retrying the same payload returns
the same accepted work; changing a payload under that identity fails. The shared service stores
its own organization mapping, immutable definitions, conversations, tasks and native receipts.
It does not create an Agents-product account, membership or subscription for the Agency user.

The managed client definition can create a text, Markdown or JSON file when the task calls for one.
Files appear with the task in chat or in the producing specialist's activity view and can be
downloaded by the same authorized staff member. Agency
rechecks the current workspace, staff role and client assignment, and the shared runtime checks the
task and its sources before returning file contents. The browser's download sends the selected
workspace, and Agency verifies the file length and digest across the signed chunks. Files belong to
the task; they are not Agency client records or uploaded attachments. Product file access depends on
private object storage being configured.

New managed definitions include the optional file-creation tool. At first setup after schema109,
an existing unchanged managed default is republished with that tool; an existing memory toggle is
preserved. Customized definitions and unpublished draft changes are not changed. The rollout marker
prevents a later deliberate tool removal from being undone. Work already admitted keeps its pinned
definition and tool versions.

On setup, an unchanged service-managed definition with the former 8,192-token input cap is
republished with automatic capacity from its selected model. The migration preserves the selected
model, memory setting, and current tool selection. Custom instructions, source or connected-tool
bindings, skills, and unpublished drafts keep their existing version and cap.

Every conversation and root context pins `client_id`. Client identity also appears in destination
binding authority, the explicit product mapping, source information audiences and memory namespace.
Client metadata reads filter `workspace_agents.tenant_client_id`; existing unassigned metadata is
not silently assigned to a client. An empty explicit allowlist returns no records, never all records.
Current client status, assignment, staff role and destination grant remain independent checks.

The visible client assistant rechecks readiness, the latest unpaged conversation list/history and
settled root/child observations every five seconds; active work updates every second. On the latest
pages, a settled task refreshes the list and history. While an older page is loading or visible,
settlement preserves that cursor snapshot; **Refresh conversations** or **Refresh history** starts
a new chain. Losing current authority clears cached messages, assignments, activity and
memory/model dialogs without requiring a reload. An access restoration shows content only after
fresh authorized reads. Background tabs do not run these intervals.

`POST /internal/agents/authority` checks originating-product access independently of the selected
tools. It uses the `product-execution-authority` audience and also works when no direct product
schema is selected. Model setup additionally requires the current `configure_model` authority.
Ordinary data reads keep the separate `product-capability-actions` audience.

Memory is initially disabled. The user can enable it through the shared Memory panel. Model
proposals remain suggestions until the user accepts the exact content. Correct and Forget use
record revisions and stable request keys. Memory is scoped to product, workspace, client, actor and
agent. It does not become a shared business fact. Disabling selection fences new runtime recall;
the user can still inspect, correct or forget existing records. Conversation-source retention and
already-transmitted provider data are separate from learned-memory suppression.
Accept and Correct preserve the reviewed assertion type and conflict classification through the
signed command and strict native memory store. Forget accepts only its record identity, expected
revision and action; it cannot change the assertion classification.

## Configuration

Configure private server environment values only. Never use `VITE_*` for these keys.

| Service | Setting | Purpose |
| --- | --- | --- |
| Agency API | `AGENTS_EXECUTION_URL` | Installed Agents API origin |
| Agency API | `AGENCY_AGENTS_ISSUER`, `AGENCY_IDENTITY_ISSUER` | Service and verified staff identity namespaces |
| Agency API | `AGENCY_AGENTS_PRIVATE_KEY`, `AGENCY_AGENTS_KEY_ID` | Execution ingress signing key |
| Agents API | `AGENCY_AGENTS_PUBLIC_KEYS_JSON` or `AGENCY_AGENTS_PUBLIC_KEY` | Matching trusted Agency ingress keys |
| Agents API/worker | `AGENCY_PRODUCT_API_URL` | Installed Agency API origin |
| Agents API/worker | `AGENTS_PRODUCT_ACTION_PRIVATE_KEY`, issuer/key-ID settings | Destination calls and origin revalidation |
| Agency API | `AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON` or `AGENTS_PRODUCT_ACTION_PUBLIC_KEY` | Matching worker trust |
| Agency API | `AGENCY_AGENTS_CONTROL_PRIVATE_KEY`, `AGENCY_AGENTS_CONTROL_KEY_ID` | Optional owner/admin model setup signer |
| Agents API | `AGENCY_AGENTS_CONTROL_PUBLIC_KEYS_JSON` | Separate control key set for model setup |

Issuer defaults are `https://agency.kasitek.co.za`, with staff identity issuer ending in
`/identity`; worker action issuer defaults to `https://agents.kasitek.co.za`. Development origins
must be loopback HTTP; production service URLs require HTTPS. Missing configuration remains
unavailable. Service signatures bind the full command digest, audience, short expiry and nonce.

A workspace owner/admin can use **Configure model** when control trust is installed. The server
uses the existing provider discovery and protected credential vault. It records only the request
digest and non-secret setup receipt outside credential custody. The selected profile applies to
new workspace requests. Accepted work keeps its pinned model route; current credential revocation
still fences physical requests. Model readiness checks the saved route, use grant and matching
credential, reporting revoked or missing credentials as unavailable. It does not probe the provider
or promise that a future model request will succeed.

## Verification and release

Focused metadata tests use actual Agency migrations and PostgreSQL in disposable schemas.
The shared `agency-product-runtime.test.ts` additionally drives an actual staff session through
Agency API and the full native Agents app, including its service-ingress Origin boundary, signed
admission, current metadata invocation, evidence, native operation
receipt and authorized observation. It covers duplicate payload identity, changed-input conflict,
same-name client isolation, staff model-setup denial, reviewed memory classification, assignment
revocation, and disabling a client setup after task acceptance while membership and assignment
remain active. The disabled setup blocks worker origin reauthorization and signed metadata egress
without revoking the mapping/grant or changing the accepted command receipt. The optional
`AGENTS_AGENCY_BROWSER=1` case uses an explicit built Agency artifact
(`AGENCY_BROWSER_ASSET_ROOT`), the real session/API/database path and controlled UI identity and
child observation. It verifies a mobile modal, memory review, terminal-output removal after actual
assignment revocation and restoration after fresh authorized reads. The inspection child is a
controlled DTO; this case does not prove real subagent admission or model behavior. Controlled model
discovery and explicit fixture settlement do not prove autonomous inference or Restate execution.
Real in-app/Restate acceptance is recorded separately on KAS-260; fixture success alone does not
establish model quality or hosted deployment.

Risk: high for the new identity/client boundaries. Affected services are Agency API/web and Agents
API/worker. The owned acceptance services use release ID
`shared-agents-runtime-upgrade-local-20261102`; no production release version has been assigned. Apply
the Agents schema sequence through `109_product_task_artifacts.sql` and Agency migration
`20261102181000_shared_agent_client_scope.sql` before the matching services. Client-scoped execution
starts at native schema102; reviewed assertion metadata requires105. The current shared worker
also requires the additive receipt and stop-decision tables in107–108 and the product artifact
ownership and rollout changes in109. New work uses the shared V15/V25 runtime; accepted earlier work retains its
pinned release. Do not apply setup to another product's database.

The focused setup-disable fence adds no schema migration, public command shape, environment key or
capability. Deploy the matching Agency API and Agents API/worker together; the existing setup flag
provides the disable and re-enable control. It reuses current command and capability logs and
analytics attribution. New analytics events, metrics, dashboards, alerts and Collector changes are
not applicable. No production release identity or rollout is assigned by this source change; the
local acceptance release ID above is not a production version. The focused integration fixture is
the validation path. A rollback to code without the fence restores the old in-flight authorization
behavior, so keep the fixed service pair installed when relying on a disabled setup as the fence.
There is no data rollback. Post-release review is not applicable until a release is separately
authorized.

The rollout is gated by service trust, explicit product setup, current staff/client authority and
model readiness. Memory remains opt-in. Existing task/operation analytics and product attribution
are reused; new customer business outcome event schemas are not applicable to this metadata
capability. Structured logs record command/operation, request/task, workspace/client, binding and
model connection IDs with bounded failures. Keys, prompts, model reasoning and record bodies are
excluded. Collector/exporter changes, new hosted dashboards and production alert qualification are
not applicable to this implementation.

Rollback disables ingress trust, sets the client setup disabled, or revokes the relevant destination
grant/tenant. It stops future access without deleting accepted task receipts or retrying unknown
effects. Revert frontend adapters with the shared package and rebuild each consumer. Keep additive
tables while accepted work depends on them. Production release version, hosted artifact identity,
production rollout and post-release review date are not applicable until separately authorized.


### Activity and continuation follow-up

This local UI change reuses existing signed commands, scoped observation cursors and server task
capabilities. It adds no schema, public command, agent definition, analytics event, logging pipeline
or release version. Deploy the rebuilt Agency web artifact; roll back by restoring its previous
artifact. Hosted rollout and backup configuration are outside this change. Verification uses the
existing signed Agency fixture with controlled browser activity/resume responses, not model inference.
