# Billing production rollout

This runbook moves the central billing service from Paystack sandbox to live. It assumes Growth
and Agents are the products in scope. Agency remains draft and read-only.

## 1. Provision

- [ ] Choose the billing hostname, for example `billing.example.com`.
- [ ] Create the production PostgreSQL database and credentials.
- [ ] Create the billing deployment secrets outside the repository:
  - `BILLING_DATABASE_URL`
  - `BILLING_INTERNAL_SECRET` (at least 32 bytes)
  - `BILLING_SNAPSHOT_SECRET` (at least 32 bytes)
  - `KASITEK_ADMIN_SERVICE_SECRET` (at least 32 bytes)
  - `PAYSTACK_MODE=live`
  - `PAYSTACK_LIVE_SECRET_KEY`
  - `BILLING_PUBLIC_URL=https://billing.example.com`
  - `BILLING_RETURN_ORIGINS=https://growth.example.com,https://agents.example.com`
  - `BILLING_FREE_PLANS_JSON={"growth":"growth-free","agents":"agents-free","agency":"agency-free"}`
  - `BILLING_TRIAL_PLANS_JSON={"growth":"growth-mid"}`
  - `BILLING_TRIAL_DAYS=14`
- [ ] Do not use test keys or test plan codes in this deployment.

## 2. Build and migrate

- [ ] Build the image with `SERVICE_PACKAGE=@kasitek/billing` and `SERVICE_PATH=services/billing`.
- [ ] Run `node dist/migrate-main.js` once.
- [ ] Run `node dist/seed-main.js` once.
- [ ] Start the API with `node dist/api-main.js`.
- [ ] Start the worker with `node dist/worker-main.js`.
- [ ] Confirm `/health/ready` succeeds.

## 3. Paystack live catalog

- [ ] Create or confirm live ZAR monthly plans for Growth Entry, Growth Mid and Growth Scale.
- [ ] Create or confirm live ZAR monthly plans for Agents Starter and Agents Growth.
- [ ] Verify each live plan amount matches the local plan version.
- [ ] In Admin → Billing, set the live plan code on each draft version.
- [ ] Publish the versions.
- [ ] Confirm only one active version exists per plan and currency.

## 4. Register the webhook

- [ ] In Paystack, set the webhook URL to `https://billing.example.com/webhooks/paystack`.
- [ ] Confirm the live secret key is the webhook signing key.
- [ ] Send a test event and confirm it reaches the service.
- [ ] Confirm a duplicate delivery is idempotent.

## 5. Configure products

- [ ] Set Growth `BILLING_SERVICE_URL`, `BILLING_SERVICE_SECRET`, `BILLING_SNAPSHOT_SECRET`.
- [ ] Set Agents `BILLING_SERVICE_URL`, `BILLING_SERVICE_SECRET`, `BILLING_SNAPSHOT_SECRET`.
- [ ] Set `AGENTS_BILLING_ENFORCEMENT=1`.
- [ ] Keep Agency enforcement off while its plans are draft.
- [ ] Add the billing return origins to the product origins.

## 6. Live verification

- [ ] Buy Growth Entry with a real card.
- [ ] Confirm one billing account, one Paystack customer, one paid invoice, an active subscription and
      USD 5.00 AI usage.
- [ ] Buy Agents Starter with the same owner identity and billing email.
- [ ] Confirm the Agents workspace links to the same billing account, with a second subscription and
      a second invoice.
- [ ] Confirm the product entitlement snapshots update.
- [ ] Process a live renewal.
- [ ] Process a live refund and confirm only that subscription's unspent plan usage is revoked.
- [ ] Fail a payment and confirm grace, read-only access and recovery.
- [ ] Resolve any reconciliation issue from the admin screen.

## 7. Monitoring and rollback

- [ ] Alert on billing API health, worker heartbeat, webhook failures, reconciliation backlog,
      Paystack verification failure and invoice-number gaps.
- [ ] Back up the billing database and confirm restore.
- [ ] Rollback a bad plan by retiring the version and republishing the previous version.
- [ ] Rollback a deployment by restoring the prior image; do not restore Growth's removed local
      billing implementation.
- [ ] Record the live release, commit, plan versions and first-payment evidence in the release record.
