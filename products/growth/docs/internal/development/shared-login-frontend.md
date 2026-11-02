# Growth shared-login frontend

Growth sends all credential entry to Labs Keycloak. Its login gateway offers email/password,
Google and passkeys through the provider. Registration is open. Growth does not store provider
tokens in browser storage or collect passwords.

## Routes and contracts

- `/login` and `/signup` link to `GET /api/auth/login?returnTo=...`; signup adds `screen=signup`.
- `returnTo` is a local path, such as `/workspace` or `/invite/<token>`. Core independently validates it.
- `/api/auth/callback` passes through the frontend `/api` reverse proxy to Core. Use the app origin for this
  callback so transaction and session cookies reach the same browser origin.
- `POST /api/orgs/set-active` is owned by Core and requires the public Host and Origin to match
  `FRONTEND_URL`, a browser product-session cookie and current membership. Its host-only
  `kasitek_active_org` cookie is HttpOnly, SameSite=Lax and lasts one year; HTTPS adds Secure.
  The frontend reverse proxy must preserve the public Host. Core still checks permissions on
  every organization request.
- `GET /api/orgs` returns `{orgs, activeOrgId}` with `Cache-Control: no-store`. The selected ID
  must be a current membership, otherwise Core returns the oldest current organization or null
  and clears a stale preference cookie. The browser can initialize organization selection without
  reading an HttpOnly cookie.
- `GET /api/auth/me` provides the current product session. Existing organization membership,
  onboarding and role guards remain responsible for product access.
- `GET /api/auth/account` opens Keycloak account management: login methods, email, password,
  passkeys, optional two-factor authentication and recovery codes.
- `POST /api/auth/logout` ends this browser's shared login. `POST /api/auth/logout-all` revokes
  all devices. Both return `{redirectUrl}`; the client navigates to that provider logout URL.
  These requests use JSON and browser credentials. Core validates their Origin against the
  configured frontend origin.
- Old `/verify-request` and `/set-password` UI routes lead to provider account management.
  Email verification and recovery occur at the provider rather than inside Growth.

Vite's development proxy and the built frontend server keep `/api` requests on the browser origin.
The production server is `web/scripts/serve.mjs`; it serves the build and forwards API requests to
`CORE_API_BASE_URL`. Set `FRONTEND_URL` to the public app origin in both frontend and Core
configuration. The frontend derives trusted forwarding metadata from its configuration and the
request connection, rather than accepting arbitrary client forwarding headers.

The API proxy keeps redirects and individual Set-Cookie headers intact. Browser navigation
must use the app proxy by default, and OIDC callback configuration must point to the same app
origin. In local development this is `http://localhost:3000/api/auth/callback`, with Core at
`http://localhost:4000`.

## User journeys

A new user registers at Keycloak and verifies email before receiving a Growth session.
React Router client loaders resolve the product session and current organization before protected
workspace requests. Client guards provide navigation behavior; Core independently enforces every
permission. A new account with no organization is redirected to `/onboarding`. Session expiry,
logout, and business switching clear private query state and cancel prior scoped requests.
Matched loaders share one session and organization result through their router `Request`. The
result lasts only for that request, without an authentication-cache timeout. New navigations read
Core again. Request abort and business-scope checks reject late results; a navigation that detects
its own session expiry can still redirect to login. Generic feature data remains in the shared
query cache.

Onboarding creates their organization
with its initial owner. Organisation creation asks only for a name; Core generates a unique URL slug and records durable setup for the four Growth agents. Agent setup can finish after onboarding without delaying organisation creation. A workspace invitation returns
through login to its original invitation URL; accepting requires an authenticated matching
identity and grants the invitation's organization role. Signup does not grant access to existing
organizations. Existing early-access activation is a product workflow and no longer creates
password accounts.

Account-security actions appear in both desktop and mobile account menus and workspace
profile settings. Logout failure displays an error and retains the current page. Provider
errors return to `/auth-error` with bounded display copy, never raw tokens or server details.

Session limits are seven days inactive and thirty days total, enforced by Core and Keycloak.
Growth records trusted pointer, keyboard and scroll input through `POST /api/auth/activity`,
throttled to once per minute. Background polling and leaving a tab open do not count as activity.
Core enforces expiry and the thirty-day maximum; the frontend redirects an expired session to login.

## Focused verification

1. Open `/login` and `/signup`; follow their links and inspect the provider screen.
2. Register, verify email, return to onboarding and create an organization.
3. Return to a workspace invitation after provider login and accept it using its intended account.
4. Open account management, add a passkey, and enable optional two-factor authentication.
5. Check logout and all-device logout, including a failed request and provider unavailability.
6. Check the account menu and profile controls at mobile, tablet and desktop widths.
7. Run client route generation, TypeScript and focused ESLint. Security/token validation is
   verified in Core tests and end-to-end provider checks.
8. Run the request-lifetime bootstrap checks from the repository root with
   `pnpm --filter @kasitek/growth-core exec tsx --tsconfig ../web/tsconfig.json --test ../web/scripts/workspace-bootstrap.test.ts`.
   Browser coverage also checks that matched settings loaders perform one session read and one
   organization read per navigation.

Release scope: local development only; no production deployment or legacy account migration.
Analytics events are unchanged; new browser telemetry is not applicable. Server authentication
logs and revocation evidence belong to the Core implementation. Production release identity and
promotion are not applicable until deployment is authorized. Disabling the provider does not
restore the removed credential implementation; login fails closed until service is restored.

## Agent interface ownership

Growth's current Agents UI uses neutral components under dashboard/agents and the typed product
bridge. The old dashboard/kasiai controller, protected bootstrap and installation transport are
removed. Shared login does not create standalone Agents product membership.
