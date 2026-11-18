# Integration boundaries

Owner: Agents engineering. Last reviewed: 2026-11-04.

The shared execution service uses two technical execution kinds: `business` and `workspace`. Connections do not
create another agent category. Business execution uses Restate; the Lina workspace
adapter remains unavailable.

| Connection | Contract | Current boundary |
| --- | --- | --- |
| External agents to Growth or Agencies | Product-owned MCP with OAuth or scoped API keys. | Separate product work; no Agents gateway. |
| External assistants to standalone Agents | Agents-owned MCP with OAuth and organization-scoped grants. | Opt-in server; availability depends on the serving deployment configuration. |
| Product backends to Agents execution | Authenticated service with initiating identity and bounded authority. | Signed delegated-identity contract fixtures exist; production product integration and richer private resource contracts remain unavailable. |
| Customer channels to Agents | Verified channel binding, customer event identity, conversation ownership, and authorized automated or human replies. | Website/widget execution and shared Inbox controls are implemented. WhatsApp, Facebook and Instagram remain unavailable. |
| Business agents to external tools | Immutable selected native HTTP or MCP bindings, current connection/resource authority and durable receipts. | Restricted repository/Stash profiles, general remote MCP and imported native API operations implemented for operator runs. Customer service authority remains separate. |
| Business agents to report delivery | Exact report bytes, one human approval, one dispatch claim, status-only recovery. | ReportDeliveryHTTP with a verified persistent local receiver. |

Customer channels are separate from external-agent MCP access and outbound tool connections.
The standalone client targets support, FAQ, booking, and intake. Research and campaign experiences
belong in Growth or Agencies. The read/report adapters below are shared runtime capabilities;
they do not define the Agents client catalogue. General MCP onboarding supports anonymous servers, bearer or named keys and browser OAuth. The older restricted profiles retain their separate read contracts. Native API import supports static credentials; provider OAuth requires an implemented provider connector.

## Standalone Agents MCP server

Growth's existing MCP is the in-repository reference for the transport and authorization shape.
[`catalog.ts`](../../growth/api/src/operations/catalog.ts) reads operation definitions from the
shared Growth contracts catalogue. [`policy.ts`](../../growth/api/src/operations/policy.ts) filters
discovery and rechecks current scope, membership and entitlements. [`mcp.ts`](../../growth/api/src/operations/mcp.ts)
uses Streamable HTTP and invokes operations through that same policy; it records bounded
operation/outcome/duration metadata. [`routes.ts`](../../growth/api/src/operations/routes.ts) uses
the same operation executor for the authenticated HTTP interface. Agents follows those proven
patterns but keeps an Agents-owned operation list, identity, storage and customer-service
permissions. Growth's campaign/content permissions are not reused or proxied.
The Agents MCP transport is in [`server.ts`](../api/src/product/mcp/server.ts);
[`app.ts`](../api/src/composition/app.ts) composes its operation handlers from the product services. Agent create, read and save operations
share [`creation-operations.ts`](../api/src/product/agents/creation-operations.ts), which is also
used by the management API.
Creating an agent without a customer-service setup or explicit configuration starts a generic
agent with no assigned tools or retained memory. Both the management API and MCP `create_agent`
accept an optional purpose and instructions. MCP requires an operation ID for safe retries;
the management API accepts one. Capability assignment and publication still use the existing
configuration flow. Both entry points enforce the current workspace agent-management permission
and agent-count entitlement at creation; retries recheck permission without consuming another slot.
Member chat admission now uses the shared `platform/runs/member-admission.ts` operation. It pins
the current agent version and creates the execution grant in the same transaction as the run.
The MCP `start_agent_run` operation uses it for a signed-in workspace member and records the
originating OAuth connection with the run. `get_agent_run` returns that connection's run state,
public updates and result. Assigned tools use the ordinary runtime policy. MCP uses `runs:start`
and `runs:read` independently of agent-management scopes. Separate application credentials
still require implementation.
With `runs:control`, the originating connection can add instructions or cancel its run and child
work. The connection and selected-agent grant are checked again for these operations.
Consent for `runs:start` requires choosing workspace agents. The connection can start only those
agents, and the runtime rechecks the selection while work continues. A connection created before
agent selection has no runnable agents and must be reauthorized.
The operation ceiling used when issuing execution grants is shared under
`platform/access/grant-operations.ts`. The repository boundary check rejects imports from
`platform/` into Agents product or integration modules as those platform modules are migrated.
Agents adds revision-pinned signed-in reviews for setup changes, knowledge approval, and website
activation. The boundary follows the shared product architecture in
[`agent-platform-architecture.md`](./architecture/agent-platform-architecture.md).

When `AGENTS_MCP_ENABLED=true`, the standalone API exposes `/mcp` and OAuth discovery at
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. OAuth uses
authorization code with PKCE, account consent, an organization selection and revocable scoped
connections. Users can remove their own connections in Settings. MCP requests recheck membership;
long-running imports also retain their originating connection and recheck it before further work.
The shared runtime authority check also rechecks the originating MCP connection for a run and its
child work, in addition to the model-call checks.
An external request already sent to a provider cannot be recalled on revocation.

The server exposes agent setup, knowledge, supported capabilities, model selection, private preview,
widget appearance and website activation through the same product services as the app. It requests
signed-in review for permission expansion, source policy and website activation. A review is tied to
the proposed revision and a stale proposal cannot be approved.

`import_knowledge` imports UTF-8 text, Markdown, JSON or CSV as a private candidate. The content is
limited to 120 KB to leave room for JSON escaping inside the 256 KiB MCP request body. JSON and CSV
use the same normalization as the management API. The import returns the source, revision and
accepted generation; approval still requires `request_knowledge_review`. When document processing
is available the source is embedded for hybrid retrieval; otherwise it is admitted through the
inline text path and reports `lexical-v1`. PDF, HTML and larger files use the management API or web
Knowledge page. Private preview permits knowledge and
discovery only; connected actions, delegation and other effectful tools are unavailable there.
OAuth consent shows the client ID and callback host; the client-provided display name is unverified.
Authorization is rate-limited per socket peer and registered client, forwarded IP headers are not
trusted, CIMD client metadata is cached for ten minutes, and expired OAuth rows are removed in
bounded batches.

Set `AGENTS_MCP_ALLOWED_HOSTS` only to trusted upstream Host values when a frontend proxy rewrites
the Host header. `AGENTS_MCP_ALLOWED_ORIGINS` controls browser-origin MCP requests. Public URLs
must use HTTPS in production. The frontend proxy must route `/mcp`, `/oauth/*` and OAuth discovery
paths to the API, while `/app/mcp/*` remains a frontend route. Deploy schema migrations before
enabling the server. To roll back, disable MCP admission first and retain grants, review records,
and accepted tasks for recovery. A hosted deployment and real client compatibility must be verified
independently of the isolated API tests.

Focused integration coverage uses an MCP SDK client through the actual API composition for OAuth,
tool discovery, agent creation/configuration, private-preview admission and website activation review.
Restate preview completion is conditional on `AGENTS_TEST_RESTATE_BINARY`; hosted client compatibility
and serving rollout remain separate acceptance gates.

## Catalogues and custom connections

The agent Tools catalogue contains reviewed built-ins and integrations. The Skills catalogue contains
curated and private immutable packages. Custom MCP and API setup supplement those catalogues.
Connection entries stay distinct by account and connection ID. Adding a library item does not
change a published agent version.

Supported connector metadata comes from the validated records in
`api/src/adapters/providers/default-connectors.json`. Records define names, descriptions,
recommendations, authentication configuration, and trusted setup/action descriptors. The management
client reads `/api/organizations/:organizationId/connectors`; it does not hardcode the default
provider list. Calendar setup still uses its installed protocol-specific picker and policy form.
The loader accepts a validated configuration snapshot, but database-backed registry editing is not
implemented. A metadata record cannot import code or enable an uninstalled adapter.

Custom MCP setup starts at `remote-connections` with a URL. OAuth uses the pinned MCP SDK for
resource/issuer discovery, PKCE and client registration. An own client is optional and remains bound
to its exact issuer. Tokens, verifier and registration state are encrypted. Callback state is single use
and scoped to the signed-in owner. Refresh uses a database lease, runs outside database transactions,
and persists rotated tokens with compare-and-swap checks. A failed or abandoned refresh requires
reconnection. Replacing credentials increments the policy revision and invalidates prior bindings.
Verified provider account identity is not inferred from the endpoint or a successful sign-in.

Operator-owned OAuth registrations use `AGENTS_MCP_OAUTH_CLIENTS`, a bounded JSON array
of issuer-keyed records. Each record contains `issuer`, `clientIdEnvironment`, optional
`clientSecretEnvironment`, and `authMethod`. Values name separate environment variables;
literal client secrets are rejected. Selection follows the validated authorization issuer.
An explicit issuer-bound own client takes precedence. Otherwise the shared SDK selects a
configured registration, advertised CIMD, or compatible DCR. `AGENTS_MCP_CLIENT_METADATA_URL`
must refer to an approved public HTTPS client document for live CIMD. Controlled CIMD tests
do not establish public document hosting or live provider acceptance.

Interrupted authorization reuses only its same-owner, connection-generation and issuer-bound
registration. A new attempt always gets fresh state and verifier. An actual provider
`insufficient_scope` challenge can request a bounded scope union. The owner explicitly
reauthorizes through the existing connection flow; a model cannot supply authentication scopes.
Denied or narrower consent preserves the current grant. Successful step-up changes policy and
requires reviewed tool selection. Interrupted or scope-rejected operations are never resent
automatically. Each subsequent physical request rechecks token expiry and current authority.


Discovery creates an immutable candidate catalog. Selection pins compatible operation schemas,
original names, aliases, exact endpoint and adapter identity. Refresh does not broaden an existing
agent version. The general adapter supports MCP 2026-07-28, 2025-11-25 and explicit deprecated
HTTP+SSE compatibility. Unsupported schemas have per-operation diagnostics. The connection picker
separates tools, resources, templates and prompts. Each selection creates an immutable scoped binding.
Resource reads pin an exact URI; template selection pins owner-entered scalar values and the
URI expanded by the SDK. Runtime arguments cannot choose another URI. The supported template
subset uses simple named scalar substitutions; reserved expansion operators are unavailable.
Resource URIs remain opaque arguments to `resources/read` on the selected server. The adapter
does not fetch HTTPS resource URIs or open file URIs locally. Returned resource contents must
match the selected URI; directory results with other URIs require a separate scope contract.

Each prompt activation requires exact single-use approval of its name and arguments. Prompts
cannot use the owner-attested read shortcut. Returned roles and typed content remain external
tool-result data and private receipt bytes; they never become system messages, conversation roles
or installed skills. Approval labels show the prompt name or selected resource URI. Observations
retain the actual `resources/read` or `prompts/get` method and descriptor digest.
Tasks, subscriptions, sampling, roots, elicitation and MCP Apps are not declared client capabilities.

General tool calls retain typed content, structured output and complete bounded private result bytes.
The model receives a bounded projection and content-block diagnostics. Returned links never cause
an unrestricted fetch. The metadata-only descriptor cache has at most 16 category/authority entries, 8 MiB total, and 2 MiB
per index. Indexes expire within 30 seconds, or sooner when the server declares a shorter TTL.
The partition binds organization, account, connection credential/policy revision and generation,
task principal, version/resource, selected bindings, endpoint, transport/protocol, executable
adapter release, hashed credentials and operation category. Cache entries never supply current execution authority.

Each call still negotiates capabilities, validates pinned input/output schemas, and rechecks the
grant, connection, and exact review before physical send. An index can remain stale within its
bounded TTL. Expiry or a capability change relists tools; incompatible drift refuses the immutable
binding instead of adopting a replacement. Explicit discovery bypasses the cache and invalidates
its local partition. A persisted refresh changes revision identity so other workers cannot reuse
an old partition. The 2025 protocol uses the 30-second application policy when TTL is absent;
2026 zero-TTL indexes are uncached, and missing required TTL is rejected by the SDK.
Persistent push/subscription change notifications remain unsupported.

Native API setup previews bounded OpenAPI 3.0/3.1 JSON or YAML, or an authored structured request.
The advanced editor accepts a path, method, authentication, and primitive path/query/header/body
fields without manual JSON. Nested complex schemas use OpenAPI import. It requires one explicit server URL and an explicit selection when authentication alternatives differ.
Unsupported external references, combined security and schemas have diagnostics. None, bearer,
named header/query keys and Basic credentials are supported. Import and connectivity checks never
execute an arbitrary write. Imported OAuth operations remain unavailable until a provider/client is
configured through its provider connector.

The grounded-conversation program permits explicitly selected connections for operator chat without
enabling delegation, personal memory or sandbox access. Website deployment still rejects personal
connection bindings until an explicit customer service policy applies.

General MCP and API effects default to exact review, including HTTP GET and tools with a read-only
hint. An owner may explicitly attest a read policy. The model cannot choose credentials, destination
or policy. An exact review binds the immutable binding and arguments; its durable human wait holds
no provider execution slot. Approval is consumed at the physical effect admission. Unknown write
outcomes retain any response body, become uncertain and are not blindly resent. Completed receipts
replay before live adapter or credential lookup. Generic imports do not establish business-specific
idempotency or reconciliation guarantees.

The fresh runtime is `AgentsBusinessRunV15` / `modular-programs-v5`. Fresh schema 028–038 adds
connection authorization, packaged skills, exact tool reviews and API operation snapshots. Existing
owner databases and running local services are not upgraded by verification fixtures. Use the normal
fresh setup command for an isolated environment. Disable new connection/binding admission before
rolling back code; retain operation receipts and supported runtime releases for in-flight recovery.
Production deployment, hosted telemetry retention and a live Google OAuth application remain
separate acceptance steps. Native calendar bookings use a separate customer service policy. The standalone
Booking creation offering remains unavailable; customer-service configuration can enable appointments.

## Connection observability

Connection management emits metadata-only `connection.lifecycle` JSON logs and OTLP
spans for connect, authorization/callback, discovery, refresh, reconnect, credential
rotation, selection, probes and disconnect. Credential freshness checks have a separate
`credential_check` label. Each record has a trace ID, fixed provider/flow/outcome labels
and elapsed time. Authorized rows already read by the operation supply connection,
organization, policy revision and authorization generation when available. Unknown
identifiers are omitted; control-plane flows do not fabricate agent or task identities.
Provider URLs, credentials, scopes, callback parameters, provider bodies and customer
text are excluded. SDK OAuth error responses are normalized before SDK warning paths.

Control-plane logs and spans are best effort, separate from durable task observations.
Telemetry performs no additional database lookup, does not await exporters and cannot
turn settled provider work into a retry. Control-span export permits at most 64 pending
requests with the existing three-second exporter timeout. Hosted delivery and retention
remain deployment concerns. Runtime connected-tool task observations retain the existing
agent/version/task/operation lineage and add the actual resolved authorization generation.
Explicit provider duration survives projection while the parent operation is still active.

`agents.connection.lifecycle.attempts` and `.duration_ms` measure lifecycle attempts, not
business effects. Their labels are limited to fixed provider, flow, outcome and failure
classes. `agents.connected.provider.attempts` and `.latency_p95_ms` derive from persisted
physical-attempt receipts over the last hour, grouped by provider, setup/read phase and
response/failure outcome. Snapshot metrics are replica-scoped and must not be summed
across replicas. Connection IDs and tenant IDs are never metric labels.

Focused evidence is in [connection-telemetry.test.ts](../api/test/connection-telemetry.test.ts),
[telemetry.test.ts](../api/test/telemetry.test.ts),
[remote-connections.test.ts](../api/test/remote-connections.test.ts),
[generic-connected-runtime.test.ts](../api/test/generic-connected-runtime.test.ts) and
[native-api-executor.test.ts](../api/test/native-api-executor.test.ts).

## Native business providers

The reviewed JSON registry supplies provider identity, fixed endpoints, scopes, supported actions
and installed-handler references. The registry cannot install executable code or grant an agent
permission. Native OAuth is separate from MCP discovery and custom OpenAPI import.

| Provider | Server variables | Registered callback on `AGENTS_PUBLIC_URL` | Supported actions |
| --- | --- | --- | --- |
| Google Calendar | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_CALLBACK_URL` | `/api/google-calendar/callback` | Selected-calendar availability and confirmed bookings |
| Microsoft 365 Calendar | `MICROSOFT_CALENDAR_CLIENT_ID`, `MICROSOFT_CALENDAR_CLIENT_SECRET`, `MICROSOFT_CALENDAR_CALLBACK_URL` | `/api/providers/microsoft-calendar/callback` | Selected-calendar availability and confirmed bookings through Graph v1.0 |
| HubSpot Contacts | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_CALLBACK_URL` | `/api/providers/hubspot/callback` | Staff exact-email lookup and confirmed contact intake through API version 2026-09 |

All require `AGENTS_CONNECTION_KEYS` and `AGENTS_CONNECTION_ACTIVE_KEY`. Production callbacks
require HTTPS. Missing or invalid server configuration reports the provider unavailable. Fresh
schema setup is required for this source revision; setup refuses an existing database with a
different schema checksum. Do not initialize or replace an owner's existing database to test it.

### Account lifecycle

Owners select actions before consent. Scope step-up requires explicit reauthorization. Google and
Microsoft use OIDC authorization code with S256 PKCE, nonce, issuer and audience validation.
Microsoft validates tenant-specific issuers through the official discovery metadata and records
`tid:sub` as identity. Google requires a verified email and stable subject. HubSpot's native
confidential-client code flow uses one-use state and token introspection to verify client, Hub ID
and scopes. Its native OAuth guide does not specify PKCE; MCP OAuth is a separate protocol.

Connections start private. Encrypted one-use attempts bind browser account, organization, provider,
generation, exact requested scopes and a validated agent return path. Refresh leases serialize
refresh across API instances. An abandoned or identity-changing refresh requires reconnect.
Reauthorization clears resource selections, bindings and service sharing. Changes to execution
configuration fence existing credentials and callbacks; display edits do not broaden access.
Disconnect cuts off local authority. Removing the external application's consent is a separate
provider-account action.

### Calendar booking authority

Owners select a writable calendar, a time zone and explicit customer-service sharing. A policy pins provider,
owner, connection policy revision, calendar, title, duration, notice, advance window and opening
hours. The saved agent configuration uses `calendar-booking-v1`. Calendar selection alone grants
neither customer access nor booking authority. Each policy pins availability-only access or availability
plus booking. Read-only policies expose no reserve tool and cannot admit a booking effect. The
standalone Booking creation offering remains
unavailable.

`booking.availability` combines provider busy checks with local reservations. Microsoft uses
`calendarView` for the selected calendar, rather than mailbox-wide `getSchedule`. Its selected
calendar time zone is explicit because Graph's calendar resource does not supply that setting.
`booking.reserve` waits for exact principal confirmation, then rechecks membership, current grants,
conflicts, channel ownership and deadline. Google uses a deterministic event ID. Microsoft uses
`transactionId` and a pinned intent marker. Lost acknowledgements remain uncertain; reconciliation
performs reads without another create. Provider event IDs and tokens stay out of customer cards.

The website widget supports appointment confirmation and status recovery. Staff can inspect and
reconcile appointments but cannot approve for a customer. Other messaging transports retain their
existing booking-confirmation limitations; connecting a channel does not establish a booking UX.

### HubSpot contact authority

The two actions use explicit email and optional first/last name fields. Search returns only ID,
email and those names. No arbitrary properties, updates, deletion, bulk export or other CRM objects
are supported. HubSpot's OAuth grant covers account contacts, so staff lookup never becomes
customer lookup merely because the account is connected.

Staff can select lookup and intake. Customer deployments allow only `contacts.create`, explicit
organization-service sharing and an exact customer confirmation. A customer agent containing a
lookup binding must remove that binding before deployment. Sharing renews bindings at the current
policy revision; previously published bindings remain fenced. Each effect rechecks membership,
connection, sharing, deployment, selected action and ownership. Customers receive only the intake
outcome, including when a matching contact already exists. Existing contact names and IDs remain
private. The website widget shows exact Confirm/Decline cards. WhatsApp, Telegram, Facebook and
Instagram send native confirmation buttons with the exact submitted fields. Verified callbacks
must match the sender, thread, deployment, accepted prompt and current ownership. Expired prompts
and staff takeover prevent approval. An unknown provider outcome requests Inbox handoff while
automated ownership remains current.

Creation first searches the exact email. A matching record completes intake without mutation.
Otherwise the adapter sends one create and verifies the receipt. HubSpot search is eventually
consistent and offers no create idempotency key. Timeout recovery performs a read-only exact-email
lookup. An unresolved result stays uncertain and never authorizes a second create. A contact found
later proves existence, not which request created it.

### Verification and owner acceptance

OAuth, connection lifecycle, adapter, runtime and widget tests use signed local identities,
isolated PostgreSQL databases and controlled HTTP providers. They cover scope step-up, explicit
resource selection, secret redaction, revocation, exact confirmation, receipt replay and uncertain
outcomes. These checks do not certify live app registration, consent or production readiness.
The owner runs live provider acceptance and purpose-specific model evaluations. Evaluation uses
the existing external Harbor adapter and authoritative provider receipts; no separate agent loop
is introduced for these providers.

## Skill packages

SKILL.md and ZIP uploads, plus explicit public GitHub commit/path imports, preserve a complete
immutable package digest and reviewed file inventory. Repository imports verify Git object hashes
and reject mutable references. Private repositories are unavailable through this importer.
Private and repository imports do not enable a skill on an agent. Curated Add explicitly installs
and selects a reviewed revision in the unsaved configuration. Save changes applies the selection. Neither path executes scripts. Internal snapshots pin reviewed
revisions. Context initially exposes package metadata, then `skills.activate` and `skills.read` load
bounded exact files. Activation and file receipts survive compaction and worker continuation.
Files that exceed a complete-read limit are rejected rather than silently truncated.

Installation state supports enable, disable and terminal removal. Current authority checks lock those
states and recheck required connection policy, grant operations and runtime. Optional
`metadata.kasitek.requirements` is bounded JSON with `connectionProfiles`, `permissions` and
`runtimes`; it never grants capabilities. A skill family separates publishers and repository paths.
One reviewed revision per family can be selected; updates and rollback change a draft only after
explicit selection. Import and review remain inert. A selected, activated package can run an exact
reviewed Python entry through `skills.run` when the version separately enables `sandbox.analyze`
and holds the required sandbox and artifact grants. Script reads are optional. The existing
`python-analysis-v1` runtime stages the complete package read-only, supports reviewed bundled
helpers, and runs the selected entry with no network, environment credentials or dependency installs.
Entries are limited to 16 KiB; all package files and artifact inputs share the 32-file/4 MiB limit.
The admitted operation retains its original deadline and budgets. Immutable execution records and
artifact dependencies pin package/script digests. Current installation authority fences guest launch
and dependent artifact access. Existing finalization and the independent reaper own cleanup.
Other script languages and unavailable runtimes fail explicitly.

## Public repository reads

The `public-repository-read-v1` profile requires no external credential. It combines
anonymous GitHub REST reads with DeepWiki MCP at `https://mcp.deepwiki.com/mcp`.
The owner selects exact public repositories and refs. A connection retains local
ownership, policy generation and a finite authorization window; its credential
revision has a SQL NULL envelope. No Authorization header is sent to either service.
Key replacement is unavailable for this profile.

Native reads use the same commit/file handles as the keyed GitHub profile. DeepWiki
permits only `read_wiki_structure` and `read_wiki_contents` for an approved repository.
The model cannot send a question, URL or private context to DeepWiki. A native
public-repository check consumes one physical read before each MCP invocation.
DeepWiki documentation is a timestamped provider observation, not a snapshot of the
Git commit. Missing indexes, oversized responses and tool errors remain explicit;
the adapter does not request indexing or follow returned links.

## Private Stash reads

The `stash-read-v1` profile connects to `https://api.stash.kasitek.co.za/mcp` using
an encrypted Stash agent key. The owner selects exact note or idea IDs. Stash keys
have account-wide authority, so Agents independently limits each binding and
specialist to selected items. Only `get_item` and `read_project_document` are allowed;
there are no search, write, summary-generation or original-file tools in this profile.
The second tool requires a project document.

A finite connection expiry is an Agents authorization window. It does not assert
that a manual Stash key has a provider expiry. Key replacement and revocation use
the existing connection controls. Outgoing arguments contain only the approved
item ID and bounded offset. Private item identifiers use the
`approved_resource_identifiers` disclosure policy.

The executor reads Stash's inline JSON text envelope, verifies the item ID, kind,
revision and document chunk metadata, and records a bounded text passage and
citation. It excludes unrelated item metadata from model context. A changed item
revision within one root yields an explicit conflict; a fresh task can read the new
revision. UTF-16 offsets cannot turn split surrogate pairs into replacement text
in stored evidence. Stash REST cookies and the chat connector's credentials are
not reused by the worker.

## MCP compatibility

The isolated SDK supports MCP 2026-07-28 and the explicit 2025-11-25 negotiation
path. Schemas retain their original digests. The restricted schema subset accepts
2020-12 and compatible draft-07 schemas, UUID format and the boolean-true
`x-fastmcp-wrap-result` annotation used by DeepWiki. Arbitrary patterns, other
formats, nested dialect changes and unknown extensions remain denied.
Local fixtures and public-service probes have separate evidence. Stash worker
acceptance requires an explicitly supplied read key; using Stash in the chat does
not establish acceptance through Agents. GitHub's authenticated MCP endpoint is an
optional integration check, not a prerequisite for public MCP execution.

### Verification matrix

The current general adapter release is `remote-mcp-v1-sdk2.3.1-content1`, using
`@modelcontextprotocol/client@2.3.1`. Native API execution uses `native-api-v2`.
The matrix records controlled fixture results separately from live provider evidence.
An unsupported or untested combination is not a passed compatibility case.

| Combination | Evidence | Verified boundary or remaining gap |
| --- | --- | --- |
| MCP 2026-07-28 and 2025-11-25 over Streamable HTTP | Fixture: [remote-mcp.test.ts](../api/test/remote-mcp.test.ts), 34 passing cases, plus eight [content cases](../api/test/remote-mcp-content.test.ts). | Version negotiation, bounded pagination, isolated schema validation, cancellation, exact resource/prompt RPCs and physical request limits. |
| Deprecated HTTP+SSE | Fixture: [remote-mcp.test.ts](../api/test/remote-mcp.test.ts). | Explicit SSE and opt-in fallback pass; cross-origin message endpoints and authentication-triggered fallback are refused. |
| Anonymous, bearer and named-key MCP | Fixture: [remote-connections.test.ts](../api/test/remote-connections.test.ts), [generic-connected-runtime.test.ts](../api/test/generic-connected-runtime.test.ts). | Scoped encrypted custody, selected bindings, published execution and current-authority checks. This does not establish every public server's compatibility. |
| OAuth discovery, DCR and own client | Fixture: [remote-auth.test.ts](../api/test/remote-auth.test.ts), [remote-connections.test.ts](../api/test/remote-connections.test.ts). | Actual controlled HTTP token exchange, S256 PKCE, issuer binding, registration reuse, callback replay/cancellation, persisted resume and rotating-token refresh. |
| Metadata-selected pre-registration, CIMD and permission step-up | Fixture: 14 [auth cases](../api/test/remote-auth.test.ts), six [durable connection cases](../api/test/remote-connections.test.ts), and [generic runtime cases](../api/test/generic-connected-runtime.test.ts). | Validated issuer selects configured clients before advertised CIMD or DCR. Tests cover issuer-bound own clients, registration reuse after lost callbacks, denied/narrower scope consent, policy invalidation after step-up and redaction of hostile error/token responses before SDK logging. CIMD tests prove SDK selection and controlled code exchange; public document hosting and live provider fetching remain unverified. |
| Catalog schemas, results and cache partitions | Fixture: [remote-mcp.test.ts](../api/test/remote-mcp.test.ts), [generic-connected-runtime.test.ts](../api/test/generic-connected-runtime.test.ts). | Per-tool diagnostics, structured/media blocks, malformed output, secret reflection, immutable drift and organization/account/credential/policy/generation/authority partition tests pass. Metadata can remain stale within its declared maximum 30-second TTL. |
| Scoped resources, fixed template instances and explicit prompt activation | Fixture: [remote-mcp-content.test.ts](../api/test/remote-mcp-content.test.ts), [generic-connected-runtime.test.ts](../api/test/generic-connected-runtime.test.ts). | Both protocol versions preserve typed content and external prompt roles. Exact URI handles, fixed template expansion, per-activation approval, capability refusal, category cache/zero-TTL behavior, descriptor drift and foreign returned-URI denial pass. No direct URI fetching, prompt role promotion or implicit skill installation. |
| Persistent change notifications, tasks, sampling, roots, elicitation and MCP Apps | Unsupported. | These client capabilities are not declared. Persistent catalog push is unavailable; TTL and explicit refresh provide revalidation. Operations requiring unavailable capabilities are refused. |
| Public no-auth DeepWiki | Current-release live probe: `.audit/public-mcp-current-release-20261020.json`, checked 2026-10-20T18:33:24.104Z, endpoint `https://mcp.deepwiki.com/mcp`, protocol 2025-11-25. | `remote-mcp-v1-sdk2.3.1-content1` discovered three compatible tools and executed `read_wiki_structure` for `facebook/react` without authentication; the result was 7,763 bytes. This proves current-release public tool execution, not live resource/prompt RPCs, OAuth or a complete tenant browser journey. |
| Approved live OAuth and keyed/API providers | Not verified. | No complete current-release live matrix is recorded. A chat connector's credentials do not establish Agents provider acceptance. |
| OpenAPI 3.0/3.1 with none, bearer, Basic and header/query keys | Fixture: [openapi-import.test.ts](../api/test/openapi-import.test.ts), [api-connections.test.ts](../api/test/api-connections.test.ts), [native-api.test.ts](../api/test/native-api.test.ts), [native-api-executor.test.ts](../api/test/native-api-executor.test.ts). | Bounded import, safe references, fixed request compilation, encrypted credentials, selected published execution and private response bytes. Explicit GET read policies support bounded cursor pagination and optional retries for HTTP 429/502/503/504. JSON Pointer projection narrows model-visible fields; complete pages remain private receipts. The default and reviewed writes perform one physical request. See response-policy acceptance below. |
| Native provider lifecycle and effects | [provider-oauth.test.ts](../api/test/provider-oauth.test.ts), [native-provider-connections.test.ts](../api/test/native-provider-connections.test.ts), [native-provider-runtime.test.ts](../api/test/native-provider-runtime.test.ts), [microsoft-calendar.test.ts](../api/test/microsoft-calendar.test.ts), [hubspot-contacts.test.ts](../api/test/hubspot-contacts.test.ts), [channel-tool-reviews.test.ts](../api/test/channel-tool-reviews.test.ts) and existing Google/booking tests. | Signed OIDC/token-introspection fixtures, selected-account/action isolation, exact customer confirmation, receipt replay, uncertainty and takeover fences. Live account consent and provider acceptance remain owner-run. |
| Portable instruction and multi-file skills | Fixture: [skill-packages.test.ts](../api/test/skill-packages.test.ts), [skill-repository.test.ts](../api/test/skill-repository.test.ts), [skill-package-store.test.ts](../api/test/skill-package-store.test.ts). | Immutable package bytes, hostile archive/refusal cases, review, requirements and scoped activation. [skill-script-runtime.test.ts](../api/test/skill-script-runtime.test.ts) and [platform-business.test.ts](../api/test/platform-business.test.ts) verify exact reviewed Python execution through published tools and real gVisor, bundled helpers/resources, no mandatory script read, current withdrawal fences and cleanup. Other languages remain unavailable. |
| Imported API plus reviewed skill through normal agent execution | External controlled Harbor trial: `.audit/harbor-eefdc68d-68f6-4cec-8ffb-873e41aca258/acceptance.json`; [fixture support](../api/test/harbor-connector-support.ts). | FAQ policy-read trial passed with authoritative provider checks. It records `mutationsVerified: false`; it is neither live provider consent nor booking-write acceptance. |
| Browser connection execution and recovery | Controlled API/provider/Restate: [catalogue-execution-live.spec.ts](../web/test/catalogue-execution-live.spec.ts), five journeys passed, including seven successful approved provider invocations with seven completed private receipts. Mock transport: [remote-connections.spec.ts](../web/test/remote-connections.spec.ts), [api-connections.spec.ts](../web/test/api-connections.spec.ts), [google-calendar.spec.ts](../web/test/google-calendar.spec.ts). | Actual MCP publication/review/execution/reconnect/revoke, native credential expiry/repair, full-page OAuth cancellation/one-use callbacks across tabs, exact-revision skill repair, and selected resource/template/prompt execution have controlled browser evidence. The expired native credential also produces an additional denied request and an uncertain operation. The flow does not depend on a popup. These are not live-provider consent or fresh-user usability results. |

The current wire snapshot passed 42 cases: 34 general MCP cases and eight content
cases, including escaped credential-reflection refusal over HTTP and SSE. The G2
producer suites passed 20 generic runtime, 14 OAuth and six durable connection cases.
The later G9 PostgreSQL snapshot passed 55 cases across generic/native execution and
MCP/API/Google connection management; subsequent focused checks verify committed
callback/disconnect generations, revoked refresh outcomes and receipt metric grouping.
These counts identify controlled tested snapshots, not untested live-provider combinations.

This matrix records the remaining live-provider and recovery gaps; it does not
mark every compatibility checklist item complete. Local verification and disable
evidence remain separate from production deployment and live-provider acceptance.

## Outbound GitHub reads

A connection belongs to an organization and account. The owner supplies an expiring
read-only PAT and explicit public repositories/revisions. AES-256-GCM protects the
credential with an external keyring. The server chooses endpoints and headers;
model arguments cannot supply credentials, paths, refs, URLs or arbitrary queries.

Native REST supports metadata, releases, immutable commit resolution, bounded tree
listing and text-file reads. Issued revision/file/release handles bind the task's
root, connection policy and approved resource. Related content reads use the same
resolved commit SHA. Observations carry acquisition time and response digests.
Native `list_tree` accepts an optional exact `filePath` filter over the validated
tree. Native `read_file` accepts `maxBytes` from 128 to 4,096, defaulting to 4,096.
Both controls apply locally after the bounded provider read; neither changes the
remote URL, authorization or immutable file verification. Smaller visible spans
retain exact citation hashes and valid UTF-8 boundaries.

The isolated outbound adapter uses `@modelcontextprotocol/client@2.3.1`. It requests
MCP 2026-07-28 and explicitly supports the 2025-11-25 HTTP negotiation path. Only
selected trusted GitHub read operations are available. Provider read-only headers
and tool filters supplement local validation. Sampling, roots, elicitation, stdio,
subscriptions, arbitrary remote writes and resource-link traversal are denied.
For `get_file_contents`, the executor reads the returned inline text resource.
It requires the accepted repository, commit and file path in the resource URI,
then verifies the UTF-8 byte count and Git blob digest against the issued file
handle. Status messages do not count as file evidence. Binary, linked, missing
or mismatched bodies fail explicitly; the executor does not fetch resource URIs.

Discovery creates an immutable candidate catalog. Selecting operations and
publishing a new AgentVersion are separate owner actions. Remote hints do not
grant permission. Catalog/schema changes never expand an existing version.
MCP tree/file tools require explicitly selected native tools that issue their
immutable handles. Missing dependencies fail publication.

Every HTTP send waits for durable physical-attempt admission. Native reads allow
three physical requests; MCP allows up to four setup messages and three read
attempts, with seven total wire messages and one 30-second logical deadline.
A separate public metadata check consumes one read allowance when needed.
Responses are bounded to 2 MiB native, 256 KiB MCP and 8 KiB model observations.
Larger permitted response bodies remain private. Completed receipts replay before
adapter lookup; an abandoned started send stays uncertain and is not repeated.
An immutable native claim bounds a live read by its original operation, binding and task
deadline. Concurrent callers receive `CONNECTED_READ_IN_PROGRESS` without adopting the claim.
Expired or orphaned claims become uncertain and never authorize another provider request.
Physical-attempt admission and final publication check the exact token and database deadline.
The executor holds no database transaction or session-lock connection during provider waits.
The model receives exact source text, citations, acquisition time and provenance.
Its view omits internal receipt IDs and digests, and omits duplicate structured
handles only when the same named IDs occur in that text. Complete durable receipts
and their byte limits remain unchanged.

Anonymous access still has provider quotas. HTTP 429 and quota-confirmed 403
responses yield `RATE_LIMIT`; 401 and other 403 responses yield `AUTHENTICATION`.
Retries respect both declared reset and Retry-After times within the original
attempt and deadline limits. An exhausted quota without safe retry timing fails
immediately. The public profile retains its GitHub publicness check even when
that shared anonymous quota prevents a DeepWiki read.

Executable digests bind the actual adapter files. API and worker must use the same
execution mode and artifacts: both compiled for acceptance and production, or both
TypeScript during development. Publishing in one mode and running in another fails
closed until a compatible binding is selected and published.

Local HTTP/SDK fixtures verify these contracts. They do not prove an account can
use GitHub's hosted MCP endpoint. Live acceptance requires an approved expiring
read-only token and records the actual protocol, tool names and schema hashes.
OAuth, private repository access, generic search and arbitrary provider writes
remain unavailable.

See the [platform architecture](architecture/agent-platform-architecture.md),
[implementation boundary](source-boundary.md) and [setup](../README.md).

## API response policies

The advanced request editor exposes Response handling. Builders can select up to sixteen
JSON Pointer output fields, a declared string query cursor and a maximum page count.
OpenAPI imports use the same `x-kasitek-response` operation extension. Response policy
is part of the immutable request template and import digest, not model arguments.

Automatic pagination and retry require GET and the owner's explicit Allow reads without
individual approval selection. They share one original operation deadline and a maximum
of eight physical requests. Every physical request rechecks current authority and records
its outcome. Cursor values are encoded into the fixed approved query parameter; returned
URLs never become fetch destinations. Repeated cursors fail. A page limit returns a
continuation cursor and `complete: false` instead of claiming the result is complete.

Retries apply only to opted-in reads on 429, 502, 503 and 504, at most three attempts per
page. The adapter honors Retry-After only within the configured delay and original
deadline; otherwise it returns the provider error without retrying early. Transport
uncertainty and writes are never automatically repeated. Projection excludes unselected
fields from model output while each accepted page is captured privately after credential checks and before projection. Decoded JSON keys and values are checked so Unicode escapes cannot bypass credential reflection protection.
Invalid UTF-8 is preserved as exact base64 bytes before a protocol error is returned.

Acceptance: [native-response-policy.test.ts](../api/test/native-response-policy.test.ts)
covers actual controlled HTTP requests, projection, pagination, backoff, deadlines and
revocation; [native-api-executor.test.ts](../api/test/native-api-executor.test.ts) covers
published grants, each physical receipt and replay without a second send;
[api-connections.spec.ts](../web/test/api-connections.spec.ts) covers the structured editor
and explicit read selection at 1440, 768 and 390 pixels using a mocked API transport.
These checks do not establish a real provider's pagination or mutation semantics.
