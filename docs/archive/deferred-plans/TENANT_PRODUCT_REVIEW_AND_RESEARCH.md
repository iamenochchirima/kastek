# Tenant product review and research

**Status:** Draft

**Owner:** KasiTek product and engineering

**Last updated:** 2026-08-31

## Objective

Define a focused Tenant product direction for agencies that sell and operate AI-assisted
customer acquisition and service workflows for their clients.

This is a product review, not an implementation status claim. The current source of truth for
implemented behavior remains the owning service, its migrations, tests, and deployment evidence.

## Working product decision

Tenant should share KasiTek's domain contracts, agent runtime, provider adapters, analytics rules,
and security standards. It should not be a second copy of the direct KasiTek application.

The three audiences have different jobs:

| Audience | Primary job | Product view |
| --- | --- | --- |
| KasiTek platform operator | Provision, govern, bill, support, and monitor agencies | Control plane |
| Agency staff | Configure services and operate several client businesses | Agency workspace |
| Agency client | Follow leads, conversations, appointments, and outcomes | Client workspace |

The first sellable workflow should be lead response and conversion:

```text
lead arrives -> AI responds -> qualifies -> books or hands off -> follow-up -> outcome report
```

Marketing content, ads, reviews, and voice should attach to this workflow. They should not become
separate tools without a clear customer outcome.

## Current repository evidence

The existing architecture already records the intended boundary. The white-label runtime owns
tenant identities, branding, client accounts, tenant business records, and client-scoped access.
Direct and white-label runtimes use separate databases and identity/session models.

### Backend-backed today

- Tenant workspace resolution, staff authentication, sessions, roles, domains, and branding.
- Client account creation, client users, invitations, activation, and staff-to-client assignments.
- Tenant and client conversation reads, message timelines, and client scoping.
- Lead creation, lead status changes, scoring, status history, and analytics outbox records.
- Dashboard summary, recent activity, usage reads, and scoped analytics catalog/query gateways.
- Workspace email settings, custom sending domains, and test email handling.
- Agent reads from `workspace_agents`.

Relevant code is in `server/kasitek-tenants/src/routes.rs`, the tenant controllers, the tenant
migrations, and `client/apps/tenant-portal/src/lib/tenant-access.ts`.

### Visible but not implemented as tenant product capabilities

The tenant portal currently exposes navigation for Content Pipeline, Client Reporting, Nurturing,
AEO, Voice Agents, Reputation, and Ad Creatives. The shared tenant API client still returns
placeholders or empty values for most of these modules. The real endpoints and persistence models
are not present in the tenant server for those modules.

The current client API also contains a concrete wiring defect: `useCreateTenantClient` posts to
`/api/client/leads/stats` instead of `/api/clients`.

### Missing agency-product foundations

The tenant database currently has no complete domain model for:

- contacts and companies as reusable customer records;
- client-owned provider connections and channel health;
- agent creation, configuration, channel assignment, and deployment;
- appointments or calendar availability;
- campaign definitions, consent, templates, sends, and journey state;
- workflow definitions and durable executions;
- review records and provider location connections;
- agency product catalog, subscriptions, entitlements, invoices, and rebilling;
- outcome attribution from source to lead, booking, conversion, and revenue.

`workspace_usage_limits` and `workspace_usage_events` are useful primitives, but they are not a
complete agency billing and entitlement system.

## Market signals

The useful signal is how established products package work for agencies and businesses, not a
claim that every feature is equally valuable.

- HighLevel packages AI as specialized products for voice, conversations, reviews, funnels,
  content, and workflows. Its SaaS Mode combines client sub-accounts, permissions, provisioning,
  dunning, and agency rebilling. Sources: [HighLevel AI tools](https://www.gohighlevel.com/ai/funnel-ai),
  [SaaS Mode](https://www.gohighlevel.com/saas-mode), and
  [rebilling and reselling](https://help.gohighlevel.com/support/solutions/articles/155000002095).
- HubSpot is packaging specialized agents across marketing, prospecting, customer service, data,
  and campaign planning on top of a shared CRM context. Its customer-agent material emphasizes
  testing before launch, working hours, staged rollout, channel coverage, and controlled human
  transfer. Sources: [Agent Hub](https://www.hubspot.com/products/artificial-intelligence) and
  [Customer Agent](https://www.hubspot.com/products/artificial-intelligence/ai-customer-service-agent?external_link=true).
- Google Business Profile exposes review listing, retrieval, reply, and reply deletion through
  OAuth-protected APIs. Reputation management is therefore a concrete integration opportunity,
  although location ownership and OAuth setup are real delivery constraints. Source:
  [Google review data](https://developers.google.com/my-business/content/review-data).

The recurring pattern is a shared customer record, specialized AI work, controlled automation,
human escalation, measurable outcomes, and agency packaging. A generic collection of AI screens is
not the product.

## Implementation order

Tenant is still early, so the sequence matters. Each phase should have a working vertical slice
before the next phase expands the product surface.

### Phase 0: Choose the first sellable workflow

- Select one or two agency segments, preferably local-service businesses with a clear booking or
  enquiry process.
- Define the first offer in one sentence: AI receptionist, lead qualification, booking, and
  follow-up.
- Define the outcome events and success measures before building dashboards.
- Decide which channels are launch-critical. Website and WhatsApp are the initial candidates.

Exit condition: the team can demonstrate the complete customer journey on paper, including consent,
handoff, booking, failure, and conversion outcomes.

### Phase 1: Make the Tenant foundation honest and safe

- Fix current client provisioning and API-client wiring defects.
- Separate real modules from placeholders. Hide or disable unfinished modules by default.
- Keep workspace, client, staff, client-user, role, assignment, domain, branding, audit, and
  session boundaries enforced on the server.
- Define the canonical tenant contracts for customers, connections, agents, conversations, leads,
  appointments, journeys, outcomes, usage, and entitlements.
- Add contract tests for tenant and client isolation.

Exit condition: a tenant can be provisioned, an agency staff member can invite a client, and the
client can sign in without crossing workspace or client scope.

### Phase 2: Add the commercial control-plane primitives

- Define products, plans, feature entitlements, quotas, usage meters, and lifecycle states.
- Make the Tenant runtime consume a server-issued entitlement view.
- Meter conversations, agent runs, messages, connected channels, bookings, and other billable
  resources with idempotent records.
- Start with operator-managed billing if necessary, then add agency checkout, rebilling, invoices,
  dunning, and payment-provider automation.

Exit condition: an agency plan can enable or restrict a feature and show usage without relying on
browser-only flags or hard-coded limits.

### Phase 3: Connect each client business

- Model client-owned connections and credentials separately from the agency connection inventory.
- Add website and WhatsApp connection setup first, including health, scopes, webhook state,
  revocation, and provider errors.
- Add Instagram/Messenger when the existing Meta connection flow is exposed safely to the Tenant
  runtime.
- Store connection ownership, channel identity, and client scope in canonical records.

Exit condition: an agency can create a client, connect its first channel, see connection health,
and disconnect it without affecting another client.

### Phase 4: Make agents and the inbox operational

- Add real agent create, configure, version, deploy, pause, and channel-assignment flows.
- Provide a small set of agent templates: receptionist, sales qualifier, support, and booking
  assistant.
- Build the unified inbox for website and WhatsApp first, with conversation assignment, agent
  status, human handoff, internal notes, and delivery state.
- Keep agent permissions, tools, approvals, and handoff policy server-side.

Exit condition: one client can receive a message, get an agent response, see the conversation in
the agency inbox, take over, and return control safely.

### Phase 5: Build the conversion data model

- Add canonical contacts and companies instead of keeping customer identity only on leads or
  conversations.
- Add lead deduplication, source attribution, consent state, lifecycle status, owner assignment,
  tasks, and a small pipeline.
- Link conversations, leads, contacts, channels, and agent runs without duplicating ownership
  rules.

Exit condition: every test lead can be traced from source to conversation, qualification, owner,
and current pipeline state.

### Phase 6: Add booking and narrow follow-up

- Define an appointment contract and integrate the first calendar or booking provider.
- Let the agent collect the required information, offer available times, create a booking, and
  record failure or human takeover.
- Add a few durable journeys: immediate lead response, no-response follow-up, and appointment
  reminder.
- Stop journeys on reply, opt-out, handoff, booking, or operator cancellation.

Exit condition: the lead-to-booking flow works end to end with retries, duplicate protection,
consent checks, and an auditable history.

### Phase 7: Report customer outcomes

- Replace generic activity counts with response time, qualified leads, bookings, handoffs,
  conversions, delivery health, and source attribution.
- Reuse the analytics outbox and reporting contracts rather than adding screen-specific counters.
- Give agencies an operational view and clients a reduced outcome view.
- Include data freshness, unavailable, and no-data states.

Exit condition: an agency can show a client what happened to its leads and which outcomes came from
the Tenant workflow.

### Phase 8: Expand the channel and service catalog

- Add reviews after the core lead and customer loop is reliable.
- Add voice as another channel using the same contacts, agents, handoff, booking, and outcome
  contracts.
- Add campaign content only when it is tied to an offer, audience, approval, send, and measurable
  result.

Exit condition: each added service reuses the same customer, consent, agent, connection, workflow,
and reporting contracts.

### Deferred until the foundation proves itself

- General-purpose content generation.
- Standalone ad-creative generation.
- AEO as a primary product area.
- A full visual workflow builder.

These can return after the first workflow has real usage, delivery reliability, conversion data,
and paying agency demand.

## Proposed Tenant V1

### Agency workspace

- Workspace branding, domain, staff, roles, client assignments, and audit history.
- Client provisioning with a guided setup checklist.
- Per-client channel connections for website, WhatsApp, Instagram/Messenger, and email where the
  provider contract is ready.
- Agent templates such as receptionist, sales qualifier, support, and booking assistant. These
  are configured roles over the shared agent system, not separate agent implementations.
- Unified conversations with live state, assignments, human handoff, agent controls, and channel
  health.
- Contacts, leads, a small pipeline, consent state, tasks, and appointment requests.
- A small set of durable follow-up journeys, starting with lead response and missed-response
  follow-up.
- Client approval controls for agent behavior, campaign content, and external sends.
- Reports for response time, qualified leads, booked appointments, handoffs, conversion, and
  channel delivery health.

### Client workspace

- Inbox and conversation history.
- Leads and pipeline status.
- Appointments or booking requests.
- Agent status and requests for changes, subject to agency controls.
- Simple outcome reporting.
- Approval queue for content or campaigns when the agency enables it.

### Platform control plane

- Agency provisioning and lifecycle.
- Product catalog, plans, feature entitlements, usage meters, limits, invoices, and payment state.
- Agency margin or rebilling rules.
- Support access with explicit scope, expiry, and audit evidence.

Billing and entitlements belong to the control plane. The Tenant workspace consumes a bounded
entitlement view and must not invent its own pricing rules in the browser.

## KEEP / CHANGE / DEFER / ADD

| Area | Direction | Reason |
| --- | --- | --- |
| Workspace auth, branding, domains, client accounts | Keep | These are the correct agency boundary and already have real support. |
| Leads and conversations | Keep and deepen | They form the first measurable customer workflow. Add contacts, assignment, handoff, and outcomes. |
| Dashboard and analytics | Change | Replace generic counts with lead response, booking, handoff, conversion, and freshness indicators. |
| Agent navigation | Change | Add real create/configure/deploy flows and per-client assignment before exposing more templates. |
| Content pipeline | Defer and narrow | Start with approved campaign assets tied to a lead or offer. Do not build a general content studio first. |
| Nurturing | Keep as a narrow first journey | Build a small durable lead follow-up model before a visual workflow builder. |
| Reporting | Keep and rebuild | Reports should be client-facing outcome views backed by real event contracts. |
| Reputation | Add after the first lead loop | It has a clear business outcome, but provider connection and OAuth ownership need a dedicated boundary. |
| Voice | Add as a channel after core messaging | Voice should use the same contact, agent, handoff, booking, and outcome model. |
| Ad Creatives | Defer | Creative generation without lead-source ingestion and attribution is disconnected from value. |
| AEO | Defer | It is an interesting signal, but it should not displace reliable acquisition, conversation, and reporting workflows. |
| Agency plans, usage, entitlements, rebilling | Add early | Agencies need to sell a defined service and protect margin. |
| Billing UI inside every client workspace | Defer | Keep client experience focused; billing belongs to the agency and platform control planes. |

## Architecture rules for the next plan

- Keep direct KasiTek and Tenant as separate runtimes, databases, and identity realms.
- Keep one canonical customer, conversation, agent, workflow, integration, and analytics contract per
  domain. Tenant adapters must not create parallel fake versions of those records.
- Put `workspace_id` and, where needed, `tenant_client_id` into every tenant-owned record, job,
  event, cache key, object path, and reporting scope.
- Treat client connections as tenant-owned resources with explicit client ownership, health, scopes,
  webhook registration, and revocation.
- Make entitlements and provider readiness server-side decisions. A hidden navigation item is not
  authorization.
- Make every external action idempotent, auditable, approval-aware, and replayable where safe.
- Use real backend contracts before exposing a module in the default navigation. An unfinished
  module should be disabled or clearly marked unavailable, not presented as operational.
- Build measurement around outcomes, not vanity activity. At minimum, preserve source, response,
  qualification, booking, handoff, conversion, and delivery state.

## Decisions still needed

| Topic | Question | Suggested next decision |
| --- | --- | --- |
| First agency segment | Which agencies and client industries will use the first workflow? | Select one or two local-service segments. |
| First commercial offer | What can an agency sell in one sentence? | Start with AI receptionist, lead qualification, booking, and follow-up. |
| Agency billing | Does KasiTek collect client payment, or only meter and report usage initially? | Decide before implementing plans and entitlements. |
| Channel scope | Which connections are launch requirements? | Prefer website and WhatsApp first, then Meta messaging after provider health and permissions are proven. |
| Booking ownership | Is booking native to Tenant or delegated to calendar providers? | Define the canonical appointment contract and first provider. |
| Agent governance | Which changes require agency or client approval? | Define policy by action risk, not by screen. |
| Vertical data | What information is needed to prove conversion? | Start with lead source, contact, status, booking, handoff, and outcome. |

## Next step

Turn this review into a Tenant V1 execution plan with one vertical workflow, a domain inventory,
an entitlement model, a connection ownership model, and a real-versus-placeholder cleanup list.
