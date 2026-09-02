# Connection Permission State Fix Checklist

**Status:** Active

## Diagnosis

- [x] Confirm Bluesky deletion is implemented but absent from the provider capability map.
- [x] Confirm Threads stores the provider token `scope` field directly, which can be absent after
      long-lived token exchange.
- [x] Confirm Threads authorization attempts retain the effective capability set used for consent.

## Implementation

- [x] Map Bluesky `SOCIAL_POST_DELETE` to its repository-post permission.
- [x] Persist a verified Threads scope fallback when the token response omits `scope`.
- [x] Preserve additive authorization behavior and reject unsupported or unverified claims.
- [x] Add regression coverage for both reported UI states.

## Release and verification

- [x] Update public and internal documentation.
- [x] Run targeted tests, full Core tests, formatting, build, and diff checks.
- [ ] Commit and push the implementation.
- [ ] Deploy the tested Core artifact and verify health.
- [ ] Record final commit/deployment evidence and move the plan to `docs/plans/completed/`.
