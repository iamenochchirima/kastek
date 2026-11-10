# Billing production rollout

This runbook moves the central billing service from Paystack sandbox to live. It assumes Growth
and Agents are the products in scope. Agency remains draft and read-only.

Status: prepared on 10 November 2026. Live mode has not been enabled. This is the final release
gate and requires explicit owner approval and live Paystack keys.

## Live plan matrix

| Product | Plan | Price | AI usage | Current test version | Live Paystack code |
| --- | --- | --- | --- | --- | --- |
| Growth | Starter | R350 | $10 | 2 | To record at publication |
| Growth | Growth | R999 | $25 | 2 | To record at publication |
| Growth | Scale | R1,999 | $60 | 2 | To record at publication |
| Agents | Starter | R350 | $10 | 4 | To record at publication |
| Agents | Growth | R999 | $25 | 3 | To record at publication |
| Agents | Scale | R1,999 | $60 | 3 | To record at publication |
| Agents | Reseller | R4,999 | $150 | 3 | To record at publication |

Free plans do not have Paystack codes.

## 1. Provision

- [ ] Choose and provision the billing hostname, target `billing.kasitek.co.za`.
- [ ] Create the production PostgreSQL database and credentials.
- [ ] Create the billing deployment secrets outside the repository:
  - `BILLING_DATABASE_URL`
  - `BILLING_INTERNAL_SECRET` (at least 32 bytes)
  - `BILLING_SNAPSHOT_SECRET` (at least 32 bytes)
  - `KASITEK_ADMIN_SERVICE_SECRET` (at least 32 bytes)
  - `PAYSTACK_MODE=live`
  - `PAYSTACK_LIVE_SECRET_KEY`
  - `BILLING_PUBLIC_URL=https://billing.kasitek.co.za`
  - `BILLING_RETURN_ORIGINS=https://app.kasitek.co.za,https://agents.kasitek.co.za`
  - `BILLING_FREE_PLANS_JSON={"growth":"growth-free","agents":"agents-free","agency":"agency-free"}`
  - `BILLING_TRIAL_PLANS_JSON={"growth":"growth-mid"}`
  - `BILLING_TRIAL_DAYS=14`
- [ ] Do not use test keys or test plan codes in this deployment.

## 2. Build and migrate

- [ ] Build the image with `SERVICE_PACKAGE=@kasitek/billing` and `SERVICE_PATH=services/billing`.
- [ ] Run `node dist/migrate-main.js` once.
- [ ] Run `node dist/seed-main.js` once.
- [ ] Apply the current plan definitions with `node dist/apply-plans.js` and
      `BILLING_PLAN_CODES_JSON` mapping each paid plan key to its live Paystack plan code.
- [ ] Start the API with `node dist/api-main.js`.
- [ ] Start the worker with `node dist/worker-main.js`.
- [ ] Confirm `/health/ready` succeeds.

## 3. Paystack live catalog

- [ ] Create or confirm live ZAR monthly plans for Growth Starter, Growth and Scale.
- [ ] Create or confirm live ZAR monthly plans for Agents Starter, Growth, Scale and Reseller.
- [ ] Verify each live plan amount matches the local plan version in the matrix above.
- [ ] Record each live plan code in this runbook before applying it.
- [ ] In Admin → Billing, set the live plan code on each draft version.
- [ ] Publish the versions.
- [ ] Confirm only one active version exists per plan and currency.
- [ ] Confirm existing subscribers remain pinned to their prior versions.

## 4. Register the webhook

- [ ] In Paystack, set the webhook URL to `https://billing.kasitek.co.za/webhooks/paystack`.
- [ ] Remove or repoint the legacy `https://dev-client.kasitek.co.za/api/webhooks/paystack` entry.
- [ ] If Paystack does not allow removing the legacy entry, leave it and monitor its failure count. The central billing endpoint remains authoritative; do not treat the legacy route as a billing source.
- [ ] Confirm the live secret key is the webhook signing key.
- [ ] Send a test event and confirm it reaches the service.
- [ ] Confirm a duplicate delivery is idempotent.
- [ ] Confirm an invalid signature returns `401` without state changes.

## 5. Configure products

- [ ] Set Growth `BILLING_SERVICE_URL`, `BILLING_SERVICE_SECRET`, `BILLING_SNAPSHOT_SECRET`.
- [ ] Set Agents `BILLING_SERVICE_URL`, `BILLING_SERVICE_SECRET`, `BILLING_SNAPSHOT_SECRET`.
- [ ] Set `AGENTS_BILLING_ENFORCEMENT=1`.
- [ ] Keep Agency enforcement off while its plans are draft.
- [ ] Add the billing return origins to the product origins.

## 6. Live verification

- [ ] Buy Growth Starter with a real card.
- [ ] Confirm one billing account, one Paystack customer, one paid invoice, an active subscription
      and USD 10.00 AI usage.
- [ ] Buy Agents Starter with the same owner identity and billing email.
- [ ] Confirm the Agents workspace links to the same billing account, with a second subscription and
      a second invoice.
- [ ] Confirm the product entitlement snapshots update.
- [ ] Process a live renewal.
- [ ] Process a live refund and confirm only that subscription's unspent plan usage is revoked.
- [ ] Fail a payment and confirm grace, read-only access and recovery.
- [ ] Confirm the public pricing pages show the live prices and canonical URLs.
- [ ] Resolve any reconciliation issue from the admin screen.

## 7. Monitoring and rollback

- [ ] Alert on billing API health, worker heartbeat, webhook failures, reconciliation backlog,
      Paystack verification failure and invoice-number gaps.
- [ ] Watch `billing.webhook_events` for `failed`, `ignored` and duplicate deliveries.
- [ ] Watch `ai_allowance_exhausted` and `BILLING_AI_ALLOWANCE_EXHAUSTED` denial events.
- [ ] Back up the billing database and confirm restore.
- [ ] Rollback a bad plan by retiring the active version and republishing the previous version.
- [ ] Rollback a deployment by restoring the prior image; do not restore Growth's removed local
      billing implementation.
- [ ] If live checkout must stop, disable the plan versions before changing the webhook or keys.
- [ ] Record the live release, commit, plan versions, plan codes and first-payment evidence in the
      release record.

## 8. Release record

- [ ] Record the publication date.
- [ ] Record the live plan-code matrix in this runbook.
- [ ] Record the first live checkout and webhook references.
- [ ] Record any blocked target or excluded deployment.
