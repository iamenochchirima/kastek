# Analytics scope-isolation incident

**Version:** A-03 foundation
**Severity:** P0

Treat suspected cross-organization, tenant-workspace, or tenant-client access as a security and
privacy incident. Do not continue exploratory queries against production data.

## Immediate actions

1. Stop the affected reporting or export surface through the narrowest approved control.
2. Preserve audit records, service revision, request correlation IDs, and authorization decisions.
3. Revoke the affected grant or service identity if that is safe and audited.
4. Notify Security and the Analytics owner. Do not redact or rewrite immutable facts in place.
5. Identify potentially exposed scopes using access-controlled audit data only.

## Required investigation

The completed implementation must test reporting, cache, export, alert, scheduled-report, replay,
and agent-readable paths. It must prove that client administrators cannot read workspace-wide data
without an explicit grant, revoked grants stop authorizing new requests, producers cannot publish
unauthorized scope kinds, and hierarchy replay cannot change ownership.

## Close criteria

- The vulnerable path is disabled or corrected and verified by the isolation matrix.
- Access review, notification, retention, and deletion obligations are recorded.
- A forward migration or code fix is deployed without mutating historical facts.
- Security signs off with evidence and a follow-up prevention item.
