---
title: Platform 0.9.9 release record
owner: platform engineering
last_reviewed: 2026-11-15
---

# Platform 0.9.9 release record

Change: Simplify Growth's shared authentication screen with the existing KasiTek logo and
clearer vertical spacing. The sign-in action, account creation path, legal links, and identity
provider remain unchanged.

Owner: Enoch Chirima. Risk: low.

Affected service and surfaces: Growth web authentication shell, covering sign-in, signup, and
sign-in error routes. No API, database, migration, permission, or provider changes.

Platform release ID: `0.9.9`; release tag: `platform-v0.9.9`; source commit:
`ca8acb9de3996585ed86b2775adfc577ee003844` (includes `ac6be6145`, the authentication UI
change).

## Measurement, logs, and documentation

Analytics events, metrics, dashboards, alerts, structured logging, and Collector configuration:
not applicable. This visual update adds no new behavior, event, or failure mode.

Public documentation and feature map: not applicable; supported authentication paths and behavior
are unchanged. The shared authentication technical documentation remains accurate. No ADR is
required.

## Validation and rollout

- Growth web typecheck and production build passed.
- Focused ESLint passed for the changed authentication component. Repository-wide ESLint also
  scanned generated Vercel bundle files and reported errors there; the source-scoped check passed.
- `pnpm verify:boundaries` passed.
- Local visual inspection passed at desktop and 390 px mobile widths.
- Rebuilt and packaged under Node `24.15.0`, matching the workspace requirement.
- CI's Growth build passed; its separate browser-contract step failed in the existing route
  validation assertion `route validation rejects a wrong module, missing file and incomplete
  baseline`. The authentication change's focused checks passed; this unrelated assertion did not
  block the owner-approved direct deployment.
- Rollout: pushed `ca8acb9de3996585ed86b2775adfc577ee003844` to `main` and published the prebuilt
  Growth artifact directly to Vercel production. Deployment `dpl_PjWqxKskRgyMVfsmfeypJKScMgfU`
  is `READY` and aliased to `https://app.kasitek.co.za`.
- Production smoke check: `https://app.kasitek.co.za/login` returned HTTP 200 and all 22 referenced
  assets returned HTTP 200.

## Rollback

Restore the preceding Vercel frontend deployment or revert the authentication-shell commit and
redeploy. No data, API contract, or migration rollback is required.

Post-release review: verify the production sign-in page, account-creation link, and authentication
redirect in the browser.
