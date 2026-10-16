# Agents client integration status

Updated: 2026-10-06.

The client lives in web and now uses React/TypeScript, Vite and React Router. Next.js routing, server cookie helpers, font/image imports and dependencies have been replaced. Existing agent, Studio, workflow and activity components remain product-local source, adapted to browser route loaders.

## Preserved UI

Growth's Vantage design tokens, authored Geist fonts, theme/accent/density preferences and existing UI primitives remain. The Agents shell uses Growth-style grouped navigation, collapse behavior, a mobile navigation dialog and a workspace header. Marketing pages have a separate cream/green layout and scoped styles.

## Remaining dependencies

The backend implements standalone /api/auth routes, with its own workspace/session records, OIDC callback, HttpOnly cookie and bounded provider checks. Independent local clients are registered. Password sign-in, workspace onboarding, dashboard access, provider rechecking and browser logout were verified with a dedicated local test account. An explicit browser route manifest now connects the initial /api/agents creation/Studio/playground contracts to the existing scoped handlers. Other inherited agent/integration screens still need endpoint review. No fake session or browser service-secret injection has been introduced.

The dev/preview proxy points /api to the configured Agents endpoint. It does not forward to Growth by default. Shared login belongs to Labs; the Agents integration must register its own client and enforce its own memberships.

### Current API boundary

The mounted initial journey uses Agents-owned `/api/auth/me`, workspace
creation/selection, activity and logout routes. Agent list, creation, version
editing, playground pinning, conversations, run detail/timeline, streaming,
retry and cancellation use the explicit `/api/agents` manifest in
`api/src/http/browser-agent-routes.ts`. Browser sessions supply account and workspace
context; no Growth Core session or service credential is required by these screens.
The Knowledge page lists hosted agents and opens their source controls. Agent
detail now connects source list/create/read/delete, manual text ingestion, file/URL
ingestion, website crawl and durable-memory controls through the same scoped
manifest. A signed-in member's manual FAQ create/list/delete path was verified in
the browser. File and single-URL ingestion, cross-workspace denial and retrieval-backed model answers passed locally. Firecrawl crawling still needs provider configuration.

Retained integration source such as `web/src/lib/connections.ts` still describes
Growth's `/api/connections` contract. It is not an enabled part of this slice.
Do not redirect that contract to another service or turn its settings on without
an Agents-owned connection design and scoped browser endpoints.

Execution needs a configured model provider and the configured billing dependency
or the explicit isolated development billing mode. Simple runs execute in the API;
durable runs also require Temporal and its matching worker. Real OpenRouter replies,
cancellation/retry/reconnect and simple process interruption are verified. Other
providers have independent adapters and credentials; their live acceptance remains
pending their own credentials. See the end-to-end plan for current evidence.

Studio approval groups now have explicit browser admission. Calendar approve/reject
and MCP approval transport passed locally. Rich `platform/ui-interactions` remain
outside the browser manifest. Tool grants, website chat and the inbox now work locally. Discord connection
setup is enabled, while real messaging acceptance, general live promotion and
personal runtimes remain later work.
Independent machine APIs keep their existing authentication.

Account settings provide current account/workspace information and logout. Workspace creation, selection and activity reporting use the real backend. Invitations and role management remain planned. Inbox now uses scoped Agents conversations and handoff controls. Connections and usage pages remain pending integration. Knowledge source management and retrieval-backed answers work locally. Personal runtime deployments are a later platform capability.

## UI retention decisions

Preserve Growth typography and colors, theme/accent/density preferences, spacing,
sidebar/top bar, workspace context, page headers, form/dialog/table primitives,
toasts and loading/empty/error states already present in Agents. Keep Studio,
Playground, agent definitions, conversations and run inspection as Agents-owned
components. The authenticated shell screenshot is saved locally under
`.artifacts/agents-authenticated-shell.jpg` for review.

Exclude Growth campaign/content publishing, CRM/contacts, bookings administration,
its billing/onboarding implementation, PWA/offline infrastructure and Growth-only
analytics. Booking tools remain backend agent capabilities. Growth remains a
reference checkout; runtime imports and changes to that repo are excluded.

## Evidence

The migration passed frontend typecheck, production build and existing Studio event/reducer checks. Landing and signup navigation were inspected in the browser. The dashboard and account screen rendered with real session/workspace records. A 390-pixel viewport check confirmed no horizontal page overflow and working mobile navigation dismissal. A Booking Assistant was created through the real standalone backend, reopened in Studio after refresh and shown in its workspace list. This migration evidence preceded the real OpenRouter acceptance now recorded in
`docs/plans/agents/END_TO_END_IMPLEMENTATION_PLAN.md`.

Follow the [frontend checklist](plans/agents/FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md). Growth's styling is reference material; no Growth files were modified by this frontend migration.

### Initial detail-screen availability

The initial browser manifest supports agent identity updates, installation status,
version reads/creation, hosted run history, the Studio execution path and knowledge
source/memory controls. Agent details now display pending states for analytics, customer conversations,
full workflow editing, provider-key management, tool grants, integrations, appearance,
live deployment/rollback and external credentials/operations. Studio links provide
the initial instructions/model workflow. Missing preference, archive/delete,
schedule and publish/retire controls are disabled or replaced with pending copy.
These are frontend availability choices for the initial slice, not authorization
rules. Backend permissions and independent machine APIs remain authoritative.

The remaining retained backend capabilities still need explicit scoped browser
admission and ordinary product verification before enabling those copied sections.
The unused detail-page schedule form was removed; backend scheduling code remains.

Copied route availability: ordinary `/agents/new` and `/agents/new/general`
bookmarks now enter the initial Studio creation form; a draft bookmark opens its
agent in Studio. Template setup, external registration, workspace activity,
workflow canvas and website appearance bookmarks expose pending screens rather
than mounting their incomplete setup/operator controls. Existing underlying
components and backend APIs are retained for later platform phases. The old
conversation bookmark enters the planned Inbox screen. Aggregate analytics keeps
its scoped backend summary and reports API failures through route errors instead
of manufacturing zero totals. Agent detail and Studio retain their scoped run
history; this is not a claim that workspace-wide operations are implemented.

Studio's initial browser path currently exposes behavior, memory and model/version
editing plus text playground setup. Capability catalogs/grants, gateway credential
and channel setup, audio submission and detailed safety-policy review have explicit
pending states. Their future source/backend paths remain intact, and frontend
availability does not replace backend authorization. Mobile Studio panels scroll
vertically so the conversation and observatory are both reachable.

### Frontend cleanup, 2026-10-06

Removed the superseded creation-flow/profile/general wizard and their exclusive
configuration/website-preview helpers. Both old creation routes now redirect to
Studio. Removed unused Next loading route modules and their skeleton component.
The workflow editor, website appearance and conversation source remains available
for later delivery; those product routes still show pending availability.


## Hosted installation API keys

Agent Settings uses explicit browser aliases to list/create/revoke
`/v1/installations/:installationId/api-keys`. Browser membership, role and
same-origin mutation checks still apply. Hosted keys have a separate table and
authenticate only the explicit `/api/v1/agent` aliases in
`api/src/http/hosted-agent-api-routes.ts`. They do not open the internal `/v1` routes,
external MCP interfaces, model vault, or agent administration.

Each key belongs to one custom hosted installation and its creating account.
Authentication reads only its lookup row in operator discovery scope, then returns
to tenant scope for usage and product operations. Public requests validate run and
conversation installation ownership, reject browser requests and model overrides,
and recheck expiry/revocation during streams. The public message path always uses
persisted conversation admission. Model/provider secrets remain in the backend.
Real key invocation, response and revocation passed locally on 2026-10-06.
See README for requests/errors and the implementation checklist for remaining work.


Studio's retained external-event action now has an explicit browser alias for
`POST /v1/runs/:runId/external-event`. It uses the existing workspace/session,
write-role and same-origin admission. Expected event keys are checked against
persisted wait metadata before signaling Temporal. Actual waiting, worker restart,
browser resume and terminal response are verified locally. Approval-group browser
routes are separately admitted and verified as recorded below.

## Website and live inbox contracts (local implementation, 2026-10-06)

Agents owns website deployment, visitor capability and customer conversation storage.
Management uses the signed-in workspace under explicit browser aliases. Public widget
routes under `/api/widget/v1` use exact allowed origins and one-day visitor capabilities
stored as hashes. The widget never receives administrator cookies or provider keys.
Website creation pins a separate published installation; drafts do not change it.

Teammates read `/api/agents/conversations/customer`, scoped conversation history,
`conversations/events/stream` and per-conversation `events/stream?after=N`.
The organization feed is a wake-up hint; reload the authoritative list after reconnect.
Per-conversation lifecycle events have durable sequence cursors. Message notifications
trigger history reload; message IDs identify rows and prevent duplicate rendering.
Browser streams recheck the signed-in session. A periodic history reload catches missed
message notifications. The initial inbox lists at most 200 conversations/latest messages;
larger-history pagination and per-teammate unread tracking remain follow-up work.

Mutation contracts:

- `POST conversations/:id/takeover` and `/reopen`: explicit teammate commands with
  an idempotency key. Reopen targets resolved conversations; takeover claims an
  existing pending request or creates a request with `request_source=operator`.
- `POST conversations/:id/notes`: an idempotent `private_note` system message.
  Only teammates can read it. Visitor history excludes it, and agent context skips it.
- `POST conversations/handoffs/:id/messages`: assigned teammate reply with an
  idempotency key. The message keeps its retry identity; the delivery attempt holds
  the provider receipt. Website publication sets the saved message to `sent`.
- Handoff `/resolve`, `/release`, `/claim` and `/continue` use the existing state
  machine. Continue uses the shared simple/durable dispatcher when it creates a run.

Customer inbound messages persist even while a human owns replies; no agent run is
created in that state. Ownership changes suppress queued automation replies, and
local website publication checks ownership inside the transaction. Sent historical
messages remain facts. An external provider send already in flight cannot be recalled;
actual channel acceptance remains pending a test account.

Growth can consume these APIs/events later under its own service admission. This
implementation does not read Growth tables or change Growth. Human write aliases
require a non-viewer workspace role and same-origin admission; channel ingestion and
operator administration remain outside the browser manifest.


## Remote MCP setup and deferred execution

Agent Tools uses explicit browser aliases for custom MCP providers, discovery,
health, published versions and per-version pins. Viewers can read; member writes
require same-origin admission. Global revocation is not exposed by these aliases.
Published Playground pin changes create a new candidate/version and preserve old
pins. Website installations retain their independent published versions.

Execution and approval revalidation both register only healthy, published,
organization-scoped pins. Deferred activities reload the run version's pins on a
fresh worker and reject no-longer-effective remote tools before dispatch. A local
separate-service read fixture passed through browser approval and durable execution.
The restricted MCP manifest still redacts the raw result. Before publication,
a member can explicitly review top-level scalar JSON fields for each discovered
tool. The separately projected reviewedResult reaches the model, while nested
objects, credential-shaped fields and redacted values stay excluded. A real
booking lookup returned its reviewed reference/status after browser approval;
the approval preview displayed its bounded reference. Inbox backend cursor
replay and browser recovery passed. Widget interruption recovery also passed after transient-error retry and
bounded fetch/history reload repairs.

## Customer channel setup

Channel list/create/pairing/disconnect browser aliases reuse the existing
installation and organization checks. Viewers have channels:read only; members
have channels:write with same-origin mutation admission. No browser aliases
expose inbound ingestion, pairing consumption or provider delivery callbacks.
The channel setup screen reads Agents-owned connections without calling
Growth’s /api/connections. Discord requires its own bot token, the gateway
process and an authorized test account; browser setup and invalid-token failure passed; actual message delivery is unverified.
Shared WhatsApp/Facebook/Instagram account linking remains pending an
Agents-owned contract.
