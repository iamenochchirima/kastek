# Billing Support Runbook

This runbook covers direct Kasitek workspace billing. It does not cover the white-label tenant platform.

## Before changing access

Identify the organisation, checkout reference, internal subscription, and provider subscription code. Check the latest `BillingCheckout`, `OrganizationSubscription`, `PaystackWebhookEvent`, and `BillingReconciliationIssue` records before creating a manual grant or editing subscription state.

Do not use a successful browser return as proof of payment. Use a completed internal checkout, a signed processed webhook, or a successful server verification result.

## Payment completed but access is missing

1. Find the checkout by reference and confirm it belongs to the reported organisation.
2. Check `status` and the normalized `providerResponse`.
3. Run `POST /api/admin/billing/reconcile/paystack` if the checkout is still `PENDING` after the normal worker interval.
4. Inspect open reconciliation issues and failed webhook records.
5. Confirm the plan is active and still maps to the expected Paystack plan code.
6. Use a time-bound manual grant only when service must be restored before the provider issue is resolved. Record the support case in the grant reason.

## Failed recurring payment

An `invoice.payment_failed` event or Paystack `attention` subscription state changes the internal subscription to `PAST_DUE`. The current resolver does not grant paid product access for `PAST_DUE`.

Confirm the event is signed and linked to the correct provider subscription. Ask the customer to correct the payment method through the approved Paystack management flow when that flow is enabled. Do not change the subscription back to `ACTIVE` manually; reconciliation or a verified provider event must do that.

## Refunds

A processed full refund changes the matching checkout to `REVERSED` and cancels only the subscription created from that checkout. It does not cancel a later replacement subscription.

Partial refunds and refunds whose amount cannot be matched to a verified transaction create an open reconciliation issue. Review those manually because a partial refund does not always mean access should be removed.

## Disputes

`charge.dispute.create` creates an open reconciliation issue. It does not remove access automatically because a dispute is not a completed reversal. Review the case in Paystack, preserve relevant service records, and resolve access only after the dispute outcome or an approved internal decision.

## Incorrect usage

Usage events are append-only and idempotent. Do not delete or rewrite the original event. Record a compensating usage event with the same organisation, product, and metric, a negative quantity, a support-case source, and a new idempotency key. Verify the current-period aggregate after the correction.

## Manual access correction

Manual grants require a reason and actor. Use an expiry unless the grant represents an approved permanent internal entitlement. Expire the grant after provider access is restored so it does not mask future subscription failures.

## Closing reconciliation issues

Subscription state mismatch issues resolve automatically after a later reconciliation confirms the internal and provider states agree. Verification failures remain open until a successful provider check. Refund and dispute issues require operator review; do not mark them resolved until the access decision and provider outcome are recorded.
