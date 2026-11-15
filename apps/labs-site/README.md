# Kasitek Labs website

Next.js website for KasiTek Labs, part of the root pnpm workspace.

## Local development

Requirements: Node.js 24 and pnpm 10.30.1.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter labs dev
```

The homepage runs at `http://localhost:3007/`. Run checks from the root:

```sh
pnpm --filter labs lint
pnpm --filter labs build
pnpm verify:boundaries
```

## Landing page

`src/app/page.tsx` renders the approved landing design as native Next.js components in
`src/components/landing/`. The standalone exploration remains in `designs/labs-landing/`.
Production assets live in `public/labs-landing/assets/`; styles are scoped to `.labs-landing`
to avoid changing the other Labs routes.

The client runtime loads GSAP, runs the Agents, Growth and Agency demonstrations, and disposes
listeners, timers and animations when navigation leaves the homepage. Agent scenes use hidden,
inert JSX source containers so React can hydrate them before the runtime clones a scene.
Reduced-motion preferences keep the demos available through the in-preview navigation. Growth
and Agency previews omit the external scene-label and playback-control strips. Each product
section has a visible Open Agents, Open Growth or Open Agency button.

Product destinations are defined in `src/lib/site-config.ts`:

- Agents: `https://agents.kasitek.co.za`
- Growth: `https://app.kasitek.co.za`
- Agency: `https://portal.kasitek.co.za`

Company and project enquiries stay on Labs routes. Chat uses an explicitly configured Agents publication; unavailable chat has a contact fallback.

## Configuration

- The homepage loads the owner-approved Agents publication
  `2a25e036-7985-4c67-816a-8d05389d61aa` from `https://agents.kasitek.co.za`.
  `NEXT_PUBLIC_AGENTS_PUBLIC_URL` and `NEXT_PUBLIC_AGENTS_WIDGET_DEPLOYMENT_ID` override that
  publication as a pair. When either override is present, both must be valid; an empty deployment
  ID disables chat and shows the contact fallback. The publication must allow the site's origin.
  See `.env.example`.
- Invalid configuration or a script-load failure shows Contact us. HTTPS is required outside local
  development. The fallback does not call the retired Growth widget API.
- `NEXT_PUBLIC_KASITEK_CONTACT_EMAIL` sets the displayed contact address. It defaults to
  `hello@kasitek.co.za`.
- `CORE_API_BASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, and `NEXT_PUBLIC_KASITEK_PUBLIC_API_URL` set
  the upstream API origin for the quote-request and waitlist routes, in that precedence order.
  In development they otherwise target `http://localhost:4000`; in production they default to
  `https://api.kasitek.co.za`.
- Vercel Web Analytics is rendered from the root layout and tracks page views across the public
  Labs site. It is enabled for the `kasitek-app` Vercel project. The privacy policy describes the
  aggregate page, referrer, device, and browser data collected; Vercel says Web Analytics does not
  use cookies. See [Vercel Web Analytics](https://vercel.com/docs/analytics).

Moving the source into this repository does not change the hosting project, domains, or deployed
environment. Those remain separate cutover work.

## Landing migration release record

- Change and owner: approved design moved to the Labs homepage at the owner's request.
- Risk and surface: standard; Labs homepage presentation, animations and product navigation.
- Release identity: not applicable to this local source change; no deployment or release tag created.
- API, schema, migrations and permissions: not applicable; demonstration data is illustrative.
- Analytics and success metrics: no new events; verify each product CTA resolves to its configured
  domain. Widget configuration is explicit. No hosted publication was enabled by this source change.
- Structured logs, dashboards and alerts: not applicable; no server behavior changed.
- Documentation: this README records implementation ownership, local commands and destinations.
- Validation: production build, focused landing lint, product-boundary checks, browser checks at
  320, 390, 768, 1024 and 1440 pixels, and repeated client navigation away and back passed.
  Full app lint reports an existing `react-hooks/set-state-in-effect` error in
  `project-enquiry-form.tsx`.
- Rollout: source changes only. Hosting and DNS changes are separate work.
- Rollback: restore the previous homepage, shared navigation and URL configuration; remove the
  landing-only components, assets and GSAP dependency together.
- Post-release review: not applicable until a deployment is scheduled.

## Product navigation cleanup

- Change and risk: low; remove the Growth/Agency scene-label and playback strips, make all
  three product links visible buttons, restore the hand cursor, and keep the Agency button
  clear of its mobile client tabs.
- Documentation: product URLs and preview-control behavior are recorded above.
- Analytics: not applicable; existing navigation destinations are unchanged. Structured logs,
  metrics, API/schema changes, migrations and permissions: not applicable.
- Validation: focused component/runtime ESLint, production build with TypeScript, and product
  boundaries passed. Browser checks at 320, 390, 768, 1024 and 1440 pixels confirmed 44-pixel
  button targets, pointer cursors, configured URLs, no horizontal overflow or Agency-tab overlap,
  and removed playback strips. Growth view selection and Agency client selection worked with
  motion disabled.
- Version, rollout and post-release review: not applicable; local source and preview only.
  Rollback: revert this navigation/presentation change together, including its runtime cleanup.

## Website chat publication

The owner's supplied embed selects the Labs homepage publication above. This is a low-risk
website configuration change; API/schema changes, migrations, new analytics, structured logs,
metrics and release identity are not applicable. No deployment or hosted access-policy change
is included. Rollback or disable chat by setting an empty deployment-ID override.

Validation: focused ESLint, production build/TypeScript, product boundaries and configuration
checks passed. The hosted script returned HTTP 200 and its launcher opened locally. The
publication API rejects `http://127.0.0.1:3007` with `ORIGIN_DENIED`, so message delivery could
not be verified from this preview. Verify chat on the publication's allowed production origin
at rollout; no origin permissions were changed by this source update.
