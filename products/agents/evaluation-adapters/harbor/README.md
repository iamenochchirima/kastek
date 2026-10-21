# Kasitek Harbor adapter

This optional Python package implements Harbor's host-side `BaseAgent`. Harbor owns trial scheduling, environments, verification and aggregation. Kasitek owns admission, model/tool execution, durable recovery and authoritative records. The adapter imports no Agents API internals and no Agents Lab code.

The adapter supports stable request recovery, bounded scripted conversations, cancellation and ATIF conversion from authorized native exports. Actual Harbor trials have passed for grounded FAQ, two-turn FAQ, research/report, delegated research, controlled delivery reconciliation and website Inbox handoff/return. These acceptance runs use deterministic provider responses with actual HTTP, PostgreSQL, Restate, private storage and independent Harbor verifiers. They establish execution and evidence contracts, not general model quality. Arbitrary Harbor resume remains unsupported. Local HTTP unit tests are separate contract fixtures.

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
