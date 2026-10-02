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
- [x] Within Agents, distinguish API-based agents from Personal deployments, with separate appropriate detail screens. Personal deployment functionality follows its own platform phase.
- [x] Implement responsive sidebar/top bar, active navigation, organization context and basic account actions using existing patterns.
- [ ] Provide consistent loading, empty, error and unavailable states. Later features must show honest availability rather than fabricated counts or working controls.
- [ ] Preserve basic keyboard navigation, labels, focus behavior and readable mobile layouts during the port.

Exit: the shell looks and behaves consistently with the retained Growth UX while exposing only Agents product areas.

## Phase 4: Separate marketing layout in the same frontend

- [x] Build the public landing page with its own navigation, styling and responsive layout, isolated from dashboard CSS and authenticated layout providers where possible.
- [x] Explain API-based agents, workflows and personal deployments, with clear availability language. Do not advertise later capabilities as shipped.
- [x] Add product overview, use cases and clear signup/login calls to action. Use real product screenshots when available and identify any illustrative previews.
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
- [x] Create an agent with name, instructions and supported model/settings; persist it through the real backend and reopen it after refresh.
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

Settings keyboard behavior and personal navigation, 2026-10-02:

- Replaced the hand-built settings overlay with the existing Radix-based Dialog
  primitive and its Settings trigger. Added a dialog title and description while
  retaining the settings layout and viewport-relative dimensions.
- In the real browser, opening Settings focused Close settings inside the dialog.
  Shift+Tab wrapped to Save draft; Tab returned to the first control. Escape
  removed the dialog and restored focus to Settings. Screenshot:
  `.artifacts/agents-settings-dialog.jpg`. Frontend build and focused lint passed.
- Verified the hosted agent list still showed both saved fixtures. Selecting
  Personal deployments showed its planned explanation, without counts or a
  Create action, then its link opened `/app/agents/personal` with all four
  planned control areas. Screenshot: `.artifacts/agents-personal-planned.jpg`.
  This clears the previous checkpoint's pending desktop category/page navigation;
  mobile coverage for that new page remains pending.

Agent-list actions and detail loading, 2026-10-02:

- Exposed the existing installation status handler through the explicit browser
  manifest. It retains membership admission, same-origin writes, agents:write
  scope and the repository's organization-scoped update/audit transaction.
- Fixed the frontend request helper to add JSON content type only when a body is
  present. Empty POST actions previously failed Fastify JSON parsing with 400.
  Agent-card status failures now show a toast rather than an unhandled rejection.
- Removed detail-loader catches that converted API failures into a false missing
  agent or empty version list. The route error UI now receives those failures.
- In the dedicated local workspace, Pause changed the test fixture to paused;
  Resume restored active. Its list card opened the real saved detail page with
  its name/version data. Screenshots: `.artifacts/agents-paused-fixture.jpg` and
  `.artifacts/agents-saved-detail.jpg`. This does not verify every retained detail
  control; deployment, knowledge, credentials and other copied features still
  require endpoint integration or explicit unavailable states.
- Backend/frontend builds, focused lint and the five existing browser-admission
  checks passed. No real model call was submitted.

Landing overview and real screenshot, 2026-10-02:

- Added a Studio product overview and actual screenshot of the saved Booking
  Assistant in the dedicated local test workspace. The caption states that
  credentials are missing and no response/booking is demonstrated. The image
  contains only local test-fixture data and is stored as a frontend public asset.
- Added common-question, appointment-request and ongoing-work examples. Scheduling
  integration and personal deployments are labelled planned; business/workflow
  product categories are labelled in development. Existing signup/login links
  continue to enter the same app's shared-login flow.
- The real landing page displayed the new overview, all three use cases and
  caption. The image loaded at natural width 1280 and rendered at 1160 within
  the 1270-pixel document width. Screenshot: `.artifacts/agents-landing-preview.jpg`.
- Frontend production build and focused landing lint passed. Responsive coverage
  of the added sections is still part of the normal verification checklist.

Mobile layout follow-up, 2026-10-02:

- At a 390-pixel viewport, the landing's document client/scroll widths both
  measured 380 pixels with its scrollbar; the screenshot rendered at 332 pixels
  and use-case cards formed one column. No horizontal document overflow occurred.
- The personal-deployment page also had matching 380-pixel client/scroll widths.
  Its back link opened the hosted-agent list. The category filter stayed within
  its 348-pixel container and selecting Personal deployments showed the planned
  state without counts or provisioning controls. Screenshot:
  `.artifacts/agents-personal-mobile.jpg`. The viewport override was reset.
- The product-type distinction now has verified separate hosted-agent detail and
  planned personal-deployment screens, including this mobile check. The broader
  shell/keyboard/state acceptance remains open for other inherited controls.
- Updated frontend startup documentation with the separate backend/worker
  prerequisites. No source code changed, so builds/tests were not repeated.

Inherited detail-control availability, 2026-10-02:

- Added explicit pending panels for copied detail sections without initial browser
  integration. They do not mount their upload, provider-key, workflow, grant or
  deployment forms. Model/behavior panels direct users to Studio. Model-section
  effects skip unnecessary credential requests while that section is pending.
- Identity editing, installation status and hosted recent runs remain available.
  Missing preference and archive/delete/publish/retire controls are disabled.
  Scheduled-trigger copy is pending; its unmounted copied form was removed.
  Backend scheduling and independent machine APIs are unchanged.
- In the browser, Knowledge showed an unavailable panel and Studio link; Operations
  loaded the actual empty run history. Settings showed the identity form and
  disabled preferences with explanatory copy. Screenshot:
  `.artifacts/agents-detail-pending.jpg`. These checks do not verify every detail
  section or claim the future features are implemented.
- Frontend typing/production build and focused detail-page lint passed.

Playground setup and version labels, 2026-10-02:

- The isolated local development environment now explicitly disables credit
  charging. API and Temporal worker were restarted with that setting; normal run
  limits and production billing defaults remain unchanged. Model credentials are
  still absent, and no model call has been submitted.
- Studio Overview distinguishes Selected version, Playground installation and
  Published version. An active playground is labelled Active rather than Live;
  publishing a version does not establish a live deployment. Browser verification
  showed the saved Booking Assistant, active playground and published v1.
  Screenshot: `.artifacts/agents-studio-version-labels.jpg`.
- Frontend production build and focused settings lint passed for these labels.
- Opening Studio also exposed an inherited deployment lifecycle request to
  `/api/agents/:agentId/deployment-status` without a browser alias. Its failed
  request can show an incorrect Deployed control. Deployment integration remains
  incomplete and must be reconciled rather than inferred from saved versions.

Studio deployment-status follow-up, 2026-10-02:

- Connected the read-only deployment-status browser alias to the existing handler,
  which requires agent read scope and looks up the agent within the authenticated
  organization. Browser session admission remains shared with the explicit route
  manifest; deployment mutation endpoints were not exposed.
- Studio now displays actual playground/live version assignments from that status
  response. Its copied deployment actions are explicitly pending rather than
  showing Deployed after a failed status request. The full deployment lifecycle
  still requires integration; this read-only mode is an interim frontend state.
- Reloading Booking Assistant showed Playground v1 and Live v1 from the backend,
  with no request-error notifications. Its independent readiness remained Blocked
  because the runtime model credential is absent. Version assignment does not
  prove execution readiness. Screenshot:
  `.artifacts/agents-studio-deployment-status.jpg`.
- Backend/frontend builds, focused lint and the five existing browser-admission
  tests passed. Those admission tests do not establish complete deployment behavior.

Saved draft to playground, 2026-10-02:

- Studio's initial deployment mode now supports publishing a saved draft and
  assigning its immutable version to the playground. Live promotion and rollback
  controls remain pending. The explicit browser manifest includes version publish
  and deployment; the backend permits browser deployment only to an installation
  belonging to the session organization with environment `playground`. Existing
  deployment ownership, version validation and expected-version conflict checks
  remain in the repository transaction. Machine deployment behavior is unchanged.
- Studio refreshes readiness after the playground version changes. Message input
  and submission require the selected version to match the actual playground
  assignment, preventing a draft selection from testing an older pinned version.
  The published-version summary updates immediately from the current version list.
- Browser verification edited Booking Assistant's instructions, saved v2 as a
  draft, published/assigned it through Use version in Playground, and refreshed.
  The edited instructions persisted; Playground showed v2 while Live stayed v1.
  Selecting retired v1 showed the required-version guidance, then v2 was restored
  without another assignment. Screenshot:
  `.artifacts/agents-playground-version-update.jpg`.
- Basic creation/model/behavior persistence and reopen acceptance is now checked.
  Tool/connection configuration, actual model execution, streaming and history
  remain incomplete. No model call or live promotion was submitted.
- Backend/frontend builds, focused lint and five browser-admission tests passed.
  A frontend nullability error caught during the build was fixed before the final
  successful build. The browser checks cover the normal playground update path;
  they do not establish full live deployment or adversarial access coverage.

Conversation model and readiness, 2026-10-02:

- Connected the conversation PATCH browser alias to the existing hosted-chat
  handler, which checks organization, actor ownership, installation and model
  catalog. The picker can change the chat model while execution setup is blocked;
  sending remains disabled. Use agent model clears the conversation override.
- The readiness endpoint optionally takes a conversation ID, requires chat read
  scope and checks that the owned conversation belongs to the requested
  installation. It evaluates that conversation's persisted model provider rather
  than reporting the saved version's provider. A credential reference for another
  provider does not establish readiness. Chat override evaluations do not overwrite
  the installation baseline analytics snapshot.
- Studio reloads readiness when the conversation model changes. In the browser,
  selecting OpenAI persisted after refresh and the blocker changed from OpenRouter
  to OpenAI. Use agent model restored the version's OpenRouter model and blocker.
  Screenshot: `.artifacts/agents-conversation-model-readiness.jpg`. No provider
  credential was configured and no model run was submitted.
- Backend/frontend builds, focused composer/Studio lint and eight existing browser
  admission/readiness checks passed. Actual model execution and complete access
  coverage remain unverified.

Basic validation and recovery states, 2026-10-02:

- The initial creation screen is now a real form with required fields and matching
  backend length limits. Whitespace-only names/instructions produce an associated
  inline alert and focus the invalid field. Fields are disabled during creation.
- Unknown URLs now show Page not found with workspace/home links. Route failures
  distinguish unavailable resources, forbidden workspace access and loading
  failures; a missing endpoint is not described as a connection failure.
- Created an empty local workspace under the dedicated test account. Its real agent
  list showed zero counts and No installed agents yet. Create opened the initial
  form; a whitespace-only name showed Enter a name for this agent and focused the
  field without creating an agent. Screenshot:
  `.artifacts/agents-create-validation.jpg`; empty state:
  `.artifacts/agents-empty-workspace.jpg`.
- A direct unknown URL rendered the missing-page screen. Stopped only the Agents
  local API, verified workspace-unavailable feedback, restarted the API, and Try
  again recovered the empty list. Screenshot:
  `.artifacts/agents-backend-unavailable.jpg`. Restored Agents demo workspace using
  the actual selector; the empty workspace remains a local test fixture.
- Browser control timed out on the previous tab. A fresh tab in the same browser
  continued these checks. Frontend production build and focused creation/router
  lint passed; no additional automated test suite was added for these UI changes.
- Broader route/mobile/unfinished-control checks and the actual response/stream/
  history journey remain open; these observations do not complete all acceptance.

Copied bookmark availability, 2026-10-02:

- Ordinary and general creation bookmarks now enter the working Studio form. A
  draft bookmark enters its agent's Studio. Template requests remain explicitly
  pending instead of silently applying or discarding an unavailable blueprint.
- Template, external-registration, workspace-activity, workflow and appearance
  bookmarks show initial availability and a useful next action. Workflow and
  appearance pages still resolve the agent through the authenticated workspace;
  read failures are not masked as nonexistent agents. The old conversation route
  enters the planned Inbox. These changes do not implement those later features.
- Workflow version saving/publishing has retained backend support, but its canvas
  test path does not apply the displayed draft to the playground. The incomplete
  editor is not mounted in this slice; its source remains for later integration.
  Studio remains the supported version editing/testing path. Other future
  components and all independent backend functionality are also retained.
- Analytics continues to display the real scoped operations summary. A failed
  summary request now reaches the route error UI rather than displaying zeros.
- Browser checks confirmed the old general-creation bookmark reached the working
  form, external registration showed pending rather than a missing developer URL,
  and the saved Booking Assistant workflow bookmark showed its pending state and
  Studio link. Screenshot: `.artifacts/agents-workflow-bookmark-pending.jpg`.
  Other changed bookmarks were inspected in source; they are not all claimed as
  browser-verified. Frontend production build and focused changed-file lint passed.
- Studio capability/connection settings and remaining initial journey acceptance
  still need work. Model credentials remain pending; no actual response was run.
