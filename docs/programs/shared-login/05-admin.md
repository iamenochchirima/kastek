# Central Admin sign-in

Status: Draft follow-on. UI owner: Labs. Current authentication/API owner: Growth Core.
Outcome: Central staff use the shared identity authority with explicit administrative entitlement and optional two-factor authentication, independently of customer roles.
Dependencies: Labs contract, Growth pilot, and accepted staff entitlement rules. Two-factor authentication is optional for administrators by owner decision.

## Work

- [ ] Inventory Labs Admin login/session forwarding and Growth Core AdminUser authentication/authorization.
- [ ] Define staff entitlement ownership, new staff-account provisioning, permitted admin roles, and recovery/offboarding.
- [ ] Register a separate privileged OIDC client. Offer optional two-factor authentication and recovery codes. Enforce staff entitlement without introducing mandatory MFA.
- [ ] Define the authenticated interface from Labs Admin to Growth/Agency administrative endpoints. Those endpoints must enforce staff entitlement and the intended operation, not trust a browser role or customer token.
- [ ] Replace existing admin login/session behavior without copying credentials or granting customer accounts administrative access.
- [ ] Implement bounded disable/revocation and audited staff access; agree an emergency recovery path.
- [ ] Define administrative identity and API ownership for the new sign-in flow.

## Minimum verification

- [ ] A regular signed-in customer is denied central Admin.
- [ ] An entitled staff user reaches Admin with or without optional two-factor authentication; enrolled users can use recovery codes.
- [ ] Role removal and suspension revoke access within the chosen bound.
- [ ] Wrong-client tokens, expired/replayed sessions, and forged role claims are rejected.
- [ ] Approved administrative calls succeed and produce redacted audit records.

## Release and rollback

Build with fresh test staff accounts and one privileged sign-in flow. Record release/schema revisions, login/denial/audit metrics, documentation, and operational recovery before deployment. Do not add a legacy-login fallback.
