# Kasitek Agents

Owner: Agents engineering. Last reviewed: 2026-10-23.

The standalone product creates customer-service agents with configurable question answering, support,
appointments and native enquiries for websites and messaging channels, with a shared staff inbox. Research
and campaign experiences belong in Growth or Agencies using the shared execution backend.
The website/widget path includes a shared staff Inbox, assignment, human replies, takeover and
explicit return to automation. Google and Microsoft Calendar appointments use explicit organization service access, a pinned booking policy, and
exact customer confirmation. Configured messaging adapters share the same Inbox. Live provider
acceptance remains owner-run. See the
[product and inbox contracts](docs/architecture/agent-platform-architecture.md#standalone-agents-product).

The standalone application creates customer agents with approved knowledge, simple chat, website
publication and Inbox support. The shared harness also implements reviewed memory, pinned skills,
bounded specialist tasks, optional isolated analysis and reviewed report workflows for developer
and product contract fixtures. Skills expose scoped connection repair with explicit tool adoption;
compatible tool-directed versions can open a contextual Analysis control. Grounded customer versions
cannot enable analysis or silently switch programs. These capabilities do not define new standalone offerings.
Restate workflow `AgentsBusinessRunV21` and harness `product-capabilities-v11` coordinate durable execution.
The technical kinds remain `business` and `workspace`; workspace
execution is unavailable until its separate Lina adapter is implemented.

The [architecture](docs/architecture/agent-platform-architecture.md) defines the target.
The [implementation boundary](docs/source-boundary.md) records current behavior and limits.
Growth embeds the shared business harness through a signed product contract. Its general assistant,
Research, Content and WhatsApp Campaigns features use Growth-owned permissions and records.
[Configure the Growth integration](docs/growth-integration.md) separately from standalone Agents.
Agencies integration remains future work. Neither integration is required to run Agents.

Live provider acceptance is owned by the project owner. Optional native-provider and MCP
OAuth settings are listed in [api/.env.example](api/.env.example); keep credentials in the private
`api/.env`. Follow [connection setup](docs/mcp-integration.md) to connect accounts, select agent
access, publish a version and test it. Controlled acceptance results do not certify live providers.

## Model selection

Connect a provider account in **Settings > Model providers**, refresh its models,
and choose an organization default. New agents use that default. A key in the
server environment does not create a workspace connection or authorize agent use.

Use the model picker in chat to select a connected account and model. The selection
saves the agent configuration in the background and applies to new messages,
including connected customer channels. Changes affecting those channels or model
access require confirmation. In-progress work keeps its accepted route. Unsaved
Configure edits must be saved or discarded before switching from chat.

**Configure > Model** exposes the same selection and advanced limits. The displayed
input budget is separate from the model's advertised context window. Admission
checks model capacity, saved limits, grants and shared execution policy; changing
only the form does not grant additional authority. There is no silent model or
account fallback.

## Start locally

Use Node 24 and the repository's pnpm workspace. Install dependencies from the root:

```sh
pnpm install
```

Configure [local identity](../../infra/identity/README.md). Its Keycloak 26.6.0
registration includes the separate `agents` client. Copy `api/.env.example` to
`api/.env`, set independent local secrets, and use the matching Agents client secret.
Keep that file private. Use `http://localhost:3100` consistently for the browser.

Provision a fresh, dedicated PostgreSQL 17 database with pgvector 0.8.7 and set `AGENTS_DATABASE_URL`.
The setup command rejects a database containing other application tables. It does
not migrate or delete an existing product database.

The verified local database image is
`pgvector/pgvector@sha256:cd4ccfdaf62cbfeb5c6ee19ef0dd663406d4ed740c320b324d016a90e85385b3`,
which contains PostgreSQL 17.11 and pgvector 0.8.7. Schema setup requires permission to create
the `vector` extension in this dedicated database.

For document imports, configure private S3-compatible storage, prepare the isolated document
runtime, and set `AGENTS_DOCUMENT_RUNTIME_ENABLED=1`:

```sh
bash infra/agents-runtime/document-prepare.sh
```

This setup downloads pinned public runtime/model artifacts. Import processing and embeddings
run without guest network access. From `products/agents/api`, run the independent cleanup
processes alongside the worker:

```sh
pnpm dev:document-reaper
pnpm dev:source-object-reaper
```

The document reaper needs the Agents database and runtime, and the source-object reaper needs
the database and private storage. Storage outages do not stop physical resource cleanup.

Start Restate from the repository root:

```sh
docker compose -f infra/agents-runtime/compose.yaml up -d
```

The worker defaults to loopback. For the private Docker bridge above, set these
values in your local `api/.env` so Restate can reach it:

```dotenv
RESTATE_WORKER_HOST=0.0.0.0
AGENTS_ALLOW_UNSIGNED_WORKER=1
```

Restrict that development listener with host network controls. Production requires
`RESTATE_REQUEST_IDENTITY_KEYS` even when the unsigned development override is set.
Use the cluster's `publickeyv1_` keys and keep the worker private. The
[environment example](api/.env.example) lists these settings.

From `products/agents/api`, initialize the schema, then run the API and worker in
separate terminals. Each command loads the local environment file:

```sh
node --env-file-if-exists=.env --import tsx src/composition/setup.ts
node --env-file-if-exists=.env --import tsx --watch src/composition/server.ts
node --env-file-if-exists=.env --import tsx --watch src/composition/worker.ts
```

After the worker starts on port 9080, register its HTTP/2 endpoint with Restate.
Run this local registration from the repository root:

```sh
curl --fail-with-body -X POST http://127.0.0.1:19070/deployments \
  -H 'Content-Type: application/json' \
  -d '{"uri":"http://host.docker.internal:9080","use_http_11":false,"force":false}'
```

Start the management app from the repository root:

```sh
pnpm dev:agents
```

Open `http://localhost:3100`. The web server proxies `/api` to port 4100.
API diagnostics are `http://127.0.0.1:4100/health` and `/ready`.
Connect a provider in **Settings > Model providers** before using agent chat.
The API and worker use encrypted workspace credentials, not an environment-key fallback.

Private storage is required for knowledge, connected evidence and isolated analysis. Conversations without those capabilities can run without it. Configure all five `AGENTS_S3_*` settings
from the environment example and provision a private S3-compatible bucket.
Without them, artifact storage remains unavailable. Context snapshots and memory
revisions remain in private PostgreSQL records.

## Enable local analysis

The analysis profile requires Linux x86_64, user namespaces, a working systemd user
manager with delegated CPU/memory/process controls, and the pinned gVisor runtime.
Prepare and verify the local backend from the repository root:

```sh
bash infra/agents-runtime/prepare-sandbox.sh
bash infra/agents-runtime/verify-sandbox.sh
```

Configure private S3 storage and set `AGENTS_SANDBOX_ENABLED=1` in the local API
`.env`. From `products/agents/api`, run the independent cleanup process alongside
the worker:

```sh
pnpm dev:sandbox-reaper
```

The reaper shares the private allocation directory with the worker. Generated code
receives no credentials or network. Select the analysis capability in an immutable
agent version. Missing storage or a missing backend blocks analysis admission.
This runtime is temporary compute; it does not create a persistent workspace.

A coordinator can pin at most two permitted business specialist versions with
explicit source/tool subsets and child allocations. Specialists have no inherited
personal memory, sandbox or delegation permission. Parent and children share the
original root budget.

## Reviewed reports and automation

This setup verifies shared runtime capabilities. It does not add research or campaign offerings
to the standalone client. Those customer experiences belong in Growth or Agencies.

Configure the connection keyring and destination allowlist in `api/.env` using
`api/.env.example`. Keys contain 32 random bytes encoded as base64; keep them
outside Git and PostgreSQL. Every destination names one HTTPS `/deliveries`
endpoint and resource. Loopback HTTP is restricted to local development.

Create a scoped connection in **Connections**, enable **Report delivery** on an
agent, select its connection and artifact name, and publish an immutable version.
**Automations** binds that version to a one-shot UTC time, fixed UTC interval, or
authenticated event. Each occurrence has its own task and exact human report
review. Automation authorization is finite and does not preapprove any delivery.

The first adapter implements ReportDeliveryHTTP, with a persistent acceptance
receiver for local verification. It does not configure a third-party provider,
OAuth or external MCP connection. See the [implementation boundary](docs/source-boundary.md#connected-reports-and-automation)
for policy, expiry and uncertainty behavior.

## Platform interface

This section describes the current management interface. Shared Inbox and guided customer-service
creation are implemented. Runtime research/report fixtures do not define the Agents
client catalogue.

The public root restores the landing page. Sign in and Get started use the configured
identity provider; registration requires email verification. A signed, transaction-bound
return destination preserves internal application links through login.

The workspace sidebar contains Agents, Inbox, Customers, Tasks, Knowledge, Connections,
Automations and Settings. Creation exposes one customer-service offering with selectable
responsibilities.
The conditional appointment step binds an authorized Google or Microsoft calendar policy.
Every runnable business agent opens Chat,
with Activity and Configure tabs.
Customer configuration exposes instructions, approved knowledge/revision pins, a curated Tools
catalogue and a Skills library with reviewed KasiTek procedures, private SKILL.md/ZIP imports,
and public GitHub packages pinned to an exact commit and package path.
Installing a skill preserves its complete immutable package. Add the selected skill
and use Save changes to apply it. Owner review checks the exact package digest before execution. Website
publication permits enabled, reviewed server-curated instruction packages. Private or repository
skills and generic personal connection bindings remain unavailable to website visitors.
Owners can compare skill revisions and explicitly select an update or rollback within the same
publisher/source family. Disable and removal retain immutable history. Import never runs scripts.
Tool-directed versions can explicitly enable the existing isolated analysis capability to run reviewed
Python package entries through `skills_run` after activation. Script source reads are optional.
The package remains read-only, with bundled helpers and resources, no network, no credentials and
no dependency installation. Other languages remain unavailable. Execution receipts and generated
artifacts retain exact package/script digests and current withdrawal checks.
See [approved package execution](docs/source-boundary.md#customer-agent-configuration) for limits.
Connections includes custom MCP discovery/selection, native OpenAPI import, and shared Google,
Microsoft Calendar and HubSpot setup. Tools opens optional appointment setup without changing the agent program. Connect saves an
unsaved draft before navigation and preserves input if saving fails.
Rich harness configurations use developer/product fixtures. In the ordinary client,
Save changes validates the configuration and creates its immutable execution snapshot
in one transaction. No numbered-version action or selector is required. The collapsed
Configuration history control can load an earlier configuration into the editor;
Save changes applies it as a new snapshot after current permissions are validated.

New chat turns use the latest saved configuration, including in existing conversations.
Accepted turns retain their own settings. Retry recovers the original task and snapshot,
even if a save happened after its submission. Permission reductions revoke affected old
grants immediately. Changes expanding permissions or affecting live customer channels
require confirmation. Invalid channel configurations roll back the entire save. Website
URLs, visitor sessions, Inbox ownership and history remain stable.

Connection setup can persist an incomplete draft while authorization is in progress.
Save changes applies the completed configuration. Product and evaluation contracts
retain explicit snapshot IDs. Existing scheduled workflows retain their separately
authorized configuration; creating a new schedule uses the latest saved configuration.

Conversation history comes from authorized server records and survives cleared
browser storage. New chat starts a separate conversation; unresolved admission must
be retried with its original request key first. Ordinary navigation does not cancel
accepted work. The initial composer accepts text, with Enter to send and Shift+Enter
for a new line. File imports remain in Knowledge.

Tasks lists authorized root work and links to its conversation or report review.
Inline progress, sources, files and exact report decisions use the same task APIs as
the standalone task page. Refresh conversation, window focus and visibility return
revalidate history against current policy. Older messages and events load in bounded
pages. Settings exposes actual account/workspace identity and persisted appearance.

Desktop uses separate navigation, agent/history and chat panes. Tablet collapses
global navigation; mobile exposes accessible navigation/history drawers and keeps the
composer within the viewport.


## Connect business providers

Google Calendar, Microsoft 365 Calendar and HubSpot Contacts use the same owner-managed
connection flow. Configure each provider's registered OAuth client and callback, plus the
encrypted connection keyring. Missing configuration keeps that provider unavailable. See
[native business providers](docs/mcp-integration.md#native-business-providers) for exact variables,
permissions, supported actions and recovery rules.

In **Connections**, choose an account and actions. Calendar connections require a writable
calendar and explicit customer-service sharing before a calendar policy can be selected in
agent settings. Choose availability only or also allow bookings. Google and Microsoft use the
same booking workflow and exact confirmation for writes.

HubSpot supports exact-email lookup for staff and confirmed contact intake. An owner must
explicitly allow customer intake and add only the intake action to a customer-deployed agent.
Website cards and messaging buttons collect exact customer confirmation. Customer agents cannot
look up contact records. Customer responses contain an intake outcome,
not the provider contact ID or existing private record fields.

Focused checks use signed OAuth fixtures, isolated databases and controlled provider servers.
Live account registration, consent, reconnect acceptance and model evaluations remain owner-run.

## Customer channels

In **Connections → Customer channels**, connect an account, choose its asset and bind an
existing saved agent. WhatsApp defaults to embedded signup; manual token setup is advanced.
Telegram checks the bot and asks before replacing an existing webhook. Facebook and Instagram
use explicit account selection. One agent can serve several authorized channels.

The operator configures the existing credential vault and a reachable HTTPS callback origin
in `AGENTS_CHANNEL_WEBHOOK_ORIGIN`. Meta profiles are private server records in
`AGENTS_META_CHANNEL_PROFILES`, validated by `metaSetupProfileSchema`. Supply the reviewed app
ID/secret, verification secret, API version, scopes and subscribed fields. WhatsApp also needs
its embedded configuration ID. OAuth redirect URI is the application origin followed by
`/app/connections`. Never put app secrets in browser configuration or commit environment files.
The catalogue shows setup unavailable when these prerequisites are absent.

| Channel | Customer input | Staff output | Important boundary |
| --- | --- | --- | --- |
| Website | Text and existing booking decisions | Text | Origin/session checks; optional files/speech are unavailable. |
| WhatsApp | Text/captions; private media references | Text, supported received-media replies, approved text templates | Standard24h window; out-of-window templates require recorded opt-in and current approval. |
| Telegram | Text/captions, media, rejected unsupported callbacks | Text and supported received-media replies | Bot/chat identity; acceptance does not prove delivery/read. |
| Messenger | Text, attachments, native receipts | Text and supported received-media replies | Standard reply window; no inferred human-policy exemption. |
| Instagram | DMs, attachments, available native receipts | Text and received image/audio/video replies through approved CDN URLs | Direct and Page-linked modes stay distinct; documents/reusable IDs are unsupported. |

Media-only inputs request staff assistance; no transcription or image understanding is implied.
Staff downloads use authenticated, bounded private routes. Replying with an attachment reuses an
authorized attachment already received in that conversation. New arbitrary file uploads, media
templates/buttons and out-of-window human-agent tags are not implemented. Direct-Instagram
refresh is disabled unless the operator explicitly reviews and enables its profile.

Inbox supports assignment, takeover, human reply, resolution and explicit return. Ownership and
credential checks apply immediately before dispatch. An unknown delivery is never automatically
resent: the assigned human can review it and continue later messages while retaining uncertainty.
A failed multipart send suppresses its remaining parts. Check connection health after permission
or subscription loss. Setup uncertainty requires explicit native-state reconciliation; elapsed
time alone never proves success. Quarantined ingress is visible in connection details and can be
retried deliberately after correcting the displayed failure. Repeated ingress retains its identity.

### Support waiting and staff alerts

An accepted handoff creates a durable waiting episode and a native Inbox alert for each currently
authorized workspace member. Evaluation conversations alert only their trial owner. Alert reads
and acknowledgement require current membership and the original recipient. Acknowledgement
records the staff action; it does not establish that a customer received a reply.

The worker registers `AgentsSupportWaitingV1` with Restate and dispatches the PostgreSQL waiting
outbox. Product defaults permit customer waiting notices after 5 and 15 minutes and staff reminders
after 10 and 30 minutes. Each kind is limited to two stages. These thresholds are reminder policy,
not a promised response time. After downtime, one notice covers the latest elapsed stage. Configured
support hours defer updates to the next opening in the published timezone; missing hours remain
unknown. The initial handoff alert is immediate regardless of hours.

Assignment, takeover and unassignment preserve the waiting episode. An actual human reply,
resolution, return to automation, a superseding handoff, channel revocation or removal of the
published human-support capability stops later waiting work. Customer notices use a separate
receipt and current ownership generation. They do not grant the agent ordinary replying or business
tool authority during human ownership. Provider delivery applies the existing connection,
messaging-window and permission checks; a canonical notice is not proof of provider delivery.

Native alerts use `GET /api/organizations/:organizationId/inbox-alerts` and
`POST /api/organizations/:organizationId/inbox-alerts/:alertId/acknowledge`. They do not send staff
email, push notifications or third-party messages. Waiting failures use the structured
`support_waiting_publisher_error` event and `SUPPORT_WAITING_DISPATCH_FAILED` code without message
bodies. Inspect `support_waiting` dispatch/completion records and `support_waiting_notices` receipt
states before retrying. Apply schema084 before starting the worker, and refresh its Restate
deployment registration to include the new workflow. To stop future effects, remove Human support
from the published agent configuration or pause its channel. Keep accepted receipts and unknown
provider deliveries for reconciliation; never resend an unknown effect during rollback.

Website settings provide install/share links, pause and **Customize widget**. The recovered Growth
appearance editor includes a live preview, custom colour, title/greeting/avatar, position, window
and launcher dimensions, corner radius, screen offset, suggested messages and branding visibility.
The same editor is available in Configure → Website. The embedded widget retains current Agents
sessions, canonical Inbox messages and confirmed booking/intake flows. Pause
stops new grants and publication; resuming preserves the URL and conversation identity. Saved
agent settings create background snapshots and apply to future turns. Existing accepted tasks
retain their own configuration and executable release.

Schemas through072 require the current matching schema digest and worker
`product-capabilities-v11` / `AgentsBusinessRunV21`. The preceding product worker was
`growth-products-v10` / `AgentsBusinessRunV20`. Fresh setup uses the normal command below;
starting the app never silently upgrades an existing database. The explicit setup command accepts
only recognized preceding schema digests for its additive upgrade. Stop new admissions before an
operator-controlled local schema application. Retain old executable releases for any
accepted work; do not replay an old journal through the new worker. To disable a channel,
disconnect its binding and remove only owned provider subscriptions. Already accepted or unknown
provider effects are retained and cannot be undone by local rollback.

Channel metrics use the existing OTLP configuration: `agents.channels.connections`,
`agents.channels.ingress`, `agents.channels.delivery` and `agents.channels.oldest_pending_ms`.
Labels contain bounded channel/state values. Private receipt IDs correlate with canonical task,
message and delivery records; message bodies, provider locators and secrets are excluded from
telemetry. No hosted collector, dashboard, retention change or production-scale qualification is
claimed by this local implementation.

The owner runs evaluation and live account acceptance. Use the existing
[Harbor adapter instructions](evaluation-adapters/harbor/README.md#isolated-messaging-trials)
and its five channel case manifests. Receipt fixtures cover accepted, rejected and lost-ACK
transport; setup/reconnect and staff-driven cases have separate stated prerequisites. Existing
purpose-specific graders still judge knowledge, handoff and booking outcomes. No evaluation or
live-provider result is implied by installed fixtures or deterministic engineering checks.

## Verify

From the repository root:

```sh
pnpm build:shared
pnpm --dir products/agents/api typecheck
pnpm --dir products/agents/api test
pnpm --dir products/agents/api test:runtime
pnpm verify:boundaries
```

The UI CI suite builds the interface and runs the existing public entry, chat and
model-provider browser tests with controlled API responses:

```sh
pnpm --filter @kasitek/agent-platform build
pnpm --filter @kasitek/agent-platform exec playwright install --with-deps chromium
pnpm --filter @kasitek/agent-platform test:ci
```

It starts its own preview server on port 3199. It does not call model providers,
run agent evaluations or verify live backend execution. Browser failure traces
and screenshots are uploaded by CI. The Agents source job uses the pinned
PostgreSQL/pgvector image documented above so fresh schema creation can install
the required `vector` extension.

PostgreSQL integration suites require `AGENTS_TEST_DATABASE_URL` pointing to a
separate disposable test server with permission to create databases. They create
and drop uniquely named test databases. The business suite also starts its own
Restate container and uses deterministic provider responses. These checks do not
prove a real model reply or the complete browser journey.

Verify real private storage and memory against disposable PostgreSQL and MinIO:

```sh
bash infra/agents-runtime/verify-storage.sh
```

For the live harness browser journey, leave ordinary local services running. The
fixture starts its own UI, API, worker and Restate on available ports. Set
`AGENTS_BROWSER_FIXTURE_DATABASE_URL` in your shell to a disposable PostgreSQL
administrator connection. From `products/agents/api`, run:

```sh
AGENTS_HARNESS_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file-if-exists=.env --import tsx test/browser-fixture.ts
```

This uses the approved free-model key from the local environment. It creates its
own database, UI, API, worker, Restate and browser session, and
cleans its owned resources. It verifies reviewed memory, a pinned skill,
contextual follow-up, a new conversation, and a real `memory.search` operation.
Run the complete delegation/analysis journey with the same disposable database,
free-model prerequisites, using `AGENTS_ADVANCED_LIVE=1` in place of
`AGENTS_HARNESS_LIVE=1`. It starts owned MinIO storage and a separate reaper,
checks two real specialist tasks, and verifies a downloaded analysis report.

For scheduled report review and delivery, build the API first, then run:

```sh
pnpm --filter @kasitek/agents build
AGENTS_AUTOMATION_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file-if-exists=.env --import tsx test/browser-fixture.ts
```

Use the same disposable PostgreSQL prerequisite. This mode
starts a compiled worker, private Restate instance, MinIO, gVisor, and a separate
authenticated receiver. It restarts the worker while review is pending, then
interrupts the sender after the receiver has persisted the approved report. It
checks the original artifact, two specialist tasks, one delivery POST, and receipt
recovery through a real status request. The receiver never contacts real people.
The runtime cache and MinIO binary prerequisites are the same as the advanced
journey (`AGENTS_TEST_MINIO_BINARY` can select the local MinIO executable).

Identity is seeded for these fixtures. Real OIDC is checked separately:

```sh
bash infra/agents-runtime/verify-identity.sh
```

[Runtime setup and recovery limits](../../infra/agents-runtime/README.md) cover
pinned versions, worker signatures, duplicate delivery, cancellation, storage, and
retention. Local checks do not establish production deployment readiness.

## Verify connected knowledge

The ordinary backend suite uses explicit protocol/model/storage fixtures where
noted. It never turns on paid provider calls:

```sh
pnpm --filter @kasitek/agents exec vitest run --maxWorkers=1
```

Actual document, local embedding, PostgreSQL/pgvector, private MinIO and compiled
worker checks are opt-in. In `api/`, load your approved local configuration and
point `AGENTS_TEST_DATABASE_URL` at an owned disposable-database-capable server:

```sh
AGENTS_INGESTION_LIVE=1 AGENTS_INGESTION_FREE_MODEL=1 \
  node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run \
  test/platform-ingestion-live.test.ts --maxWorkers=1
```

The fixture expects private MinIO at port 19000 with the explicit test credentials
in its source. It creates and deletes its own bucket/database/Restate/worker. It
checks PDF tail evidence, private candidates, duplicate admission, worker SIGKILL
recovery and a real free-model website FAQ. No external connector is mocked into
that free-model proof. `AGENTS_INGESTION_BROWSER=1` additionally requires the local
Vite fixture on port 3113 and drives import, preview, approval and withdrawal.

The optional keyed GitHub check requires a separately approved fine-grained read-only PAT
in `AGENTS_GITHUB_ACCEPTANCE_TOKEN` and its actual finite ISO expiry in
`AGENTS_GITHUB_ACCEPTANCE_EXPIRES_AT`. It reads the default approved public
`github/github-mcp-server` repository; the test header lists explicit overrides.
Never put the token in a command argument or chat. From `api/`:

```sh
AGENTS_GITHUB_LIVE=1 node --env-file-if-exists=.env \
  node_modules/vitest/vitest.mjs run test/github-live-acceptance.test.ts --maxWorkers=1
```

That check uses fixed official native/hosted-MCP endpoints, records negotiated
protocol/schema hashes and has no model calls. A skipped check is not provider
acceptance. The scheduled knowledge journey has passed with the free model, two
specialists, gVisor analysis, exact report review and delivery recovery across two
worker restarts. Public repository acceptance uses anonymous native GitHub and DeepWiki MCP reads;
it requires no provider key. Keyed GitHub and Stash acceptance are separate opt-in checks.

The combined provider journey is a separate opt-in path. It requires the same
approved GitHub configuration, `OPENROUTER_API_KEY`, an owned fixture database in
`AGENTS_BROWSER_FIXTURE_DATABASE_URL`, the prepared gVisor/document runtimes and
private MinIO fixture. Build the API first; the fixture starts its own UI. From the
repository root:

```sh
AGENTS_GITHUB_JOURNEY=1 AGENTS_AUTOMATION_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file=products/agents/api/.env \
  --import ./products/agents/api/node_modules/tsx/dist/loader.mjs \
  products/agents/api/test/browser-fixture.ts
```

This mode uses matching compiled API/worker adapters. It combines imported source
revisions with native and official hosted-MCP reads in two specialists, then
checks isolated analysis, a dated report with explicit gaps, factual quotes, exact
citations, review and delivery recovery. Expected public text must fit a
16–200 character quote from the actual file. The fixture also
checks a worker restart after completed connected reads. The provider mode stops
before resource allocation when its approved credential or expiry is missing.
Preparing this path does not establish live-provider acceptance; that proof remains
pending until the configured journey exits successfully against GitHub.


For the public repository journey, build the API and
provide an owned disposable PostgreSQL fixture through
`AGENTS_BROWSER_FIXTURE_STATE_PATH` or `AGENTS_BROWSER_FIXTURE_DATABASE_URL`. The
prepared document and analysis runtimes and local MinIO binary are required. From
the repository root:

```sh
AGENTS_PUBLIC_REPOSITORY_JOURNEY=1 AGENTS_AUTOMATION_LIVE=1 AGENTS_BROWSER_REAL_MODEL=1 \
  node --env-file=products/agents/api/.env \
  --import ./products/agents/api/node_modules/tsx/dist/loader.mjs \
  products/agents/api/test/browser-fixture.ts
```

The default approved public repository is `modelcontextprotocol/typescript-sdk`, ref `main`, file
`README.md`. The native specialist reads an issued immutable file handle. The MCP
specialist reads its DeepWiki documentation structure. Each has a distinct imported
source and tool scope. The coordinator has no direct connected tools; its explicit
specialist selections supply the aggregate grant and version pins. The fixture
verifies exact evidence quotes, a dated report
with explicit gaps, isolated analysis, completed-read replay after restart and
reviewed delivery recovery. It uses the approved free model and no provider token.

For private Stash acceptance, use `AGENTS_STASH_JOURNEY=1` with the same automation
and model flags. Supply `STASH_AGENT_KEY`, the explicitly approved project note or
idea ID in `AGENTS_STASH_ACCEPTANCE_ITEM_ID`, and an exact first-passage quote in
`AGENTS_STASH_ACCEPTANCE_EXPECT`. The two specialists use `get_item` and
`read_project_document` respectively. Stash credentials stay in protected local
configuration, never command arguments, model context or browser state.

## Local website crawler

The optional Firecrawl provider has a pinned local stack in
[`infra/firecrawl/`](../../infra/firecrawl/README.md). Its server-side adapter supports local
Firecrawl and Firecrawl Cloud through the same v2 scrape, crawl, status and cancellation calls.

Configure the Agents API's private `.env` with:

```dotenv
AGENTS_FIRECRAWL_URL=http://127.0.0.1:3002
AGENTS_FIRECRAWL_API_KEY=
AGENTS_FIRECRAWL_TIMEOUT_MS=60000
```

Run `pnpm --filter @kasitek/agents verify:firecrawl` from the repository root to verify a
Markdown scrape of `https://example.com`. The command prints a character count, not the page
body or credential. It does not invoke a model. An optional URL argument changes the target.

To use Cloud, change `AGENTS_FIRECRAWL_URL` to `https://api.firecrawl.dev` and set
`AGENTS_FIRECRAWL_API_KEY` to a private Cloud key. The same command and adapter apply; Cloud
requests use the account's credits. There is no automatic fallback between providers. Drain outstanding crawl jobs before switching;
job identifiers and stored results belong to the original instance. The transport accepts at most
10 MiB of JSON per response, matching the existing raw-source byte budget. Crawl page count and
depth are explicit caller options, not subscription limits imposed by this adapter.

Agent creation now uses guided customer-service setup: business, responsibilities, conditional
knowledge, channels, operating preferences and review/test. Website import appears when answering
questions or handling support is selected. Existing eligible agents expose the same import flow
under Configure → General → Import website. Enter a domain, wait for the crawl, select pages and
review their content, then import the selection. The existing isolated document pipeline prepares
a private candidate. Review it and choose **Approve and use** to attach it to the agent. Enable
**Allow use in public website replies** when the source may be used by website visitors.

Closing the dialog retains the draft and crawl. Reopen Import website to resume. Crawl progress
and cancellation survive API restarts. Uncertain external submissions fail explicitly; they are
not automatically repeated. The existing exact-URL importer remains separately available.
Automatic scheduled refresh is not implemented.


Guided setup saves progress after each forward step and resumes from **Continue setup** in Configure.
Selecting enquiries exposes a native submission tool with the chosen fields. The customer confirms
exact details before a durable record is saved. Submitted enquiries appear in Inbox conversation
details. A CRM connection is not required; external export and Growth synchronization are deferred.

The Appointments step reuses service-calendar authorization and structured booking policies.
Selecting a policy configures actual booking tools. A responsibility checkbox alone never shares
an account, confirms an appointment or activates a channel. After testing, the Agent setup panel
opens each selected channel with the agent preselected. Website setup carries the business domain
into the existing widget editor and install-code flow. Messaging authorization preserves the
agent and return path. The panel reports current readiness, private knowledge restrictions,
connections needing attention and paused deployments.

Local schema setup applies supported additive schemas076–079 through the existing explicit
`pnpm --filter @kasitek/agents setup:db` command. Restart API and business worker afterwards.
Keep the configured database/environment for each service; do not run setup against another
product database. Revert application code or disable affected capabilities for rollback, retaining
schema files and submitted records. Purpose-specific owner acceptance cases and native enquiry
read/decision ports are in [the existing Harbor adapter](evaluation-adapters/harbor/README.md).

## Customers and follow-up

Open `/app/customers` for Enquiries and Contacts. Confirmed real website or messaging enquiries
appear once with their submitted details, source, permitted booking links and history. Staff can
claim or assign follow-up, set a due date, add internal notes and update status. Inbox's
**Manage enquiry** link opens the same record. Owners can correct contact details and explicitly
link records. Email/phone text never verifies identity or merges contacts.

Enquiry setup enables native enquiry submission, own-enquiry reading and exact-confirmed
amendment. Original submissions remain immutable. Configure → Tools separately enables staff
record search and follow-up updates for signed-in staff with explicit grants. Customer deployments
never receive those staff tools or internal notes. Due dates do not trigger outbound reminders.
Private operator tests and evaluation trials do not create ordinary customer records. Staff-tool
model acceptance uses an owner-controlled disposable organization, not access to ordinary records
from an evaluation trial. See [owner adapter cases](evaluation-adapters/harbor/README.md).

Apply explicit local schema setup and restart API/worker before testing. The
[API and recovery reference](docs/source-boundary.md#native-customer-records) documents routes,
command identity, revisions, schema078/079 and rollback. Growth linkage and external CRM
synchronization are excluded.
