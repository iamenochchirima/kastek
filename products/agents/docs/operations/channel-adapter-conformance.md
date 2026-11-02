# Channel adapter conformance

Owner: Agents engineering. Last reviewed: 2026-10-30.

Provider webhook authentication establishes the transport sender, not organization membership.
Private member access requires the product's pairing and current-member authorization checks.
The provider adapters do not decide whether a conversation belongs to a member or a customer.

## Supported transport contract

Each adapter call sends at most one provider message. Telegram and WhatsApp support plain text
or one referenced image, audio, video or document. Media must have exactly one locator: a provider
media ID or an HTTPS URL without user information or a fragment. Telegram permits 4096 text
characters and 1024 caption characters; WhatsApp text is bounded to 4096 and captions to 1024.
WhatsApp audio captions are rejected. Application buttons use bounded payloads, including
Telegram's 64-byte callback limit. Rich-message formatting and automatic media fallback are
not supported by this transport contract.

Credential-bearing sends reject redirects. Telegram validates its credential's bot ID against
the selected asset and rejects a response naming another chat as an unknown outcome. Provider
responses, error descriptions and token-bearing URLs are not retained in adapter errors.

The adapters report provider acceptance separately from delivery. Network failures, malformed
successful responses, HTTP 408 and server failures remain unknown outcomes. A known 4xx
rejection can carry a retry delay. Adapters never resend internally. The delivery worker owns
durable segment claims and retries; an expired send claim becomes unknown rather than pending.
An accepted segment must survive failure or uncertainty in a later segment.

Telegram normalization marks a chat private only when `chat.type` is `private` and the actor ID
equals the chat ID. Callback actors use `callback_query.from`, not the original message author.
WhatsApp direct numeric sender messages are marked private; provider echoes are not. The safe
sender label is the provider identity, not a claimed display name. Neither marker grants access.
Receipts do not establish a member identity.

Production composition supplies an authorized bounded transport: one request, one attempt,
15-second deadline, 32 KiB request and 1 MiB provider-response limits. Attachment downloads
use a 2 MiB streaming limit, deny redirects and private destinations, allow only configured
provider hosts, reject active browser content and recheck membership and connection revisions
after transfer. Media bytes and provider locators do not enter model prompts. These product
limits are intentionally lower than provider upload limits.

## Reuse decisions and evidence

The historical checkpoints are evidence, not source to restore. Source paths in this table
are relative to each checkpoint and differ from the current monorepo API layout.

| Historical implementation | Decision | Current implementation and fixture evidence |
| --- | --- | --- |
| `76549ab5^:products/agents/src/channels/telegram-client.ts`, formatted and media sends | Adapt native methods and bounded interaction payloads; reject catch-all fallback after a partial/uncertain send | `api/src/adapters/channels/telegram/adapter.ts`; `api/test/channel-provider-adapters.test.ts` proves one call, invalid batches, lost acknowledgments, redirects and receipt scope checks |
| Same client, `downloadFile` buffers `arrayBuffer()` before size check | Reject buffering before bounds | `api/src/product/channels/channel-attachments.ts`; `api/test/channel-policy-attachments.test.ts` covers streamed overflow, active content and access revocation |
| `76549ab5^:products/agents/src/channels/telegram.ts`, raw sender/chat metadata | Adapt explicit actor/chat identity; reject allowlist or webhook secret as member authorization | Provider fixtures prove private-chat type and actor matching, group rejection marker, callback actor distinction and safe identity label |
| `c49c5ed3:server/kasitek-core/src/services/whatsapp.rs`, unified assistant routing | Reject product-coupled/private identity assumptions | Current product routing must resolve explicit member links and customer grants separately |
| `76549ab5^:products/growth/server/kasitek-core/src/services/whatsapp/inbox-delivery-sql.ts`, durable claims | Keep exclusive claims and unknown-outcome semantics through the current delivery ledger | `api/test/channel-delivery.test.ts` covers concurrent claims, segment identities, lost acknowledgment, stale leases, credential rotation and monotonic receipts |
| Current webhook verification, setup and provider asset checks | Keep | `channel-provider-adapters`, `channel-meta-adapters`, `telegram-setup`, `channel-meta-setup`, `channel-store` and `channel-routes` tests |

`api/` paths above are relative to `products/agents/`. PostgreSQL-backed fixtures require
`AGENTS_TEST_DATABASE_URL` and a disposable database owner. Skipped database tests are not
runtime evidence. Provider fixture tests do not establish live provider acceptance.

## Provider documentation and acceptance

The [Telegram Bot API](https://core.telegram.org/bots/api) was reviewed on 2026-10-30 for
webhook secret headers, callback payload limits, native send methods and retry metadata.
Newer Telegram rich/ephemeral message features are outside this implementation.

Official Meta [media documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)
returned HTTP 429 when rechecked on 2026-10-30; the new documentation route was also unavailable.
The [Meta-owned Postman collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
rendered its shell but no endpoint documentation. The current [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy), updated
23 September2026, was readable and confirms the 24-hour free-text reply window and approved-template
requirement outside it. Meta's [archived official SDK webhook documentation](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/)
corroborates challenge verification and signed raw-body webhook authentication; it is historical
transport evidence, not current API-version support. Complete current Meta technical conformance
and the supported Graph API version remain unverified. The configured setup profile supplies
the version explicitly; test versions such as `v24.0` and `v99.0` are fixtures, not support claims.

Before live rollout, the owner must verify the selected Graph version, permissions, subscribed
assets, token expiry, webhook ownership/signatures, messaging windows, template status and
consent requirements against accessible official documentation. With owned bot/number and
test accounts, confirm pairing, a direct answer, specialist draft, duplicate webhook, revoked
member, connection rotation, delayed result/window expiry, stale callback and interrupted send.
Inspect application delivery state independently from provider sent/delivered/read receipts.
No provider calls or model evaluations are part of the deterministic adapter checks.

## Release handling

The transport correction affects Agents API/worker sends; schema migrations and user analytics
are not applicable. Reuse the existing bounded channel error codes and delivery-state logging;
additional message bodies, credentials and sender display names must not enter logs. Release
identity is the tested deployment commit and existing worker configuration, recorded by the
release owner. Rollout and rollback use the containing private-assistant release; disabling
private admissions must preserve unresolved delivery records. Never clear unknown outcomes to
force a resend. Public provider-conformance claims must wait for the owner checks above.
