# Kasitek Harbor adapter

This optional Python package implements Harbor's host-side `BaseAgent`. Harbor owns trial scheduling, environments, verification and aggregation. Kasitek owns admission, model/tool execution, durable recovery and authoritative records. The adapter imports no Agents API internals and no Agents Lab code.

The default `kasitek_harbor.agent:KasitekAgent` supports stable request recovery, bounded scripted conversations, cancellation and ATIF conversion from authorized native exports. Actual Harbor trials have passed for grounded FAQ, two-turn FAQ, research/report, delegated research, controlled delivery reconciliation and website Inbox handoff/return. These acceptance runs use deterministic provider responses with actual HTTP, PostgreSQL, Restate, private storage and independent Harbor verifiers. They establish execution and evidence contracts, not general model quality. Arbitrary Harbor resume remains unsupported. Local HTTP unit tests are separate contract fixtures.

The optional `kasitek_harbor.growth:GrowthHarborAgent` uses Growth's normal product HTTP
interfaces instead of standalone account-scoped evaluation APIs. Its preparation and evidence
limits are documented below. It has pure contract coverage; no Growth Harbor evaluation run or
model-quality result is claimed by this change.

## Toolchain and checks

Pinned interfaces: Python 3.12, Harbor 0.24.0, httpx 0.28.1 and Pydantic 2.14.1. The installed compatibility probe used Python 3.12.3. Package builds use setuptools 80.9.0; lint uses Ruff 0.14.1.

From the repository root:

```sh
uv run --project products/agents/evaluation-adapters/harbor --extra dev ruff check products/agents/evaluation-adapters/harbor
uv run --project products/agents/evaluation-adapters/harbor python -m unittest discover -s products/agents/evaluation-adapters/harbor/tests -v
uv build --project products/agents/evaluation-adapters/harbor
```

The implementation was checked against the installed [Harbor BaseAgent API](https://github.com/harbor-framework/harbor/blob/v0.24.0/src/harbor/agents/base.py), [ATIF models](https://github.com/harbor-framework/harbor/tree/v0.24.0/src/harbor/models/trajectories) and [0.24.0 package](https://pypi.org/project/harbor/0.24.0/).

## Operator scope

Prepare a dedicated agent, approved knowledge, initial memory and controlled provider namespace through normal authorized platform APIs. Do not select an owner's active agent. Native trial preparation reserves the selected agent, rejects prior task/memory state, checks the immutable composition, and bounds total token allocation and expiry. The adapter cannot provision elevated grants or choose a model from a task instruction.

Store a `kasitek-prepared-scope.v2` JSON file owned by the evaluator's OS user with mode `0600`:

```json
{
  "schema_version": "kasitek-prepared-scope.v2",
  "scope_id": "11111111-1111-4111-8111-111111111111",
  "origin": "http://127.0.0.1:4101",
  "organization_id": "22222222-2222-4222-8222-222222222222",
  "agent_id": "33333333-3333-4333-8333-333333333333",
  "version_id": "44444444-4444-4444-8444-444444444444",
  "composition_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expires_at": "2099-01-01T00:00:00Z",
  "model_routes_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "root_token_limit": 16384,
  "max_tokens": 32768,
  "session_cookie_env": "KASITEK_EVALUATION_SESSION",
  "cookie_name": "agents_session",
  "isolation": "operator-provisioned-per-trial"
}
```

Before writing the scope, request `POST /api/organizations/:organizationId/agents/:agentId/model-preview` with `versionId` and `rootTokenLimit`. Use its `modelRoutesDigest` and `rootTokenLimit` in the scope. The preview resolves the authorized provider accounts, models and effective policies for all execution roles. Native trial preparation requires that exact digest and allocation. A later organization default change cannot silently select another account or model for the trial. An unavailable or revoked pinned account fails the trial rather than falling back.

The adapter's `root_token_limit` option must equal the scope's `root_token_limit`. Both default/example allocation and option are 16384. To choose another allocation, repeat the preview and prepare a new scope with its digest, then pass `--agent-kwarg root_token_limit=VALUE`. The maximum trial allocation is 2147483647 tokens, an integer storage bound; provider limits and effective policy can impose lower limits. This does not promise provider capacity.

Replace every sample ID, digest and expiry with actual isolated records. Pass the short-lived session through the named host environment variable. The cookie never appears in the scope file, trial mapping, trajectory or result metadata. HTTPS uses `__Host-agents_session`; plain HTTP is restricted to loopback.

The actual Harbor custom-agent selection is:

```sh
PYTHONPATH="$PWD/products/agents/evaluation-adapters/harbor/src" harbor run \
  --path /absolute/path/to/approved-suite \
  --agent kasitek_harbor.agent:KasitekAgent \
  --agent-kwarg scope_path=/absolute/private/scope.json \
  --n-concurrent 1 --max-retries 0
```

Select an approved suite and a fresh dedicated scope for each trial. Do not pass hidden answers, verifier credentials, task MCP servers, skills or a model override. Files/tools required by a suite must be bound to the actual Harbor environment through a supported native resource adapter. A copied or disconnected fixture cannot establish a mutation outcome.

## Recovery and evidence

`trial-mapping.json` persists the Harbor context identity, exact request, pinned composition and model-policy digest, native trial/task IDs and original deadline before admission. A repeated invocation inspects the same accepted task. Transport retries preserve the request key; changing an instruction or scope requires another trial. Trial lookup resolves lost preparation acknowledgements without creating resources. Cleanup revokes the native trial before following cancellation. A request to cancel is separate from observed cancellation, and uncertain native outcomes remain unconfirmed.

Every export must retain the prepared root model-policy digest and allocation. The adapter verifies each task's complete accepted route snapshot against its SHA-256 digest and checks model calls and compactions against that task's binding and policy. Child tasks may narrow their accepted policy. ATIF extras retain the nonsecret task routes and per-call policy for separate grading by model or purpose. Provider keys and private native continuation state remain absent.

`native-export.json` retains the authorized `execution-export.v1` response. `trajectory.json` validates against installed ATIF v1.8. Exact input snapshots stay in step metadata, rather than becoming invented user turns after compaction. Tool results pair only with exact provider call IDs and native operation receipts. Children remain separate embedded trajectories linked through native delegation operations. No hidden reasoning, missing token split, response or receipt is invented. Unsupported argument mappings fail explicitly. Coverage is retained independently from native outcome and eventual grading.

Artifacts use authorized same-organization paths, bounded byte counts and verified SHA-256 digests. Opaque artifact IDs choose local filenames. Withheld artifacts stay unavailable. Trial evidence is private authorized data; restrict Harbor job artifacts accordingly.

## Release scope

This package adds no production deployment, schema, model override, telemetry exporter or analytics event. Root platform changes are owned separately. Validation and native acceptance must be recorded independently. Rollback removes this optional evaluator selection without changing native task history. No production release is claimed.

The `suites/faq-grounded` Harbor task verifies a dedicated FAQ fixture's actual approved retrieval, source revision/citation receipt, model request/response, pinned composition, observations and native cleanup. Its container has no network and receives no credentials. Harbor mounts the adapter's authorized host evidence for the verifier. The fixture's fixed answer is specific to this contract test; passing it does not establish general FAQ answer quality or paraphrase recall.

Run the isolated native FAQ acceptance from the repository root with Node 24 and local PostgreSQL administrative credentials in the API environment file:

```sh
node --env-file=products/agents/api/.env --import ./products/agents/api/node_modules/tsx/dist/loader.mjs products/agents/api/test/harbor-fixture.ts
```

The fixture requires Docker, the pinned local Harbor installation and a local MinIO binary (`AGENTS_HARBOR_BINARY` and `AGENTS_TEST_MINIO_BINARY` override executable paths). It compiles into its own ignored `.audit/` directory, creates a fresh database and random service ports, runs Harbor's verifier, then removes its services/database. It preserves private proof under `.audit/harbor-<id>/`. The default provider is deterministic; `AGENTS_HARBOR_REAL_MODEL=1` explicitly selects the already configured approved free model. No fallback model is allowed. Identity is seeded for transport verification; this fixture does not test browser OIDC.

## Scripted conversations

`follow_ups` is a trusted adapter option containing at most seven additional public user questions, each with a unique stable `id` and `instruction`. It carries no answers or grader criteria. Harbor owns the trial and verifier; the adapter sends the bounded script through normal native conversation admissions. Each request is checkpointed before submission with an identity derived from the Harbor trial and explicit turn ID. Retrying follows the original accepted root; changed configuration conflicts. Even identical question text remains distinct when configured with different turn IDs.

All turns share the original trial, conversation, pinned composition, deadline and total allocation ceiling. Set `root_token_limit * turn_count <= scope.max_tokens`. Failed or uncertain native turns stop the script. Cleanup revokes the trial after the last turn or any error. Each turn retains its own native export; ATIF concatenates only actual ordered user/model steps and keeps per-root provenance and coverage. Bare `resume(new_instruction)` is rejected because Harbor does not supply a stable external step ID to that method.

Run the actual two-turn fixture with `AGENTS_HARBOR_SUITE=faq-follow-up` before the native fixture command above. Its independent Harbor verifier checks that the second request contains the first server-authored assistant response, both tasks share the same conversation/version, and the ATIF preserves two real user turns.

## Native suite selection

Set `AGENTS_HARBOR_SUITE` before the isolated fixture command:

| Suite | Independent checks |
| --- | --- |
| `faq-grounded` | Approved passage, exact citation and model request |
| `faq-follow-up` | Two native roots, pinned conversation and server history |
| `research-report` | Search receipt, downloaded report digest, normal approval and receiver receipt |
| `delegated-research` | Separate specialist identity, usage and delegation provenance |
| `controlled-transaction` | Lost delivery acknowledgement, one POST and status-only reconciliation |
| `inbox` | Visitor admission, staff takeover/reply/resolve/reopen/return and labeled human context |
| `isolated-analysis` | Actual gVisor computation, downloaded artifact bytes and independent resource cleanup |
| `faq-unknown` | Empty scoped retrieval and an explicit unknown answer |
| `faq-private` | A separate approved private source excluded from the version's actual retrieval scope |
| `faq-paraphrase` | Held-out question, actual source receipt and independent repetitions |
| `faq-withdrawal` | Normal policy withdrawal, withheld payloads and an unsupported/inconclusive transcript |
| `faq-escalation` | Exact handoff tool receipt, handoff ownership and suppressed automated delivery |

Report verifiers read the actual receiver through a finite read-only bridge. They compare native action, payload and artifact digests; approval alone never proves delivery. Research fixtures do not claim sandbox execution. Source extraction is an explicit fixture; ingestion policy, storage, approval and retrieval remain native.

For `inbox`, trusted `channel` configuration contains only `deployment_id` and allowed website `origin`. The prepared trial's normal operator creates the native evaluation session. Visitor requests use a separate cookie-free Bearer client; operator credentials never cross that boundary. Public response DTOs carry no task IDs. The operator-only trial history establishes exact message, task and conversation bindings. Scripted questions are normalized by the canonical visitor API's whitespace rule before checkpointing. Native human replies remain labeled reference data in model inputs, not fabricated model turns.

## Repetition and recovery

Harbor's `--n-attempts` owns repetition and aggregation. A private `kasitek-prepared-scope-pool.v1` file contains `scope_paths`, an array of one to eight absolute prepared-scope filenames. Each scope must name a different dedicated agent. Process-shared local assignment binds a Harbor context to one scope before native preparation. Repeated observation recovers the assignment; exhaustion fails instead of reusing an agent. This allocates preauthorized scopes and does not schedule executions or create permissions.

`AGENTS_HARBOR_ATTEMPTS=2 AGENTS_HARBOR_SUITE=faq-paraphrase` selects the fixture's actual Harbor repetitions. Each attempt receives a fresh agent/version and native trial. Before admission, the fixture freezes instruction, verifier, environment and fixture source hashes in private `baseline.json`, together with pinned toolchain/model identity and the exact correctness threshold. Rewards, native outcome and coverage remain separate. No model judge is used for these exact contract criteria; judge calibration is not applicable. Deterministic-provider scores do not measure live-model accuracy.

Installed Harbor 0.24.0 creates a new context UUID when an interrupted job is resumed; it does not restore an unfinished adapter mapping automatically. The explicit trusted `recovery_id` UUID supports one intended trial across that process boundary. Use one prepared scope, retain its private sidecar mapping and resume with the identical Harbor configuration. An OS-held exclusive lock rejects another active process. The native trial, request, scope, composition, deadline and allocation never renew. A different Harbor context can follow only an unfinished mapping; a completed mapping rejects being counted as a new trial. Use a fresh scope pool for repetitions. Ordinary same-context observation remains idempotent.

The fixture accepts `AGENTS_HARBOR_LIFECYCLE=native-restart` with `faq-follow-up` to restart its own compiled worker between native turns. This verifies conversation continuity across two actual worker processes; it is separate from an in-flight operation crash/replay test. `evaluator-restart` and `cancel` exercise evaluator loss and bounded native cancellation. Cancellation requests and observed terminal/cancellation confirmation remain distinct. Interrupted owned environments are cleaned by their exact recorded Harbor Compose project identity.

Negative verifier probes use `AGENTS_HARBOR_VERIFIER_TEST=assertion`, `exception`, or `missing-evidence` with the ordinary deterministic FAQ fixture. They modify an isolated verifier copy, never the native program or published suite. A failed criterion, missing reward and explicit inconclusive classification cannot become a passing default. The fixture records expected negative behavior separately from a successful agent-quality score.

`inbox-takeover` grades `ownership_safety`, separately from `grounded_faq`. Its actual model call is in flight when an authorized staff member claims, takes over and replies. The verifier requires the old automated delivery to be suppressed and the human reply to appear once. Native uncertainty and incomplete model coverage leave model quality inconclusive; a safety reward cannot establish an answer-quality result. The regular Inbox fixture also loses visitor-ingress and human-reply acknowledgements, retries their original stable identities, and requires unchanged native message/delivery counts.

The paraphrase predicate checks an explicit opening-time claim and its actual source citation. Negative calibration rejects an incorrect opening time with nine elsewhere, negated nine, 9:30 and contradictory opening claims; it accepts nine and 9:00 forms. This closed-case heuristic is not a general semantic judge and may reject valid wording outside its declared forms. Live trials must retain failed or inconclusive outcomes rather than adjust the rubric after observing answers. Lexical matching and semantic thresholds can miss other paraphrases; this case does not establish general FAQ recall.

The Agents Lab reference uses its own evaluation admin token, platform/variant selection and a scoped Harbor file bridge. Kasitek instead requires normal current operator membership, immutable native versions and server-enforced trial reservations. Native storage, sandbox and controlled receiver interfaces supply the actual resources exercised here. No Lab private code, token protocol or execution path is imported.

## Customer FAQ parity and verifier revisions

FAQ and Inbox fixtures use the actual `customerConfiguration('faq')`: the published `grounded-conversation@1` program with knowledge search/read and channel handoff. Research/report and analysis fixtures retain the tool-directed program. Shared agent defaults and customer offerings require exact provided source labels for knowledge-backed facts and prohibit invented facts/citations. The FAQ policy prefers sufficient supplied passages; tools remain available when more evidence is needed. These default changes affect newly published configurations, not existing version pins.

The original live baseline is retained: its instruction omitted the citation requirement and both answers omitted citations. A customer-parity baseline then produced correct cited answers through legitimate search/read rounds, which exposed two verifier assumptions: first response equaling final response, and the citation always being the first reference. Neither is a customer requirement.

`faq-paraphrase-v2` retains the original fact/citation checks and adds complete multi-round native/ATIF accounting. `faq-paraphrase-v3` additionally accepts any authorized supporting reference from the approved source/revision that was present in actual model-visible user/tool input. Every answer citation must qualify. Missing, unknown, unprovided, withdrawn/unavailable and wrong-scope/revision references fail. The factual predicate is byte-identical across revisions; its SHA-256 is pinned before grading. Negative calibration covers both citations and dropped/forged transcript records. Old jobs/results are never rewritten.

Harbor's official `jobs regrade` uses separate verifier environments. `kasitek_harbor.verifier:RecordedNativeVerifier` uploads only three exact recorded files from Harbor's seeded trial directory: native export, evaluation result and ATIF trajectory. Harbor still owns environment, verification, rewards and reports. Regrading makes no agent/API/model calls and does not renew grants or revalidate live policy; it evaluates the retained authorized capture. A fresh native trial is required for fresh current-policy evidence.

`controlled-transaction-conflict` exercises a separate, attributed fixture negative probe after one actual native accepted delivery. The same delivery identity with a different valid payload receives HTTP 409. An independent verifier reads the actual receiver's request audit and accepted row: one native 200, one fixture-probe 409, one unchanged approved receipt/digest. The verifier has read-only authority; it cannot issue this probe or another delivery. This remains report/effect-contract acceptance, not booking support.

The controlled-conflict verifier revision `kasitek-controlled-transaction-conflict-v2` independently reads the receiver's request audit as well as accepted receipts. It requires exactly one native 200 and one separately attributed fixture 409 under the same delivery identity, independently validates both payloads and canonical digests, requires different valid bodies, and verifies one unchanged accepted receipt with the reviewed artifact bytes. Negative calibration rejects a missing probe, incorrect status/actor, extra acceptance, invalid or unchanged body, incorrect digest and replaced receipt. The earlier conflict job's reward checked ordinary report acceptance only; its fixture assertion of 409 was insufficient independent conflict grading. Retain that historical result with this limitation rather than treating it as v2 acceptance.

## Connector and reviewed skill cases

The existing native fixture also accepts these `AGENTS_HARBOR_SUITE` values:

| Suite | Verified behavior |
| --- | --- |
| `faq-connected-skill` | FAQ program activates a reviewed skill and reads its scoped opening-hours record |
| `customer-service-connected-skill` | Customer service program reads a return policy through the selected connector |
| `booking-policy-connected-skill` | Customer service program reads a booking notice policy; no appointment is reserved |
| `research-connected-skill` | Tool-directed program reads an isolated research record |
| `campaign-research-connected-skill` | Tool-directed program reads a campaign research policy; no campaign is sent |

Each case uses a fresh database, private object storage, actual Restate execution and an authenticated HTTP provider namespace. The setup calls the same scoped connection, skill import/review and draft/version management services used by the production routes. Its explicit loopback transport is confined to the fixture. An owner attests the selected GET operation as a read; the default operation policy still requires exact approval.

The deterministic model requests skill activation and one connector call. A separate Harbor verifier reads the controlled provider state with a distinct read-only credential. It compares the persisted skill review digest, pinned binding digest, exact namespace and provider bytes with the native receipts and cited final answer. It also requires complete model/tool coverage, one physical record read, no effect receipts and confirmed trial cleanup. Provider and verifier credentials never enter model context or prepared scope files. The baseline includes both the runner and connector helper source hashes.

These cases verify execution, authorization and provenance. They do not measure model quality, live vendor compatibility, Google OAuth acceptance or appointment delivery. Research and campaign research use the existing backend program; they add no customer offering. Booking policy retrieval does not establish reservation safety or customer confirmation. Connector cases support one isolated trial per fixture invocation.

## Isolated messaging trials

Owner-run only: implementation of these ports is not evidence that an evaluation or a live channel acceptance has passed. The existing website `channel` option remains separate. Select `messaging_channel` to exercise Telegram, WhatsApp, Messenger or Instagram through real native payload normalization, durable ingress, canonical Inbox admission, the same saved agent runtime and native outbound serialization. This option creates synthetic tenant-owned bindings, with fixture-only vault credentials. Public webhooks reject these bindings. The server intercepts outbound HTTP with a controlled transport; it never falls back to a real account.

Use one fresh prepared scope per matrix row, including a separate scope for each outcome case:

| Kind | Mode | Owner cases |
| --- | --- | --- |
| telegram | bot | accepted, rejected, lost acknowledgement |
| whatsapp | cloud_api | accepted, rejected, lost acknowledgement |
| facebook | meta | accepted, rejected, lost acknowledgement |
| instagram | meta | accepted, rejected, lost acknowledgement |
| instagram | instagram_login | accepted, rejected, lost acknowledgement |

Add this option to the existing `harbor run` command and select `suites/channel-native-receipts`:

```sh
--agent-kwarg 'messaging_channel={"kind":"telegram","mode":"bot","outcomes":["accepted"]}'
```

Use `"rejected"` or `"lost_ack"` for the respective negative case. Each array entry authorizes one controlled native HTTP outcome; exhausted arrays fail closed. Lost acknowledgement records a private simulated provider acceptance while the canonical delivery remains `unknown`; no automatic resend is introduced. These are simulated provider effects, not live delivery evidence. Existing product-specific graders still judge knowledge, booking and other permitted outcomes independently.

The authenticated API ports are `POST evaluation-trials/:trialId/channel-fixture`, `POST .../channel-fixture/ingress` and the existing `GET .../channel-history`. Preparation pins exact owner, trial, published configuration, route digest and token allowance. Raw native payloads can be resubmitted through ingress for duplicate-event checks; changed payloads under an existing provider identity must conflict. Use the same authenticated staff Inbox commands to test claim/takeover/reply/return and read canonical commands, ingress and delivery evidence from channel history. Do not send these fixtures to public provider webhook endpoints. The runner persists native envelopes before dispatch and correlates canonical receipt/message/task IDs, rather than inferring success from reply text.

`native-channel-history.json` includes `fixture`, `ingress`, canonical `messages`, staff `commands`, delivery states and private controlled `effects` with request digests. Access remains bound to the current authorized trial owner. Revocation/expiry stop admission and fixture sends; authorized historical reads do not require an active trial. Queue and worker processes must be running before the owner launches a trial. Channel delivery can finish after model completion; the runner waits within its original bounded deadline before collecting terminal receipts. No new execution engine, channel-specific model loop, real provider token or evaluation credential is supplied by a task instruction.

Per-channel owner case manifests are in `cases/website.json`, `cases/telegram.json`, `cases/whatsapp.json`, `cases/facebook.json` and `cases/instagram.json`. They label each case's driver and prerequisite: fixture Harbor trial, authenticated fixture/staff HTTP, or a live owner UI journey. Setup/reconnect require an actual dedicated provider account and are never represented as fixture delivery success. Knowledge/tool cases reuse their existing purpose-specific suites and graders; the receipt suite only judges canonical channel transport evidence.

For example, after exporting the session variable named by the private prepared scope, this is a complete owner-run fixture command:

```sh
PYTHONPATH="$PWD/products/agents/evaluation-adapters/harbor/src" harbor run \
  --path "$PWD/products/agents/evaluation-adapters/harbor/suites/channel-native-receipts" \
  --agent kasitek_harbor.agent:KasitekAgent \
  --agent-kwarg scope_path=/absolute/private/fresh-scope.json \
  --agent-kwarg 'messaging_channel={"kind":"telegram","mode":"bot","outcomes":["accepted"]}' \
  --n-concurrent 1 --max-retries 0
```

Substitute the exact kind/mode from its manifest. Do not reuse a prepared scope between cases. For duplicates or staff takeover/return, drive the same authenticated fixture and Inbox ports while the trial is active; retain the exact saved payload and current staff command revision/command ID. These scripted HTTP cases are supplied as interface cases, not claimed as already executed Harbor scenarios. Owner credentials and receipt artifacts remain private.

## Run native provider acceptance

These cases are owner-run. The implementation has not run provider evaluations or live vendor sign-in. [Native provider owner cases](cases/native-providers.json) records the Google Calendar, Microsoft 365 Calendar, customer contact intake, and signed-in staff lookup coverage. It is an acceptance matrix, not a registered Harbor suite.

Prepare the following before each case:

1. Use a dedicated organization, fresh agent/version, isolated provider calendar or CRM namespace, and a private prepared scope. Start the API, worker, queue, and private object store.
2. Configure the provider application and exact callback URL through the registry's environment keys: `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_CALLBACK_URL`; the corresponding `MICROSOFT_CALENDAR_*` keys; or `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_CALLBACK_URL`. Configure the credential vault. Keep secrets out of scopes, prompts, and saved evidence.
3. In Connections, select the provider, intended actions, and account. For calendars, select the calendar and explicit IANA booking time zone, allow customer bookings, and attach a booking policy to the saved agent. For customer intake, select `contacts.create`, allow customer intake, and attach only that exact binding to the customer agent. Attach `contacts.search` only to a signed-in staff agent.
4. For a website case, prepare the normal evaluation channel session for the pinned website deployment and allowed origin. Keep the visitor Bearer client separate from the operator session. Record the pinned model route, composition, provider configuration, and expected resource before submitting the case.
5. Give the independent verifier read-only access to that isolated provider namespace and its request audit. Capture actual event/contact fields and physical write counts. Native task completion, customer confirmation, HTTP acceptance, and observed provider state are separate outcomes.

| Case | Providers / principal | Expected authoritative outcome |
| --- | --- | --- |
| Calendar setup | Google and Microsoft; owner | Verified account, explicitly selected calendar, least requested action scopes, and saved time zone; cancellation/reconnect preserves the intended agent return path. |
| Confirmed booking | Google and Microsoft; customer | Exact proposed interval and time zone approved; one event matching the policy and request identity; native `confirmed` receipt agrees with the provider event. |
| No consent / changed proposal | Both calendars; customer | Missing, rejected, expired, changed-digest, or other-session confirmation produces no event creation. |
| Busy slot / duplicate | Both calendars; customer | Busy/conflicting slot creates no event. Replaying the same native invocation creates no second event. Concurrent slot claims cannot both reserve the same interval. |
| Lost acknowledgement | Both calendars; customer | At most one create request. Native reconciliation observes the same event or retains `uncertain`; neither task text nor a second create establishes recovery. |
| Time zone / permission change | Both calendars; customer | Offset/DST and explicit calendar selection match the policy; revoked scopes, private sharing, account/resource change, or disconnected authorization prevent new effects. |
| Contact intake | HubSpot; customer | Exact email/name fields approved by that customer. One matching contact is created, or an already matching record is reused with zero creates. No existing contact fields/record IDs enter the customer response. |
| Intake refusal / mismatch | HubSpot; customer | No consent, expired/changed review, wrong session/conversation, or human takeover produces no write. Existing mismatched or ambiguous contacts are not silently overwritten or disclosed. |
| Staff lookup | HubSpot; signed-in staff | Exact-email query returns only the permitted bounded projection for the connected account; zero create requests. An unverified email in a customer message grants no lookup authority. |
| CRM recovery / withdrawal | HubSpot; permitted principal | Replaying an accepted invocation does not create again. Unknown acceptance remains uncertain. Revoked membership, sharing, selected action/binding, or connection stops new effects. |

### Drive exact customer decisions

The host-side `VisitorClient` now exposes `bookings(conversation_id)`, `tool_reviews(conversation_id)`, `decide_booking(conversation_id, booking_id, decision, request_digest)`, and `decide_tool_review(conversation_id, review_id, decision, request_digest)`. These methods use only the prepared website publication and cookie-free visitor session, validate exact identifiers/digests, bound responses, and preserve the same decision on a transport retry. They never select or approve a proposal automatically.

While the isolated trial is waiting, inspect its normal customer proposal and send the owner's explicit decision through the corresponding method. Decisions are `approve` or `reject` and must carry the current proposal's exact `requestDigest`. Use the same conversation/session that submitted the case. The underlying public endpoints are:

```text
GET  /api/website/:deploymentId/customer-conversations/:conversationId/bookings
POST /api/website/:deploymentId/customer-conversations/:conversationId/bookings/:bookingId/decision
GET  /api/website/:deploymentId/customer-conversations/:conversationId/tool-reviews
POST /api/website/:deploymentId/customer-conversations/:conversationId/tool-reviews/:reviewId/decision
```

POST bodies contain only `decision` and `requestDigest`. For a staff lookup, use the prepared signed-in staff task and its exact allowed binding; a website visitor token cannot become a staff credential.

### Grade provider receipts

The authorized `execution-export.v1` retains two additional receipt schemas in `effectReceipts`:

- `calendar-booking-receipt.v1`: provider, exact request/policy digest, proposed interval/time zone, confirmation/native state, sanitized event receipt, and bounded physical-attempt metadata.
- `native-provider-operation-receipt.v1`: provider/action/binding digests, exact review digests, native operation state, sanitized provider result, and bounded physical attempts. `contacts.search` records have `effect: read` and expose match counts/record IDs without contact fields. Contact creation records preserve `created: false` when an existing matching contact was reused.

Private CRM receipt bytes are read only through the authorized exporter, using the exact rooted object identity and verified byte/result digests. Exported receipts omit customer email/name fields, credentials, raw bodies, and object paths. Customer APIs retain their narrower confirmation DTOs. Missing private storage, changed policy, corrupt receipts, or withheld tasks make `coverage.effects` partial. Reviewed arbitrary MCP/API effects remain explicitly unsupported by this provider receipt contract. `complete` means the supported native records were exported; it does not mean a write succeeded or live vendor acceptance passed.

Compare the exported event/contact receipt with the independent provider record and request audit. Check exact fields against the case's private baseline, create count, review/digest linkage, current authority, and native uncertainty. Keep purpose quality, authorization safety, delivery correctness, and evidence coverage as separate results. A confirmed write must not turn a missing model transcript into a passing model-quality result.

The existing `booking-policy-connected-skill` suite still reads a notice policy; it does not reserve appointments. `KasitekAgent` has no automatic confirmation script or provider-specific independent verifier. There is no new `AGENTS_HARBOR_SUITE` selector for these mutation cases. Use the owner-controlled decision methods and independent provider inspection above; retain this limitation when recording results.

## Growth product mode (owner-run)

Use `GrowthHarborAgent` for an independently prepared Growth assistant, Research, Content or
Campaigns case. It keeps Harbor as the runner and verifier. Growth still authenticates the user,
checks business permissions, owns the review and saves the business record; shared Agents runs
the accepted task. The adapter creates no standalone Agents accounts or memberships, private
service assertions, runner, model loop or provider integration.

Prepare one fresh dedicated Growth business and staff session per Harbor trial through the normal
product setup. Configure the intended feature and managed model with its normal product policy,
plus the case's authorized records and destinations. Do not use an owner's active business or
provider publishing account. The selected staff user must have no previous agent conversations or
tasks in that business. The adapter checks that condition before first submission, verifies the
bootstrap's business/user, and pins the active-business cookie on every request.

Store this operator-owned file with mode `0600`; replace the example values with actual isolated
records and a suitable short expiry. `origin` is the Growth web/BFF origin, not standalone Agents.

```json
{
  "schema_version": "kasitek-growth-prepared-scope.v1",
  "scope_id": "11111111-1111-4111-8111-111111111111",
  "origin": "http://127.0.0.1:3000",
  "business_id": "actual-isolated-growth-business",
  "user_id": "actual-growth-staff-user",
  "feature_id": "content",
  "context": {"kind": "content_post", "resourceId": "actual-authorized-source-post"},
  "session_cookie_env": "KASITEK_GROWTH_EVALUATION_SESSION",
  "expires_at": "2099-01-01T00:00:00Z",
  "max_turns": 1,
  "isolation": "operator-provisioned-per-trial-business"
}
```

Use `context: null` for business-level guidance. Supported attached contexts are `workspace`,
`content_post`, `whatsapp_campaign` and `analytics_report`; reports require their actual
`range: {from, to, timezone}`. Growth validates every context independently. Supply the dedicated
session only through the named host environment variable. Credentials never enter scope files,
trial mappings, task instructions or result evidence.

Select one prepared case per invocation. A scope is claimed permanently by its original Harbor
trial context. It cannot be reused for another case or attempt; repeated invocations of that same
context retain the original deadline and stable conversation/turn request IDs. Prepare another
business/session/scope for another independent trial. Changed instructions or context conflict
with a retained mapping. Recovery needs the same private scope and original Harbor context.

```sh
PYTHONPATH="$PWD/products/agents/evaluation-adapters/harbor/src" harbor run \
  --path /absolute/path/to/one-growth-case \
  --agent kasitek_harbor.growth:GrowthHarborAgent \
  --agent-kwarg scope_path=/absolute/private/growth-scope.json \
  --n-concurrent 1 --max-retries 0
```

The existing trusted `follow_ups` format supports up to eight total turns within `max_turns`.
Task MCP servers, skills, model overrides and hidden grader fields are rejected. Purpose-specific
criteria belong in the independent case verifier, never in the agent's scope or instructions.
No Growth suites were executed while implementing this mode.

Review decisions are manual by default: the adapter observes the normal product task and waits
for a real decision, subject to the original deadline. For an explicitly approved evaluation case,
`--agent-kwarg review_decision=approve` or `reject` simulates the staff decision through the normal
Growth endpoint. Automatic approval requires the exact current review digest and ready selected
fixture destinations. It never invents a publishing account, rewrites a proposal, publishes or
schedules content. For another final draft or account, revise through Growth before approving.

Each turn retains `turns/<turn-id>/growth-product-history.json`: actual product task state, bounded
ordered event pages, Growth reviews, artifact references and authoritative saved-record outcomes.
A saved draft is verified with `GET /api/social/posts/:id` under the pinned business. The checks bind
review/task/user/digest, current record revision, normalized content/variants, DRAFT status and
selected accounts. Assistant prose saying "saved" is never accepted as an outcome. Provider fields
from the record response are not copied into outcome evidence. `evaluation-result.json` records
observed completion and cleanup separately; the independent verifier determines pass/fail.

Growth exposes the initiating user's authorised native capture through
`GET /api/agents/tasks/:id/export`. The adapter validates actual task/conversation identity,
accepted model-route digests, model/tool operation records and current source access. It retains
that capture with each turn and advertises ATIF support. ATIF is written only from validated
native records; missing results or unsupported mappings are never invented. An older server's
404/501 or an explicit capture-size limit remains an unavailable coverage state. Authentication,
malformed capture and pin mismatches fail rather than silently weakening the evidence.

Optional prepared-scope `expected_composition_digest`, `expected_model_routes_digest` and
`expected_manifest_digest` pin the configuration under test. Manifest pins match the root task's
platform-exported product binding snapshot, never a string in model output or tool results. A
requested pin requires a usable capture. Each preset or customised composition can have its own
prepared scope and purpose-specific suite. Review decisions follow actual task reviews and
capability authority rather than the agent's display name.

The standalone server evaluation-trial reservation/revoke contract is still unavailable in Growth.
The adapter reports that gap separately. Artifact references are retained; binary downloads are
not implemented in this mode. Installing capture support does not run an evaluation or establish
model quality. All evaluation and grading runs remain owner-operated.

The host lock/mapping and freshness check complement operator isolation; they are not a server
admission fence or tenant-wide trial budget. Provision only isolated services/businesses, keep the
prepared session private, and arrange fixture expiry and discard with the owner-run environment.
On completion or failure, the adapter requests cancellation of active roots in its own conversation
and records actual terminal states. Uncertain or unauthorized cleanup stays unconfirmed. It does
not call operator tenant/model controls, delete Growth business data or revoke a customer session.
`cleanup.admissionFenced` therefore remains false. The owner must disable/expire/discard the
isolated fixture after the trial. Do not call the scope's expiry a server-side revocation.

Prepare the case verifier separately for its purpose. The following coverage is independent:

| Selected feature | Prepared actual context | Owner-run outcome checks |
| --- | --- | --- |
| Assistant | Dedicated business profile or explicit workspace | Guidance agrees with configured Growth features; returned record links are authorized; no invented saved result. |
| Research | An authorized content record or report range | Findings cite the actual source/revision, distinguish uncertainty and avoid claiming external web research without an installed adapter. |
| Content | A source post and ready controlled destination | Exact reviewed final fields, actor/digest/revision match the normal DRAFT record; reject, stale decision and missing-permission cases cannot produce a saved receipt. |
| Campaigns | A real dedicated WhatsApp campaign | Recommendations agree with its actual state/receipts and preserve opt-in/template rules; no launch, schedule or recipient mutation is claimed. |

Use the same selected product mode for an owner-approved real managed provider, configured through
normal model setup. Keep provider keys in protected service configuration and record the setup
receipt with the private case evidence; never pass a key or a model override to Harbor. Run separate
fresh prepared businesses/scopes for different providers or purposes. Check that the intended
feature is ready before starting. This adapter's product evidence does not prove the exact accepted
per-call model policy; model-sensitive grading requires the missing authorized export or the
existing standalone adapter with its genuine native pins. Live destination acceptance additionally
requires an explicitly approved isolated provider account and the normal Growth record checks.
No provider/model availability, answer quality or live effect is inferred from a listed feature.

The new mode is optional source preparation. It changes no native runtime, production schema,
analytics registry or deployment. Its eight MockTransport/mapping/driver tests are contract checks only;
real Growth Harbor trials, model quality, provider acceptance and operational isolation remain
owner-run.

## Guided setup and native enquiries

[Guided setup owner cases](cases/guided-setup.json) separates FAQ, support, booking,
intake and combined configurations of the same customer-service agent runtime. It is
an owner acceptance matrix, not an additional runnable Harbor suite. Prepare a fresh
isolated agent and immutable scope for each profile. Reuse existing FAQ and Inbox
suites for their supported purposes. Run native enquiry and combined cases with the
owner-controlled HTTP ports and independent native records described in the manifest.
No evaluations were run for this addition.

`PlatformClient.setup_readiness()` reads the saved draft revision, requirement gaps
and channel states. Readiness describes configuration metadata. It does not replace
the prepared immutable version or prove a successful provider call. Scope preparation,
model pinning, grants and trial isolation continue through the existing platform APIs.
The adapter never grants itself access or modifies a reserved agent.

Native enquiries use `capabilities.enquiries.enabled`, its exact selected `fields`,
the `enquiry.submit` tool and matching grant operation. Customer details are stored
in Agents after explicit confirmation; no CRM account is required. The host helpers are:

- `VisitorClient.enquiries(conversation_id)` and
  `VisitorClient.decide_enquiry(conversation_id, enquiry_id, decision, request_digest)`.
- `PlatformClient.task_enquiries(task_id)` and
  `PlatformClient.decide_enquiry(task_id, enquiry_id, decision, request_digest)` for
  the signed-in task principal, retaining the prepared version.
- `PlatformClient.submitted_enquiries(limit=50)` for a bounded staff record page
  filtered to the prepared agent. Pending proposals are absent from this staff list.

The helpers use the normal routes:

```text
GET  /api/website/:deploymentId/customer-conversations/:conversationId/enquiries
POST /api/website/:deploymentId/customer-conversations/:conversationId/enquiries/:enquiryId/decision
GET  /api/organizations/:organizationId/tasks/:taskId/enquiries
POST /api/organizations/:organizationId/tasks/:taskId/enquiries/:enquiryId/decision
GET  /api/organizations/:organizationId/enquiries?agentId=:preparedAgentId&limit=50
GET  /api/organizations/:organizationId/agents/:agentId/setup-readiness
```

The caller supplies every approve/reject decision and exact digest. Transport retries
preserve that decision; the adapter never chooses it automatically. Visitor requests
carry only the visitor bearer credential, without the operator cookie. Native DTO
checks retain enquiry, task, agent and conversation identities, bounded configured
fields, state and digest. A pending or approved proposal is not a submitted enquiry.
Require the actual `submitted` tool receipt and matching staff record with its
submission timestamp. Inspect absence of submitted records for rejection, expiry,
wrong-session requests and authority withdrawal. Check the same native identity after
retries rather than accepting a second generated record. Retain personal-data evidence
in private trial artifacts.

Release impact: host adapter methods and owner manifests only; no API/schema change,
new runtime, grant bypass, analytics event or production rollout. Existing bounded
HTTP failures remain the diagnostic signal. Rollback removes these helper methods
and the manifest without changing native data or existing suites. Focused mocked-HTTP
unit checks and Python compilation establish adapter contracts, not agent outcomes.
