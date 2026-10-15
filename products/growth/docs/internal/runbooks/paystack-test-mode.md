# Paystack Test-Mode Validation

Run this procedure with a dedicated internal organisation before configuring live Paystack keys. It verifies the server path from checkout creation through webhook handling and subscription cancellation. It does not grant access from a browser redirect.

## Preconditions

- Set `PAYSTACK_MODE=test` and provide only `PAYSTACK_TEST_SECRET_KEY`.
- Point Paystack's test webhook configuration at `POST /api/webhooks/paystack` on the environment under test.
- Configure an active product plan with the matching Paystack test plan code.
- Use a dedicated internal organisation and an organisation owner account.

## Procedure

1. Start checkout from Billing and usage and complete the Paystack test payment.
2. Confirm the browser return only reports status; verify the server receives either the signed `charge.success` webhook or performs transaction verification.
3. Confirm one `BillingCheckout` is `COMPLETED`, one organisation subscription has the intended plan, and only that organisation receives its entitlement.
4. Confirm one `BillingInvoice` exists with the internal invoice number and retained provider transaction reference. If Paystack returns an invoice code during subscription reconciliation, confirm it is stored as `providerInvoiceId`.
5. Re-deliver the same webhook and confirm no duplicate checkout, subscription, or invoice appears.
6. Trigger an unsuccessful payment or `invoice.payment_failed` test event and confirm the subscription moves to `PAST_DUE` without granting a new entitlement.
7. Cancel and reactivate the test subscription through Billing and usage. Confirm the provider state, `cancelAtPeriodEnd`, and server state reconcile correctly.
8. Review open reconciliation issues in the internal billing controls and resolve any unexpected mismatch before proceeding.

## Evidence to retain

- Checkout reference and Paystack transaction ID
- Webhook event key and processing status
- Subscription and invoice external references
- Screenshots or request logs for duplicate, failed-payment, cancellation, and reactivation checks

Do not switch `PAYSTACK_MODE` to `live` until this procedure succeeds and the merchant-market recurring decision is approved.
