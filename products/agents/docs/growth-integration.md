# Configure Growth agent execution

Owner: Agents engineering. Last reviewed: 2026-11-03.

This setup connects Growth's Agents workspace and general assistant launcher to the shared
business worker. New managed defaults revision15 uses `AgentsBusinessRunV25` / `product-capabilities-v15`
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

Managed Growth agents publish capability revision15 with adapter release11. Declared Growth
record selectors are projected to opaque, conversation-scoped references before model use;
authorized tool inputs resolve those references before Growth rechecks the current actor and
resource access. Retained task history uses the same projection. The additive Agents schema132
stores the scoped references and should be applied before starting the updated API and worker.
On the next Growth request, the shared runtime upgrades existing Growth bindings to the current
reference publication while preserving custom settings, permissions and accepted in-flight work.

## Growth-managed customer channels

Facebook Page Messenger, Instagram messaging and WhatsApp use Growth as the only provider
credential owner. Start linking from an Agent's **Deploy** section. Growth authorizes the current
Growth organization, runs its existing Meta OAuth or WhatsApp Embedded Signup, presents eligible
accounts, and exchanges a short-lived one-use grant with Agents. The callback returns to the
selected Agent route; it does not send the user to the global Connections page. Agents stores the
selected asset ID, a revocable grant reference and the route binding. It never receives or stores
the provider access token and does not read Growth's database.

Growth signs the channel grant and relays signature-verified provider webhooks through its existing
`public_webhooks` worker and an idempotent outbox. Agents persists the normalized event through its
existing channel delivery path and Inbox. Agents creates the active deployment binding before
Growth transfers webhook ownership, so the receiving Inbox is ready when the first event arrives.
Growth keeps publishing and other Growth features when the Agent grant is revoked. One provider
asset can have one active Inbox owner. A grant marked
`needs_attention` continues to own inbound routing but cannot send; selecting the account again
rechecks permissions and refreshes the grant. Unknown provider send outcomes are retained as
unknown and are not retried automatically. Growth-managed replies use the same provider reply-window
policy as native channels while Growth remains the sole provider credential and send owner.

Configure the existing signed service connection in both directions. These values belong to the
API and worker processes, not either browser application:

| Service | Required values |
| --- | --- |
| Agents API and worker | `GROWTH_PRODUCT_API_URL`, `AGENTS_PRODUCT_ACTION_PRIVATE_KEY`, `AGENTS_PRODUCT_ACTION_ISSUER`, `AGENTS_PRODUCT_ACTION_KEY_ID`, and Growth verifier `GROWTH_AGENTS_PUBLIC_KEY`, `GROWTH_AGENTS_ISSUER`, `GROWTH_AGENTS_KEY_ID`, `GROWTH_IDENTITY_ISSUER`. |
| Growth API | `AGENTS_PRODUCT_ACTION_PUBLIC_KEY`, `AGENTS_PRODUCT_ACTION_ISSUER`, `AGENTS_PRODUCT_ACTION_KEY_ID`, `AGENTS_PRODUCT_API_URL`, `GROWTH_AGENTS_SIGNING_PRIVATE_KEY`, `GROWTH_AGENTS_ISSUER`, `GROWTH_AGENTS_KEY_ID`, and `GROWTH_IDENTITY_ISSUER`; set `GROWTH_AGENT_CHANNEL_LINKS_ENABLED=true` outside development/test to enable new links. |
| Growth worker | `AGENTS_PRODUCT_API_URL`, `GROWTH_AGENTS_SIGNING_PRIVATE_KEY`, `GROWTH_AGENTS_ISSUER`, `GROWTH_AGENTS_KEY_ID`, and `GROWTH_IDENTITY_ISSUER`. It uses the existing `public_webhooks` process; no separate channel service is added. |

The Growth API's public origin is `KASITEK_CORE_PUBLIC_URL`. Register these exact callback URLs
on the matching Meta app, using separate development and production apps:

```text
<Growth API origin>/api/social/oauth/meta/callback
<Growth API origin>/api/social/oauth/instagram/callback
```

Set Growth `AGENTS_FRONTEND_URL` to the Agents frontend origin so Growth can return the browser to
the chosen Agent. Growth API OAuth and Graph calls use `AUTH_META_APP_ID` and
`AUTH_META_APP_SECRET`. WhatsApp also needs the existing Meta app ID and
`WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` (or `META_EMBEDDED_SIGNUP_CONFIG_ID`). Register the existing
Growth webhook endpoints with Meta and WhatsApp; Growth verifies their signatures before routing:

```text
<Growth API origin>/api/webhooks/meta
<Growth API origin>/api/webhooks/whatsapp
```

Growth webhook verification uses `AUTH_META_APP_SECRET`; WhatsApp's webhook challenge also uses
`WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Direct Instagram Login is a separate authorization mode and
requires `AUTH_INSTAGRAM_APP_ID` and `AUTH_INSTAGRAM_APP_SECRET`; it uses the Instagram callback
above. Page-linked Instagram uses the Meta app and Meta callback. Keep each development callback
on the development app and each production callback on the production app.

Set Growth API `GROWTH_AGENT_CHANNEL_LINKS_ENABLED=true` to allow new Agent channel links in a
staging or production environment. It defaults on only for development/test and off for other
environments. Setting it to `false` blocks new link intents, provider authorization, account
selection and pending grant activation; existing grants continue to route and send until
individually revoked. Use the Agent's Disconnect action to return a selected asset's route to
Growth.

### Release record

Channel link and delivery monitoring uses bounded operational telemetry. Growth records
`growth.agent_channel.command.count` and `growth.agent_channel.command.duration_ms` with the fixed
operation, provider, outcome and grant/delivery state dimensions. Its
`growth.agent_channel.webhook_event.count` counter records queued, duplicate, delivered,
retry-scheduled and quarantined events by provider. Agents' existing
`agents.channels.connections`, `agents.channels.ingress` and `agents.channels.delivery` snapshots
cover grant health, Inbox admission and outbound state; connection snapshots now distinguish
`provider_health=ready|needs_attention|native`. No new central Analytics event is emitted: its
current connection-capability contract describes the Growth provider connection, not the separate
revocable Agents grant. Reusing it for grant revocation would report a false change to Growth's
provider permissions.

Structured request and worker logs record channel command and authorization outcomes, validated
webhook receipt and relay delivery, retries/quarantine, and Agents Inbox admission. They use
provider, operation, correlation ID, opaque grant/event IDs, bounded state/error code and duration
or attempt count.
They exclude provider asset IDs, customer identities, tokens and message contents. The existing
Growth OpenTelemetry SDK, OTLP environment and Collector profiles are reused. No Collector or
exporter configuration changes are part of this branch. Collector source revision:
`6de8838bce9710109dfab1c9d847a7bf24e1c8e1`; local signal export and hosted retention are not
verified by this implementation.

| Field | Decision |
| --- | --- |
| Change and owner | Growth-owned Facebook Page Messenger, Instagram messaging and WhatsApp connections in Agent Deploy; Growth and Agents engineering. |
| Risk | High: signed cross-product authorization, provider webhooks, outbound messages and additive database tables. |
| Affected services and surfaces | Growth API and `public_webhooks` worker; Agents API, worker and Agent Deploy UI; Inbox delivery. |
| Release identity | Planned platform release `0.6.0` (`platform-v0.6.0`); merge commit, service deployment IDs and artifact identities will be recorded after rollout. |
| API/schema changes | Versioned signed channel-link contract; Growth migration `20261105090000_growth_agent_channel_grants`; Agents schema `131_growth_managed_channels.sql`. |
| Rollout | Owner-authorized production release after local Facebook/Messenger acceptance. Apply the Growth migration and Agents schema before deploying their API/worker runtimes; deploy the Agents UI through its existing Vercel project. No production provider messages will be sent as part of rollout. Keep `GROWTH_AGENT_CHANNEL_LINKS_ENABLED` off until the production service configuration is verified, then enable it for customer use. Turning it off blocks new links; revoking an Agents grant returns that asset's route to Growth. |
| Analytics and success metrics | No central Analytics event is emitted because the registered Growth connection lifecycle contracts do not represent a separate Agents grant. Bounded OTel metrics include Growth `growth.agent_channel.command.count`, `growth.agent_channel.command.duration_ms` and `growth.agent_channel.webhook_event.count`; Agents `agents.connection.lifecycle.attempts`, `agents.connection.lifecycle.duration_ms` and snapshot gauges for `agents.channels.connections`, `agents.channels.ingress`, `agents.channels.delivery` and `agents.channels.oldest_pending_ms`. Success is an active grant with verified permission, one durable Inbox admission per provider event, and a factual provider send receipt; failures remain visible in bounded states. |
| Logs, metrics, dashboards and alerts | Structured events: `growth.agent_channel.command`, `growth.agent_channel.oauth_callback`, `growth.agent_channel.oauth.blocked`, `growth.agent_channel.oauth_failed`, `growth.agent_channel.webhook.received`, `growth.agent_channel.webhook.delivered`, `growth.agent_channel.webhook.quarantined`, `growth.agent_channel.delivery.quarantined`, `growth.agent_channel.delivery.retry.scheduled`, `growth.agent_channel.delivery.disabled`, and `agents.growth_channel.inbox.admission`. Fields include service/request context, provider, outcome/state, correlation ID, opaque grant/event ID, duration/attempt and bounded error code. Message bodies, tokens, external asset IDs and customer identities are excluded. Existing SDK, OTLP endpoint environment and Collector profiles are reused; Collector config source revision is `6de8838bce9710109dfab1c9d847a7bf24e1c8e1`. No dashboards or alerts were added. Local signal export and hosted Collector routing/retention remain unverified or unavailable. `OTEL_SDK_DISABLED=true` disables export while stdout request/worker logs remain. |
| Documentation | This integration guide, the Agents source boundary and the Growth feature map are updated. The Agent Channels UI identifies connection status and supported account actions; this release adds no separate public API surface. |
| Validation | On Node 24: Growth channel tests (9), Agents channel tests (9), Growth API build/typecheck, Agents API typecheck, Agents UI focused lint/build, Prisma validation and `pnpm verify:boundaries` passed. The owner confirmed the local Facebook Page Messenger inbound/reply journey works. Instagram and WhatsApp provider journeys have not received real-provider end-to-end acceptance. Production health and deployment IDs will be added after rollout; no production messages are part of validation. |
| Rollback | Revoke the selected Agents grant to return route ownership to Growth; stop the Growth relay and roll back compatible API/worker/UI artifacts together if needed. Keep additive tables while events or outbound receipts are pending. Growth provider connections, credentials and publishing remain active. Disable OTel export with `OTEL_SDK_DISABLED=true` or by removing the OTLP endpoint; structured stdout logs remain. |
| Post-release review | 13 November 2026: check connection failures, relay backlog/quarantine, send outcomes, provider permissions and Growth publishing; keep Instagram/WhatsApp provider acceptance explicitly open until owner-run development journeys pass. |

Apply the Growth channel-grants migration before the Growth API/worker and Agents API that use it.
The change is additive. To roll back, set `GROWTH_AGENT_CHANNEL_LINKS_ENABLED=false`, revoke each
Agents grant that should return to Growth, stop the Growth outbox relay if delivery must pause, and
roll back matching API/worker artifacts together. Keep the additive tables and columns; do not
remove grants while events or outbound receipts are pending. Growth-owned provider connections
and publishing remain intact. Resume by deploying compatible Growth and Agents artifacts, then
re-enable the existing public-webhook worker and the channel-link flag.

To rotate verifier keys, use `GROWTH_AGENTS_PUBLIC_KEYS_JSON` or
`AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON` with `kid` to public PEM entries. Keep an optional feature
configuration control key in `GROWTH_AGENTS_CONTROL_PUBLIC_KEYS_JSON`; its separate private key
never belongs to the Growth browser service. Restart matching services after configuration changes.

## Growth product assistant channels

Growth's own assistant is a product-owned business agent, not an organization assistant. Growth
selects it through an explicit target binding in the Agents workspace linked to the Growth
organization. There is one active `growth-assistant` per workspace; schema `151` enforces that
uniqueness. A caller never sends an Agents agent ID. Agents resolves the target from the workspace
and rejects a workspace without one.

Growth administrators do not need an Agents account or the Agents UI. The Growth API signs each
request with the existing product-service key. Agents verifies the signature and request digest,
then acts through one product-owned service principal per workspace
(`https://growth.kasitek.co.za/products/channel-admin`). The Growth user remains the audited actor
in Growth and in the request digest. Agents records the actor issuer and subject, operation,
workspace, connection and outcome in bounded logs without bot tokens or message contents.

`POST /internal/v1/products/growth/channels` carries the channel operations as a discriminated
contract:

| Operation | Effect |
| --- | --- |
| `telegram.connect` | Creates and verifies a bot through the existing `TelegramSetupService`. The token is encrypted in the Agents vault and never returned. |
| `telegram.health` | Rechecks provider identity and webhook ownership. |
| `telegram.rotate` | Replaces the bot token with the current connection revision. |
| `telegram.disconnect` | Removes the Agents webhook and revokes deployments for that connection. |
| `channel.list` | Returns Telegram connections and their deployments. |
| `assistant.target` | Returns the workspace's Growth assistant ID, or omits it when provisioning is incomplete. |
| `channel.bind` / `channel.unbind` | Binds or revokes a Telegram connection against the resolved Growth assistant. |
| `growth.link` / `growth.unlink` | Creates or removes a Growth-managed WhatsApp grant and deployment against the resolved Growth assistant. |

Every mutating request carries a UUID `requestId`. Agents stores the request digest and response in
`agents_platform.product_request_results`; an identical replay returns the stored response, a
reused ID with different input returns `409`, and a failed request releases the reservation. A
Telegram bot already connected to the workspace is rejected before setup so a retry cannot steal
its webhook.

Telegram credential setup lives in Growth → Connections. Link and unlink live in the Growth
assistant's Channels dialog. The dialog warns before linking that inbound messages stop appearing
in the Growth Inbox and move to the assistant. Owners and admins can manage channels; members can
view the same list without mutation controls. Unlinking Telegram revokes the Agents deployment and
restores the prior routing behaviour. Unlinking WhatsApp calls `growth.unlink`, which revokes the
Growth grant, deployment and connection, then marks the Growth grant revoked.

Growth projects each Telegram connection into its own `ExternalConnection` row with
`sourceType='TELEGRAM'`. The projection contains the Agents connection ID, bot ID and username,
setup and webhook state, and inbound/outbound capability checks. It never contains the bot token.
Growth removes a projection when Agents no longer lists the connection. The generic connection
editor omits Telegram because credential and routing controls live in the Telegram card and the
assistant dialog.

Set `AGENTS_CHANNEL_WEBHOOK_ORIGIN` on the Agents API to the public Agents origin, for example
`https://agents.kasitek.co.za`. Without it, Telegram setup is unavailable and returns
`CHANNEL_SETUP_NOT_CONFIGURED`. The existing `AGENTS_CONNECTION_KEYS` and
`AGENTS_CONNECTION_ACTIVE_KEY` vault configuration must also be present. Apply Agents schema `151`
before deploying the API that uses the request-result table.

Apply the change with the Agents API, workers and Growth API/web. To roll back, deploy the previous
Agents and Growth artifacts together; the additive table and offering constraint remain. Existing
Telegram connections continue to route through their Agents deployments. Remove a webhook with the
bot owner's token if a connection must be retired during rollback.

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
Defaults revision `11` includes its four presets, operation manifest, optional-capability policy and
the per-preset delegation graph. Agents persists this publication and validates it against the
installed adapter. The Assistant can use Research, Content and Campaigns; Content and Campaigns can
commission Research for focused evidence work. Research is a leaf. An operator can run
`upgrade-defaults` to queue the new managed revision. Repair preserves customised
configurations, disabled features, model selections and revoked tenants; accepted turns retain
their old configuration. An unsupported optional capability remains denied even if requested in
configuration. See [Product capabilities](product-capabilities.md) for the shared contract.

### Growth agent profiles

The managed agent record owns its display name and avatar. Provisioning selects an avatar from the
existing catalogue once when creating an agent. The Growth feature response returns the saved name
and avatar alongside the preset role and readiness. An owner or administrator can update both with
`PATCH /api/agents/features/:featureId/profile`. Growth checks manage access and forwards the signed
command; Agents rechecks current product authority and resolves the agent through the tenant's
managed feature mapping. The update changes profile fields only. It does not publish a configuration
version, change a role or permission, or replace accepted work.

Release decisions: standard risk; Growth web and API, the shared contract and Agents API are
affected. No database migration or feature flag is required. Existing request and command logging
applies; new analytics events, metrics, dashboards and alerts are not applicable. The Growth feature
map and this integration guide document the change. Release identity, focused validation and hosted
rollout evidence must be recorded with the deployment. Deploy compatible services together and verify
profile updates and existing agent execution. Rollback restores the previous web and API artifacts;
saved profile fields remain in the existing agent record. Post-release review remains pending.

### Growth defaults and content projection release record

Growth defaults revision `11` uses installed adapter release `6`; revisions `2`–`10` retain their
registered publication and adapter identities. This internal versioned publication adds a trusted
delegation policy and preserves the trusted model-only view for selected content reads. The policy
removes default depth, task-count and per-child token/time ceilings; current grants, ancestor limits,
the two-child concurrency setting, and each preset's product/tool authority still apply. It does not
change public HTTP schemas, product database schema, effect handling, or `AgentsBusinessRunV25` /
adapter release `6`. No Growth Analytics event or new structured log, metric, dashboard, or alert
is added; those release concerns are not applicable.
The shared model-result boundary applies the same safe view to retained revision `6`–`9` bindings
that already expose the canonical post read operations, despite their pinned adapter releases `3`–`5`.
Older accepted work keeps its permission and native receipt; only private fields in the model-facing
read result are removed.

Growth's internal shared-agent endpoint also builds `connections.list` and `content.accounts.list`
model views before applying the bounded transport format. It keeps the page/account name, platform,
status, permitted capabilities, usable selector and explicit continuation while omitting unrelated
provider metadata. A public platform account identifier is available in the typed account view so an
agent can answer an explicit Page ID question; ordinary recipient text still hides it unless the
current user asks for it. Internal connection, account selector, and execution identifiers remain
hidden. This projection applies to existing as well as current Growth agent publications; it does not
change grants, saved agent settings, native records or Growth's direct REST responses.
The signed URL returned by `content.media.preview` is excluded from model results for the same reason.

Release impact for these read projections: Growth API only; no database migration, configuration
revision, product analytics event or new structured log/metric. The serving Growth API release must
carry the projection for all active Growth agents. Verify with the focused connection projection test
and API build. If rolling back to code without these projections, pause the affected internal read
operations until projection-aware code is restored; do not resume raw results as a fallback.

Local verification covers the V10-to-V11 managed upgrade, recursive child configuration, publication
identity and content-read projection. No live model prompt was replayed. Hosted rollout is not
included. Deploy matching Agents and Growth APIs/workers together, then use the existing
managed-default upgrade for eligible organizations. For rollback, stop V11 upgrades, publish retained
revision `10` again, and run the managed-default upgrade for organizations already moved to V11.
Keep code that can read accepted V11 task configurations available until those tasks settle. No data
migration is required. Do not roll the Growth context reader or Agents model-result boundary
back to code that forwards selected-account or publish-job fields. If a code rollback removes those
projections, pause affected Growth agent admissions and canonical post-read tools until projection-aware
code is restored; preserve the product's ordinary post APIs and existing receipts.

Release record: risk is standard; Growth API/worker, Agents API and the four managed Growth feature
versions are affected. Publication revision changes from `10` to `11`; adapter release remains `6`,
and the Agents runtime release remains V25. No feature flag, analytics event, schema migration,
structured log, metric, dashboard or alert change applies. Rollout is the existing explicit
`upgrade-defaults` operation. Rollback uses retained publication `10` and the same managed upgrade;
accepted V11 task versions stay readable until terminal. Documentation is updated here and in the
Agents/Growth architecture and feature map. Focused test evidence is recorded with the implementation;
hosted rollout and post-release review are not performed in this local change.

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
