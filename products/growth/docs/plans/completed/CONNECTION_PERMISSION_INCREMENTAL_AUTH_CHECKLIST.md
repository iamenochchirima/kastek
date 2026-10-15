# Incremental connection permission authorization checklist

**Status:** Completed

**Plan:** [`CONNECTION_PERMISSION_INCREMENTAL_AUTH_PLAN.md`](./CONNECTION_PERMISSION_INCREMENTAL_AUTH_PLAN.md)

**Last updated:** 2026-09-02

Status markers: `[x]` complete, `[~]` partial, `[ ]` pending.

## Diagnosis and design

- [x] Confirm the failure: requesting one X capability replaces the previous OAuth scope set.
- [x] Confirm the production symptom: authorizing publish removed messaging and media access.
- [x] Define additive effective capabilities at the shared access-request seam.
- [x] Define fail-closed behavior for narrower or missing provider inventories.

## Implementation

- [x] Add current-grant unioning to the shared access-request plan.
- [x] Use effective capabilities in every OAuth start path.
- [x] Protect existing verified permission inventory from silent callback downgrade for X, whose OAuth response exposes the scope set.
- [x] Keep provider-specific unsupported and approval-required access excluded.
- [x] Keep user-facing access state concise and provider-neutral.

## Verification

- [x] Add a regression test for sequential X permission requests.
- [x] Add tests for duplicate capability normalization and unsupported capabilities.
- [x] Run Core formatting, lint/build, and targeted tests.
- [x] Verify no debug instrumentation or secrets are present.

## Documentation and release

- [x] Update social connection operations documentation.
- [x] Update connection failure recovery documentation.
- [x] Record commit SHA and deployment evidence.
- [~] Verify production X access state after reauthorization; deployment is complete and the user must authorize the currently missing X permissions once.
- [x] Commit and push the completed change.
