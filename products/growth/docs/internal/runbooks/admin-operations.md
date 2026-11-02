# Growth operations

The central Operations page exposes Growth-owned webhook recovery and support grants.
It no longer proxies the retired agent installation/run/Temporal operator API.

## Recover a public webhook

1. Open Operations and inspect the failed delivery identifier and attempt count.
2. Request replay with the expected attempt count and a stable command identity.
3. Have a different authorized operator approve the command.
4. Inspect the existing delivery state after the worker retries it.

A stale attempt count or reused command with changed input must conflict. Do not edit payloads
or destination secrets while replaying a delivery.

## Investigate customer data

1. Create a support grant scoped to the required organization/resource, with a reason and expiry.
2. Use the supported admin business view under that grant.
3. Revoke the grant when the investigation ends.

Support grants do not grant shared execution control. For agent incidents, inspect the owning
Agents service using its current task/operation identifiers and current authorization.
Do not restore obsolete installation credentials, disable tenant checks, or place secrets or
customer message text in logs.

## Admin lists and failed requests

The central admin applies filters and bounded pages in the Growth API. Web services, outreach
campaigns, campaign leads and delivery attempts accept `page`, `limit` and `paginate=true`.
Normal page sizes are at most 200. Delivery CSV exports include at most 20,000 matching attempts.
Cards marked "on page" describe only that page. Delivery totals describe all matching attempts.

Use Retry after a failed page read. Do not treat unavailable results as zero or an empty catalogue.
When a partial bulk lead action fails, refresh and retry only records still requiring the action.
Do not recreate a Web services collection-delete route; that action is unsupported.

### Commercial send recovery and invoice cycles

The admin lead **Send attempts** dialog displays durable SMTP attempts. A submitting or uncertain
attempt blocks another submission for that lead. Reconcile against the provider's authoritative
message evidence. Record the accepted recipients and confirmed rejection for the others, or
explicit non-submission, with an evidence reference. Only rejected or verified non-submitted
attempts can be retried. SMTP acceptance is separate from delivery; the admin does not infer delivery.
A failed result transaction leaves the original submitting claim intact.

Growth owns `AdminOutreachSendAttempt` and `AdminCommercialAudit`. The release must apply
`20261023095000_admin_commercial_safety` before enabling the changed controls. To disable,
stop SMTP submission and invoice mutations; retain both tables and reconcile pending attempts.
Logs must not contain mail bodies, credentials, or recipient addresses. Audit details record bounded
outcome/evidence and actor IDs; operators must avoid putting customer content in evidence notes.

Invoice list/detail GETs do not generate cycles or notifications. On an invoice detail page,
**Update cycle** explicitly materializes that invoice's cycle. Authorized automation may POST
`/api/admin/invoices/materialize` to refresh all invoices; no schedule is installed by this change.
Invoice create, edit, delete, cycle actions, and materialization commit their audit with their writes.
Sent/reminded controls record external bookkeeping only and make no provider call.

Release impact: standard risk; Growth API, Growth schema, and admin UI. No new analytics events
or telemetry exporter changes (not applicable); transactional audit is the operational evidence.
Release identity is the implementation Git commit until an owner-authorized release is prepared.
Validation uses isolated SQL fixtures and provider doubles. Deployment, live sends, and owner evals
are outside development verification. Revert application controls to disable; do not delete attempts
or audit rows during rollback. Production retention/alerts remain release-owner decisions.
