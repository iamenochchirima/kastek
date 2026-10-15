# Bluesky Media OAuth Scope Fix

**Status:** Complete

## Checklist

- [x] Declare `blob:*/*` in the public Bluesky OAuth client metadata.
- [x] Keep the initial connection limited to identity and post access.
- [x] Request `blob:*/*` only when the user grants media access.
- [x] Add regression coverage and run Core verification.
- [x] Record the production deployment requirement.

## Release record

- Affected service: `kasitek-core` and Bluesky connection authorization.
- Platform release version or release ID: implementation commit on `main`; Core deployment required.
- API/schema/migration changes: not applicable.
- Analytics/logging changes: not applicable.
- Validation: the red regression reproduced the missing metadata declaration; seven targeted
  Bluesky OAuth tests, 261 Core library tests, `cargo fmt --check`, `cargo check -p kasitek-core`,
  and `git diff --check` passed.
- Rollout: deploy the Core service from the resulting `main` commit.
- Rollback: revert the implementation commit.
