# Approval real-provider evidence

This record captures the local configured-model approval run completed on 2026-09-12. It is
the local end-to-end evidence for the approval implementation.

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

## Local calendar capability run

The same commit also passed the four-event configured-model calendar sandbox through the platform
message endpoint and the default `kasitek.calendar.delete` capability. The test replaced the
Temporal worker while the group was pending, then submitted concurrent duplicate decisions. The
group consumed exactly four selected operations, and each disposable internal-calendar event
changed from `active` to `cancelled` once before the fixture cleanup removed it.

| Field | Value |
| --- | --- |
| Test | `temporal-real-approval.integration.test.ts`, `drives the real calendar capability through the Studio message and group decision path` |
| Run ID | `495093f5-074c-45ed-a236-4cd77495c124` |
| Temporal Workflow ID | `agent-run-495093f5-074c-45ed-a236-4cd77495c124` |
| Approval group ID | `81716e5a-a079-48cc-8fbc-604a2cd15676` |
| Plan digest | `41b1c588262b5ec045a742dbf79cdf46c16bc38035da21f25170b77e1c2c6489` |
| Provider response IDs | `gen-1789177157-oUuic2178T1eklBFLAJM`, `gen-1789177162-6LH3I8WWG0t7qtytgUFS` |
| Final run/group state | `completed` / `consumed` |

The event rows were deleted by the test's disposable-fixture cleanup after the before-and-after
assertions passed. No customer calendar or external provider resource was used.

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

The test uses a disposable organization and a synthetic external-effect capability. It does not
touch customer resources or retain credentials and private arguments in this record.
