# Agent operations incident runbooks

These runbooks are the operator response attached to the protected Operations console. They use
only organization/resource identifiers and projection state; operators must not copy prompts,
tokens, provider credentials, or raw customer payloads into tickets or chat.

## Provider or model outage

1. Check the `provider_workers`, `health`, and `alerts` projections.
2. Confirm the provider credential status and affected capability without opening credential data.
3. Enable the narrowest applicable kill switch, record the incident reason, and require the second
   operator for the command.
4. Leave existing effect receipts unchanged until the provider outcome is known; reconcile only
   `unknown` receipts with a provider receipt or explicit failure.
5. Rebuild projections after recovery and disable the switch through an audited command.

## Queue backlog or stuck run

1. Compare the run-health projection with the recent run list and Temporal readiness.
2. Cancel only the affected run when cancellation is safe; do not retry an ambiguous provider effect.
3. Record the incident correlation ID and acknowledge the generated notification.
4. Rebuild projections after the worker recovers and verify the run reaches a terminal state.

## Database authorization or tenant-isolation alert

1. Check `kasitek.database.authorization_failure.count` and
   `kasitek.database.context_missing.count` for the affected service, release, and time window.
2. Treat any `context_missing` event as a fail-closed background-process defect. Pause the
   affected worker or maintenance job before retrying it; do not weaken RLS or grant `BYPASSRLS`.
3. For repeated authorization failures, inspect the migration version, runtime database role,
   and process scope. Expected restricted-role negative tests are not production incidents.
4. If a production path is denied unexpectedly, roll back the compatible application artifact or
   disable only the affected policy set through the reviewed administrative migration procedure.
5. Record the release ID, migration version, bounded process name, and outcome. Do not copy tenant
   payloads, credentials, or SQL parameter values into the incident record.

## Duplicate or ambiguous effect

1. Open the effect identifier and confirm it is `unknown` and `reconciliation_required`.
2. Do not invoke the provider again. Request the exact outcome through the dual-control reconcile
   command and keep provider receipts redacted in the console.
3. Verify the receipt is terminal and that the reconciliation notification is acknowledged.

## Credential compromise or data-access incident

1. Revoke the affected installation credential or support grant immediately.
2. Scope any investigation grant to one organization/resource, provide a reason, and use the
   shortest duration possible. Grant expiry and revocation are audited automatically.
3. Search by correlation, run, effect, or delivery ID; never search for or export secrets.
4. Enable the narrowest kill switch if effects must stop, preserve the audit trail, and escalate
   to security/owner review.

## Webhook or delivery storm

1. Check the delivery-health and alerts projections for the failed/unknown attempt count and the
   affected organization or channel identifiers.
2. Pause only the affected scope; do not replay a delivery without its idempotency key and an
   attributable incident reason.
3. Verify provider status, acknowledge the notification, and rebuild projections after the queue
   drains.
