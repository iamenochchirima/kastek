# Agency self-service implementation plan

Status: Core self-service implementation is complete and locally verified end to end. Local Keycloak now supports optional environment-driven SMTP for real inboxes while retaining Mailpit by default. Growth currently sends transactional mail through Resend; use a separate sending-only key restricted to Identity's verified sender domain rather than copying Growth's key. Real-inbox delivery, Google OAuth callback correction and provider-specific browser checks remain pending external setup; they do not block verified email/password signup or local Agency business setup.
Prepared: 2026-10-06.
Primary repository: `kasitek-agency`. Supporting identity configuration: `kasitek-labs`.

## Current implementation checkpoint — 2026-10-06

The implementation includes Agency partner tables and sessions, the dedicated Keycloak client, validated partner OIDC login and registration, self-service business and branding endpoints, owner screens, activity-based session refresh, and the local branded portal route. The browser walkthrough exposed and fixed two integration defects: Keycloak direct registration requires `prompt=create`, and the client-create UI needed to map `admin_email` to the API's `adminEmail`. Staff invite setup copy now uses workspace-neutral language. Tailwind ignores generated Next build caches, and no `src-ts/` or `test-ts/` directories remain in the four project repositories.

Verified locally:

- Agency API and portal typechecks and production builds pass after the final code changes. The portal build used a separate output directory, leaving the running development server's build files alone.
- A fresh isolated-browser journey passed using a disposable `.test` address: landing page -> Keycloak registration -> verification link from local Mailpit -> partner login -> create two businesses -> update branding -> reload and open each correctly branded portal -> logout -> log back in and find both businesses. No actual user's email or browser session was used.
- The database-backed Agency auth integration passes 2/2 tests with no skips. It verifies registration through a test OIDC issuer, PKCE, single-use state, nonce, issuer/audience/signature checks, verified-email enforcement, safe return paths, partner sessions with zero businesses, owner-scoped business APIs, session cookies, explicit activity refresh, seven-day idle and thirty-day absolute expiry, logout, all-device logout and signed backchannel logout.
- The same focused integration checks cover fail-closed internal admin access, cross-origin activity denial, client-cookie and spoofed-owner-field denial, staff/client scope protection, changed branding in public tenant context, idempotent create retries, concurrent slug creation by two partners and rollback after a forced audit-write failure. A partner cannot re-invite their linked owner account as staff, and neither the primary partner nor another workspace owner can be removed through staff management.
- The migration and foundation checks pass with fourteen total migrations; all twelve original migrations remain unchanged and the two Agency partner migrations are appended.
- The local Tenant API health route, portal registration page, Keycloak discovery endpoint and Mailpit API respond successfully.
- A live registration-start/cancel cycle through the Next proxy preserves the Keycloak redirect and flow cookie, then clears that cookie and returns to partner sign-in. It used no signed-in browser session.
- A focused call to the actual Next proxy handler preserves a provider redirect and two independent `Set-Cookie` headers.
- The browser also verified a Viewer invitation and activation, confirmed owner-only Clients and Settings routes redirect for that role, created a client through the owner UI, and accepted its invite into the assigned client portal. The client saw only its client portal navigation and client-scoped data.
- The browser test confirmed local verification through Mailpit, but the local mail sender is not configured for external delivery. The disposable Keycloak account, partner row, two workspaces, client/staff records, Mailpit message and temporary browser profile were removed and cleanup was verified.
- Labs identity configuration is applied and validated. Required identity secrets and SMTP settings now fail preflight before processes start. Focused checks cover the Mailpit defaults and reject incomplete SMTP and missing secrets; a live start attempt with incomplete SMTP was rejected while the running Keycloak, Mailpit and PostgreSQL processes stayed up. The running Keycloak instance was reconciled and confirmed to retain Mailpit as its default. Real-inbox delivery remains unverified until an Identity-scoped Resend key is configured. Google remains unverified until the owner corrects the Google callback URI. Passkeys are configured in Keycloak but were not tested with an authenticator. The API build/test runner reports Node 23.11.1 while the package declares Node 24; both completed successfully under the current shell runtime.
- The broad Tenant API test run still has two failures outside the partner self-service routes: `transport.test.ts` expects a malformed form body to return 400 but receives 200, and `typed-json-body.test.ts` expects an unauthenticated Analytics request to return 401 but receives 500. They were not changed in this pass.

Still open: confirm the sender domain is verified in Resend, create a dedicated sending-only key restricted to it, add the key to the ignored Labs identity `.env`, and verify delivery to the owner's real inbox; correct the Google callback URI; and verify Google and passkey login in a browser with the required provider/authenticator setup. The SMTP configuration path is implemented, but no Identity-scoped provider key is configured and no real email has been sent. The code path for email/password signup, business setup, branding, business switching, owner re-entry, staff role limits and client activation is implemented and locally verified. The broad Tenant API suite still has two unrelated failures noted above.

## Completed prerequisite: TypeScript layout cleanup

- [x] Standardized migrated TypeScript services on `src/` and tests on `tests/`; no `src-ts/` or `test-ts/` directories remain in Agency, Growth, Labs or Agents.
- [x] Updated active scripts, configuration and documentation to use the standard directories.
- [x] Corrected the two remaining historical `src-ts` source labels in Growth's route-census fixture.
- [x] Kept this cleanup separate from the Agency product checklist below; product tasks are tracked independently and remain incomplete until verified.

## Outcome and completion boundary

A new visitor can open the Agency landing page, register or log in, create a white-label business, become its primary partner, save its branding, and open a portal that uses that branding. They can return later, log in again, and manage their businesses without asking Labs Admin to provision them.

The first complete milestone is this real browser journey against native local Keycloak and Agency PostgreSQL. A rendered landing page, an API health response, mock data, or a database row created through an internal admin endpoint does not satisfy it.

The full checklist also covers self-service team and client management by reusing the existing Agency functionality. Production hosting, billing, live custom-domain activation and a new identity provider for agency customers are follow-up work. They must not hold up the local login and business-creation milestone.

## Agreed product rules

- Anyone can register as an agency partner. Registration uses the shared Labs-operated Keycloak service.
- The person who creates a business becomes its primary partner, represented by the Agency `owner` role. Owner access comes from current Agency membership, never from a provider login alone.
- An owner can create and select more than one business. Each business is one existing Agency `workspace`, with its own branding, staff, clients and data. Do not create a second competing organization model.
- Partner sign-in offers the selected provider's email/password, Google and passkey methods. Email/password requires verification. Password reset and credential enrollment belong to Keycloak.
- Agency staff and client accounts stay agency-specific. A client account cannot create an agency business or gain owner access, even when its email matches a partner's email.
- Use a separate Agency partner OIDC client, backend-held tokens and an opaque HttpOnly product cookie. Apply the agreed 7-day inactivity and 30-day absolute limits, optional two-factor authentication, browser logout and all-device logout.
- Business setup and ordinary changes happen in the Agency product. Labs Admin remains an internal support and platform-operations tool.
- This is a fresh product. Do not add existing-user migration, password imports, a second partner password login, legacy fallbacks, new issue boards, extra working branches or Docker.

The primary-partner journey above is the concrete scope of this plan. It resolves partner ownership and signup for this release. Wider provider federation for agency staff/customers and automatic access to other KasiTek products remain outside it. Their current workspace-scoped login is a separate account audience, not an alternate login for partners.

## What exists and what is missing

Inspected source on 2026-10-06:

| Area | Existing source | Work required |
| --- | --- | --- |
| API | `server/kasitek-tenants/src/`, Fastify and PostgreSQL | Partner OIDC/session and self-service business routes are implemented; complete browser/provider verification |
| Business records | Existing workspace migrations plus Agency partner migrations | Reuse `workspaces`, branding, limits and audit records; partner membership and idempotency records are implemented |
| Staff identity | Existing staff schema plus partner membership bridge | Owner workspace context works through the partner cookie; finish cross-workspace and activation checks |
| Client identity | `migrations/20260410113000_tenant_clients_and_client_auth.sql` | Reuse separate client users, roles and sessions |
| Provisioning | `src/controllers/admin.ts`, `src/workspace-provisioning.ts`, partner business routes | Shared transaction helper and partner-authorized creation are implemented; finish adversarial and concurrency checks |
| Internal protection | `requireAdminSecret` in `controllers/admin.ts` | Missing or invalid admin secret now fails closed; retain a focused denial check |
| Workspace management | `controllers/workspace.ts`, `controllers/clients.ts`, partner business routes | Owner business list/detail/branding and existing staff/client operations are connected; verify full browser paths and isolation |
| Branding | Partner branding route and public tenant context | Owner-authorized writes and local `/portal/[slug]` route are implemented; verify persisted appearance after reload |
| Frontend | `client/apps/tenant-portal/`, Next.js | Landing, partner login/registration, onboarding, business picker, owner settings and local portal routes are implemented; browser journey remains |
| Existing UI | `screens/settings.tsx`, `screens/clients.tsx`, `screens/admin-setup.tsx` | Reuse appropriate screens; invitation activation is not public business creation |
| Browser proxy | `src/app/api/tenant/[...path]/route.ts` | Manual redirects and separate `Set-Cookie` forwarding are implemented; verify in a real browser |
| Workspace selection | Frontend `lib/api.ts`, `lib/tenant-context-provider.tsx` and `screens/tenant-home.tsx` | Partner setup before a workspace and explicit local portal selection are implemented; verify refresh and switching |
| Domain verification | `controllers/workspace.ts`, partner business routes | Partner domain changes are denied; custom-domain ownership verification remains outside this release |
| Shared provider | Labs `infra/identity/` | Dedicated Agency partner clients are configured locally; Google redirect and browser login remain unverified |

The API and portal started successfully during local setup. A dedicated local `kasitek_agency` database is configured and the existing migrations ran. These startup checks did not verify partner signup or self-service business creation. Redis is available locally for Growth; this plan does not add a Redis requirement to Agency.

## Frontend and API contract

Extend the existing Agency Next.js app, with separate public, partner and tenant/client layouts. Keep this as one frontend application for now. Do not move Agency marketing or onboarding into Growth.

| Journey | Frontend route | Backend responsibility |
| --- | --- | --- |
| Public entry | `/` | Public product information, no required workspace/session |
| Partner sign-in/signup | `/login`, `/register` | `/api/partner/auth/start`, provider redirect and callback |
| Session and account | Partner account controls | `/api/partner/auth/me`, logout, logout-all, verified backchannel logout |
| First business | `/onboarding` | Authenticated, atomic business creation |
| Business selection | `/app/businesses` | List only the partner's active memberships |
| Business management | `/app/businesses/[workspaceId]` and settings | Authorize that workspace on every read/write |
| Branded local portal | `/portal/[slug]` | Resolve public branding and the correct scoped staff/client session |

Use `/api/partner/businesses` for collection operations and `/api/partner/businesses/:id` for detail/settings. Publish the small request/response contracts before connecting forms. Reuse existing staff/client handlers through an authorized workspace context instead of duplicating their business logic.

The frontend's existing same-origin `/api/tenant` prefix proxies backend routes. The local partner callback is exactly `http://localhost:3010/api/tenant/api/partner/auth/callback`; the backend route is `/api/partner/auth/callback`. Register the exact post-logout return `http://localhost:3010/login` and backchannel endpoint `http://localhost:8090/api/partner/auth/backchannel-logout`. Use `localhost` consistently for browser login and passkeys. No wildcard callback or callback derived from an arbitrary request host.

The partner account and session exist before a workspace does. Model a unique provider identity using issuer and subject, partner sessions independent of workspace, and explicit partner-to-workspace memberships. Bridge authorized owners to the existing workspace role model so existing features still use its permission checks. A partner identity does not silently merge with `tenant_users` or `tenant_client_users` by email. Select and document the concrete tables/constraints before writing the migration; no new provider realm per business is needed for this owner journey.

Workspace IDs, slugs, route segments and forwarded host headers select a resource. They never grant access. Public tenant-context responses contain approved branding only. The local default slug must not silently select a different business on partner or public routes.

## Checklist in implementation order

### 1. Freeze the small contract

- [x] Confirm the existing migrations, screens and auth audiences against this inventory; record only material differences in this document.
- [x] Define partner account/session/membership schema and uniqueness constraints, including how an owner reaches the existing workspace access context.
- [x] Define business-create, business-list, branding-update and session response shapes, with field errors and authorization status codes.
- [x] Set one configurable creation limit and safe default resource limits. Business setup must work without payment, API keys or enabled agent execution.
- [x] Define reserved/valid slugs and a stable platform portal URL. Use `/portal/[slug]` locally so setup works without DNS changes.

### 2. Add partner persistence and authorization

- [x] Add the next Agency SQL migration through the existing migration runner. Do not edit the twelve already-applied migration files.
- [x] Enforce unique issuer/subject mapping and unique workspace slug at the database level.
- [x] Separate provider-backed owner membership from local-password staff credentials. The existing `tenant_users.password_hash NOT NULL` requirement must not lead to a generated/shared owner password or a second owner login method.
- [x] Store opaque session-token hashes and backend-only provider/session references needed for renewal and logout. Keep credentials and tokens out of API responses and logs.
- [x] Add partner session lookup that works with zero businesses.
- [x] Resolve current owner membership and workspace status on every scoped operation, including staff/client handlers reached from the owner console.
- [x] Keep partner, staff and client cookies/session audiences distinct. Reject a client cookie on partner creation endpoints.
- [x] Make internal admin authorization fail closed if `TENANT_ADMIN_SECRET` is missing or invalid. Keep support provisioning separate from public signup.

### 3. Connect shared login end to end

- [x] Add a dedicated `agency-partner` confidential client to Labs identity configuration and its configuration script; preserve the existing Growth client.
- [x] Supply its backend secret through ignored local environment configuration, with the exact callbacks above. Update examples without copying real secrets.
- [x] Implement login and registration starts, code exchange with PKCE S256, single-use transaction state/nonce, validated identity and safe local return paths.
- [x] Require verified email for the partner creation journey. Record provider identity by issuer/subject; never infer ownership from email or provider-wide roles.
- [x] Issue a host-scoped HttpOnly Agency partner cookie, SameSite=Lax and Secure in production. Protect authenticated writes against CSRF and unapproved origins.
- [x] Enforce seven inactive days and thirty days absolute in Agency sessions. Background reads do not refresh the idle clock; visible user interaction is explicitly recorded.
- [x] Implement browser logout, all-device logout and validated backchannel logout.
- [x] Fix the Next.js proxy to use manual redirect handling, forward `Location` and append each upstream `Set-Cookie` separately. Browser verification of this boundary remains open.
- [x] Add partner account/session state in the frontend independently of tenant context. Confirm provider error and expired-session behavior in the browser.
- [x] Link users to provider-managed password recovery and credential management. Do not collect a partner password in the Agency backend.

Reuse the implementation patterns in Growth's identity modules, but do not call Growth's human-authentication API or share its product cookie. Extract a small Labs helper only if both consumers actually require it; shared-package refactoring is not a prerequisite for this milestone.

### 4. Create a business without Labs Admin

- [x] Extract reusable workspace creation logic from the internal provisioning controller, leaving its support authorization at its own endpoint.
- [x] Add authenticated partner business creation. Derive the creator from the session; reject caller-supplied owner IDs, roles, status, entitlements and limits.
- [x] Validate business name, slug, reporting timezone and allowed brand values. Return readable field errors and a slug-conflict response.
- [x] Create workspace, initial branding, owner membership, required local owner principal, safe limits and an audit record in one PostgreSQL transaction.
- [x] Make retries/double submission idempotent per partner and creation request. Replaying the same key and payload returns the existing result; reusing the key with a changed payload is rejected.
- [x] Avoid generating an API credential or accepting an unverified domain during public creation. External services and email sends must not determine whether the database transaction commits.
- [x] Return the business and portal link, then send the user into its dashboard. A creation error retains the form and allows retry.
- [x] Add partner-authorized list/detail operations and explicit business selection. An account with no businesses returns to onboarding.

### 5. Build the landing page and onboarding

- [x] Make the public landing page explain the white-label product, setup steps and available capabilities. Include Register and Log in actions, without invented prices, testimonials or functionality.
- [x] Separate public/partner branding and providers from tenant/client layouts. The landing and registration pages render without a tenant session or preconfigured workspace.
- [x] Wire Register and Log in to the provider flow. Backend callback logic routes new partners to onboarding and existing partners to their business list or a safe saved destination.
- [x] Build the business form with name, timezone and optional initial brand color. Slug is created by the API. The form has labels, loading/error states and duplicate-submit protection.
- [x] Build the business list/switcher and empty state. The backend authorizes every business operation.
- [x] Add a setup checklist driven by saved business data, with links to branding, team, clients and portal preview.
- [x] Load saved businesses and settings on direct routes. Verify browser refresh, back navigation and a second login in the end-to-end browser check.
- [x] Use responsive layouts and labelled form controls. Full keyboard/browser review remains part of the end-to-end check.

### 6. Let owners configure their white-label business

- [x] Add owner-authorized business-name and branding writes for display name, primary/secondary color and optional logo URL.
- [x] Validate lengths, color formats and logo URLs; reject unrecognized branding fields and keep user text out of raw HTML.
- [x] Add owner branding settings with an in-page preview. Logo upload/storage remains unnecessary for this milestone.
- [x] Save settings to Agency PostgreSQL and return the updated business for immediate UI refresh.
- [x] Implement `/portal/[slug]` tenant selection, pass it through workspace context and check staff/client scope. Public branding lookup grants no access to private data.
- [x] Confirm the saved brand appears after reload and switching between two businesses loads each business's own saved brand.
- [x] Keep owner business setup usable without a custom domain. Disable self-service domain verification/primary-domain activation in the API and UI for this release; hiding a button alone is insufficient. The existing DNS/IP check cannot prove ownership.

Milestone 1 is complete only when sections 1 through 6 pass the core browser and authorization checks below.

### 7. Connect the existing team and client management

- [x] Expose the existing workspace-scoped staff list/invite/remove operations through the owner's business workspace, with consistent success/error handling.
- [x] Keep roles explicit, block partner owners from assigning themselves staff roles, and prevent direct removal of any owner. Ownership transfer and additional owner assignment need a separate flow.
- [x] Connect the existing client list, creation/detail and client-user invitation screens to the selected business.
- [x] Reuse the existing activation/session flow for agency-specific invited users. Invitations bind to the correct workspace and client and use expiring, single-use tokens.
- [x] Provide development invitation links when email is not delivered. Document that Mailpit/local delivery does not send to a real inbox.
- [x] Confirm in the browser that an invited Viewer is blocked from owner-only Clients and Settings pages, and an invited client enters only its assigned client portal.
- [x] Deny disabled staff and expired client sessions in the API. Verify the owner-facing removal flow in the browser.

Section 7 completes the self-service management portion of this plan. Reuse the current client/staff behavior rather than rebuild the whole portal.

### 8. Document and verify the actual result

- [x] Update Agency README/environment examples and Labs identity README with local start commands, provider client, session policy, callback URLs and route ownership.
- [x] Explain how to register and create the first business without an admin secret, manual SQL inserts or an internal provisioning request.
- [x] Record the completed checks below, with failures and external blockers stated plainly.
- [x] Update the shared-login Agency follow-on plan to distinguish primary-partner self-service from deferred staff/client provider adoption.

## Minimum verification

Keep verification focused on these behaviors. Do not add a test for every UI component, rerun unrelated product suites, or make Railway/GitHub Actions a dependency.

- [x] Run Agency API typecheck/build and the changed frontend's typecheck/build once after the final changes. Run Labs configuration validation only if its provider setup changes.
- [x] Run a fresh isolated-browser journey: public landing -> register a new test identity -> verify through local Mailpit -> login -> create businesses -> save brand -> open branded portals -> reload -> logout -> login and retrieve both businesses. A disposable `.test` address was used; external inbox delivery was not claimed.
- [x] Use a second partner and business in the API integration check. Cross-owner detail lookup and spoofed tenant headers for staff/client routes are denied.
- [x] Verify in the browser that one partner can create/select two businesses without settings or brand context leaking between them.
- [x] Verify atomic creation side effects and duplicate retries with a focused real-database integration check; the check also confirms changed-payload key reuse is rejected.
- [x] Extend the real-database integration check to cover simultaneous slug conflict and rollback with no orphan data.
- [x] Check replayed auth state, unsafe return URL, unverified email, cross-origin write, client-cookie business creation and missing admin secret denial.
- [x] Validate OIDC transaction state, PKCE and signed identity issuer/audience; the integration check covers a valid callback, replay rejection and unverified-email rejection.
- [x] Check seven-day idle and thirty-day absolute session expiry, browser logout and signed provider backchannel logout using controlled timestamps.
- [x] The database integration issues and accepts staff and client invitations, checks audience separation, and denies cross-client access; the browser also confirmed invite activation and role-specific navigation.
- [x] Verify the Next proxy handler forwards `Location` and preserves multiple upstream `Set-Cookie` headers. The live unauthenticated start/cancel cycle confirms the provider redirect and flow-cookie clearing; full callback behavior remains in the fresh-user browser journey.
- [ ] Configure Labs Identity with a dedicated Resend sending-only key restricted to an approved, verified sender domain, then verify an Agency signup email reaches a real inbox. Keep Mailpit as the local default until this provider setup is complete.
- [ ] Verify Google/passkey login when their external prerequisites are available. Google still needs its authorized redirect URI corrected; passkey sign-in needs an available authenticator. Configuration is not counted as a successful login test.

The core outcome uses verified email/password through Keycloak and must work locally. Google configuration readiness and an external Google redirect blocker must be reported separately, without holding the completed core journey open indefinitely. Optional two-factor behavior reuses the existing provider policy rather than introducing a new project-wide rollout.

## Completion report

- [x] A visitor can register and verify email before any business exists, then log in.
- [x] Creating a business assigns the correct owner and persists complete data atomically.
- [x] The owner can return, select businesses and edit branding without Labs Admin.
- [x] The portal displays each business's saved brand and isolated workspace context.
- [x] Team/client management works through the selected business with enforced roles.
- [x] Negative authorization checks pass, and each requested login method has an explicit verification status.
- [x] Local commands and outstanding external setup are documented, distinguishing implemented code, verified browser behavior and deferred production work.

## Follow-up work, outside this checklist

- Live custom-domain activation with ownership proof, exact approved login callbacks, trusted host routing and HTTPS/TLS automation. A resolvable IP alone is insufficient.
- Production deployment, real inbox email delivery and production passkey RP-domain configuration.
- Provider account-disable behavior beyond signed Keycloak backchannel logout. Agree on revocation timing before production.
- Billing/subscriptions and enforcement of paid plan changes.
- Full provider isolation/federation and branded identity pages for agency-specific staff/customer accounts.
- Logo file upload/object storage, ownership transfer and advanced agency permissions if needed.
- Agent execution, new analytics features and a redesign of existing client product screens.

## Source references for implementation

Paths are relative to this workspace's sibling repositories. Check current source before editing; the checklist specifies behavior rather than line-by-line implementation.

- [Agency README](../../kasitek-agency/README.md) and [Tenant API README](../../kasitek-agency/server/kasitek-tenants/README.md).
- [Provisioning controller](../../kasitek-agency/server/kasitek-tenants/src/controllers/admin.ts), [workspace management](../../kasitek-agency/server/kasitek-tenants/src/controllers/workspace.ts), [middleware](../../kasitek-agency/server/kasitek-tenants/src/middleware.ts), [client management](../../kasitek-agency/server/kasitek-tenants/src/controllers/clients.ts).
- [Portal auth](../../kasitek-agency/client/apps/tenant-portal/src/lib/auth.tsx), [root layout](../../kasitek-agency/client/apps/tenant-portal/src/app/layout.tsx), [API proxy](../../kasitek-agency/client/apps/tenant-portal/src/app/api/tenant/[...path]/route.ts), [settings screen](../../kasitek-agency/client/apps/tenant-portal/src/screens/settings.tsx).
- [Labs local identity](../../kasitek-labs/infra/identity/README.md), [realm configuration](../../kasitek-labs/infra/identity/kasitek-realm.json) and [configuration script](../../kasitek-labs/infra/identity/configure.py).
- [Growth auth routes](../../kasitek-growth/server/kasitek-core/src/routes/auth.ts), [provider client](../../kasitek-growth/server/kasitek-core/src/identity/provider.ts), [session enforcement](../../kasitek-growth/server/kasitek-core/src/identity/session.ts) and [logout handling](../../kasitek-growth/server/kasitek-core/src/identity/logout.ts).
- [Shared login implementation](../shared-login/IMPLEMENTATION.md) and [Agency follow-on identity plan](../shared-login/04-agency.md).
- [Keycloak administration guide](https://www.keycloak.org/docs/latest/server_admin/index.html) for registration, account methods, clients and logout. The locally installed version is pinned; check support against that version before changing configuration.
- [OAuth security best current practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) for redirect validation, PKCE and authorization-code protections.
