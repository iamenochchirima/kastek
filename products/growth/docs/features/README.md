---
owner: engineering
last_reviewed: 2026-10-24
---

# Feature map

This is the index of user-facing routes currently present in Growth. The Agency tenant portal
and central Admin UI live in their owning monorepo directories and are outside this Growth route map.

For local startup, environment, and test commands, use [Local Development](../internal/development/local-development.md).
The main client runs on port `3000`; the other app ports and service prerequisites are listed in
that guide.

## Main client

React Router declarations are in `web/src/routes.ts`; route modules remain under `web/src/app/`.
`web/scripts/route-contract.json` records the complete 52-page URL inventory and alias behavior.
The table below groups those routes by feature; it is not the complete route list.

| Feature area | User entry point | Source route | Verification starting point |
| --- | --- | --- | --- |
| Public landing | `/` | `page.tsx`, `landing.module.css`, `root.tsx` | Public page follows Agents’ cream and green design with Growth content, signup/sign-in actions and Labs links. Production build prerenders public HTML. Inspect raw HTML metadata, canonical URL, sitemap, robots, and real HTTP status using `web/scripts/serve.mjs`. Signed-in navigation resolves in the browser; private session data is excluded from the prerender. |
| Shared login | `/login`, `/signup`, `/auth-error`, `/onboarding`, `/invite/<token>`, workspace Account security | `(auth)/`, `onboarding/`, `invite/`, `components/auth/` | Provider login, registration and account management use Labs Keycloak through Core. [Frontend contracts and verification](../internal/development/shared-login-frontend.md). Browser verification requires the configured Labs identity runtime, Core database and email delivery; Google additionally needs its configured OAuth client. |
| Agents and general assistant | `/agents`, `/agents/conversations/<id>`, dashboard quick access; contextual content/campaign/report actions | `(dashboard)/agents/`, `components/dashboard/agents/` | The image-aligned hub presents four defaults in a two-column grid, recent-conversation and task tables, and one shared general-assistant drawer. Four defaults and their managed model provision through durable setup. Growth-owned presets share configurable permitted tools for business context, content/campaign discovery and reads, explicit-range analytics, and explicitly requested private content draft saves. Current source defaults revision15 lets the Assistant coordinate Research, Content and Campaigns; Content and Campaigns can delegate focused evidence work to Research. Delegation depth and cumulative work use the shared runtime policy, while current grants, ancestor limits, concurrency and each preset's product/tool authority still apply. Owners/admins can separately import, review and select feature-owned text/Markdown knowledge and portable or curated skills from the feature card. Memory is opt-in and scoped to the verified member and feature agent; the specialist list shows whether selected specialist memory is enabled and available to the Assistant under both agents' current settings. Exact resource pins and current selection/revocation apply to accepted work; a managed assistant republishes its specialist bindings when a specialist configuration changes. Explicit operator and organization allowances still apply. An explicitly selected conversation context is pinned as a scoped reference and resolved through Growth's signed `context.read` action into a model-safe view. Its reference, content revision and recipient/provider audience are rechecked for replay, compaction, accepted-memory recall and delegated use. Content-post views omit internal publishing account and job fields while native records retain them. Growth capability revision15 uses the shared product-reference contract: declared record selectors become conversation-scoped handles in model results and retained history, then resolve only at declared tool inputs before Growth checks current authority. Growth connection and account reads use bounded, typed model views with usable selectors and continuation; unrelated provider metadata and signed media URLs are omitted. Ordinary output hides internal execution IDs and handles; public platform account IDs appear only when explicitly requested. Conversations use the shared agent UI for messages, compact tool activity and context inspection. Running and completed specialists open their own authorized conversation/activity in the same shared modal; closing inspection leaves execution running. Root and specialist operation history is paginated. Queued instructions, exact reviews, access renewal, safe continuation of incomplete work and cancellation retain product-owned controls. Continuation preserves prior results and cumulative usage in a linked immutable task. Draft requests return chat copy; saving requires an explicit request and current write authority. Multi-record evidence retains current access checks. Operator-controlled managed-default upgrades preserve customisations; saved settings apply to future turns. Authorized task capture supports owner-run evaluations. [Integration setup](../../../agents/docs/growth-integration.md) and the controlled `growth-product-http.test.ts` journey exercise the actual UI, Growth API proxy, signed shared HTTP, Restate and Growth record readback. Model evaluations and live-provider acceptance remain owner-run. |
| Campaigns | `/campaigns`, `/campaigns/create`, `/campaigns/<id>` | `(dashboard)/campaigns/` | Compact status-filtered records, four-step creation with authoritative audience preflight, explicit draft/send/schedule review and a recipient/template inspector preserve lifecycle and recovery controls. Run `playwright.campaigns.config.ts` and the migration draft-save journey; API recovery tests cover queue semantics. [Campaign behavior and verification](../internal/architecture/campaigns.md). Live delivery and model quality remain owner acceptance. |
| Contacts | `/contacts` | `(dashboard)/contacts/page.tsx` | Real contact rows, list/consent filters, pagination and a responsive record inspector retain CSV import/export, custom fields, consent and editing. Current-page sorting, field visibility, explicit page selection and formula-safe selected CSV export are available; single-contact creation reuses the existing import contract. The linked customer detail keeps channel identities and activity. Run the saved-edit migration journey and focused Contacts design checks; consent is separate from customer lifecycle. |
| Inbox | `/inbox` | `(dashboard)/inbox/page.tsx` | Channel tabs remain above the conversation list and reading pane. Search filters names, contact identifiers, previews and connected accounts; unread/starred filters remain available. Selected conversations show actual contact details and recent message activity in a sidebar from 1280px or a smaller-screen drawer. The reply composer keeps its Send action visible; the general assistant opens from the Inbox header. SMS remains unavailable. Run the controlled `playwright.inbox.config.ts` browser journeys for channel navigation, search, mobile details and persisted replies; live delivery needs the configured provider. |
| Calls | `/calls` | `(dashboard)/calls/page.tsx` | Verify filtered call history, responsive details, partial-read failures and Twilio cancellation/cleanup with `playwright.communications.config.ts`. Live calls remain owner-run. |
| Connections | `/connections`, `/connections/whatsapp-onboarding` | `(dashboard)/connections/` | Verify connected-account state, split-host OAuth callback → authenticated completion, and WhatsApp onboarding with the required provider configuration. Agents can reuse eligible Growth accounts through a scoped, revocable grant; provider credentials remain in Growth and an Agent grant does not disable Growth publishing. |
| Templates | `/templates` | `(dashboard)/templates/page.tsx` | Verify scoped template filters, responsive previews, two-account creation, retained input and persisted provider-review state with `playwright.communications.config.ts`. Live submission/sync remain owner-run. |
| Calendar and bookings | `/calendar`, `/bookings` | `(dashboard)/calendar/page.tsx`, `(dashboard)/bookings/page.tsx` | Open the route with the required service and test data available; verify the visible event or booking and its persisted result. |
| Content | `/content`, `/content/posts`, `/content/calendar`, `/content/history`, `/content/media`, `/content/templates` | `(dashboard)/content/` | `/content` presents the unified post-state library with search, platform/status filters and a selected-post preview. `/content/posts` remains a Published-first entry. Media library and social templates support retained upload reuse, metadata/usage/archive, literal field previews, independent drafts, duplication and Save as template. WhatsApp `/templates` remains separate. [Content reuse](../public/docs/operations/content-reuse.md) and [technical behavior](../internal/architecture/content-library.md) describe contracts and verification. Existing detail/calendar/history, composer, consent and publishing actions remain reachable. Saved drafts and scheduled posts use a direct editor; confirmed Facebook-only posts support text/caption updates and single-photo removal on the existing provider post. Published media replacement and destination changes are unavailable. Threads-only published edit previews and execution report the Threads API limitation explicitly and preserve the Threads destination in the preview. Drafts require a platform but can be saved before connecting an account; scheduling and publication require selected connected accounts. The controlled draft-save and unconnected Facebook journeys verify preview, retained platform copy and editing the same record at mobile, tablet and desktop widths in both themes. Database checks cover persistence, account isolation and manual channel response fields. Controlled publishing checks cover valid JSON batch requests, destination names, retained drafts after unreadable responses and automatic processing-to-terminal status updates without losing composer input. See [draft destinations](../internal/architecture/growth-operations.md#draft-destinations). Live publication remains owner acceptance. |
| Analytics | `/analytics` | `(dashboard)/analytics/page.tsx` | The Growth client requests Analytics catalog and report data through its `/api/analytics` routes. Analytics service source and local setup live in Labs. This source move preserves the Growth client routes and configured endpoint; it does not verify a live report response. |
| Workspace | `/workspace`, `/workspace/team`, `/workspace/settings`, `/workspace/profile` | `(dashboard)/workspace/` | Overview uses a compact four-metric strip, activity chart, real attention counts, recent campaigns and workspace totals. Metric definitions and coverage come from the existing analytics contract; unavailable data is not zero. Date/metric selectors and Analyse results retain real report/context behavior. Other workspace routes retain their current data flows. |
| Billing | `/billing`, `/upgrade`, `/upgrade/<planKey>` | `(dashboard)/billing/page.tsx`, `(dashboard)/upgrade/page.tsx`, `(dashboard)/upgrade/[planKey]/page.tsx` | Plans, prices, trials, and AI usage allowances come from the central billing catalog and are filtered to the account currency. Customers see AI usage in USD and can start the configured one-time trial without a card. Managed models debit the allowance at provider list price; customer-supplied provider keys do not debit it. Free plans keep the free managed models, and customer provider keys require a paid plan. New AI work stops when the available credit balance reaches zero; the usage panel warns at 80% and 100%. Billing settings show the current plan, invoices and renewal date; cancellation takes effect at the end of the period and can be reversed. Settled agent usage is pulled by the billing worker, so a completed turn is billed whether or not a client opens the task. Use a test account and the configured billing test environment; do not use live payment credentials for local verification. |
| Public pricing | `/pricing` | `app/pricing/page.tsx`, `components/pricing/public-pricing-page.tsx` | Public plan cards and comparison come from `GET /api/public/plans`, which returns only active customer-visible catalog plans without requiring a workspace session and omits internal billing fields. Paid plan calls to action route through signup to the in-app plan page. The page is canonical at `https://app.kasitek.co.za/pricing`, is listed in the sitemap, and supports mouse and keyboard card selection. Verify that plan names, prices and visible limits match the active catalog. |
| Developer surfaces | `/developers`, `/developers/api`, `/developers/cli`, `/developers/mcp`, `/oauth/consent` | `(dashboard)/developers/`, `(auth)/oauth/consent/` | MCP shows configured endpoint, requested OAuth scopes/workspace consent and independently revocable connections. OAuth, canonical REST and internal agents share the supported operation catalogue. Authorized content writes execute directly with durable receipts across MCP, REST and internal agents. Optional `content.actions.preview` exposes exact content, media, destinations and timing. Current permissions, snapshot validation and duplicate prevention remain enforced; no Growth approval card/form is required. Non-content review rules remain intact. [Agent access operations](../internal/operations/growth-agent-access.md) records isolated verification and deployment gates. |
| Agent operation reviews | `/operations/reviews/<id>` | `(dashboard)/operations/reviews/[id]/page.tsx` | Authenticated users inspect the exact operation input and approve/reject its digest. Approval alone does not execute; the same agent resumes the approved request. Generic embedded reviews link here. Content draft reviews keep their existing dedicated editor. |

## Agent profiles

Growth agent cards display each agent's saved name and avatar alongside its role. Owners and
administrators can edit the name and choose or shuffle an avatar from the card. New managed agents
receive a random avatar when provisioned; the choice persists until changed. Profile edits do not
change the agent's role, configuration, permissions, or published version. The cards retain their
existing setup, chat, memory, resources, and update actions.

## Workspace appearance

Growth uses the shared `@kasitek-labs/ui` Geist theme and controls, with white light
surfaces and neutral charcoal dark surfaces. The dashboard retains its own navigation
and data flows. Appearance settings under `/workspace/settings?section=appearance`
retain theme, accent, density and motion controls. Existing saved accents remain;
unset preferences use blue. Preferences remain local to each browser origin.
The sidebar uses the bundled KasiTek logo in expanded and collapsed states, with the workspace switcher, quick search and account/settings footer. The posts calendar is available within Posts at `/content/calendar`; it has no separate sidebar entry. The existing `/calendar` URL and quick-search entry remain available. Connections offers direct Instagram Business/Creator login without a Facebook Page, alongside the Page-linked Meta option. Verify direct login → account identity → granted capabilities separately from Page discovery. Connections uses a searchable account table with status filters, a compact categorized provider catalogue, and existing email/OAuth APIs. Provider access selection, manual WhatsApp setup and connection reporting remain reachable.
The Growth redesign uses Hugeicons Stroke Rounded
through `components/ui/interface-icons.tsx`; provider logos remain separate. Public
landing styles retain their cream and green treatment.

## Agent execution reporting

Agent conversations show current operation and specialist activity, estimated context usage against
the model window, elapsed time, and expandable model/context/usage measurements. Native operation
history and terminal outcomes remain available after reload. A finished response identifies incomplete
or uncertain specialist work even when its activity is collapsed. Live observations use the authenticated
`/api/agents/tasks/:taskId/live` connection with scoped cursor replay and ordinary polling recovery.
Recognized provider503 failures settle as Failed and show the existing unavailable-model message;
ambiguous post-200 stream interruptions remain Outcome unknown. Unknown timing/usage stays
unavailable; provider observations and accounted usage remain distinct.
Shared-runtime specialists receive the originating user request separately from the coordinator's
scoped assignment. Coordinator-added factual claims remain unverified until an authorized source
confirms them; the original request does not expand the child's permissions or assignment.
When an agent creates a task file, its result can be downloaded from the conversation with current
Growth membership and source access. A specialist's own files also appear in its activity modal.
Text, Markdown and JSON require configured private storage.
Verification starts with `api/tests/growth-agent-live.test.ts`, Agents API
`test/growth-runtime-reporting.test.ts`, and the runtime cases in `web/e2e/growth-agents.spec.ts`.
Actual provider execution through the visible in-app interface is recorded separately from controlled
fixtures; these checks do not certify model answer quality.

The Knowledge & skills panel keeps selected resources absent from the current inventory visible as
unlisted selections. Users can remove them without assuming why they are absent.

Owners and administrators can inspect selected specialists on an agent card. Configured indicates
the pinned version and enabled product mapping exist; it is not a live model or tool health check.
A disabled specialist does not block the coordinator's chat.

Agent chat readiness checks the saved model route and credential, including missing and revoked
credentials, and selected knowledge and skills. It does not probe the provider or guarantee that a
future model request will succeed. An explicit provider HTTP 503 settles as a failed request. A
bounded HTTP 200 event stream carrying a numeric upstream 503 is classified the same way; other
ambiguous stream failures may remain outcome unknown, and are not replayed.

Managers can select the chat model from the composer in full conversations and the assistant dock. The shared picker searches saved authorized models and can restore Default. It shows the context value above input/output prices per million tokens, or Free for zero-priced models. Default includes the resolved model name; missing pricing remains unavailable. Saving changes the selected agent for future requests; admitted work keeps its model snapshot. Other members see the current model without configuration controls. Listing and saving do not run inference or expose provider keys.
Managers can open **Review update** on an agent card to preview canonical capability changes and affected specialist pins. Updates preserve instructions, model, context, memory, reviewed resources and disabled state. Conflicts require an explicit Keep current or Use update choice; stale settings require a refreshed preview. Apply updates new agent versions for future work and keeps accepted tasks pinned.


The shared worker applies learned-memory revision cleanup and optional organization conversation expiry. [Retention defaults](../../../agents/docs/operations/retention.md) distinguish recall suppression, retained source records, physical memory-store cleanup and backup installation.

## Frontend and offline verification

The built Vite application uses the same-origin API proxy in `web/scripts/serve.mjs`.
Recorded local engineering verification on 2026-10-24 passed the production build, TypeScript,
ESLint, and all 48 route contracts. The browser runs passed 65 migration cases and 19 Agents
cases. `test:frontend` passed 37 checks at the recorded checkpoint, including actual Chromium
worker installation, explicit update acceptance, exactly one update reload, and offline fallback.

`api/tests/frontend-identity.test.ts` passed against the built proxy, a synthetic OIDC provider,
and an isolated database. It verifies product persistence, uploads larger than 5 MB, private
inbox/notification ownership, developer key rotation, and logout. The signed Growth/Agents HTTP
suite passed eight cases through both APIs and Restate, including real-browser general-assistant
quick access. These checks use controlled boundaries and do not qualify live provider accounts.

The static `/manifest.webmanifest` keeps the installed app identity and scope. `/sw.js` caches
only selected public static assets and `/offline.html`. It never stores authenticated documents,
API responses, invitations, or OAuth returns. Push payload and same-origin click restrictions
have unit coverage; actual push delivery remains owner acceptance. The Agents browser suite
blocks service workers, so the dedicated PWA browser tests enable them separately.

Run `pnpm --filter client test:frontend`, `test:e2e:migration`, and `test:e2e:agents` after building.
Focused redesign checks use `pnpm --filter client exec playwright test --config playwright.design.config.ts`, `playwright.contacts.config.ts`, `playwright.inbox.config.ts`, `playwright.campaigns.config.ts`, and `playwright.communications.config.ts`. These configurations reuse the controlled migration API and ports; run them sequentially rather than concurrently. Browser fixtures verify engineering behaviour, not live provider acceptance or model quality.
The Growth CI job runs these engineering checks; other product frameworks remain unchanged.
The [frontend release runbook](../internal/operations/growth-frontend-release.md) records evidence
locations, Railway image configuration, performance measurement prerequisites, retained-asset
handling, and rollback. Final artifact/performance evidence and hosted TLS, DNS, live callbacks,
provider acceptance, and model evaluations remain separate owner-controlled work.

## Central admin integration

The separate `apps/admin-site` client exposes `/analytics`, `/analytics/customers`,
`/analytics/adoption`, `/analytics/usage`, `/analytics/revenue`, `/analytics/reliability`, and
`/reports`. `/operations` adds persistent incident detection and monitor coverage for Growth,
Agents, Agency, and Analytics, alongside the existing reporting diagnostics and recovery controls. Customer name/ID search filters bounded records; selecting a
result opens its owning product scope. Growth supplies scoped organization, usage, billing, and safe customer metadata through
`GET /api/admin/reporting`. Agents and Agency remain independent HTTP sources. Growth's main
`/analytics` route above remains customer-facing and is not this privileged admin.

The [admin reporting reference](../internal/architecture/admin-analytics.md) maps the boundaries.
Verification starts with `products/growth/api/tests/admin-reporting-source.test.ts`, shared
reporting tests, and `apps/admin-site/tests/admin-report-format.test.ts`. Browser verification
covers product and organization filters, permitted metric detail, source outages, private saved
scopes, audited CSV and the worker-pause/source-outage recovery paths against the dedicated
development services. The [operational profile](../../../../docs/operations/admin-reporting.md#dedicated-development-profile)
keeps product databases and the existing Agents app separate. Model evaluations remain
owner-run.

## Map rules

- Add or change a feature entry in the same pull request as shipped user behavior.
- Describe current behavior only. Specs and planned work live in the selected issue tracker.
- For a feature without a runnable local path, name the missing service, credential, or test data
  instead of claiming it was verified.

### Administrative customer operations

The separate Labs admin exposes `/customers` and `/customers/:product/:customerId` for current
account facts and scoped recovery. Growth owns pure credit/entitlement projections, failed webhook
replay with two distinct approvals, durable receipts and scoped support-access audits. Agents and
Agency own their respective APIs over HTTP. Metadata and actions are development-only and
independently gated. Verification uses `products/growth/api/tests/admin-customers.test.ts` and
`scripts/customer-operations-smoke.mjs`; model/product eval execution remains with the owner.
See [the operations runbook](../../../../docs/operations/admin-customer-operations.md).

### Incident and operations centre

The Labs admin exposes `/operations`, `/operations/incidents/:id`, `/operations/settings`, and
`/operations/audit`. Operators investigate incidents, assign ownership, acknowledge conditions,
manage scoped maintenance, and follow existing customer recovery links. Operations owns its
independent admin sessions, durable worker, and database. Growth exposes pure source signals,
authorized audit metadata, and an idempotent in-app notification bridge. Notification read state
is recipient-scoped and does not acknowledge an incident.

Focused verification starts with `services/operations/tests/engine.test.ts`, identity fixtures,
`services/operations/tests/telemetry.test.ts`, and the shared/source operation tests. Actual
development HTTP and browser evidence belong to the release handoff. Evals remain owner-run.
See the [incident-centre reference](../../../../docs/operations/incident-centre.md).
