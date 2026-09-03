# TikTok OAuth Scope Fix

**Status:** Active

**Owner:** Platform integrations

**Last updated:** 2026-09-03

## Objective

Make TikTok connection authorization reach the consent screen by sending only the scopes
supported by the configured TikTok Login Kit product, while preserving the capability-driven
permission flow used by the other social providers.

## Scope

### Included

- Trace the TikTok authorization URL from the access request through the provider adapter.
- Correct invalid or unsupported TikTok scope construction at its source.
- Keep the first-time permission modal from preselecting optional TikTok scopes.
- Add a regression test that fails on the current provider `scope` error.
- Update relevant connection and operational documentation and release evidence.

### Excluded

- TikTok app-console product setup or approval changes that require the user.
- Vercel deployment; frontend deployment remains user-owned.
- Unrelated provider adapters or permission-panel redesign.

## Context and constraints

- The provider fails before consent with `scope`, so the first boundary to verify is the
  authorization URL rather than token exchange.
- TikTok’s accepted scopes depend on the enabled Login Kit product and app configuration.
- The server must not claim access that TikTok did not return or that the app did not request.
- User-visible UI should continue to use the existing provider capability inventory.

## Implementation plan

1. [x] Reproduce the rejected TikTok scope with a deterministic URL/helper test.
2. [x] Align TikTok capability-to-scope mapping and authorization URL construction with the
   provider contract.
3. [x] Add regression coverage for requested scopes, encoding, and unsupported capabilities.
4. [x] Update documentation and release record.
5. [x] Run verification and commit/push the implementation; production release remains pending.

## Verification

- [x] Targeted TikTok tests: 2 passed; provider mapping regression passed.
- [x] Full Core tests/build: 257 passed, 3 environment-dependent ignored; build passed.
- [x] Client checks/build if frontend code changes: changed-file ESLint and client production build
  passed.
- [ ] Production smoke check: pending the new Core release from `main`.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| TikTok app configuration | Which Login Kit scopes are enabled in the production app? | User / Platform integrations | Pending provider-console verification |

## Release record

Change: Correct TikTok OAuth scope request construction.

Owner: Platform integrations.

Risk: standard.

Affected services and user surfaces: `kasitek-core`; Connections access panel; TikTok OAuth.

Platform release version or release ID: pending current UI follow-up commit.

API/schema/migration changes: not applicable.

Feature flag or rollout method: not applicable.

Analytics events and success metrics: not applicable; existing connection lifecycle analytics are
sufficient.

Logs, metrics, dashboards, and alerts: not applicable unless diagnosis identifies a new signal;
existing provider errors remain bounded and redacted.

User, API, internal, and operational documentation: updated `social-connections.md`,
`connection-failures.md`, and the Core README.

Validation evidence: the red-capable baseline-scope regression initially failed to compile because
the helper was absent; after implementation, targeted TikTok tests passed, the full Core suite
passed (257 passed, 3 environment-dependent ignored), the Core build passed, the changed frontend
file lint and client production build passed, rustfmt check passed, and `git diff --check` passed.

Rollback or disable plan: revert the implementation commit.

Post-release review date: 2026-09-09.

## Notes and blockers

The provider-console scope/product configuration may still require a user-side change for optional
access after the baseline connection succeeds. The UI follow-up was required because it had been
preselecting optional TikTok capabilities and bypassing the server baseline path.
