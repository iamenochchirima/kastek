# Kasitek Harbor adapter

This optional Python package implements Harbor's host-side `BaseAgent`. Harbor owns trial scheduling, environments, verification and aggregation. Kasitek owns admission, model/tool execution, durable recovery and authoritative records. The adapter imports no Agents API internals and no Agents Lab code.

The current checkpoint implements the HTTP adapter, request recovery, cancellation and ATIF conversion. The grounded FAQ suite has passed through actual Harbor, isolated compiled Kasitek API/worker, PostgreSQL, Restate and private storage using one deterministic provider response. Inbox, research/report, controlled-transaction suites and multi-turn Harbor resume remain required for package E acceptance. The separate local HTTP unit tests use contract fixtures; they do not establish native platform behavior.

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

Store a `kasitek-prepared-scope.v1` JSON file owned by the evaluator's OS user with mode `0600`:

```json
{
  "schema_version": "kasitek-prepared-scope.v1",
  "scope_id": "11111111-1111-4111-8111-111111111111",
  "origin": "http://127.0.0.1:4101",
  "organization_id": "22222222-2222-4222-8222-222222222222",
  "agent_id": "33333333-3333-4333-8333-333333333333",
  "version_id": "44444444-4444-4444-8444-444444444444",
  "composition_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expires_at": "2099-01-01T00:00:00Z",
  "max_tokens": 8192,
  "session_cookie_env": "KASITEK_EVALUATION_SESSION",
  "cookie_name": "agents_session",
  "isolation": "operator-provisioned-per-trial"
}
```

Replace every sample ID, digest and expiry with actual isolated records. Pass the short-lived session through the named host environment variable. The cookie never appears in the scope file, trial mapping, trajectory or result metadata. HTTPS uses `__Host-agents_session`; plain HTTP is restricted to loopback.

The actual Harbor custom-agent selection is:

```sh
PYTHONPATH="$PWD/products/agents/evaluation-adapters/harbor/src" harbor run \
  --path /absolute/path/to/approved-suite \
  --agent kasitek_harbor.agent:KasitekAgent \
  --agent-kwarg scope_path=/absolute/private/scope.json \
  --n-concurrent 1 --max-retries 0
```

This is the adapter invocation contract, not a claim that the pending suite currently passes. Do not pass hidden answers, verifier credentials, task MCP servers, skills or a model override. Files/tools required by a suite must be bound to the actual Harbor environment through a supported native resource adapter. A copied or disconnected fixture cannot establish a mutation outcome.

## Recovery and evidence

`trial-mapping.json` persists the Harbor context identity, exact request, pinned composition, native trial/task IDs and original deadline before admission. A repeated invocation inspects the same accepted task. Transport retries preserve the request key; changing an instruction or scope requires another trial. Trial lookup resolves lost preparation acknowledgements without creating resources. Cleanup revokes the native trial before following cancellation. A request to cancel is separate from observed cancellation, and uncertain native outcomes remain unconfirmed.

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
