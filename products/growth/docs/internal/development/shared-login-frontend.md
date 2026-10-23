# Growth shared-login frontend

Growth sends all credential entry to Labs Keycloak. Its login gateway offers email/password,
Google and passkeys through the provider. Registration is open. Growth does not store provider
tokens in browser storage or collect passwords.

## Routes and contracts

- `/login` and `/signup` link to `GET /api/auth/login?returnTo=...`; signup adds `screen=signup`.
- `returnTo` is a local path, such as `/workspace` or `/invite/<token>`. Core independently validates it.
- `/api/auth/callback` passes through the Next API proxy to Core. Use the app origin for this
  callback so transaction and session cookies reach the same browser origin.
- `POST /api/orgs/set-active` requires same-origin submission, a product session and current
  membership before changing the active-organization cookie. Core still checks permissions on
  every organization request.
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

The API proxy keeps redirects and individual Set-Cookie headers intact. Browser navigation
must use the app proxy by default, and OIDC callback configuration must point to the same app
origin. In local development this is `http://localhost:3000/api/auth/callback`, with Core at
`http://localhost:4000`.

## User journeys

A new user registers at Keycloak and verifies email before receiving a Growth session.
Dashboard server loaders use a cached workspace-session guard before organization-bound
requests, because Next renders pages and layouts concurrently. A new account with no organization
is redirected to `/onboarding` before these requests run. Onboarding creates their organization
with its initial owner. A workspace invitation returns
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

Release scope: local development only; no production deployment or legacy account migration.
Analytics events are unchanged; new browser telemetry is not applicable. Server authentication
logs and revocation evidence belong to the Core implementation. Production release identity and
promotion are not applicable until deployment is authorized. Disabling the provider does not
restore the removed credential implementation; login fails closed until service is restored.

## Agent interface ownership

Growth's current Agents UI uses neutral components under dashboard/agents and the typed product
bridge. The old dashboard/kasiai controller, protected bootstrap and installation transport are
removed. Shared login does not create standalone Agents product membership.
