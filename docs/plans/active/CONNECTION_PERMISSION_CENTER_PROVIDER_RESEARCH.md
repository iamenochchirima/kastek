# Connection permission center provider research

**Status:** Research complete, implementation follow-up required

**Owner:** Platform integrations

**Checked:** 2026-08-31

**Scope:** WhatsApp Business Embedded Signup and Cloud API, Meta/Facebook/Instagram, Threads,
TikTok, LinkedIn, X, and Bluesky.

This note records facts from first-party documentation and API references. It does not change
application code or claim that a provider feature is available merely because a scope exists.
Provider products, versions, review requirements, and endpoint contracts change. The adapter must
revalidate the live provider contract before enabling a capability.

## Findings that affect the shared design

There is no single permission model that fits these providers.

| Provider family | Reliable post-authorization evidence | Request model | Main limitation |
| --- | --- | --- | --- |
| Meta, Facebook, Instagram | Token permission inspection, plus Page, business, and Instagram asset checks | Request a subset of permissions through the applicable Meta Login flow. The user may grant only a subset. | A granted token permission does not prove that the user has the required Page task, WABA asset, account linkage, or provider approval. |
| WhatsApp Embedded Signup | Token permissions, returned WABA and phone identifiers, assigned users, phone numbers, templates, webhook subscription, and setup responses | Embedded Signup configuration and setup flow. This is not a generic arbitrary-scope checkbox flow. | Live Embedded Signup only exposes permissions approved for Advanced Access. Asset setup and business roles are separate from OAuth grants. |
| Threads | Access Token Debugger and successful calls against the Threads user, posts, replies, or insights endpoints | Request permission names in the Threads Authorization Window. | Non-role users need App Review and a published app. Public-profile permission grants have a documented 90-day lifecycle. |
| TikTok | The token response returns the user-approved comma-separated `scope`; endpoint-specific creator and status APIs provide further evidence | Users may approve a subset of requested scopes. Request additional approved scopes through Login Kit again. | App/product approval and scope pre-approval are separate from the user's grant. Unaudited direct-post clients are limited to private viewing. |
| LinkedIn | The token response returns `scope`; organization authorization endpoints inspect the member's effective rights for a target organization | OAuth asks the member to approve the requested scope set as a whole. LinkedIn does not provide individual scope checkboxes in one consent screen. | Organization roles and API products are separate gates. Changing scopes invalidates previous tokens. |
| X | OAuth scopes and endpoint responses. The current OAuth documentation does not describe a user-token introspection endpoint equivalent to Meta's debugger. | OAuth authorization URL with requested scopes. Users must authorize a new scope set to change access. | API product access, developer-policy approval, plan, and credit balance can block calls even when the user scope is correct. |
| Bluesky and atproto | OAuth token response must return the granted `scope`; PDS and Authorization Server metadata are part of the authorization evidence | Progressive scope requests and explicit upgrades are documented. Granular repo, blob, RPC, and chat permissions are possible. | The network is distributed. The account's authoritative PDS and Authorization Server must be resolved and verified. |

The shared permission center should therefore store two kinds of evidence:

1. A normalized provider grant snapshot, with raw provider names retained only inside the provider
   adapter or encrypted Core record.
2. A target capability check, such as a Page task, organization authorization, WABA phone access,
   creator information response, or action-time provider response.

`GRANTED` should require evidence appropriate to the target. A scope string alone is not enough for
Meta assets, LinkedIn organizations, or WhatsApp setup. `UNKNOWN` is the correct state where the
provider does not expose a complete inventory. The adapter should then perform a bounded action
probe and translate a provider denial into a reason code.

## 1. WhatsApp Business Embedded Signup and Cloud API

### What the provider actually authorizes

Meta describes Embedded Signup as an embeddable onboarding flow for Solution Partners, Tech
Providers, and Tech Partners. The flow collects business and WhatsApp setup information, grants
the app access to customer WhatsApp assets, and returns an exchangeable token code that the server
uses to obtain a business token.

Sources: [Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview),
[Meta's official Embedded Signup collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup?entity=request-13382743-656e8eed-45ed-4740-aba1-c632dc1f64df).

For the Cloud API flow, Meta documents these core permissions:

| Product capability | Permission or evidence |
| --- | --- |
| WABA settings, message templates, and other account management | `whatsapp_business_management` |
| Business phone number settings and sending or receiving messages | `whatsapp_business_messaging` |
| Business portfolio operations such as credit-line sharing in the Solution Partner flow | `business_management`, plus the required business role |
| Analytics | WhatsApp Business Management analytics endpoints. The current official collection exposes `Get analytics` and `Get conversation analytics`; do not infer that analytics access follows from messaging access. Verify the exact endpoint permission for the Graph API version in use. |

The permissions reference is [Meta Permissions](https://developers.facebook.com/docs/permissions).
The official API collection also documents WABA operations such as assigning users, listing phone
numbers, and subscribing an app to a WABA. Those calls are important capability evidence because a
token can have the right OAuth permission while the business has not assigned the relevant WABA or
phone asset to the app.

### What can be inspected after authorization

Use the following checks, in this order:

1. Inspect the token with Meta's [`debug_token`](https://developers.facebook.com/docs/graph-api/reference/debug_token/)
   endpoint. Record the allowlisted permission names, expiry, and any granular target information.
2. Confirm the Embedded Signup result contains the expected business, WABA, and phone-number
   identifiers.
3. Read the WABA's assigned users, phone numbers, message templates, and webhook subscription
   state through the WhatsApp Business Management API.
4. Run a cheap capability-specific read, such as reading the phone or template inventory, before
   reporting the capability as healthy.
5. For sending and receiving, verify both the messaging permission and webhook subscription. A
   successful OAuth callback alone does not prove that inbound webhooks are configured.

The official [WhatsApp analytics collection](https://www.postman.com/meta/whatsapp-business-platform/folder/r6b0bp9/analytics)
confirms that analytics is a separate API area. The implementation should keep `ANALYTICS` as
`UNKNOWN` until the versioned endpoint and required permission are verified against the token.

### Incremental requests and reauthorization

Embedded Signup lets the app configuration declare the required permissions and lets the business
customer complete asset setup. It does not give KasiTek a universal in-product permission picker
that can manufacture arbitrary per-scope choices. A later access request should reopen the
provider's Embedded Signup or related Business Login setup for the same logical connection, with
the required configuration and asset context.

The provider's own authorization result is authoritative. On callback, replace or update the
credential record and reconcile the WABA and phone assets. Preserve the logical KasiTek
connection, local drafts, posts, routes, and history. Do not tell the user to disconnect unless
the provider returns an actual connection-identity conflict.

### Publishing, messaging, analytics, and deletion

- WhatsApp Business Platform is a messaging API. It is not a social publishing API, so
  `PUBLISHING` should be `UNSUPPORTED` for ordinary WhatsApp messages.
- Sending and receiving requires `whatsapp_business_messaging`, the correct WABA and phone-number
  assignment, and a valid webhook setup for inbound events.
- WABA management and templates use `whatsapp_business_management`.
- Analytics is available through the Business Management API, but its permission and endpoint
  contract must be checked per Graph API version.
- The Cloud API does not provide a provider-level "delete a sent message for everyone" operation
  that an external application can use as a social-post delete. Do not advertise content deletion
  as available merely because local message deletion exists in KasiTek.

### Review and approval constraints

Meta's Embedded Signup documentation states that, in live mode, only permissions approved for
Advanced Access through App Review appear in the flow. The official collection says the app must go
through App Review and request Advanced Access for `business_management` and
`whatsapp_business_management` for the Solution Provider path. Messaging use cases also require
the messaging permission and the relevant review/access state.

Sources: [Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview),
[WhatsApp Solution Provider App Review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review),
[Meta's App Review guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review).

Implementation consequence: the permission center needs separate states for `REQUESTABLE`,
`REQUIRES_PROVIDER_APPROVAL`, `NOT_GRANTED`, and `UNKNOWN`. A user-facing "Grant access" button
cannot fix an app that has not received the required Advanced Access.

## 2. Meta, Facebook Pages, and Instagram

Meta has several related authorization modes. Facebook Login for Business, the Instagram API with
Facebook Login, and the Instagram API with Instagram Login do not have identical account linkage or
permission names. The connection record must keep the auth mode.

### Facebook Pages

The current Meta permission reference describes the main Page permissions as follows:

| Capability | Current permission evidence |
| --- | --- |
| Discover Pages | `pages_show_list` |
| Read Page engagement and related content | `pages_read_engagement`, with endpoint-specific dependencies |
| Create, edit, and delete Page posts | `pages_manage_posts` |
| Page comments and engagement management | `pages_manage_engagement` where the endpoint requires it |
| Page conversations and Messenger calls | `pages_messaging` |
| Page, app, and domain Insights | `read_insights` |
| Business asset access | `business_management` where the endpoint targets business assets |

Sources: [Meta Permissions](https://developers.facebook.com/docs/permissions),
[Page feed reference](https://developers.facebook.com/docs/graph-api/reference/page/feed/),
[Page Insights reference](https://developers.facebook.com/docs/graph-api/reference/page/insights/),
[Page conversations reference](https://developers.facebook.com/docs/graph-api/reference/page/conversations/).

The reliable inspection sequence is token permission inspection, Page discovery, then inspection
of the Page access token and Page task/endpoint response. The user permission and the Page's
effective task access are different facts.

### Instagram with Facebook Login

For the Instagram API with Facebook Login, Meta's current documentation and official Postman
collection identify these dependencies for a typical professional-account integration:

| Capability | Permission evidence |
| --- | --- |
| Discover and read the professional account | `instagram_basic`, plus `pages_show_list` and `pages_read_engagement` for the Facebook Login path |
| Publish organic feed media | `instagram_content_publish` |
| Read and manage comments | `instagram_manage_comments` |
| Read and respond to Instagram Direct messages | `instagram_manage_messages` |
| Read account and media Insights | `instagram_manage_insights` |
| Page-linked asset access | The Facebook Page must be linked to the Instagram professional account, and the authenticated user must have the required Page access |

Sources: [Instagram API with Facebook Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login),
[Instagram Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing),
[Instagram Account Insights](https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights),
[Instagram API App Review](https://developers.facebook.com/documentation/instagram-platform/app-review),
[Meta Permissions](https://developers.facebook.com/docs/permissions).

### Instagram with Instagram Login

Meta also documents a direct Instagram Login path with a different permission family:

- `instagram_business_basic` for business-account profile and media data.
- `instagram_business_content_publish` for organic content publishing.
- `instagram_business_manage_comments` for comment management.
- `instagram_business_manage_messages` for professional-account messaging.
- `instagram_business_manage_insights` where the current product exposes it for Insights.

Source: [Instagram Login for Business](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login).

The adapter must not merge `instagram_basic` and `instagram_business_basic` into one generic
permission. They belong to different Meta login products and can have different dependencies.

### Inspection and incremental access

Meta's permissions documentation says users can grant or deny the requested permissions or a
subset. The token debugger can show the token's current permission state, and Page/Instagram
asset calls provide the target-specific evidence. A later request should rerun the same auth mode
with the expanded permission set, then reconcile the returned token and assets.

This supports a product-level staged request, but it does not guarantee that every Meta permission
will appear as an independent user-selectable checkbox. Meta's own consent and App Review rules
remain authoritative. The KasiTek modal can select product capabilities only when the adapter marks
them as requestable.

### Publishing, messaging, analytics, and deletion

- Facebook Page post create, edit, and delete is represented by `pages_manage_posts`, subject to
  Page access and endpoint dependencies.
- Facebook Page messaging is represented by `pages_messaging`, with Page and product constraints.
- Facebook Page Insights use `read_insights` and target-specific Page access.
- Instagram feed publishing uses the appropriate content-publish permission for the selected login
  mode.
- Instagram messaging and comment moderation have separate permissions. Publishing access does not
  imply Direct access or comment-management access.
- The current Instagram API publishing and media reference pages do not document a general
  `DELETE` operation for an Instagram media object. Comment deletion is documented under comment
  management, but that is not the same as deleting a published post. The adapter should report
  Instagram published-media deletion as `UNSUPPORTED` unless a versioned first-party reference
  explicitly adds it. This is an inference from the current reference surface, not a claim that a
  future Graph version cannot change it.

### Review and approval constraints

Meta says App Review is required for apps seeking Advanced Access to data they do not own or
manage. Apps should request only the permissions they need, and the review submission must show
the real use of each permission. Standard/Advanced Access and the account's Page or Business role
are separate checks.

The permission center must expose these as different states:

- App capability not approved by Meta.
- User did not grant the permission.
- User granted the permission but lacks Page, Business, or Instagram asset access.
- Provider asset is not linked or is not eligible.
- Capability is unsupported by the endpoint.

## 3. Threads

Threads uses a Meta app with a Threads use case and a Threads user access token. The current
first-party guide lists these permission names:

| Capability | Permission |
| --- | --- |
| Base Threads API access | `threads_basic` |
| Create and publish Threads media | `threads_content_publish` |
| Read replies | `threads_read_replies` |
| Reply or manage replies | `threads_manage_replies` |
| Read account and post insights | `threads_manage_insights` |
| Delete own Threads media | DELETE is documented by the current Posts API reference; the current permission catalog does not clearly list a separate deletion scope |

Sources: [Threads Get Started](https://developers.facebook.com/documentation/threads/get-started),
[Get Access Tokens and Permissions](https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions),
[Threads Posts](https://developers.facebook.com/documentation/threads/posts),
[Delete Threads Posts](https://developers.facebook.com/documentation/threads/posts/delete-posts),
[Threads Insights](https://developers.facebook.com/documentation/threads/insights),
[Threads API reference](https://developers.facebook.com/documentation/threads/reference).

### Inspection and reauthorization

Meta's Threads guide points developers to the [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken)
to inspect token type, expiry, and granted permissions. The implementation should also call the
Threads user profile endpoint and a capability-specific endpoint after callback. A profile lookup
proves account identity, not publishing, replies, insights, or deletion access.

Users authorize permissions through the Threads Authorization Window. Threads testers can grant
permissions during development. For users without an app role, each permission must be approved
through App Review and the app must be published. The current guide says grants made by users with
public profiles are valid for 90 days, and refreshing an unexpired long-lived token extends that
grant by another 90 days. Private-profile users must grant the expired permission again.

The practical reauthorization operation is to start the Authorization Window again with the
expanded permission set, exchange the code, inspect the returned token, and replace the old token
while preserving the logical connection. Do not label this as a simple token refresh. Refreshing a
long-lived token keeps the grant alive; it does not add a new permission.

### Publishing, messaging, analytics, and deletion

- Publishing requires `threads_basic` and `threads_content_publish`.
- Reply reads require `threads_read_replies`; reply writes require `threads_manage_replies`.
- Insights require `threads_manage_insights`.
- The public Threads API is not a general private-message API. Do not map reply management to
  messaging.
- Deleting a user's own Threads post is documented by the current Posts API reference. The current
  first-party permission catalog does not clearly list a separate deletion scope, so the adapter
  must verify the current Graph/API version and a real DELETE preflight before exposing deletion as
  requestable. Do not hardcode `threads_delete` as a grantable permission until Meta documents it
  in the applicable version.

Threads therefore has a relatively good adapter fit: token permission inspection, explicit
capability scopes for the documented areas, and a documented delete operation whose current
permission gate needs version-specific verification. The 90-day public-profile grant lifecycle
must be visible in connection health and refresh scheduling.

## 4. TikTok

TikTok Login Kit uses OAuth 2.0. The token response includes the TikTok user's `open_id`, a
comma-separated `scope` string containing the scopes the user agreed to, access-token expiry, and a
refresh token. TikTok explicitly says users can grant a subset of requested scopes.

Sources: [TikTok scopes reference](https://developers.tiktok.com/docs/en/tiktok-api-scopes),
[Manage User Access Tokens](https://developers.tiktok.com/docs/en/oauth-user-access-token-management),
[Login Kit for Web](https://developers.tiktok.com/doc/login-kit-web),
[Get User Info](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info).

### Capability mapping

| Capability | Scope or evidence |
| --- | --- |
| Basic profile | `user.info.basic` |
| Extended profile | `user.info.profile` |
| Profile counts such as followers, likes, and public video count | `user.info.stats` |
| Read public videos | `video.list` |
| Direct publishing | `video.publish` |
| Upload as a TikTok draft for later editing | `video.upload` |
| Publish preflight and account-specific privacy controls | `POST /v2/post/publish/creator_info/query/` with `video.publish` |
| Publish completion state | `POST /v2/post/publish/status/fetch/` with `video.publish` or `video.upload` |
| General messaging | No public Login Kit or Content Posting scope in the current scope catalog provides general send/receive messaging. |
| Analytics | `user.info.stats` provides profile counts. Public-video reads provide video data. The current public scope catalog does not define a general creator analytics scope for the standard publishing integration. Treat richer analytics as unavailable or provider-specific until a current first-party product is approved. |
| Published-content deletion | No current public Content Posting scope or delete endpoint was found in the first-party scope and Content Posting references. Treat as `UNSUPPORTED`, not as a missing grant. |

TikTok's Content Posting API is not fire-and-forget. The creator-info request supplies current
privacy and interaction options, and the status endpoint or webhook reports the later processing
result. The permission adapter should expose `PUBLISHING` only after `video.publish` is in the
token and the creator-info request succeeds.

### Inspection and incremental requests

The token exchange and refresh responses return the current agreed scope string. Store the parsed
scope set as the primary grant snapshot. Then use `Get User Info` and Content Posting creator-info
as target checks. A failed endpoint call must distinguish a missing scope from an unavailable
product, a creator setting, a rate limit, or a processing failure.

TikTok's authorization URL accepts a scope set, and users can grant a subset. To add access later,
run Login Kit again with the newly approved scopes. A refresh token refreshes the token lifecycle;
it is not the mechanism for adding permissions. The token-management API also documents a revoke
endpoint for disconnecting the app.

### Review and approval constraints

TikTok separates these gates:

1. The app must have the relevant TikTok product enabled.
2. The scope must be approved for the app.
3. The TikTok user must authorize that scope.
4. The endpoint may impose product, creator, URL-verification, audit, or moderation rules.

For Direct Post, TikTok requires approval and user authorization of `video.publish`. Content posted
by unaudited clients is restricted to private viewing until the client completes TikTok's audit.
TikTok's app review guidance requires a real website, visible privacy and terms links, a detailed
use-case description, and an end-to-end demo video. Production revisions must be reviewed again.

Sources: [Direct Post setup](https://developers.tiktok.com/docs/en/content-posting-api-get-started),
[Query Creator Info](https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info),
[Get Post Status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status),
[TikTok App Review Guidelines](https://developers.tiktok.com/docs/en/app-review-guidelines),
[Register Your App](https://developers.tiktok.com/docs/en/getting-started-create-an-app).

Implementation consequence: TikTok should expose a guided "Request TikTok access" flow for
approved scopes, but the UI must not promise public publishing until both approval and audit state
are known.

## 5. LinkedIn

LinkedIn has member-level permissions, organization-level roles and authorizations, and product
access tiers. These are separate checks.

### OAuth inspection and reauthorization

LinkedIn's 3-legged OAuth token response includes a space-delimited `scope` value. The current
authorization guide says:

- the application requests scopes in the OAuth `scope` parameter;
- a member consents to the requested scope set;
- if multiple scopes are requested, the member must consent to all of them and cannot select
  individual scopes in that consent screen;
- if the application's scope set changes, users must re-authenticate;
- requesting a different scope invalidates previous access tokens.

Sources: [LinkedIn 3-legged OAuth](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow),
[LinkedIn OAuth overview](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authentication),
[Getting access to LinkedIn APIs](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access).

This is the clearest counterexample to a universal multi-select permission modal. KasiTek may show
feature groups before redirecting, but the LinkedIn provider screen is all-or-nothing for the
requested scope set. If the user does not approve all requested scopes, the adapter must handle the
authorization failure and preserve the old connection until the replacement token is validated.

### Capability mapping

| Capability | Permission or target evidence |
| --- | --- |
| Sign in and basic member profile | Current open permissions such as `profile` and `email` under OpenID Connect. |
| Publish as a member | `w_member_social` |
| Read member posts, comments, and likes | `r_member_social`, restricted to approved developers. |
| Publish as an organization | `w_organization_social`, plus an eligible organization role such as Administrator, Direct Sponsored Content Poster, or Content Admin. |
| Read organization posts, comments, and likes | `r_organization_social`, plus eligible organization access. |
| Organization management and reporting | `rw_organization_admin` or `r_organization_admin`, plus the relevant organization role. |
| Organization analytics | Organization Analytics authorization actions such as `VISITOR_ANALYTICS_READ`, `FOLLOWER_ANALYTICS_READ`, and `UPDATE_ANALYTICS_READ`, checked for the target organization. |
| Organization post edit and delete | The Organization Authorizations API exposes `ORGANIC_SHARE_EDIT` and `ORGANIC_SHARE_DELETE`; role and product access still apply. |
| General member or Page inbox messaging | No public general member/Page inbox permission is listed in the current Community Management access tables. Message Ads and Conversation Ads are advertising products, not a general inbox channel. |

Sources: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-04),
[Organization Access Control by Role](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-06),
[Organization Authorizations](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-authorizations/organization-authorizations?view=li-lms-2026-07),
[Community Management overview](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-06),
[Message Ads API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/message-ads-integrations?view=li-lms-2026-03).

### Inspection sequence

1. Parse the OAuth token's `scope`.
2. Discover or read the member identity with the appropriate OpenID or member endpoint.
3. For each organization target, call `/organizationAuthorizations` to ask for the concrete
   action, rather than maintaining a hardcoded list of roles. LinkedIn documents this endpoint as
   a permission-based check that avoids code changes when new roles are introduced.
4. Treat API product tier, organization role, token scope, and target action as independent
   evidence.
5. Use a real operation or a read endpoint to confirm the specific post or analytics capability.

### Review and approval constraints

LinkedIn's open permissions include profile, email, and `w_member_social`. Most other permissions
and partner programs require explicit approval. Community Management is a vetted product with
Development and Standard tiers. LinkedIn's current access documentation requires an approved use
case, verified business email, verified organization, verified website/domain, and an application
associated with the same LinkedIn Page. Standard-tier access requires a screen recording of the
application's use cases. LinkedIn may monitor or suspend access after approval.

Sources: [Getting access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access),
[Community Management access](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-06),
[Community Management App Review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-03).

Implementation consequence: the LinkedIn adapter needs target-scoped checks and must not represent
`w_organization_social` as "organization publishing works" until the target organization's
authorization action succeeds.

## 6. X

X OAuth 2.0 Authorization Code with PKCE exposes granular user scopes. The current scope list
includes:

| Capability | Scope |
| --- | --- |
| Read posts and protected posts visible to the user | `tweet.read` |
| Create, retweet, and delete the user's posts | `tweet.write`, with `tweet.read` and `users.read` required by the current endpoint mapping for manage-tweets calls |
| Upload media | `media.write` |
| Read and send/manage Direct Messages | `dm.read` and `dm.write` |
| Read users | `users.read` |
| Keep a user connection until revocation | `offline.access` |
| Read account-owned and public metrics | `tweet.read` plus the endpoint's user-context and ownership requirements |

Sources: [X OAuth 2.0 Authorization Code with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code),
[X v2 authentication mapping](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping),
[X Direct Messages integration](https://docs.x.com/x-api/direct-messages/manage/integrate),
[X API overview](https://docs.x.com/x-api/overview).

### Inspection and reauthorization

The authorize URL declares the requested scopes. The token response gives the access token and, if
requested, a refresh token. The current X documentation maps scopes to endpoints, but it does not
document a Meta-style user-token introspection endpoint that returns the full current grant.

The adapter should therefore:

1. Persist the exact scope set requested and the scope set returned by the token exchange if the
   response includes it.
2. Call `GET /2/users/me` to verify account identity.
3. Use endpoint-specific reads or a low-cost capability check for publishing, DMs, media, and
   analytics.
4. Classify 401/403 errors by missing scope, expired/revoked token, unavailable endpoint, rate
   limit, or insufficient API access.

Changing permissions requires reauthorization to obtain a token with the new grant. Refreshing a
token keeps the existing grant and does not add scopes. Reauthorization must update the existing
logical connection only after the new token and identity have been checked.

### Publishing, messaging, analytics, and deletion

- Publishing and post deletion are supported by the manage-posts endpoints with user-context
  authorization. The current mapping lists `tweet.write`, `tweet.read`, and `users.read`.
- Media publishing also needs `media.write` for upload.
- Direct Messages require both `dm.read` and `dm.write` for the manage-DM integration; the API
  documents message deletion as a separate operation.
- Public metrics and account-owned metrics are available through X API post fields and analytics
  endpoints, but private or specialized analytics may have endpoint, ownership, and plan gates.
- X is not a single fixed "analytics permission" provider. Analytics should be capability-specific
  and verified by the endpoint being used.

### Approval, policy, and commercial constraints

X currently uses a Developer Console, developer-account policy review, app permissions, API access
plans, and pay-per-use credits. The current Developer Policy says developers must disclose planned
use and that X may review it. The API documentation also states that credit balance and spending
limits can block requests. Enterprise access requires a separate application and onboarding path.

Sources: [X Developer Apps](https://docs.x.com/fundamentals/developer-apps),
[X Developer Policy](https://docs.x.com/developer-terms/policy),
[X API pricing](https://docs.x.com/x-api/getting-started/pricing),
[Enterprise access](https://docs.x.com/enterprise-api/getting-started/getting-access).

Implementation consequence: X's permission center must display both user grant state and provider
access state. "Connected" with `tweet.write` is not enough to promise publishing if the app lacks
the required product access or credits.

## 7. Bluesky and the atproto network

Bluesky uses the atproto OAuth profile rather than a single centralized OAuth provider. An account
handle or DID resolves to an authoritative PDS and Authorization Server. OAuth uses authorization
code flow, mandatory PKCE, PAR, and DPoP.

Sources: [atproto OAuth specification](https://atproto.com/specs/oauth),
[atproto permissions specification](https://atproto.com/specs/permission),
[OAuth patterns](https://atproto.com/guides/oauth-patterns),
[Permission sets](https://atproto.com/guides/permission-sets),
[Bluesky create record reference](https://docs.bsky.app/docs/api/com-atproto-repo-create-record),
[Bluesky delete record reference](https://docs.bsky.app/docs/api/com-atproto-repo-delete-record).

### What can be inspected

The atproto OAuth profile requires the Authorization Server to return the granted scopes in the
token response, even when they match the request. The client must reject a token response that
does not contain `atproto` and must verify that the returned account DID matches the authoritative
server and the account expected by the session.

The permission system has these resource types:

- `repo` for repository records and collections.
- `blob` for uploaded media.
- `rpc` for authorized calls to services.
- `identity` for DID and handle data.
- `account` for account and email-related state.
- `include` for a published permission set.

This gives Bluesky the strongest fit for a capability inspector, but the inspector must retain the
audience, collection, action, and Lexicon method details. A boolean `bluesky_scope_granted` loses
too much information.

### Incremental access

The atproto documentation explicitly supports progressive scope requests. A client can request a
minimal base scope, ask for only the scopes needed by the next feature, and later upgrade an
existing session by running OAuth again with the expanded scope set and replacing the old session.
The token response may reflect partial authorization.

The `repo` permission can restrict access to named collections and to `create`, `update`, or
`delete` actions. `blob:*/*` grants media upload. The transitional `transition:generic` scope
provides broad repository and blob access but does not include DMs. `transition:chat.bsky` adds
access to the `chat.bsky.*` Lexicons and depends on `transition:generic`.

Permission sets can give users a short title and description while expanding to granular
permissions. Their computed contents can change when tokens refresh, but an existing OAuth session
remains limited to the originally granted scopes. This is a useful model for KasiTek's product
capability groups, provided the provider stores the resolved permission evidence.

### Publishing, messaging, analytics, and deletion

- Publishing is a repository write operation, normally a `repo` permission constrained to the
  relevant collection and actions, plus `blob` for media.
- Content deletion is also a repository operation. A delete-specific `repo` action can be
  requested, so deletion is not automatically implied by post creation.
- Direct messages use the `chat.bsky.*` Lexicons. The transitional scope is `transition:chat.bsky`;
  granular OAuth permissions should be used where supported by the target Authorization Server.
- The standard atproto permission model does not define a centralized analytics permission. Read
  profile, feed, or service-specific analytics access must be represented as the relevant `rpc`
  permission and verified against the target service. Treat broad analytics as `UNKNOWN` unless
  the target service publishes a permission set or endpoint contract.

### Approval and operational constraints

There is no Meta-style central App Review process in the atproto OAuth specification. Authorization
Servers may maintain trusted-client lists, apply their own user-interface policies, and reject
clients that fail metadata, security, identity, or scope requirements. Client metadata is fetched
from a public URL, and the client ID itself is a URL.

The adapter therefore needs to support per-account discovery, public client metadata, PAR, PKCE,
DPoP nonce handling, token rotation, refresh locking, and session replacement. A failed authorization
on one PDS must not be treated as a provider-wide denial for all Bluesky accounts.

## Recommended adapter contract after research

The provider-neutral access endpoint should return capability records with at least these fields:

| Field | Meaning |
| --- | --- |
| `capability` | KasiTek product capability, such as `PUBLISHING`, `MESSAGING`, `ANALYTICS`, or `CONTENT_MANAGEMENT`. |
| `state` | `GRANTED`, `NOT_GRANTED`, `REQUESTABLE`, `UNSUPPORTED`, `UNKNOWN`, or `REQUIRES_PROVIDER_APPROVAL`. |
| `evidence` | Bounded evidence type, such as `token_scope`, `token_debugger`, `page_task`, `waba_asset`, `organization_authorization`, `creator_info`, `endpoint_probe`, or `atproto_scope`. |
| `providerGrant` | Internal-only raw scope, permission, task, role, permission set, or auth-mode reference. Never send raw credentials or unrestricted provider payloads to Agent Platform. |
| `target` | The Page, Instagram professional account, WABA, phone number, organization, member, X user, TikTok open ID, or atproto DID/PDS to which the capability applies. |
| `requestMode` | `oauth_scope_subset`, `embedded_signup`, `provider_setup`, `reauthorize`, or `none`. |
| `approval` | Whether the app/product itself needs review, audit, tier access, business verification, or provider approval. |
| `reasonCode` | A bounded user-safe reason for a missing or unknown capability. |
| `retry` | Whether the user can request access, must change provider configuration, or must retry the action after a successful grant. |

The request planner should operate on product capabilities and return a provider-specific plan.
The provider adapter owns raw names, target checks, OAuth construction, and callback reconciliation.
The agent and gateway layers should only consume the normalized result.

## Implementation order implied by the evidence

1. Finish WhatsApp as an Embedded Signup/setup adapter, not as a copy of the Meta OAuth checkbox
   flow. Add WABA, phone, template, webhook, and analytics inspection separately.
2. Add the provider-neutral access endpoint and make the existing connection read use it. The
   endpoint needs target-scoped records and an explicit `UNKNOWN` state.
3. Add Threads using token debugging, explicit scopes, 90-day grant health, and a version-checked
   deletion preflight rather than an assumed deletion scope.
4. Add TikTok using returned scope sets, creator-info preflight, publish status/webhooks, and
   explicit audit/private-viewing state.
5. Add LinkedIn using the token scope plus `/organizationAuthorizations` for every organization
   capability. Do not offer a LinkedIn checkbox UI that the provider cannot honor.
6. Add X using scope mapping plus endpoint probes and separate developer access, plan, and credit
   state.
7. Add Bluesky with account/PDS discovery, granular atproto permissions, progressive requests,
   and DPoP/PKCE/PAR handling.

No application code was modified as part of this research.
