# Agents frontend initial implementation

Updated: 2026-10-02.
Status: In progress. Vite migration, public layout and initial shell implemented; standalone session/API integration remains pending.
Priority: First implementation slice of the platform delivery plan.

## Outcome and scope

Replace the Agents Next.js frontend with React, TypeScript and Vite. Preserve the useful styling and UX structure of Growth, remove unrelated Growth features, and deliver an Agents dashboard plus a public landing page with its own styling in the same frontend deployment.

The first functional journey is create an API-based agent → test it → view its actual response and run status. Inbox and personal deployment screens get a place in the product structure, but their complete implementations remain later platform phases.

Use React Router for navigation. The separate Agents backend owns authentication callbacks, HttpOnly sessions, permissions and APIs. Browser calls use same-origin /api routing through a Vite development proxy and production reverse proxy. Do not move secrets, token exchange or business authorization into the browser.

This is a functional implementation with ordinary build, typing, browser and focused regression checks. Broad security audits, adversarial suites, capacity testing and production hardening follow later. Existing authentication and access checks remain in force; this scope does not authorize insecure substitutes.

## Phase 1: Review and retain the useful UI

- [ ] Inspect the existing Agents client and Growth shell. Identify which layouts, components, assets and styles are already present in Agents before copying more.
- [ ] Record the proposed elements to preserve: typography, colors/theme, spacing, sidebar/top bar, organization selector, page headers, forms, dialogs, tables, toasts and loading/empty/error patterns. Confirm any material redesign with the owner before replacing these patterns.
- [ ] Show one representative dashboard layout and navigation structure for review. Keep landing-page styling separate.
- [ ] Identify Next-specific routing, server components/helpers, image/font handling, middleware, environment variables and API adapters requiring replacement.
- [ ] List Growth features to exclude, including campaigns, content publishing, CRM/contact management, bookings administration, billing implementation, Growth onboarding, PWA/offline infrastructure and Growth-only analytics. Agent booking tools are separate backend capabilities, not these product screens.

Exit: a short keep/remove list and a concrete shell direction. Copy needed source into Agents; do not introduce cross-repository runtime imports or modify Growth.

## Phase 2: React and Vite foundation

- [x] Configure React/TypeScript/Vite in client/apps/agent-platform, preserving useful dependencies and existing workspace integration.
- [x] Add dev, build, preview, typecheck and lint commands appropriate to Vite. Replace Next-specific CI/build/start references and update startup documentation.
- [x] Add React Router with public and authenticated layout groups, not separate applications.
- [x] Establish public /, /login and /signup routes and authenticated /app routes. Redirect old Agents bookmarks where still useful, without retaining two implementations.
- [x] Configure development /api proxying to Agents and document production same-origin routing, SPA deep-link fallback and proxy handling for live event streams.
- [x] Replace Next navigation/link hooks and server-only client helpers with browser-safe routing and API adapters. Port font/image handling and only browser-public configuration.
- [x] Remove unused Next files, dependencies and generated configuration after equivalent behavior is available. Update source-boundary documentation to describe actual migration status.

Exit: Vite serves the landing and dashboard layouts, including direct route navigation and refresh.

## Phase 3: Growth-style Agents shell

- [ ] Port/reuse the approved Growth shell, theme and UI primitives, then remove Growth-only navigation and imports.
- [x] Add Overview, Agents, Inbox, Knowledge, Connections, Usage and Settings as the proposed navigation. Keep Studio/Playground discoverable inside the agent workflow.
- [ ] Within Agents, distinguish API-based agents from Personal deployments, with separate appropriate detail screens. Personal deployment functionality follows its own platform phase.
- [ ] Implement responsive sidebar/top bar, active navigation, organization context and basic account actions using existing patterns.
- [ ] Provide consistent loading, empty, error and unavailable states. Later features must show honest availability rather than fabricated counts or working controls.
- [ ] Preserve basic keyboard navigation, labels, focus behavior and readable mobile layouts during the port.

Exit: the shell looks and behaves consistently with the retained Growth UX while exposing only Agents product areas.

## Phase 4: Separate marketing layout in the same frontend

- [x] Build the public landing page with its own navigation, styling and responsive layout, isolated from dashboard CSS and authenticated layout providers where possible.
- [x] Explain API-based agents, workflows and personal deployments, with clear availability language. Do not advertise later capabilities as shipped.
- [ ] Add product overview, use cases and clear signup/login calls to action. Use real product screenshots when available and identify any illustrative previews.
- [ ] Connect calls to action to the same app's login/signup routes and preserve an approved post-login destination.
- [ ] Set basic document title, description, icons and share metadata. Extensive SEO work and a separate marketing deployment are out of scope.

Exit: visitors can understand the product and enter its real sign-in flow from the landing page.

## Phase 5: Authentication and backend connection

- [ ] Consume the other agent's Labs shared-login contract and Agents backend session interface. Login/signup redirect to backend-owned provider flows; support existing-user and new-user outcomes.
- [ ] Replace Growth Core session/API dependencies with Agents endpoints. Load the current user and permitted organizations from the backend.
- [ ] Implement route loading, unauthenticated redirect, organization selection and ordinary API-error handling. Backend authorization remains authoritative.
- [ ] Send cookies through the /api interface and connect logout to the agreed backend behavior. Provider tokens and credentials must not appear in frontend storage or build configuration.
- [ ] Document any missing Agents backend endpoints as explicit prerequisites; implement only the small API changes needed for this slice or leave their acceptance blocked.

Dependency: do not edit the other agent's shared-login work or invent temporary fake authentication. Shell work can proceed independently; end-to-end acceptance waits for working authenticated APIs.

Exit: a user reaches the dashboard with an actual Agents session and organization context.

## Phase 6: One actual agent creation and execution journey

- [ ] Reuse the existing agent list, creation, Studio and Playground components where they fit; adapt their routing and data fetching to Vite and Agents APIs.
- [ ] Create an agent with name, instructions and supported model/settings; persist it through the real backend and reopen it after refresh.
- [ ] Connect Playground message submission and actual run status/output. Preserve working execution visualizations where useful; do not rebuild the full editor for this slice.
- [ ] Display progress, actual response, relevant tool/error results and cancellation where supported. Use the backend's streaming/history interfaces rather than simulated execution.
- [ ] Return to the agent list/detail and retain the saved agent and visible run history.
- [ ] Remove unused copied modules/assets and update the local frontend run instructions after the journey works.

Exit: authenticated user → create agent → send a test message → see a real response/status → refresh and reopen saved agent.

## Normal verification checklist

Run once after the relevant changes; repeat only after failures or new edits.

- [ ] Frontend typecheck and production build pass. Run focused lint for changed frontend code and resolve introduced errors; record unrelated baseline errors separately.
- [ ] Open landing, login/signup entry, dashboard and agent routes. Verify navigation, back/forward, direct URL refresh and an unknown route.
- [ ] Inspect the landing and shell at desktop and mobile widths; verify menu, forms, dialogs and basic keyboard focus.
- [ ] Complete real login and logout with a test account when the shared provider/backend are available. Check the signed-out dashboard redirect.
- [ ] Create and reopen an agent, execute one real Playground message, observe its response/status and reload its history.
- [ ] Check one normal validation error, an empty agent list and backend-unavailable feedback. Confirm unfinished features do not look operational.
- [ ] Verify development and production API routing and a live stream/reconnect on the first working journey.
- [ ] Adapt existing Studio reducer/event tests if their logic changed and run those focused checks. Add a small regression test only for behavior that warrants one; do not create a broad test program for the UI port.
- [ ] Record commands, browser outcomes and external setup blockers. Mocked APIs or credentials do not establish real integration success.

## Later delivery

Full live inbox and Growth integration, durable workflow feature expansion, personal-runtime deployment controls, deeper usage/billing work, production security hardening and load/capacity checks follow the [platform delivery plan](AGENT_PLATFORM_DELIVERY_PLAN.md). This frontend slice does not silently mark those phases complete.

## Working rules and progress

Keep useful existing functionality and styling. One frontend implementation replaces Next.js; no permanent parallel frontend. Do not change Growth, promote its rewrite branch, create additional issue boards or deploy production as part of this task. Keep implementation progress here and platform outcomes in the main checklist.

Initial implementation evidence, 2026-10-02:

- React/Vite foundation and public/authenticated route groups are implemented. Existing screens are lazy-loaded route controllers; browser requests use /api and include same-origin cookies.
- Growth tokens, theme preferences, UI primitives and authored fonts are retained; the initial Agents sidebar/header and separate landing/signup/login layouts are present. A representative authenticated shell review remains pending until the real session integration works.
- Next dependencies, app-router entry points and server cookie helpers are removed. Existing Studio components remain and the two focused Studio checks passed.
- Frontend typecheck, production build and focused lint of new platform/routing modules passed. Vite startup reported 280 ms on this laptop; this is a local observation, not a production benchmark.
- Browser checks confirmed public landing rendering, signup navigation and protected-route connection errors with no backend running. Desktop and narrow layouts were inspected.
- Agents does not yet implement the required human session or inherited /api/agents facade. Login, authenticated shell/browser checks and the real create/test/response journey remain incomplete; those items must not be checked off based on compilation.

Continue with standalone authenticated backend integration and complete the remaining functional browser checks. No production deployment or Growth changes were made.

Standalone login foundation, 2026-10-02:

- Added Agents-owned account, organization, membership and hashed browser-session
  tables and their access repository. Identity uses provider issuer/subject;
  verified users can explicitly create a workspace, and selection checks live
  membership. Idle/absolute expiry and local revocation are implemented in storage.
- Backend build and five focused checks against a temporary PostgreSQL database
  passed. The temporary cluster was stopped. No existing product database changed.
- OIDC callbacks, cookies, provider revalidation and authenticated browser API
  routing remain pending. Phase 5 and the actual agent journey remain unchecked.
  See [login integration details](../../architecture/platform-login.md).

## References

- [Platform architecture](../../architecture/agent-platform-architecture.md).
- [Existing client integration status](../../source-boundary.md).
- [Shared-login contract and checklist](../../../../plans/shared-login/IMPLEMENTATION.md).
- [Vite guide](https://vite.dev/guide/).
- [Vite backend integration](https://vite.dev/guide/backend-integration).
- [React Router documentation](https://reactrouter.com/start/declarative/installation).
