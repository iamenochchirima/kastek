# Direct Instagram connection restoration

Owner: Enoch Chirima. Risk: standard. Release ID: `instagram-direct-restoration-2026-11-02`.
Platform baseline: 0.2.0. Affected surfaces: Growth Connections and direct Instagram OAuth
verification. Existing provider connections and the Page-linked Meta alternative are retained.

## Outcome and scope

Offer two selectable methods, **Instagram Login** and **Meta Login**, with one **Continue**
action. Show Business/Creator eligibility and the no-Page requirement for direct login. Reuse the existing provider flow, token exchange,
account import and provider-specific operations rather than adding a parallel connector.
The preceding picker mixed a clickable direct card with a static Page-linked section; the
inconsistent affordances made the second method look unavailable. Both methods expose requested
access choices, and switching methods alone does not navigate. Direct login disables unsupported
published-media deletion. Selected direct capabilities are included in its start URL; the backend
adds required basic account access alongside only the selected feature permission scopes. The sign-in confirmation and account boundary remain unchanged.

The live Instagram client ID matches the Meta dashboard's Instagram product. Its existing
callback allowlist already includes the current public API callback. Both Instagram-specific
credential fields are populated; no secret was displayed, changed or made global. No Meta app
settings changed. A real authenticated start reaches Instagram's login screen with the direct
client and business scopes. The account holder completed the real sign-in/consent flow; MCP then confirmed a CONNECTED
an owned professional account with `authMethod=instagram_login`. This is separate from the
workspace's existing Page-linked connection using Meta Login.

## Verification and limitations

Three focused backend tests passed without skips: dedicated Instagram credentials and callback,
short/long token exchange and profile lookup without Facebook Page discovery, and rejection of
wrong/missing credentials or account identity. Existing direct publishing and webhook signature
fixtures each passed separately. These provider fixtures do not establish a real post or message.

Meta currently calls this direct Login setup legacy but says it still works. Unified Login is
not introduced by this change. Direct Instagram token refresh is currently absent; do not claim
unattended token lifecycle reliability from a successful initial connection. Published media
deletion remains unsupported through this adapter. Other capabilities require their own tests.

## Release decisions

API/schema migrations, credential/configuration changes and new analytics events: not applicable.
The retained direct-start capability contract now has a frontend selector and a required Basic
scope correction. Explicit capabilities no longer lose the profile-access baseline.
Existing connection outcome logging and provider health records apply. Do not log passwords,
authorization codes, state, tokens or full OAuth callback URLs. Collector configuration and
existing central retention/alerting limitations are unchanged.

Update the direct-login runbook's obsolete callback URLs, public connection instructions and
feature-map verification entry. Rollout promotes a clean merged-source Growth frontend artifact
through the existing Vercel project. The backend retains existing flows and adds the mandatory Basic scope for explicit direct
permission selections. Rollback uses
the previous frontend deployment and preserves all connections; the former direct path remains
available as its clickable card. No Identity or provider configuration rollback is needed.
Post-release review: 2026-11-03. Direct provider sign-in/account import passed; publishing and messaging acceptance remain separate. Existing unrelated platform CI limitations remain in effect.

The isolated frontend passed frozen dependency installation, focused ESLint, typecheck and
shared/Growth production build. The updated drawer and its sign-in confirmation were checked
through the browser at390pxmobile,768pxtablet and the default1280pxdesktop viewport. The direct
button remains visible and the drawer scrolls without squeezing the control. Product import
boundaries and changed-file whitespace checks passed. These checks used a clean source archive
with only this change, excluding unrelated working-tree edits.

The final picker was exercised by clicking the Meta card label and changing selection with the
keyboard. The checked radio changes without navigation; both methods show their applicable access fields,
and direct Continue opens the retained Instagram sign-in confirmation with the selected capabilities. Both methods
remain selectable in the mobile drawer. An owned professional account completed the real direct
login and import; its CONNECTED state and `instagram_login` mode were read back through MCP.

Selected-permission verification: two new regressions failed before the mandatory Basic scope
fix and passed afterward. All five direct Instagram checks and two existing permission regressions
passed without skips; the Growth API build passed. Explicit publish-only, comment-only,
message-only and analytics-only selections include Basic and omit unrelated permission scopes.
The empty legacy request still retains its existing full bundle for compatibility.
