# Agents client integration status

Updated: 2026-10-02.

The client lives in client/apps/agent-platform and now uses React/TypeScript, Vite and React Router. Next.js routing, server cookie helpers, font/image imports and dependencies have been replaced. Existing agent, Studio, workflow and activity components remain product-local source, adapted to browser route loaders.

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
`src/http/browser-agent-routes.ts`. Browser sessions supply account and workspace
context; no Growth Core session or service credential is required by these screens.
The Knowledge page lists hosted agents and opens their source controls. Agent
detail now connects source list/create/read/delete, manual text ingestion, file/URL
ingestion, website crawl and durable-memory controls through the same scoped
manifest. A signed-in member's manual FAQ create/list/delete path was verified in
the browser. File/site ingestion, cross-workspace denial through these controls,
and retrieval-backed model answers remain unverified.

Retained integration source such as `src/lib/connections.ts` still describes
Growth's `/api/connections` contract. It is not an enabled part of this slice.
Do not redirect that contract to another service or turn its settings on without
an Agents-owned connection design and scoped browser endpoints.

Initial execution needs a backend model credential, a working Temporal server
and worker with matching namespace/queue, and the configured billing dependency
or the explicitly documented isolated development billing mode. These are runtime
prerequisites, not missing frontend endpoints. Model credentials remain the current
local blocker.

Inherited rich-response controls call `platform/ui-interactions` and run approval
routes that are not in the initial browser manifest. Those paths still need scoped
admission and ordinary verification before interactive tool/approval journeys can
be accepted. The first text-response journey does not establish their completion.
Capability grants, credentials/channels, live promotion, inbox and personal runtime
controls remain later work as described below. Independent machine APIs remain
available under their existing authentication.

Account settings provide current account/workspace information and logout. Workspace creation, selection and activity reporting use the real backend. Invitations and role management remain planned. Inbox, connections and usage pages are pending integration. Knowledge source management is available per hosted agent; end-to-end retrieval-backed answers remain pending. Personal runtime deployments are a later platform capability.

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

The migration passed frontend typecheck, production build and existing Studio event/reducer checks. Landing and signup navigation were inspected in the browser. The dashboard and account screen rendered with real session/workspace records. A 390-pixel viewport check confirmed no horizontal page overflow and working mobile navigation dismissal. A Booking Assistant was created through the real standalone backend, reopened in Studio after refresh and shown in its workspace list. Model execution remains unverified.

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
