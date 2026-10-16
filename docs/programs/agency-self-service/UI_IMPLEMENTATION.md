# Agency UI implementation plan

Status: Approved by the owner. React/Vite migration and redesign are implemented. Focused verification and public registration/email-verification return to onboarding passed.
Prepared: 2026-10-07.
Implementation repository: `kasitek-agency`, using the current branch.

## Outcome

Agency uses React, TypeScript and Vite for its landing page and application. Copy the Agents app's existing visual foundation and shell, then connect Agency's functionality inside it. The result should visibly match Agents in typography, spacing, surfaces, navigation, forms, motion and appearance controls. The landing page should follow the Agents landing page's composition with Agency-specific content.

Keep the working shared Keycloak login, business creation, branding, staff and client functionality. This is a frontend migration and redesign, with only the server changes needed to replace Next's proxy and serve the app. It does not introduce another identity system or change the database model.

## Inspected references

All Agents paths below are relative to `kasitek-agents/client/apps/agent-platform/`:

| Source | Use in Agency |
| --- | --- |
| `package.json`, `vite.config.ts`, `src/main.tsx`, `src/routes/router.tsx` | React/Vite entry point, React Router, Tailwind Vite integration and routing structure |
| `src/components/platform/app-shell.tsx` | Copy the shell's presentation, collapsed sidebar, mobile navigation, header, workspace selector and loading/error treatment; replace Agents session and navigation bindings |
| `src/styles/app.css` | Copy design tokens and reusable application styles; omit agent canvas/runtime-specific styles |
| `src/lib/appearance.ts`, `appearance-contract.ts`, `src/components/theme-script.tsx` | Light/dark/system themes, five accent presets, comfortable/compact density, saved preferences and reduced motion |
| `src/components/ui/`, `src/lib/motion.ts`, `src/lib/utils.ts` | Copy the components and helpers needed by Agency screens, including forms, tables, dialogs, confirmation and notifications |
| `src/components/platform/landing.tsx`, `src/styles/marketing.css` | Agency landing and sign-in composition, responsive layouts, typography and interactions |
| Geist font imports in `src/main.tsx` | Match Agents typography without a runtime font-network dependency |

Current Agency source is `client/apps/tenant-portal/`. Its runtime/build scripts use Next.js. Its API client defaults to `/api/tenant`, currently served by `src/app/api/tenant/[...path]/route.ts`. That handler forwards cookies, multiple Set-Cookie headers, manual redirects, Origin, tenant host/slug and idempotency headers. These behaviors must survive the migration.

## 1. Capture the existing Agency behavior

- [x] Inventory the current page routes and documented frontend role groups. See the route inventory below.
- [x] Complete the per-screen API-call and enforced-access inventory; retain backend enforcement as the authority. See `UI_ROUTE_INVENTORY.md`. This final source inventory was recorded during the migration audit.
- [x] Record the current Agents shell and landing appearance as the visual reference, including desktop/mobile and light/dark examples.
- [x] Identify which Agents components each Agency screen needs. Copy their source into Agency; avoid creating a new shared UI package or requiring the Agents backend.

### Route inventory from the current source

| Routes | Existing behavior to preserve |
| --- | --- |
| `/` | Tenant-aware home: Agency landing or workspace experience according to the existing context/session rules |
| `/login`, `/register` | Partner signup/login versus agency-specific staff/client login; retain `audience` and `error` query behavior and tenant context resolution |
| `/onboarding`, `/app/businesses`, `/app/businesses/:id` | Partner business creation, list and owner-scoped branding/settings |
| `/portal/:slug` | Resolve the selected business and open its branded portal |
| `/setup`, `/activate` | Staff setup and invitation activation; preserve invitation query values |
| `/clients`, `/clients/:id` | Client administration; retain detail-page invite feedback query values `adminInviteEmail`, `adminInviteSent`, `adminInviteUrl` |
| `/leads`, `/content`, `/reporting`, `/nurturing`, `/aeo`, `/voice`, `/reviews`, `/adcreative`, `/settings` | Existing workspace screens, role groups and feature-flag visibility |
| `/client`, `/client/leads`, `/client/conversations`, `/client/conversations/:id` | Separate client session, assigned client scope, client navigation and conversation detail parameters |
| Unknown routes | A styled not-found screen without masking API errors |

Frontend role groups are defined in `src/lib/tenant-access.ts`: dashboard, client administration, lead operations, reporting, content, automation, voice, reputation and settings. Staff navigation also checks tenant feature flags. The partner-only business-list item requires an Agency partner session. Preserve these distinctions when adapting the Agents navigation; do not replace them with Agents workspace roles.

Next currently resolves tenant context on the server for `/login`. The Vite route must fetch the corresponding public context before selecting the partner or tenant sign-in screen, rather than assume all visitors use the partner audience.

## 2. Switch Agency to React/Vite

- [x] Replace Next entry points with `index.html`, React root, React Router, Vite and Tailwind's Vite plugin. Keep the current portal directory and local port `3010`.
- [x] Replace Next links/navigation, route parameters, metadata and other framework imports. Preserve existing public URLs and query parameters, including invitation links and `/portal/:slug`.
- [x] Keep Agency API/client packages and backend-held authentication. No client secrets or provider tokens enter Vite's public environment or browser storage.
- [x] Replace `/api/tenant` proxy behavior in Vite development and preview. Preserve path rewriting, methods, bodies, query strings, cookies, separate Set-Cookie headers and login redirects.
- [x] Provide a native production start path that serves the Vite build and `/api/tenant` under one origin, reusing the Tenant server or a small native proxy as appropriate. No Docker and no deployment in this task.
- [x] Add SPA deep-link handling while keeping API requests and missing assets out of the HTML fallback. Preserve tenant host/slug resolution and existing origin checks.
- [x] Update scripts and configuration references so `dev`, `build` and `start` actually run the migrated frontend.

## 3. Copy the Agents visual foundation

- [x] Copy the Agents design tokens, Geist fonts, relevant UI primitives, icons and motion helpers. Adapt product naming and imports rather than inventing a different design.
- [x] Adapt the Agents app shell to Agency session data, business selection, role-specific navigation and logout. Preserve mobile drawer, collapsed sidebar, active navigation and keyboard focus behavior.
- [x] Add appearance settings for light/dark/system, accent colours, density and reduced motion. Apply saved appearance before first paint; use Agency-specific storage keys.
- [x] Keep partner appearance preferences separate from white-label business branding. A business's saved logo/name/colours must still control its branded portal without leaking into another business.
- [x] Use the copied components consistently for loading, empty, error, validation, saving and success states. Connect live Agency data instead of copying Agents fixtures or agent-specific screens.

## 4. Adapt the landing and login pages

- [x] Copy Agents landing composition: navigation, large hero typography, calls to action, capability sections, product preview, closing section and footer.
- [x] Replace Agents wording and imagery with Agency business setup, branding, teams and client-management content. Advertise only functionality that exists; use an Agency screenshot for the product preview.
- [x] Match Agents sign-in/register styling while retaining Agency's backend login/registration URLs and return paths. Keycloak remains responsible for credentials and verification.
- [x] Make landing, sign-in and registration responsive with working links, keyboard focus and readable text.

## 5. Put Agency functionality inside the copied shell

- [x] Restyle onboarding and business creation using the copied form/page components. Preserve validation, idempotent submissions and meaningful errors.
- [x] Restyle business list, business details and business switching with live data. Preserve primary-partner ownership and workspace isolation.
- [x] Restyle branding/settings and the branded portal entry. Keep save/reload behavior, branding preview and the correct business context.
- [x] Restyle staff/team and client management, invite acceptance and activation. Preserve owner/Viewer/client access boundaries and separate account audiences.
- [x] Apply the same foundation to remaining existing staff/client routes identified in step 1. Preserve their current implemented behavior; do not add new product capabilities or disguise unavailable features with sample data.

## 6. Minimal verification and cleanup

- [x] Run the portal typecheck and production build once after integration. Run backend checks only for server code changed by the proxy/static-serving work.
- [x] Verify Mailpit email verification, first Agency login/onboarding, business creation, branding save, switching and logout/re-entry through the native runtime using a disposable unverified local identity. No external email provider setup.
- [x] Submit the public Keycloak registration form in the browser. The owner entered the test credentials and submitted. Keycloak created the identity. The original browser tab became unresponsive, so a fresh sign-in triggered the real Mailpit verification email; its link returned to Agency onboarding. This proves public submission and the verification callback, with a browser interruption during the first attempt.
- [x] Check one staff invite and one client invite/activation path, plus denied owner-only access for a non-owner. Reuse existing backend auth tests rather than build another full suite.
- [x] Check deep-link refresh and login redirects through the Vite/native proxy, including cookies and multiple Set-Cookie headers. Exercise the production start path locally as well as development.
- [x] Visually compare the Agency shell/landing to Agents on desktop and a narrow viewport. Check light/dark/system, accent and density persistence, sidebar behavior and reduced motion. Capture a few review screenshots.
- [x] Remove unused Next files, dependencies, old conflicting styles and obsolete scripts after the Vite version works. Keep one frontend implementation.
- [x] Update Agency README and this checklist with the actual run commands, results and any remaining limitations.

## Completion boundary

The Agency landing and application run on React/Vite, visibly use the Agents design, and all existing Agency journeys remain connected to the real local backend. Appearance controls work, the white-label branding remains isolated by business, and a browser refresh on a nested URL works in both local development and the native production start path. No Next runtime remains in Agency.

Production deployment, Google callback repair, external email delivery, new backend features, custom-domain activation and a shared UI package are outside this task. Known unrelated backend failures are not prerequisites for this visual migration.

Implement in order: Vite and proxy -> copied shell and appearance -> landing/login -> Agency screens -> focused verification and cleanup. First visual checkpoint is the copied shell containing the real business list and business detail page, so the direction is visible early.

## Implementation evidence — 2026-10-07

- Agency now runs Vite at `http://localhost:3010`, with the native Tenant API at port 8090. Native production serving was also exercised on port 3011 without Docker.
- Portal typecheck/production build and focused ESLint checks pass on Node 24. The native proxy regression test passes for manual auth redirects, separate Set-Cookie headers, forwarded tenant/idempotency headers, request bodies, deep-link HTML fallback, and API/missing-asset exclusions.
- The database-backed auth integration passes 2/2 with no skips. It covers partner OIDC/session security and business isolation, staff/client invitations and activation, distinct audiences and role denial. The initial invocation had one skipped database check because its environment key was incorrect; it was corrected and rerun successfully.
- Browser verification created a clearly named temporary business, saved its branding, reloaded the detail page, opened the owner settings and created a Viewer staff invite and a client account. Both activation pages resolve the correct business and invitation using the preserved routes/query parameters. Credential entry on the activation pages was not repeated in this UI pass; activation and role enforcement are covered by the real database-backed integration above.
- Dark theme, Emerald accent, compact density and reduced motion persisted after a browser reload; original appearance preferences were restored. The mobile navigation drawer was verified at 390px and the viewport restored.
- The landing composition and app shell follow Agents. The landing uses an actual Agency business-page screenshot, not the Agents screenshot or fabricated data. Reference screenshots are under `evidence/`.
- Retired authored Next sources were copied to `/tmp/agency-next-source-20261007` before removal. Existing unrelated work was preserved. No branches were created and no changes were pushed.

The public registration step is now verified with owner-entered credentials. Existing Google/provider prerequisites remain outside this visual migration.

Final staff/client verification: both disposable accounts were activated through the real native API, then signed in through the production-served frontend. Viewer navigation contained only Overview and Reporting, and `/clients` redirected to Overview. The client saw only its client navigation and `/settings` redirected to `/client`. Logout worked for both. No existing user's credentials were changed. The disposable business, staff, client and their associated rows were removed and zero remaining records verified; the temporary credential file was removed and the production test server stopped. The normal development server remains running.

Fresh-account verification: a disposable, unverified Keycloak identity and client were provisioned through the local admin API. The browser required email verification, followed its actual Mailpit link and returned to Agency onboarding through the native production server. It created two businesses, saved branding, switched to the correct branded workspace, signed out and returned through existing shared sign-in. This verifies the post-registration journey, not public form submission. A stale selector name found during this walkthrough was fixed and verified immediately after saving. Partner login now also resets business theme/title overrides. The two businesses, partner record, associated local rows, disposable Keycloak identity/client, own verification message and private credential file were removed. Isolated test servers stopped; normal development services stay running. Screenshot: `evidence/fresh-account-businesses.png`.

Public registration follow-up: the owner submitted `agency-signup-test-20261007@example.test`. Keycloak confirmed the identity was created and required email verification. The original in-app browser tab repeatedly timed out while Keycloak, Agency and Mailpit each returned HTTP 200 in under 0.01 seconds. A fresh browser tab signed in with the existing test credentials, received a verification email through Mailpit and followed its actual action link to Agency onboarding. The original tab interruption was recovered; no application code change was justified by this evidence. The test account is left available for the owner. Screenshot: `evidence/public-registration-onboarding.png`.
