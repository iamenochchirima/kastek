# Direct Instagram connection restoration

Owner: Enoch Chirima. Risk: standard. Release ID: `instagram-direct-restoration-2026-11-02`.
Platform baseline: 0.2.0. Affected surfaces: Growth Connections and direct Instagram OAuth
verification. Existing provider connections and the Page-linked Meta alternative are retained.

## Outcome and scope

Expose direct Instagram Login as an explicit **Connect Instagram** action with Business/Creator
eligibility and no-Page requirement visible. Reuse the existing provider flow, token exchange,
account import and provider-specific operations rather than adding a parallel connector.
The preceding clickable card was easy to overlook beside the Page-linked **Continue to Meta**
button. The sign-in confirmation and account boundary remain unchanged.

The live Instagram client ID matches the Meta dashboard's Instagram product. Its existing
callback allowlist already includes the current public API callback. Both Instagram-specific
credential fields are populated; no secret was displayed, changed or made global. No Meta app
settings changed. A real authenticated start reaches Instagram's login screen with the direct
client and business scopes. Final consent/account import requires the account holder.

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
Existing connection outcome logging and provider health records apply. Do not log passwords,
authorization codes, state, tokens or full OAuth callback URLs. Collector configuration and
existing central retention/alerting limitations are unchanged.

Update the direct-login runbook's obsolete callback URLs, public connection instructions and
feature-map verification entry. Rollout promotes a clean merged-source Growth frontend artifact
through the existing Vercel project. Backend additions are regression tests only. Rollback uses
the previous frontend deployment and preserves all connections; the former direct path remains
available as its clickable card. No Identity or provider configuration rollback is needed.
Post-release review: 2026-11-03. Complete provider sign-in, account import, publishing and messaging
acceptance separately. Existing unrelated platform CI limitations remain in effect.

The isolated frontend passed frozen dependency installation, focused ESLint, typecheck and
shared/Growth production build. The updated drawer and its sign-in confirmation were checked
through the browser at390pxmobile,768pxtablet and the default1280pxdesktop viewport. The direct
button remains visible and the drawer scrolls without squeezing the control. Product import
boundaries and changed-file whitespace checks passed. These checks used a clean source archive
with only this change, excluding unrelated working-tree edits.
