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
Reduced-motion preferences keep the demos available through their controls.

Product destinations are defined in `src/lib/site-config.ts`:

- Agents: `https://agents.kasitek.co.za`
- Growth: `https://growth.kasitek.co.za`
- Agency: `https://agencies.kasitek.co.za`

Company and project enquiries stay on Labs routes. The existing chat widget remains enabled.

## Configuration

- `NEXT_PUBLIC_KASITEK_PUBLIC_API_URL` sets the public API origin used for the embedded chat
  widget. It defaults to `https://api.kasitek.co.za`.
- `NEXT_PUBLIC_KASITEK_CONTACT_EMAIL` sets the displayed contact address. It defaults to
  `hello@kasitek.co.za`.
- `CORE_API_BASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, and `NEXT_PUBLIC_KASITEK_PUBLIC_API_URL` set
  the upstream API origin for the quote-request and waitlist routes, in that precedence order.
  In development they otherwise target `http://localhost:4000`; in production they default to
  `https://api.kasitek.co.za`.

Moving the source into this repository does not change the hosting project, domains, or deployed
environment. Those remain separate cutover work.

## Landing migration release record

- Change and owner: approved design moved to the Labs homepage at the owner's request.
- Risk and surface: standard; Labs homepage presentation, animations and product navigation.
- Release identity: not applicable to this local source change; no deployment or release tag created.
- API, schema, migrations and permissions: not applicable; demonstration data is illustrative.
- Analytics and success metrics: no new events; verify each product CTA resolves to its configured
  domain. Existing widget configuration is retained.
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
