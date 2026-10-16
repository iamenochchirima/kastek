# TikTok OAuth Scope Fix Checklist

**Status:** Active

## Diagnosis

- [x] Capture the exact generated TikTok authorization scope without exposing credentials.
- [x] Compare the emitted scope names and encoding with the provider contract.
- [x] Confirm the provider gate: `user.info.basic` is the Login Kit baseline; optional scopes require
      the matching TikTok product and approval.

## Implementation

- [x] Correct the server-side TikTok scope mapping or URL construction.
- [x] Leave optional TikTok access unchecked on the initial connection.
- [x] Preserve capability-driven and incremental permission behavior.
- [x] Add a regression test for the provider rejection.

## Release and verification

- [x] Update documentation and release record.
- [x] Run targeted tests, full Core tests, formatting, build, and diff checks.
- [x] Commit and push the implementation.
- [ ] Verify the production Core health and OAuth URL behavior after the new release.
- [ ] Record final evidence and move the plan to `docs/plans/completed/`.
