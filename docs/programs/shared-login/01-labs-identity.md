# Labs identity foundation

Status: Draft. Owner repository: kasitek-labs.
Outcome: Products can authenticate a person through one Labs-owned authority without sharing their databases or application cookies.
Dependencies: Follow the accepted policy in IMPLEMENTATION.md. Configure exact issuer/origins and settle the revocation delay.

## Work

- [ ] Configure the selected Keycloak provider and document hosting, backups, email delivery, recovery, configuration export, and operational ownership.
- [ ] Define issuer/discovery, signing-key rotation, client registration, permitted algorithms, issuer/subject mapping, and verified-email behavior.
- [ ] Register separate development clients for Growth and later products. Use exact approved callbacks and audience restrictions; keep secrets server-side.
- [ ] Enforce 7-day inactivity and 30-day absolute limits, browser-wide shared logout, and separate all-device logout. Define account disable. Select a bounded revocation delay and implement the provider/product mechanism that enforces it. Provider logout alone must not leave unbounded local sessions.
- [ ] Configure open registration, verified email/password and reset, Google, passkeys, optional two-factor authentication for all users including administrators, and recovery codes. Require authenticated enrollment of additional methods.
- [ ] Provide isolated local configuration and a runbook. Add a shared adapter only after Growth identifies concrete repeated client logic.
- [ ] Update the existing Proposed Labs ADR with the owner's accepted choices; keep unresolved items explicit.

## Minimum verification

- [ ] A synthetic user completes Growth-client code flow with PKCE.
- [ ] Reject wrong client/redirect, replayed code, invalid signature/issuer/audience, and expired token.
- [ ] Verify key rotation and account-disable/logout behavior against the agreed propagation interval.
- [ ] Inspect logs to confirm codes, tokens, and credentials are absent.

## Release and rollback

Use a development issuer first. No production account import, client registration, DNS change, or deployment is part of planning. Before rollout, record release/config revision, operator, login error metrics, documentation, restore procedure, and disabled-provider behavior. Preserve previous provider configuration and keys for their required validation window.
