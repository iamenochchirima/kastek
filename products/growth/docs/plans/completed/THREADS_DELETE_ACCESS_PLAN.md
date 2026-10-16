# Threads Published-Content Deletion Access

**Status:** Complete

**Owner:** Platform integrations

**Last updated:** 2026-09-02

## Objective

Expose Threads post deletion as a truthful, usable connection capability. A connected Threads
account with the required `threads_delete` grant should show delete access as granted or requestable,
include the scope in OAuth requests when needed, and successfully use the existing provider deletion
path. Editing remains out of scope.

## Scope

### Included

- Map `SOCIAL_POST_DELETE` to Threads' `threads_delete` permission.
- Rename the shared access row from edit-or-delete language to delete-only language.
- Cover initial OAuth, additional-access requests, permission snapshots, and provider deletion.
- Add targeted regression tests and update user/internal documentation.

### Excluded

- Threads post editing.
- Changes to provider deletion semantics or local post deletion behavior.
- Database schema, migration, feature flag, or new analytics event.

## Context and constraints

- The Threads provider deletion HTTP path already exists in `social_publishing.rs`.
- The current `unknown_supported()` mapping has no provider permission, no request scope, and makes
  the permission non-requestable; this is the source of the lock shown in Connections.
- Threads OAuth uses `threads_basic` plus capability-specific scopes. `threads_delete` is the
  capability-specific scope for deleting the account owner's media objects.
- The change must not expose provider credentials or raw tokens in logs, UI, or agent contracts.

## Implementation plan

1. [x] Confirm the UI symptom, registry mapping, existing delete path, and provider scope contract.
2. [x] Add the Threads delete permission mapping and accurate access copy.
3. [x] Verify initial OAuth and additional-access requests include `threads_delete` only when delete
    access is selected.
4. [x] Add regression coverage for granted/requestable state and generated scope behavior.
5. [x] Update public and internal documentation, run verification, and record release decisions.

## Verification

- [x] Rust formatting and targeted Core tests: changed Rust files pass rustfmt; full `kasitek-core`
      test suite passes (248 passed, 3 ignored).
- [x] Client lint/type check/build: ESLint, TypeScript, and production build pass.
- [x] Source/runtime check for the Threads access row and OAuth scope: provider mapping tests pass.
- [x] `git diff --check`.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Threads content management | Represent the existing delete operation as `SOCIAL_POST_DELETE`; do not imply editing support. | Platform integrations | Decided |
| Release risk | Standard, provider-permission and user-visible access-state change. | Platform integrations | Decided |
| API/schema/migration | Not applicable. | Platform integrations | Decided |
| Feature flag/rollout | Not applicable; capability mapping is provider-specific and backward-compatible for existing publishing. | Platform integrations | Decided |
| Analytics | Not applicable; no new user outcome event is introduced. | Platform integrations | Decided |
| Logs/metrics | Not applicable; existing provider deletion and authorization diagnostics remain in use. | Platform integrations | Decided |
| Rollback | Revert the mapping/copy/documentation commit; existing publishing remains unaffected. | Platform integrations | Decided |

## Notes and blockers

No external blocker. Provider approval may still be required for real users before `threads_delete`
appears in an access token.
