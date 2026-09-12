# Approval real-provider evidence

This record captures the local configured-model approval run completed on 2026-09-12. It is
release evidence for the local Agents artifact, not hosted staging or production evidence.

## Run record

| Field | Value |
| --- | --- |
| Test | `temporal-real-approval.integration.test.ts`, `waits for approval` |
| Provider | `openrouter` |
| Model | `inclusionai/ling-3.0-flash-sante:free` |
| Platform release identity | `approval-evidence-d02e941233ba` |
| Application commit | `d02e941233ba` |
| Migration version | `177` |
| Organization | `real-approval-test-9091a5f7-2ded-40de-b8f9-5e6e31178a7b` |
| Run ID | `2281bb8d-095b-4d60-a234-687f37853628` |
| Temporal Workflow ID | `agent-run-2281bb8d-095b-4d60-a234-687f37853628` |
| Approval group ID | `447640ba-f677-4e4f-b21d-312608392c44` |
| Plan digest | `1030b1bc51cf34c7a13d5ca0315faba1869272e383beb76c37dea7389ebc04c2` |
| Final run state | `completed` |
| Final approval-group state | `consumed` |

The provider response identities persisted in the completed `model_calls.response` records were:

- `gen-1789177010-roricC4rmQqP05a0q52O`
- `gen-1789177012-e64OwtE9Glfql8HrSpaG`

The run used one synthetic approval-required effect. Concurrent HTTP decisions returned one
accepted response and one already-signalled response. The effect invocation count was exactly
one, and the durable invocation finished with `completed` status.

## Verification command

The command ran against the local Temporal server and PostgreSQL database with the API key loaded
from `agents/.env`. The key and all private arguments are excluded from this record.

```text
RUN_REAL_MODEL_INTEGRATION_TESTS=true
TEMPORAL_MODE=local
TEMPORAL_NAMESPACE=default
TEMPORAL_TEST_ADDRESS=127.0.0.1:7233
TEMPORAL_ADDRESS=127.0.0.1:7233
pnpm --dir agents exec vitest run test/temporal-real-approval.integration.test.ts -t 'waits for approval' --reporter=dot
```

Result: 1 test passed. The test also asserted that every completed model call had a non-empty
persisted provider response identity.

## Boundary

This artifact does not prove a hosted staging connection, an external customer resource effect,
or durable production telemetry retention. Those remain release-environment gates. The local test
uses a disposable organization and a synthetic external-effect capability.
