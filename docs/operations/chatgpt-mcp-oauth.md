# ChatGPT MCP client metadata compatibility

Change: accept the public method in a CIMD client's supported authentication choices.
Owner: Enoch Chirima. Risk: standard. Release ID: `growth-chatgpt-cimd-2026-11-02`;
platform baseline remains 0.2.0. Affected service: Growth API and its OAuth MCP connection path.

## Failure and change

The hosted authorization request using `https://chatgpt.com/oauth/client.json` returned
400 `invalid_client_metadata`: Growth rejected the legacy `private_key_jwt` preference before
checking the client's supported methods. ChatGPT's document also supports `none`, the only
method advertised by Growth. Official [OpenAI client registration guidance](https://developers.openai.com/plugins/build/auth#client-registration)
defines the plural field as supported choices and the singular field as a legacy preference.

CIMD validation now selects the supported public method only from a valid, nonempty string
list containing `none`. Without a choices list, existing singular validation remains. Clients
requiring confidential methods remain rejected. Dynamic registration retains its existing
singular-method rule. Exact metadata identity, public HTTPS fetching/IP pinning, redirect
validation, PKCE S256, workspace consent, token scope/resource checks and revocation are unchanged.

Stash's current live discovery advertises DCR and PKCE but does not advertise CIMD. It therefore
avoids this metadata-document negotiation step. Its working DCR path does not establish that
Growth's CIMD path was tested. Initial deployment checks exercised discovery and an OAuth
challenge, not a completed native ChatGPT connection.

## Verification and release

The production failure was reproduced with a synthetic read-only authorization request, without
granting access to a real workspace. Both new regression tests failed before the fix and passed
after it. Growth's API build, product import boundaries and whitespace checks passed.

Owned local PostgreSQL fixtures exercise consent, wrong-workspace denial, PKCE rejection,
code replay/races, refresh rotation, revocation and actual SDK MCP calls. A separate fixture uses
ChatGPT's real metadata URL and exact redirect URI through HTTPS fetching, consent and token
exchange; it never follows the external ChatGPT callback. These checks are distinct from the
native ChatGPT connector dialogue, which still requires the user's consent.

API/schema migrations and configuration changes: not applicable. New analytics events: not
applicable; reuse bounded OAuth denial/grant events and existing success/error metrics. Logs must
omit codes, tokens, client assertions, consent nonces and message contents. Collector/exporter
configuration is unchanged; existing centralized retention/alerting limitations remain.

Documentation: public MCP integration contract and current agent-access runbook updated;
this record captures rollout, evidence and limits. Feature-map routes/capabilities are unchanged.
Rollout deploys the merged Growth API artifact with existing flags and database. No frontend or
Identity deployment is needed. Rollback restores the previous Growth image; it also restores the
ChatGPT CIMD rejection. Disabling Growth agent access remains the existing emergency control.
Post-release review: 2026-11-03. Existing unrelated platform CI limitations still apply.

Final local verification: 14 current-source checks passed without skips across OAuth, revocation,
operations, SDK MCP and resource safety. The real ChatGPT CIMD fixture passed four checks
(including its full consent/code/token flow) without skips. No real business workspace was
granted and no social post was published by these tests.

Hosted verification at 2026-11-02 17:42 UTC: both Growth API and its analytics worker deployed
merged source `efcb4f115a6a4bad4b1bf628925f084b04ec4405` successfully. The same synthetic
ChatGPT authorization request now returns 302 to `https://app.kasitek.co.za/oauth/consent`,
replacing the reproduced400 metadata rejection. No real workspace grant was approved by the
agent. Native ChatGPT consent completion remains with the user. The
[sanitized deployment record](./releases/growth-chatgpt-cimd-2026-11-02.json) records exact artifacts
and verification limits.
