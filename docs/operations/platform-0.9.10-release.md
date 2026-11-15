---
title: Platform 0.9.10 release record
owner: platform engineering
last_reviewed: 2026-11-15
---

# Platform 0.9.10 release record

Change: Shorten Growth sign-in copy and remove the security note; add Vercel Web Analytics to the
Kasitek Labs public website and disclose the measurement in its privacy policy. Owner: Enoch
Chirima. Risk: low.

Affected services and surfaces: Growth web sign-in at `app.kasitek.co.za`; Labs public site at
`kasitek.co.za` and its Vercel project `kasitek-app`.

API/schema/migration changes: not applicable. Feature flag or rollout method: no feature flag;
Growth was deployed as a prebuilt Vercel production artifact, and Labs from the committed
monorepo snapshot through its linked Vercel project. Platform release version: `0.9.10`;
release tag: `platform-v0.9.10`; source commit:
`2d34bd5d4d529e402e413ec03ee49ff31e9abdbe`.

## Measurement and observability

Vercel Web Analytics is enabled for `kasitek-app` and records aggregate page views across the
public Labs site. No custom events were added. Vercel's dashboard provides visitor and page-view
reporting. Application logs, metrics, alerts, and Collector settings: not applicable; this adds
no server behavior or new failure mode. The Vercel Hobby plan includes 50,000 Web Analytics events
per month and pauses collection after its limit rather than billing additional events.

## Documentation and privacy

The Labs site README records the integration. The public privacy policy now describes Vercel Web
Analytics and the data categories it reports. No Growth feature map or API documentation change is
needed; the sign-in contract is unchanged.

## Validation and rollout

- Vercel Web Analytics enablement for `kasitek-app`: complete.
- Labs focused ESLint and production build: passed under Node 24.15.0.
- Growth typecheck, focused ESLint, production build, and Vercel output packaging: passed under
  Node 24.15.0.
- `pnpm verify:boundaries`: passed.
- Growth deployment `dpl_EeDJ2VCT8KMSuoF3TaigZSGNy1Kr` is `READY` at
  `https://app.kasitek.co.za`; Labs deployment `dpl_2dsKAADgJKWePR97GPohxerjDgzA` is `READY` at
  `https://kasitek.co.za`.
- Production smoke checks passed: the Growth login route and new-copy bundle returned HTTP 200;
  the Labs homepage, privacy policy, Analytics client bundle, and `/_vercel/insights/script.js`
  returned HTTP 200. The new privacy disclosure appeared on the live policy page.
- Loaded the live Labs homepage in a browser after deployment to trigger a real page view. Vercel
  dashboard counts may take time to appear.
- GitHub CI is not a deployment gate for this owner-requested direct Vercel rollout.

Rollback: restore the prior Vercel deployment for each project. Disable Web Analytics in the
`kasitek-app` project and remove the Analytics component and dependency if analytics should stop.
Restore the prior privacy-policy text if tracking is removed.

Post-release review: confirm production page views appear in the Vercel Analytics dashboard after
normal traffic; data may take time to appear.
