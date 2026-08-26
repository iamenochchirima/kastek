---
title: KasiTek Referral Program Implementation Plan
slug: /architecture/referral-program-implementation-plan
sidebar_position: 8
---

# KasiTek Referral Program Implementation Plan

**Status:** Implementation complete — launch sign-off pending

**Owner:** Product and Engineering

**Last updated:** 2026-08-26

## Objective

Create a referral loop that rewards an existing KasiTek customer when a genuinely new
organisation becomes a paying customer through that customer's referral link.

The first release is a credit incentive, not a cash affiliate programme. A signup or trial is
not enough to earn a reward. The referred organisation must complete a verified first paid
activation, and every reward must be idempotent, expiring, auditable, and reversible.

Success means that a customer can share a link, the new organisation can complete signup and
payment without losing attribution, both sides can see the referral status, and billing retries,
refunds, chargebacks, and abuse do not create unbounded credit liability.

## Existing implementation

The repository already contains the foundation:

- Every organisation can receive one active `ReferralCode`.
- Signup and the Google callback accept `referralCode` and attribute it to the newly created
  organisation.
- `ReferralAttribution` stores one attribution per referee organisation.
- Referral qualification is called from verified paid activation, not from signup or trial
  creation.
- `qualify_referral` grants configurable credits to both organisations using idempotency keys.
- Current defaults are 1,000 credits for the referrer, 500 credits for the referee, and a
  365-day reward expiry.
- `/api/billing/credits` already returns the current organisation's referral code.

The technical implementation now covers the first release lifecycle. The remaining decisions are
commercial and operational: approve the defaults, exercise the live Paystack environment, and
decide when to enable a monitored cohort.

## Implementation progress

As of 2026-08-26, the implementation is complete for the technical launch slice:

- Referral terms now include a 90-day attribution window and are snapshotted on attribution.
- `attributionCount` is separate from qualified `redemptionCount`.
- Same-owner self-referrals are rejected, and duplicate attribution is idempotent.
- Attribution expiry is enforced during referral reads and qualification.
- Billing exposes the share URL, terms, counts, and recent referral statuses.
- Full refunds trigger an idempotent referral reversal. Unused reward lots receive append-only
  `REVOKE` ledger entries; consumed or reserved credits remain visible for support review.
- Refund and dispute provider events are covered: full refunds reverse rewards, while disputes
  create an auditable reconciliation issue for manual review.
- Support/admin endpoints and a correction surface now cover code disable/enable, attribution
  rejection, reward reversal, filtering, and audit references.
- A disposable migrated PostgreSQL integration test covers attribution, duplicate callbacks,
  qualification, provider refund handling, reversal, and compensating ledger entries.

The remaining launch gates are commercial approval, a real Paystack test-mode run, and a small
cohort/monitoring decision. The technical defaults below are implemented; they are not a substitute
for product or finance approval.

## Product contract for the first release

These are the implemented launch defaults. Product and finance should approve them before public
enablement.

| Rule | Recommended behaviour |
| --- | --- |
| Reward type | KasiTek credits only; no cash withdrawal, transfer, or resale |
| Referrer | A verified organisation with an active referral code |
| Referred customer | A new billable organisation with no previous paid activation |
| Attribution | The first valid referral code attached to the new organisation wins |
| Attribution window | 90 days from attribution; an unqualified attribution then expires |
| Qualification | The referred organisation completes its first verified paid activation |
| Rewards | One reward for the referrer and one for the referee per qualified referral |
| Current reward amounts | Referrer: 1,000 credits; referee: 500 credits |
| Reward expiry | 365 days from award, subject to the existing credit-lot expiry rules |
| Self-referral | Reject the same organisation and the same owner account; do not award either side |
| Multiple referrers | Only the first valid attribution receives credit |
| Trial signup | No reward; the attribution remains pending until paid activation |
| Referral code | One stable, copyable code and share URL per organisation |
| Limits | Make qualified-redemption limits configurable; do not count raw signups as redemptions |

The first release should not promise a reward based on a referred organisation merely starting a
trial. That would reward low-intent signups and make credit cost difficult to control.

## Referral lifecycle

```text
Share link
   -> signup / Google callback
   -> ATTRIBUTED
   -> verified first paid activation
   -> QUALIFIED
   -> reward eligibility / payment review window
   -> AWARDED
   -> expiry, reversal, or normal credit consumption
```

### State rules

- `ATTRIBUTED`: a valid code was attached to a new organisation. No reward exists yet.
- `QUALIFIED`: the first paid activation was verified and the referral passed eligibility checks.
- `AWARDED`: both idempotent credit grants were created successfully.
- `EXPIRED`: the attribution window ended before qualification, or an awarded credit lot
  expired through the normal credit lifecycle.
- `REJECTED`: the code, owner relationship, payment, or abuse review made the referral
  ineligible.
- `REVERSED`: a previously qualified referral was invalidated by refund, chargeback, or a
  confirmed abuse decision.

If a payment provider supports a meaningful refund or chargeback window, the safer model is to
award the referee immediately after verified activation and hold the referrer's reward until the
configured review window ends. If the business chooses immediate two-sided rewards, reversal
must still be implemented before public launch.

## Abuse and eligibility controls

The system should protect credits without requiring invasive device fingerprinting in the first
release.

### Required controls

- Reject codes owned by the same organisation.
- Reject codes where the referrer and referee have the same owner account.
- Require verified payment, not only a verified email or completed trial.
- Allow one attribution per referee organisation and one qualified referral per qualifying
  payment lifecycle.
- Store the referral terms and reward amounts used for each attribution.
- Make code status, attribution, qualification, award, and reversal transitions idempotent.
- Do not count attributed signups against a qualified-redemption limit.
- Preserve the payment reference, subscription/invoice reference, and referral attribution ID on
  every reward grant.
- Give support an explicit disable/reject/reverse operation with a reason and audit reference.
- Alert on unusually high referral volume, repeated owner/payment identities, or rapid reward
  consumption rather than silently awarding unlimited credits.

### Later controls if abuse appears

- A per-referrer qualified referral cap per period.
- A one-reward-per-billing-customer rule across multiple organisations.
- Manual review for unusually high-value or high-volume referral activity.
- Additional provider identity checks using Paystack customer and transaction identifiers.

## Backend and data work

### Schema and migration

- [x] Add explicit attribution expiry and reward-term snapshot fields to
  `ReferralAttribution`.
- [x] Add award/reversal timestamps and reasons, or introduce a small immutable referral event
  table for state transitions.
- [x] Add a qualified redemption counter or calculate qualified counts from attributions; stop
  using `redemptionCount` for raw signup limits.
- [x] Add a unique/idempotent reference for the qualifying payment or invoice lifecycle.
- [x] Add a `REVERSED` status and preserve the original award metadata.
- [x] Add indexes for pending attribution expiry, qualification review, referrer status, and
  payment reference lookups.
- [x] Snapshot reward amounts, expiry, and programme version when attribution is created.
- [x] Keep credit corrections append-only: unused rewards may be expired/revoked through the
  credit service; consumed rewards require a compensating ledger entry or a separately approved
  negative-balance policy. This release leaves consumed or reserved amounts for explicit support
  review rather than creating an automatic negative balance.

### Referral service

- [x] Separate `attribute`, `qualify`, `award`, `expire`, and `reverse` operations.
- [x] Make every state transition conditional on the current state.
- [x] Ensure partial award failure is safe to retry: referrer and referee grants must use stable
  idempotency keys.
- [x] Add an attribution-expiry worker or include expiry processing in the existing scheduled
  credit lifecycle worker.
- [x] Add a billing-event handler for refunds, chargebacks, and cancelled initial payments.
- [x] Add support/admin operations for disable code, reject attribution, reverse reward, and
  inspect the full referral timeline.
- [x] Return stable reason codes for invalid, expired, self, duplicate, and unavailable codes.

### API contract

- [x] Extend `GET /api/referrals` or the billing credits response with:
  - `code`;
  - canonical `shareUrl`;
  - reward amounts and expiry terms;
  - total attributed, pending, qualified, awarded, expired, and reversed counts;
  - recent referral statuses and dates.
- [x] Keep referral attribution internal to signup/auth flows; do not let an authenticated user
  arbitrarily reassign an existing organisation's attribution.
- [x] Keep recent history bounded to 25 records in the billing response; a separate history
  endpoint is not required for the first release.
- [x] Add admin endpoints for programme settings and support actions with explicit permissions.

## Client experience

The referral experience belongs in Billing, next to credits, rather than on the workspace
overview.

### Referral card

- Show the reward in credits, not a cash equivalent.
- Show the share link with a copy action.
- Show a compact status summary: pending, rewarded, expired, or reversed.
- Show the referral terms in one short sentence.
- Show recent referrals without exposing unnecessary customer information; use masked names or
  dates where appropriate.
- Show a clear pending state after signup and before payment.
- Show a success toast after copying the link or after a reward becomes available.

### Signup and payment

- Preserve referral codes through password signup, email verification, and Google signup.
- Show that a referral was applied without allowing the new user to silently replace it after
  attribution.
- Keep payment return pages informational; only verified provider events qualify a referral.
- After payment, show the pending/awarded state from the server rather than assuming the reward
  is immediate.

## Measurement and economics

Track the funnel by programme version and referrer organisation:

- links copied and referral visits;
- attributed organisations;
- attribution-to-trial conversion;
- trial-to-paid conversion;
- qualified and awarded referrals;
- time from attribution to paid activation;
- credit rewards issued and consumed;
- refunds, chargebacks, reversals, and suspected abuse;
- retained revenue and gross-margin payback after reward cost.

The programme should be reviewed after the first cohort before increasing rewards or removing
limits. Credits are not cash, but they represent future provider and infrastructure cost, so the
reward should be sized against the expected retained value of a new paying organisation.

## Implementation phases

### Phase 0 — Approve the commercial contract

- [ ] Confirm reward amounts: current defaults are 1,000 / 500 credits.
- [ ] Confirm the 90-day attribution window.
- [ ] Confirm immediate awards versus a referrer hold/review window.
- [ ] Confirm 365-day reward expiry.
- [ ] Confirm whether codes are available to trial organisations or only paid organisations.
- [ ] Confirm qualified-redemption limits and support review thresholds.
- [ ] Document refund, chargeback, cancellation, and abuse policy.

### Phase 1 — Harden the existing lifecycle

- [x] Add schema fields and migration.
- [x] Fix redemption counting so only qualified referrals consume programme limits.
- [x] Snapshot reward terms.
- [x] Add owner-account self-referral validation.
- [x] Add attribution expiry and full-refund reversal paths.
- [x] Add support correction paths.
- [x] Add service tests and an ignored database transaction test.

### Phase 2 — Expose the product

- [x] Add referral summary/history API.
- [x] Add the billing referral card and copyable share URL.
- [x] Add pending, awarded, expired, and reversed states.
- [x] Add concise referral terms and responsive treatment.
- [x] Add admin/support inspection and correction UI.

### Phase 3 — Verify and pilot

- [x] Run a local end-to-end flow with two organisations and a fake verified payment.
- [ ] Exercise Paystack test-mode payment, webhook, retry, and reconciliation paths.
- [ ] Launch to a small internal or invited customer cohort.
- [ ] Monitor qualification, reward cost, payment retention, and abuse signals.
- [ ] Review the first cohort before public enablement.

The unchecked Phase 3 items require live provider credentials, an approved cohort, and an
operational owner. They are launch gates, not unimplemented code.

## Verification checklist

### Attribution

- [ ] A referral code is generated once per organisation.
- [ ] A share link opens signup with the code intact.
- [ ] Password signup preserves attribution through email verification.
- [ ] Google signup preserves attribution through the OAuth callback.
- [ ] Invalid, disabled, expired, duplicate, and self-referral codes are handled without breaking
      signup.
- [ ] The first valid attribution wins and cannot be overwritten by a later code.

### Qualification and rewards

- [x] Trial creation does not award credits.
- [x] A verified first paid activation qualifies exactly once.
- [x] Referrer and referee grants are created exactly once.
- [x] Duplicate checkout verification, webhook delivery, and reconciliation do not duplicate
  rewards.
- [x] Partial grant failure is retry-safe.
- [x] Reward expiry is visible and enforced by the credit ledger.
- [x] Attribution expiry prevents late qualification.

### Reversal and abuse

- [x] Refund and chargeback events reverse or queue review according to the implemented manual
      dispute-review policy.
- [x] Unspent rewards can be revoked without editing ledger history.
- [x] Consumed or reserved rewards remain auditable and require an explicit support decision before
      any balance adjustment.
- [x] Same-owner self-referrals are rejected.
- [x] Qualified limits count qualified customers, not signups.
- [x] Organisation isolation is maintained for codes, status, history, and credit grants.

### Client and operations

- [x] Billing shows the code, share URL, terms, counts, and recent statuses.
- [x] Copy/share actions have responsive desktop/mobile treatment.
- [x] Payment return UI does not claim a reward before the server confirms it.
- [x] Admin support can inspect and correct a referral with an audit reason.
- [x] Rust tests, migration checks, client type checks, and lint pass.
- [ ] Targeted browser checks pass; no connected browser session was available in this environment.

## Open decisions

| Topic | Current proposal | Owner | Status |
| --- | --- | --- | --- |
| Referrer reward | 1,000 credits | Product/Finance | Implemented default; approval pending |
| Referee reward | 500 credits | Product/Finance | Implemented default; approval pending |
| Attribution window | 90 days | Product | Implemented default; approval pending |
| Reward expiry | 365 days | Product/Finance | Implemented default; approval pending |
| Award timing | Immediate two-sided reward; full-refund reversal; dispute manual review | Product/Finance | Implemented default; approval pending |
| Code eligibility | Verified organisations, with paid qualification | Product | Implemented default; approval pending |
| Referral caps | Configurable qualified-redemption cap and support review | Product/Engineering | Implemented default; approval pending |
| Refund/chargeback | Full refunds reverse; disputes queue manual review | Product/Finance/Engineering | Implemented default; approval pending |
| Account-level duplicate rule | Organisation-level first; strengthen to billing-account level if abuse appears | Product/Engineering | Proposed |

## Working rules

- Update this document whenever a commercial rule is settled.
- Do not mark a referral phase complete until the lifecycle has an end-to-end test.
- Keep referral rewards separate from subscription entitlement and recurring invoice credit
  application.
- Preserve all referral and credit history; corrections use compensating operations.
- Version reward terms so a later programme change does not silently change an already-promised
  referral.
