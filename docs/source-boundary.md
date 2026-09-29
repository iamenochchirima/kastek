# Agent Platform UI source boundary

The Agent Platform Next app is at `client/apps/agent-platform` and is the intended owner of the
existing `/agents/**`, `/studio`, `/studio/new`, and `/playground` UI source. The route group is
kept in the source tree, so it does not change the public paths.
The Growth-only `/analytics/playground` route is intentionally excluded.
Growth retains its duplicate copy until Growth issue #7 is completed.

## Relocated source

The 90 local modules reachable from those routes—including their loading states, Agent and
Studio components, UI primitives, analytics display helpers, KasıAI audio/dynamic renderers, and
Agent API/type helpers—were copied byte-for-byte from Growth commit `52bee672`. The Growth
checkout was not modified. The root stylesheet, theme bootstrap, and toaster were also copied to
provide the minimal application shell. The shell does not include Growth navigation, billing,
onboarding, product tours, or PWA registration.

Generic UI source is copied into this product because these repositories are independently
owned; no shared package or cross-repository source import is introduced.

## Transitional integrations

The copied adapters preserve the old UI behavior but are not configured as standalone product
integrations yet:

- Authentication remains in `src/lib/rust-auth.ts` and `src/lib/rust-server-api.ts`. It expects
  the existing Core session endpoint and cookies. Pages retain their current redirects, including
  `/login` and `/verify-request`; those routes and a standalone account/sign-in flow are not part
  of this app yet.
- Browser API calls in `src/lib/server-api.ts` use same-origin proxy paths by default. Server
  requests use `RUST_API_BASE_URL`, then `NEXT_PUBLIC_API_BASE_URL`, then the existing local
  default `http://localhost:4000`. The standalone app does not add an API proxy or configure an
  API origin, so Agent operations remain disconnected until a later integration task.
- `src/lib/connections.ts` preserves the existing workspace-connection requests. It still expects
  the current authenticated Core/API contract; account and workspace ownership are not changed
  here.
- `src/lib/analytics.ts` and the copied Analytics display components preserve the Agent analytics
  screen. No Analytics service endpoint or credentials are configured by this source move.

These copied Growth adapters and display modules are transitional product-local copies, not a
decision that Growth owns the Agent UI or that the products should share runtime code. Replacing
them, configuring account/API/connection integrations, and adding standalone sign-in are later
work. This change does not create fake auth, weaken page checks, or add placeholder API behavior.

## Out of scope

This source move does not delete Growth copies, change routes or screen behavior, redesign UI,
create a shared package, configure domains, migrate data, change production traffic, or perform
an API/authentication cutover. Growth issue #7 owns removal of the duplicate Growth source.

## Validation scope

The CI workflow runs the app TypeScript check and Next build under the supported Node version.
The existing copied UI currently reports 39 ESLint errors, predominantly React-hook diagnostics,
from the unchanged source. Lint is available locally but is not a merge gate for this source-only
move.
