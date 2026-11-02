# Social OAuth callback relay

Change: preserve the signed-in app session when a social provider returns to a separately
hosted public API. Owner: Enoch Chirima. Risk: standard. Release ID:
`growth-social-callback-relay-2026-11-02`; platform baseline remains 0.2.0.
Affected service and surface: Growth API, social account connection callbacks and `/connections`.

## Failure and intended behavior

Production sign-in and social state cookies are host-only on `app.kasitek.co.za`. The registered
Meta callback uses `api.kasitek.co.za`. The shared callback previously required the app session
immediately, returning401before the browser could return to the host that owns its cookies.
An unauthenticated synthetic callback reproduced the exact unauthorised response without using
or exchanging the user's authorization code.

For split origins, the public callback relays only recognized callback fields to a fixed
completion URL on the configured frontend, regardless of any API-host cookie. Its `/api` proxy
forwards the app cookies to Growth. The completion endpoint runs the existing session, workspace admin and OAuth state
checks; it does not relay again. Same-origin callbacks retain their original processing path.
A stale or different API-host session cannot override the app's session. The relay is not an authorization grant.

The Meta app's registered callback and the redirect URI used during code exchange remain on the
public API origin. No production Meta settings change. Cookies keep their host-only scope.
The shared path covers Meta, direct Instagram Login, X, Threads, TikTok and LinkedIn. Bluesky
uses its separate persisted state/DPoP flow and is unchanged.

## Release decisions

API changes: six additive authenticated `/api/social/oauth/{provider}/complete` endpoints.
Database migrations, configuration changes and new product analytics events: not applicable.
Reuse existing provider connection outcomes, bounded provider error categories and readiness
checks. Codes, states, tokens and full callback URLs must not enter logs or support exports.
Sensitive callback responses use no-store and no-referrer protections. Collector configuration
and existing platform retention/alerting limitations are unchanged.

Documentation: connection failure runbook, current topology and feature-map verification path
updated. Public connection steps and provider permissions remain unchanged. Rollout deploys
only the merged Growth backend image; the existing frontend `/api` proxy already covers these
paths. No frontend rebuild or provider app modification is required.

Rollback restores the previous Growth backend image without deleting connections, accounts or
publication history. It also restores the split-host callback failure. After rollout, start a
fresh Facebook connection so an expired code/state from the failed attempt is not reused.
A successful relay is separate from Meta token acceptance and Page import; confirm those through
a new authorized provider connection. Post-release review: 2026-11-03.

## Local verification

Five focused checks passed without skips against an owned PostgreSQL fixture. Coverage includes
all six relay routes, exact fixed destination and safely encoded callback fields, stale/valid
API cookies, authenticated app completion, same-origin compatibility, missing or mismatched state,
workspace admin denial, no redirect loops and no-store/no-referrer headers. Growth API build,
product import boundaries and whitespace checks passed. No real provider code was exchanged by
these fixture tests; Page import still requires the user's fresh Facebook authorization.

Hosted verification at 2026-11-02 20:08 Africa/Johannesburg: Growth API and its analytics worker
successfully deployed merged source `5c98003b1b33724141d758d4328d9dbfa5a92630`. The callback now
returns302to the configured app completion path, both without an API cookie and with a stale
one. No-store and no-referrer headers are present. The actual Vercel app proxy reaches the new
completion route and correctly returns401without an app session; it does not loop. API health
returns200. No real provider code was exchanged by these checks. See the
[sanitized deployment record](./releases/growth-social-callback-relay-2026-11-02.json).
