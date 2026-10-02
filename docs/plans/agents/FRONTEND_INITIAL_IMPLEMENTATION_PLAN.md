# Agents frontend initial implementation

Updated: 2026-10-02.
Status: In progress. Vite, local login/workspaces and saved-agent creation are verified; real model execution and remaining frontend acceptance are pending.
Priority: First implementation slice of the platform delivery plan.

## Outcome and scope

Replace the Agents Next.js frontend with React, TypeScript and Vite. Preserve the useful styling and UX structure of Growth, remove unrelated Growth features, and deliver an Agents dashboard plus a public landing page with its own styling in the same frontend deployment.

The first functional journey is create an API-based agent → test it → view its actual response and run status. Inbox and personal deployment screens get a place in the product structure, but their complete implementations remain later platform phases.

Use React Router for navigation. The separate Agents backend owns authentication callbacks, HttpOnly sessions, permissions and APIs. Browser calls use same-origin /api routing through a Vite development proxy and production reverse proxy. Do not move secrets, token exchange or business authorization into the browser.

This is a functional implementation with ordinary build, typing, browser and focused regression checks. Broad security audits, adversarial suites, capacity testing and production hardening follow later. Existing authentication and access checks remain in force; this scope does not authorize insecure substitutes.

## Phase 1: Review and retain the useful UI

- [x] Inspect the existing Agents client and Growth shell. Identify which layouts, components, assets and styles are already present in Agents before copying more.
- [x] Record the proposed elements to preserve: typography, colors/theme, spacing, sidebar/top bar, organization selector, page headers, forms, dialogs, tables, toasts and loading/empty/error patterns. Confirm any material redesign with the owner before replacing these patterns.
- [x] Show one representative dashboard layout and navigation structure for review. Keep landing-page styling separate.
- [x] Identify Next-specific routing, server components/helpers, image/font handling, middleware, environment variables and API adapters requiring replacement.
- [x] List Growth features to exclude, including campaigns, content publishing, CRM/contact management, bookings administration, billing implementation, Growth onboarding, PWA/offline infrastructure and Growth-only analytics. Agent booking tools are separate backend capabilities, not these product screens.

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

- [x] Port/reuse the approved Growth shell, theme and UI primitives, then remove Growth-only navigation and imports.
- [x] Add Overview, Agents, Inbox, Knowledge, Connections, Usage and Settings as the proposed navigation. Keep Studio/Playground discoverable inside the agent workflow.
- [ ] Within Agents, distinguish API-based agents from Personal deployments, with separate appropriate detail screens. Personal deployment functionality follows its own platform phase.
- [x] Implement responsive sidebar/top bar, active navigation, organization context and basic account actions using existing patterns.
- [ ] Provide consistent loading, empty, error and unavailable states. Later features must show honest availability rather than fabricated counts or working controls.
- [ ] Preserve basic keyboard navigation, labels, focus behavior and readable mobile layouts during the port.

Exit: the shell looks and behaves consistently with the retained Growth UX while exposing only Agents product areas.

## Phase 4: Separate marketing layout in the same frontend

- [x] Build the public landing page with its own navigation, styling and responsive layout, isolated from dashboard CSS and authenticated layout providers where possible.
- [x] Explain API-based agents, workflows and personal deployments, with clear availability language. Do not advertise later capabilities as shipped.
- [ ] Add product overview, use cases and clear signup/login calls to action. Use real product screenshots when available and identify any illustrative previews.
- [x] Connect calls to action to the same app's login/signup routes and preserve an approved post-login destination.
- [x] Set basic document title, description, icons and share metadata. Extensive SEO work and a separate marketing deployment are out of scope.

Exit: visitors can understand the product and enter its real sign-in flow from the landing page.

## Phase 5: Authentication and backend connection

- [x] Consume the other agent's Labs shared-login contract and Agents backend session interface. Login/signup redirect to backend-owned provider flows; support existing-user and new-user outcomes.
- [ ] Replace Growth Core session/API dependencies with Agents endpoints. Load the current user and permitted organizations from the backend.
- [x] Implement route loading, unauthenticated redirect, organization selection and ordinary API-error handling. Backend authorization remains authoritative.
- [x] Send cookies through the /api interface and connect logout to the agreed backend behavior. Provider tokens and credentials must not appear in frontend storage or build configuration.
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
- [x] Complete real login and logout with a test account when the shared provider/backend are available. Check the signed-out dashboard redirect.
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

Backend login routes, 2026-10-02:

- Added authorization-code login/signup, single-use database login attempts,
  signed ID-token verification, PKCE/state/nonce, HttpOnly cookies and current-user
  responses. Added explicit workspace creation/selection, activity, browser logout
  and all-device logout. Realm session/account checks bound revocation to five
  minutes and fail closed when a due check cannot reach the provider.
- Backend build, six focused login-boundary checks and three existing internal-auth
  checks passed. Both identity migrations were applied to the isolated database.
  The live Labs discovery endpoint responded, but actual provider registration,
  browser login and UI/backend agent contract integration remain pending.
- Phase 5 acceptance remains unchecked until the real authenticated frontend
  works. No production deployment, shared-login source changes or Growth changes.

## References

- [Platform architecture](../../architecture/agent-platform-architecture.md).
- [Existing client integration status](../../source-boundary.md).
- [Shared-login contract and checklist](../../../../plans/shared-login/IMPLEMENTATION.md).
- [Vite guide](https://vite.dev/guide/).
- [Vite backend integration](https://vite.dev/guide/backend-integration).
- [React Router documentation](https://reactrouter.com/start/declarative/installation).

Local authenticated frontend evidence, 2026-10-02:

- Registered independent `agents` and `agents-session-admin` clients using
  `scripts/configure-local-login.py`. Only those clients and their own service
  role mapping were configured. Shared realm settings and other product clients
  were untouched. Backend credentials remain in ignored, mode-0600 `.env`.
- Initialized an independent native PostgreSQL 18 cluster for Agents under
  `.artifacts/local-postgres`, on a private Unix socket and port 55434. All
  migrations through 179 passed. The API uses a non-superuser runtime login with
  the existing Agents runtime grants, RLS enforcement and HMAC machine auth.
- A dedicated local provider fixture, with no existing workspace memberships,
  completed real password login, reached onboarding, created a workspace and
  reached the authenticated dashboard/account screen. Refresh also passed a live
  provider recheck forced due through the disposable session record. Browser
  logout reached Keycloak's confirmation, then protected `/app` returned to login.
  Signing in again restored the saved workspace. No mocked browser APIs were used.
- Added workspace creation/selection and account/logout UI. Child page loaders
  check workspace selection before loading agent data. User activity is reported
  from visible clicks/typing at most once per minute; background requests do not
  prolong sessions. Workspace changes reload the app to clear previous UI state.
- Desktop shell screenshot: `.artifacts/agents-authenticated-shell.jpg`. A
  390-pixel check confirmed page width stayed at 390, the mobile menu opened and
  Escape dismissed it. The viewport override was reset afterward.
- Frontend typing/build and focused lint passed; backend build and seven focused
  login-boundary checks passed. Agent screens still need the standalone browser
  API facade, and agent creation/execution are not accepted yet. Google setup
  remains deferred by the owner; no new Google/passkey verification is claimed.

Standalone agent creation evidence, 2026-10-02:

- Added an explicit /api/agents manifest for initial creation, version/config/model
  reads, playground conversations, runs and event streaming. Aliases share the
  existing canonical handlers. Browser auth derives tenant/actor/scopes from live
  session membership rather than service tokens or browser-supplied headers.
- Removed the Studio loader's Growth-era automatic KasiAi installation. The agent
  list's Create action opens the working Studio creation form. Private hosted
  assistants are labelled workspace assistants, keeping them distinct from the
  planned filesystem-based personal deployment product.
- Created Booking Assistant in the dedicated local test workspace through the
  browser and backend. Its saved instructions/version/installation reopened after
  refresh; the real agent list showed the saved agent and count. Screenshot:
  `.artifacts/agents-saved-agent.jpg`.
- Backend and frontend builds passed. Five new admission checks and the existing
  login/internal-auth checks passed, 15 in total. Focused lint of changed Studio
  route/creation modules passed. No broad hardening suite was added.
- Actual response, streaming/reconnect, execution history, model/settings changes
  and remaining endpoint/UI cleanup remain unfinished. Agents has no configured
  model credential; the owner has been asked whether to reuse development keys
  or configure separate credentials. No key was copied or fabricated. Local
  At that checkpoint, local Temporal setup was also pending. See the execution
  setup evidence below for its current state. The actual journey is incomplete.

Model selection and local execution setup, 2026-10-02:

- The creation form loads the backend model catalog and defaults to the workspace
  model. A chosen provider/model pair is validated against that catalog and saved
  in the new agent specification. Incomplete pairs are rejected. Creation waits
  for the initial catalog request; a failed catalog request explicitly reports
  that the workspace default will be used. Options show their model identifiers.
- Created a separate local fixture with a non-default OpenAI selection through
  the real browser form. Studio and its settings still showed OpenAI after a
  refresh. Screenshot: `.artifacts/agents-model-selection.jpg`. This checks saved
  configuration, not whether that provider credential or model execution works.
- Backend compilation, frontend typing/production build, focused creation-page
  lint and five direct input-validation assertions passed.
- Started the native local Temporal development server on loopback port 7233,
  with its database under ignored `.artifacts`. The worker is polling workflow
  and activity tasks on `kasitek-agents-initial-ui`; queue inspection confirmed
  both pollers. The API uses the same namespace and queue. No model run was sent.
- Credentials remain pending the owner's answer. The retained execution path
  also defaults to enforced platform-credit billing and requires Growth's credit
  API for platform-funded calls. Local execution needs an explicit development
  billing mode or that API configured. This does not implement Agents billing or
  remove the retained production billing checks.
- The complete create/test/response/history acceptance remains unchecked.

Studio cleanup checkpoint, 2026-10-02:

- Replaced the settings prototype module with `studio-settings.tsx`, retaining
  the default sidebar layout. Removed the alternate-layout switcher, query
  parameter and global arrow-key interception. Added a settings-section selector
  for narrow screens where the sidebar is hidden.
- Conversation persistence and configuration loading no longer use generic Ready
  labels. Studio displays the backend's execution blockers and disables sending
  until installation readiness is confirmed. The submit handler checks readiness
  too. Existing conversation reads still load while execution is blocked.
- Frontend typing/build, focused lint and the two existing Studio event/reducer
  checks passed. Browser observation timed out twice on the existing tab, so
  visual, mobile-navigation and live send-state verification for this change
  remain pending. No additional live execution acceptance is claimed.

Studio browser follow-up and metadata, 2026-10-02:

- A fresh tab recovered browser access after the old tab became unavailable.
  Studio showed the missing OpenAI credential, disabled message/audio/send controls
  and loaded the saved conversation. Settings no longer showed prototype controls.
- At 390 pixels, the settings-section selector opened Runtime and showed the saved
  `openai:gpt-5.5` configuration. The viewport was reset. Screenshot of the retained
  settings layout: `.artifacts/agents-clean-settings.jpg`. This clears the previous
  checkpoint's pending mobile settings navigation and send-state observations.
- Added a local SVG favicon plus basic Open Graph and summary-card metadata.
  The landing document exposes its title/description/icon/share tags; the
  production build contains those tags and the icon. The public deployment URL
  is not known yet, so no invented canonical/share URL is configured.
- Frontend production build and built HTML/SVG checks passed. Real model
  execution remains pending credentials and development billing setup.

Personal deployment UI distinction, 2026-10-02:

- Added an explicit Personal deployments category alongside API-based agents and
  external connections. Its planned state has no fabricated counts, provisioning
  controls or Create action. Existing private hosted workspace assistants stay in
  the API-based category. Audience and runtime type remain separate concepts.
- Added the protected `/app/agents/personal` page, linked from the category and
  Overview. It explains planned persistent files/memory, runtime/skills, lifecycle
  controls and scoped product/channel connections. It does not provision a
  container or substitute another product's personal runtime.
- Replaced incomplete tab semantics on the category filters with ordinary labelled
  pressed buttons. The existing card styling and hosted/external views remain.
- Frontend typing/production build and focused lint passed. Browser control timed
  out during navigation and reconnect, so the new category/page still needs live
  navigation and mobile verification. The phase-3 acceptance stays unchecked.
