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

Platform release ID: `0.9.9`; release tag: `platform-v0.9.9`. The exact commit and Vercel
deployment ID will be recorded after publication.

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
- Validation ran under Node `23.11.1`; the workspace declares Node `>=24 <25`.
- Rollout: publish the approved release commit to `main`; verify the production Vercel deployment
  and sign-in route before closing this record.

## Rollback

Restore the preceding Vercel frontend deployment or revert the authentication-shell commit and
redeploy. No data, API contract, or migration rollback is required.

Post-release review: verify the production sign-in page, account-creation link, and authentication
redirect after the Vercel deployment completes.
