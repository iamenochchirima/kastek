# Analytics Platform Plan

**Execution plan and checklist:** [ANALYTICS_EXECUTION_PLAN.md](ANALYTICS_EXECUTION_PLAN.md)

**Status:** Sections 1–12 approved. Product and execution planning are complete; implementation has
not started.

**Process:** Sections 1–7 were reviewed individually. After the execution architecture was
approved, Sections 8–12 were completed together from the verified codebase and approved execution
constraints. Implementation follows `ANALYTICS_EXECUTION_PLAN.md`.

## Planned sections

- [x] 1. Analytics foundation and data collection
- [x] 2. Inbox analytics data contract
- [x] 3. Campaign analytics data contract
- [x] 4. Content analytics data contract
- [x] 5. Agent analytics and per-agent data contract
- [x] 6. Calls analytics data contract
- [x] 7. Bookings analytics data contract
- [x] 8. Contacts and audience analytics data contract
- [x] 9. Connections and platform-health analytics data contract
- [x] 10. Cross-feature attribution and agent-readable analytics
- [x] 11. Main Overview dashboard, based on the approved feature contracts
- [x] 12. Rollups, exports, alerts, and scheduled reports

## Section 1 — Analytics foundation and data collection

**Status:** Approved

### Existing source data

The platform already has real organization-scoped data for:

- Conversations, messages, unread counts, and message events
- Campaign recipients, send events, delivery, read, failure, and block statuses
- Social posts, variants, publishing jobs, and provider webhooks
- Agent runs, model calls, tool invocations, events, and costs
- Bookings and booking statuses
- Calls and call durations
- Contacts, opt-in status, exclusions, lists, and tags
- Connection status, health, and webhook state

### Approved foundation work

- Define every metric once, including its formula, denominator, source table, period, and freshness.
- Support 7-day, 30-day, 90-day, and custom ranges with organization timezone handling.
- Add conversation lifecycle events: opened, first response, assigned, resolved, closed, and
  reopened.
- Add responder attribution for customer, human team member, agent, and automation messages.
- Keep agent outcomes separate from run completion.
- Add provider metric storage for content reach, impressions, clicks, likes, comments, and shares
  when provider APIs are connected.
- Retain historical connection-health events instead of only the current health state.
- Return freshness and coverage metadata so unavailable data is not shown as zero.
- Keep analytics organization-scoped and exclude message bodies, phone numbers, and credentials
  from analytics projections.
- Use domain records as the source of truth before introducing a broad generic event system.

### First metrics supported by existing data

- Conversations started, inbound messages, outbound messages, and unread backlog
- Campaign recipients, sent, delivered, read, failed, blocked, and unsubscribed
- Content drafts, scheduled posts, published posts, and failed jobs
- Agent runs, outcome states, tokens, cost, tool outcomes, and waiting runs
- Bookings by status
- Calls by direction, status, duration, and day
- Contact totals, opt-in health, and audience growth
- Connection status and operational health

### Section 1 deliverables

- [ ] Metric dictionary
- [ ] Data-gap and instrumentation list
- [ ] Reporting API shape
- [ ] Freshness and coverage rules
- [ ] Backend queries and organization-isolation tests

## Cross-platform analytics data design

**Status:** Approved requirement

Analytics data must work across the entire platform and remain extensible as features gain new
metrics. Every feature should emit facts through a shared, versioned event envelope rather than
inventing a separate incompatible analytics shape.

### Common event envelope

Each event should have stable, indexed fields for:

- Event ID and idempotency key
- Organization ID
- Event name and schema version
- Occurred-at and ingested-at timestamps
- Source domain and source service
- Actor type and actor ID
- Primary entity type and entity ID
- Optional references to customer/contact, conversation, campaign, content post, booking, call,
  connection, agent definition, installation, and run
- Channel, provider, and connection dimensions where applicable

Feature-specific additions belong in a validated, versioned `attributes` object. A new optional
attribute should not require a database migration. A field becomes a typed/indexed common column
when it is used for frequent filtering, grouping, retention, or access control.

### Event rules

- Events are append-only facts. Corrections are represented by later events rather than mutating
  history.
- Every event is idempotent and can be safely replayed into projections and rollups.
- Each event type has an owner, schema version, required fields, allowed attributes, and retention
  policy.
- Raw event facts remain separate from derived daily/hourly rollups.
- Source feature tables remain authoritative for operational state; analytics events provide the
  history needed for trends and attribution.
- Analytics events contain no message bodies, phone numbers, credentials, or unnecessary PII.
- All projections and rollups remain organization-scoped and expose freshness and coverage.

## Section 2 — Inbox analytics data contract

**Status:** Approved

### Existing data

Inbox currently provides conversations, channels, customer/contact references, status, timestamps,
unread counts, messages, sender values, provider status, message events, and connection identity.

### Required Inbox additions

- Conversation lifecycle events: opened, assigned, reassigned, closed, reopened, resolved, and
  marked unresolved.
- Responder attribution for customer, human team member, agent, and automation messages.
- Agent definition, installation, and run references when an agent handles a message.
- First-response and resolution timestamps with explicit definitions.
- Resolution reason, outcome, resolver, and reopen history.
- Assignment history, current assignee, unassigned duration, and workload ownership.
- Timestamped message delivery transitions: queued, sent, delivered, read, failed, and retried.
- Consistent organization, customer, channel, provider, and external-connection references.

### Inbox metrics enabled by this contract

- Conversation starts, inbound/outbound volume, unread backlog, open/closed/resolved volume, and
  channel mix.
- First-response rate and time, resolution rate and time, SLA breaches, and no-response volume.
- Human versus agent workload and response performance.
- Conversations attributed to bookings, campaigns, or other approved outcomes.

### Customer-agent takeover contract

Human takeover is an optional capability for customer-facing agents whose workflow includes a
handoff action. It is not a universal Agent or Inbox outcome.

Track takeover separately from general conversation status with states for agent active, human
requested, waiting for a human, human claimed, human actively responding, released back to the
agent, resolved, and expired or cancelled.

The current assignee remains available as `assigned_actor_id`, but assignment history must be
append-only. Record these events with the common envelope:

- Customer handoff requested
- Handoff request shown in the Inbox
- Handoff claimed by a workspace member
- Human first response
- Human message sent
- Handoff released back to the agent
- Conversation resolved after takeover
- Handoff expired or cancelled

Each event references the conversation, customer/contact, agent definition/version/installation,
triggering run, channel, connection, workspace member where applicable, reason code, timestamp,
and idempotency key. Reference the original customer message by ID; do not copy message bodies
into analytics projections.

When a customer-facing agent requests a human, the run pauses in a customer-handoff state, the
conversation enters a visible Inbox queue, and agent outbound replies are blocked while a human
owns the conversation. A workspace member must be able to claim the conversation atomically,
reply live, resolve it, or release it back to the agent.

Takeover metrics are only calculated for agents with this capability enabled:

- Handoff requests and request rate among eligible customer conversations
- Request-to-claim and claim-to-first-human-response time
- Time waiting for a human
- Unclaimed or expired requests
- Human takeover rate
- Conversations returned to the agent
- Conversations resolved after takeover
- Repeated requests and breakdowns by agent, version, channel, connection, and reason

### Inbox implementation checklist

- [ ] Add Inbox-owned lifecycle and assignment events using the common event envelope.
- [ ] Extend message/response records with reliable actor attribution.
- [ ] Define and persist resolution state and outcome semantics.
- [ ] Normalize provider delivery transitions into analytics facts.
- [ ] Add customer-agent takeover state, event history, atomic claim, and live ownership rules.
- [ ] Keep customer handoff separate from approval and generic external-event waits.
- [ ] Add Inbox reporting queries and organization-isolation tests.

## Section 3 — Campaign analytics data contract

**Status:** Approved

### Existing data

Campaigns currently provide campaign records and statuses, recipient snapshots, sent/delivered/read/
failed/blocked/unsubscribed counts, recipient timestamps, send events, campaign/recipient/contact/
template/list/connection references, and WhatsApp provider pricing fields.

### Required Campaign additions

- Campaign lifecycle events: created, scheduled, launched, paused, resumed, completed, cancelled,
  and failed.
- Append-only recipient transitions: targeted, excluded, queued, sent, delivered, read, failed,
  blocked, unsubscribed, and retried.
- Delivery timing from launch to send, send to delivery, delivery to read, and total completion.
- Normalized provider billing data: billable state, pricing category/model, provider cost where
  available, and cost dimensions.
- Structured failure and retry data: provider code, reason, retry count, last retry, and permanent
  versus temporary failure.
- Optional attribution references to follow-up conversations, contacts, bookings, agents, tracked
  links, or approved conversions.

### Campaign metrics enabled by this contract

- Targeted-to-sent-to-delivered-to-read funnel and all documented rates.
- Failure, block, unsubscribe, delivery-delay, and read-delay rates.
- Daily trends and breakdowns by campaign, template, list, connection, provider, and batch.
- Cost per sent, delivered, and read message where provider cost is available.
- Audience frequency and repeated targeting.
- Campaign-generated conversations and bookings once attribution exists.

### Campaign implementation checklist

- [ ] Add campaign lifecycle events using the common event envelope.
- [ ] Add recipient status-transition events.
- [ ] Normalize delivery, read, failure, and retry callbacks.
- [ ] Preserve idempotency for duplicate and late provider callbacks.
- [ ] Add campaign funnel, timing, cost, and failure queries.
- [ ] Add campaign-to-conversation and campaign-to-booking attribution when approved.
- [ ] Add organization-isolation, denominator, and late-event tests.

## Section 4 — Content analytics data contract

**Status:** Approved

### Existing data

Content currently provides posts, variants, media, scheduling, per-platform publish jobs, provider
post IDs, delivery snapshots, errors, and provider webhook storage. The current analytics page
mostly counts records in the browser and does not yet provide reliable provider performance data.
The code declares analytics support for Meta, Instagram, LinkedIn, and X; Threads, TikTok, Bluesky,
and WhatsApp Status are not currently treated as analytics-capable.

### Required Content additions

- Append-only post and publishing lifecycle events: created, edited, approved where applicable,
  scheduled, unscheduled, queued, processing, published, failed, retried, cancelled, and deleted.
- Per-variant and per-platform publishing facts, including status history, queue/processing/publish
  timestamps, retry count and reason, provider post ID, provider account, connection, structured
  failure code, and failure classification.
- Content dimensions for post, variant, platform, provider account, media type, content type, tag,
  campaign, AI-generated state, CTA, tracked link, and UTM reference where available.
- Versioned provider metric observations with a metric key, numeric value, unit, provider account,
  external post ID, observation timestamp, reporting window, sync reference, and content references.
  Initial metrics include impressions, reach, likes, comments, shares, saves, clicks, and video
  views where supported.
- Provider sync and coverage state: last successful sync, next attempt, sync status, permission or
  rate-limit failure, partial coverage, unsupported metric state, last error, and provider API
  version where relevant.
- Optional attribution references from content to tracked-link clicks, conversations, bookings,
  campaigns, and agent interactions.

### Content data rules

- Use the shared event envelope for content lifecycle facts and stable post, variant, connection,
  provider, and account references.
- Keep provider observations extensible through a metric key and validated versioned attributes;
  promote frequently queried metrics to typed/indexed fields later.
- Treat provider metrics as timestamped observations over reporting windows, not as append-only
  activity counts.
- Distinguish no activity, unavailable, not connected, permission denied, not synced, and zero.
- Keep raw provider payloads in secure operational storage; analytics projections contain no tokens,
  credentials, message bodies, or unnecessary PII.

### Content metrics enabled by this contract

- Draft, scheduled, published, failed, cancelled, and publishing-retry volume.
- Publishing success/failure rates, latency, platform coverage, and provider sync health.
- Impressions, reach, engagement, clicks, and video views where provider data is available.
- Engagement trends and comparisons by platform, account, content type, media type, tag, campaign,
  and variant.
- Content-attributed conversations and bookings once attribution is implemented.

### Content implementation checklist

- [ ] Move current content analytics calculations into organization-scoped server-side queries.
- [ ] Add content lifecycle and per-platform publish transition events.
- [ ] Add idempotent provider metric ingestion, beginning with Meta and Instagram.
- [ ] Add LinkedIn and X after provider responses are normalized.
- [ ] Represent unsupported platforms explicitly instead of showing zero metrics.
- [ ] Add content-to-conversation and content-to-booking attribution when approved.
- [ ] Add freshness, coverage, late-observation, and organization-isolation tests.

## Section 5 — Agent analytics and per-agent data contract

**Status:** Approved

Agent analytics must be conditional on the agent's execution mode, creation profile, deployment
surface, capabilities, and declared outcomes. Customer takeover is only relevant when a hosted
customer-facing agent has the handoff capability configured.

### Agent categories and applicable analytics

- System-hosted KasiAi: private assistant usage, runs, model usage, tools, cost, and runtime health.
- General KasiTek-hosted agents: conversations, responses, knowledge, tools, runs, and cost when
  deployed to customer-facing surfaces.
- Custom workflow agents: workflow steps, objectives, tools, effects, schedules, and business
  results.
- External-connected agents: MCP/REST operations, transport, tools, model usage, credentials, and
  provider health.

### Common Agent data

Every Agent installation should provide:

- Agent definition, version, and installation references.
- Execution mode, creation profile, deployment surface, and trigger type.
- Run lifecycle, queue time, runtime, retries, terminal status, and failure reason.
- Model provider, model, tokens, latency, pricing version, currency, and cost.
- Tool calls, approvals, effects, retries, and reconciliation status.
- Readiness, capability availability, connection state, and runtime health.

### Conditional Agent data

Conversational agents may provide conversation volume, inbound/outbound messages, first-response
time, response time, unanswered conversations, resolution, customer engagement, and the approved
customer-takeover metrics from Section 2.

Workflow and action agents may provide workflow execution, node status, objective started/completed/
failed/abandoned, tool and external-effect results, retries, approvals, business entity references,
and duration by workflow step. Conversation resolution and takeover do not apply unless supported.

Scheduled agents should provide schedule version, expected versus actual dispatch, missed or delayed
runs, pause/resume history, resulting run, business outcome, failure, and retry data.

External-connected agents should provide MCP/REST operation status, connector and capability,
provider latency, credential and connection health, model/tool usage, and external results. Hosted
conversation metrics do not apply unless the agent is also deployed to a customer conversation
surface.

### Scalable outcome model

Each agent version or workflow declares its supported outcome types. Examples include
`conversation.answer_delivered`, `workflow.objective_completed`, `content.post_published`,
`campaign.message_sent`, `booking.created`, `external.operation_completed`, and
`customer_handoff.requested`.

An `agent.outcome_recorded` event contains the outcome type and schema version, success or failure,
agent and run references, related entity references, duration, reason code, and safe extensible
attributes. It does not contain raw prompts, responses, credentials, or unnecessary PII.

### Agent analytics display rules

- Always show common operational metrics.
- Show conversation metrics only for agents deployed to conversation surfaces.
- Show workflow/objective metrics only for agents with workflow or action execution.
- Show schedule metrics only when schedules exist.
- Show external-operation metrics only for external-connected agents.
- Show takeover metrics only when customer handoff is enabled.
- Never represent an inapplicable metric as zero.

### Agent implementation checklist

- [ ] Normalize Agent run, model, tool, effect, schedule, and readiness facts with the common
  envelope.
- [ ] Record execution mode, creation profile, deployment surface, trigger, and workflow version.
- [ ] Define versioned agent outcome contracts and outcome events.
- [ ] Connect customer-agent takeover events from Section 2.
- [ ] Add per-installation, per-version, per-agent, and organization rollups.
- [ ] Add conditional reporting queries and organization-isolation tests.

## Section 6 — Calls analytics data contract

**Status:** Approved

Calls currently span WhatsApp call sessions, provider events, WebRTC signals and actions, Twilio
voice webhooks, browser calling, and a shared `CommunicationCall` model with call-leg support.
Lifecycle data and summaries must be normalized across providers.

### Required Call additions

- Provider-normalized lifecycle events: received/initiated, ringing, connecting, accepted, active,
  missed, rejected, failed, cancelled, and ended.
- Provider timestamps, ingestion timestamp, provider event ID, call ID, leg ID, status, reason, and
  idempotency key for every event.
- Stable organization, provider, connection, call session, call leg, conversation, contact, and
  handler references.
- Human, agent, or automation handler attribution, including agent definition, version, installation,
  and run references where applicable. `agentLabel` alone is not sufficient.
- Explicit timestamps for initiated/received, ringing, answered, first media, ended, provider
  callback, and ingestion.
- Failure and outcome data: provider status, error code, hangup reason, missed/rejection reason,
  failed versus cancelled, retry state, conversation continuation, booking, callback, or other
  approved business outcome.
- Optional provider observations for cost/currency, billable minutes, recording and transcript
  references with consent state, network quality, jitter, packet loss, transfers, holds, and
  multi-leg events.

### Call metrics enabled by this contract

- Total, inbound, outbound, active, completed, missed, rejected, failed, and cancelled calls.
- Answer rate with a documented denominator, average and percentile time to answer, average and
  percentile duration, ringing time, and queue time.
- Provider, connection, handler, agent, conversation, and customer outcome breakdowns.
- Calls linked to bookings, campaigns, content, conversations, and other approved outcomes.
- Cost per call and cost per answered minute where available.
- Provider callback, event ingestion, and data freshness health.

### Call data rules

- Keep the canonical operational call/session records separate from append-only analytics events.
- Keep WhatsApp and Twilio provider-specific fields in validated attributes while sharing the common
  call envelope.
- Keep raw audio, transcripts, phone numbers, and provider payloads outside analytics projections or
  protect them separately.
- Calculate summaries server-side with organization timezone, date ranges, documented denominators,
  and freshness metadata.
- Do not show unsupported provider data as zero.

### Call implementation checklist

- [ ] Normalize WhatsApp, Twilio, and future provider lifecycle events.
- [ ] Populate stable call-leg, handler, agent, conversation, and outcome references.
- [ ] Define timing, answer-rate, failure, and cost semantics.
- [ ] Add call trend, percentile, provider, and connection reporting queries.
- [ ] Add optional quality, recording-consent, transcript-reference, and billing observations.
- [ ] Add provider callback, idempotency, late-event, freshness, and organization-isolation tests.

## Section 7 — Bookings analytics data contract

**Status:** Approved

Bookings currently provide services, bookings, customer/contact references, scheduled start and end
times, timezones, notes, five statuses, overlap validation, and basic workspace counts by status.
The current record is mutable and does not preserve how a booking changed, who caused the change,
where it came from, or what happened after the appointment.

### Required Booking additions

Keep the current `Booking` record as the operational source of truth and add append-only booking
facts for history, attribution, and reporting.

- Booking lifecycle events: created, availability checked, slot conflict detected, scheduled,
  confirmed, rescheduled, reminder scheduled/sent/delivered/failed, started or checked in,
  completed, cancelled, no-show, expired, and external sync succeeded or failed.
- Status history with previous and current status, actor type and ID, reason code, event and
  ingestion timestamps, source event ID, and idempotency key. Keep the existing five statuses as
  current state rather than adding statuses only to represent history.
- Scheduling facts: requested time versus booked time, timezone, booking lead time, service
  duration, buffer time, reschedule count, availability result, conflict reason, and actual start
  and end times.
- Optional scheduling dimensions when supported: location, resource, staff member, and delivery
  mode.
- Creation source and attribution: manual staff creation, customer self-service, agent-created,
  automation-created, imported, or external provider.
- Stable references to customer/contact, conversation, call, campaign, content, agent definition,
  agent version, installation, run, connection, and provider where applicable.
- Reminder lifecycle data: reminder type, scheduled time, channel, provider, delivery state,
  failure reason, customer response, and whether the response confirmed, cancelled, or rescheduled
  the booking.
- Attendance and outcome data: check-in, actual completion, cancellation reason, no-show reason,
  time between booking and cancellation, rebooking, outcome type, and optional amount, currency,
  payment, or revenue reference when paid bookings are supported.
- External calendar/provider data when integrations exist: provider, external event ID, sync state,
  last successful sync, conflict state, provider error code, and provider timestamps.

### Booking event types

- `booking.created`
- `booking.availability_checked`
- `booking.status_changed`
- `booking.rescheduled`
- `booking.reminder_updated`
- `booking.attendance_recorded`
- `booking.outcome_recorded`
- `booking.external_sync_updated`

Feature-specific attributes should be validated and versioned while using the shared event envelope.
Frequently filtered or grouped fields can later become typed/indexed columns without changing the
event contract.

### Booking metrics enabled by this contract

- Booking volume and growth.
- Booking funnel: attempted, created, confirmed, and completed.
- Confirmation, completion, cancellation, and no-show rates with documented denominators.
- Time to appointment, booking lead time, and rescheduling frequency.
- Slot conflict and availability-result rates once availability checks are captured.
- Service, time, day, location, resource, channel, source, customer, and agent breakdowns.
- Reminder delivery and response rates once reminders exist.
- Repeat bookings and rebooking rate.
- Attendance and utilization once capacity data exists.
- Revenue and paid-booking performance only when connected to a real billing source.

Do not show utilization, conversion, or revenue as zero when the underlying capacity, attribution,
or billing data does not exist. Return coverage and freshness metadata instead.

### Booking implementation checklist

- [ ] Add Booking lifecycle and status-transition events using the common event envelope.
- [ ] Preserve actor, source, customer, service, channel, and agent attribution.
- [ ] Capture requested versus booked times, availability results, conflicts, reschedules, and
  attendance outcomes.
- [ ] Add reminder events when reminder functionality is introduced.
- [ ] Add external calendar/provider observations only for supported integrations.
- [ ] Add booking funnel, timing, service, source, agent, repeat-booking, and outcome queries.
- [ ] Add optional capacity, billing, revenue, and utilization queries only when their source data
  exists.
- [ ] Add idempotency, late-event, denominator, freshness, and organization-isolation tests.

## Section 8 — Contacts and audience analytics data contract

**Status:** Approved

The contact record must provide more than a current `optIn` boolean. Analytics and outbound
guards need the history, source, scope, and evidence behind every consent and suppression decision.
The platform should keep canonical contact state separate from list membership projections so a
late opt-out cannot be hidden by a stale audience list.

### Data sources to collect

#### 1. Canonical contact and customer records

- Stable organization, customer, contact, phone, email, and channel references.
- Contact creation, merge, deletion, import, and ownership timestamps.
- Current marketing state as separate values: `unknown`, `opted_in`, `opted_out`, and `excluded`.
- Consent scope: channel, provider, connection, purpose, and campaign or list scope where
  applicable.
- Current state source, method, reason, effective timestamp, and most recent evidence reference.
- Contact attributes used for segmentation, with their source and last-updated timestamp.

The canonical contact record is the source for eligibility. List membership, campaign recipient
snapshots, and audience segments may project consent state for reporting, but must not override the
canonical state at send time.

#### 2. Consent and suppression change history

Create an append-only consent fact for every transition, including:

- Explicit opt-in, opt-out, unsubscribe, re-subscribe, manual exclusion, and exclusion removal.
- Previous state and next state.
- Channel, provider, connection, purpose, and scope.
- Collection method: form, import, API, keyword, inbox action, agent action, or workspace action.
- Source actor: customer, workspace member, agent definition/version/installation/run, system, or
  provider webhook.
- Reason code, effective time, recorded time, idempotency key, and safe evidence/reference ID.
- Whether the change was accepted, rejected, duplicated, or superseded.

Do not store message bodies, phone numbers, access tokens, or other unnecessary PII in analytics
facts. A reference to the operational message, webhook, form submission, or audit record is enough.

#### 3. WhatsApp provider and inbound-message sources

- WhatsApp Cloud API inbound message webhooks, including provider message ID, connection, sender
  contact, received time, and normalized message type.
- Normalized opt-out signals from supported keywords such as STOP or UNSUBSCRIBE, including the
  matched rule, message reference, and processing result.
- Provider message-status webhooks for sent, delivered, read, failed, and rejected transitions,
  including provider error code and timestamp.
- Template metadata used for outbound messages: template ID/version, category, language, provider
  account, and connection.
- Webhook delivery, retry, duplicate, signature-validation, permission, and provider API error
  records.

WhatsApp provider webhooks are evidence and delivery sources. The platform’s own consent ledger is
the source used to decide whether marketing may be sent; do not assume the provider exposes a
complete consent ledger for the workspace.

#### 4. Audience, list, and segmentation sources

- Audience/list creation, rename, deletion, membership add, membership remove, and membership
  source events.
- Segment rule version, evaluated attributes, evaluation time, match result, and audience size.
- Import batch, file or integration source, row result, duplicate result, validation failure, and
  consent-confirmation result.
- Contact-to-list projection timestamps and reconciliation status against the canonical contact.
- Tag, location, lifecycle, and custom-attribute changes used in audience filters.

#### 5. Campaign targeting and marketing-guard decisions

- Campaign audience definition, list/segment references, template, purpose, channel, connection,
  and launch version.
- Recipient targeting, exclusion, queue, send, delivery, read, failure, block, unsubscribe, and
  retry transitions.
- Guard evaluation at audience build, queue, and immediately-before-send time.
- Guard result and reason code, including `not_opted_in`, `opted_out`, `excluded`, `cooldown`,
  `invalid_destination`, `provider_rejected`, or `duplicate`.
- Consent state and state timestamp used by each decision, plus campaign/recipient references and
  idempotency key.
- Manual override attempt, actor, reason, and outcome where overrides are ever supported.

This makes opt-in, opt-out, exclusion, unsubscribe, and suppression rates measurable without
counting a current contact snapshot as a historical event.

#### 6. Other WhatsApp outbound sources

- Proactive template sends started from Inbox, automations, scheduled agents, or API clients,
  including purpose/category and the same guard decision data as campaigns.
- Customer-service replies, human takeover replies, and agent replies, explicitly classified as
  service or marketing so marketing suppression does not incorrectly block support communication.
- Agent action and run references when an agent records consent, exclusion, or an outbound attempt.

#### 7. Data quality and reconciliation sources

- Missing or conflicting consent values between canonical contacts and list memberships.
- Consent changes received out of order, duplicated, or with invalid timestamps.
- Contacts targeted after opt-out, sends attempted without an eligible state, and provider rejection
  after a local guard passed.
- Reconciliation runs comparing contact state, memberships, campaign recipients, send events, and
  provider statuses.
- Freshness, coverage, last successful provider sync, and last successful reconciliation time.

### Minimum extensible consent fact shape

Consent facts should use the approved common event envelope and add validated, versioned consent
attributes rather than creating a new table shape for every channel. The first typed fields should
cover `consent_state`, `previous_state`, `purpose`, `channel`, `provider`, `source_method`,
`reason_code`, `effective_at`, `evidence_ref`, and `scope`. New optional attributes can be added
without a migration; frequently filtered dimensions can later become indexed common columns.

### Contact and audience metrics enabled by these sources

- Opt-in, opt-out, exclusion, unsubscribe, and re-subscribe counts and rates by period, channel,
  provider, source method, purpose, campaign, list, and segment.
- Consent changes over time, net audience growth, and time from opt-in to first marketing send.
- Suppressed audience size, suppression reasons, guard-block rate, and attempted-send rate after
  opt-out.
- Campaign audience growth, list health, import quality, duplicate rate, and stale-membership rate.
- WhatsApp provider delivery, read, failure, rejection, webhook freshness, and reconciliation
  coverage.

Do not show a missing consent source, unsupported provider signal, or unavailable history as zero.
Return coverage and freshness metadata with all consent and audience metrics.

### Consent metric denominator rules

The metric registry must publish separate metrics instead of using one ambiguous “opt-in rate”:

- **Current consent distribution:** contacts in each current state divided by all active contacts in
  the same channel, purpose, and scope.
- **Known-consent coverage:** contacts whose state is not `unknown` divided by active contacts.
- **Opt-in acquisition conversion:** accepted opt-ins divided by recorded eligible acquisition
  attempts. This metric is unavailable when acquisition attempts are not collected.
- **Opt-out rate:** unique contacts transitioning to `opted_out` divided by unique contacts that
  received at least one delivered marketing message in the period.
- **Unsubscribe rate:** unique explicit unsubscribe transitions divided by unique contacts that
  received at least one delivered marketing message in the period.
- **Current exclusion rate:** currently excluded contacts divided by active contacts.
- **Guard-block rate:** recipient decisions blocked by a marketing guard divided by all evaluated
  recipient decisions.
- **Post-opt-out attempt rate:** outbound marketing attempts after the effective opt-out time
  divided by opted-out contacts. The expected value is zero, but missing guard telemetry remains
  unavailable rather than zero.

Rate responses expose numerator, denominator, distinct strategy, interval, coverage, and freshness.
One contact counts once per metric period unless a metric explicitly measures transitions.

### Contact and audience data rules

- Preserve consent changes as immutable facts and derive current eligibility from the latest valid
  effective state for the requested channel, purpose, and scope.
- Resolve out-of-order provider and user changes by effective time, source authority, and revision;
  never erase the superseded observation.
- Give explicit customer opt-out and legal suppression precedence over list membership, campaign
  inclusion, workspace actions, and Agent requests.
- Keep service communication separate from marketing communication in both guards and reporting.
- Keep canonical customers separate from channel identities and deduplicate only through approved
  operational identity linking.
- Treat imports as acquisition evidence only when the import records the required consent
  confirmation and source evidence.
- Store optional contract attributes in the versioned payload. Promote a field to a typed indexed
  dimension only through the schema registry and a measured query requirement.
- Exclude phone numbers, email addresses, names, message content, notes, file contents, and raw
  provider payloads from Analytics.
- Apply deletion and pseudonymization without removing aggregate consent and guard totals that may
  lawfully remain.

### Contact and audience implementation checklist

- [ ] Add authoritative consent, purpose, suppression, and evidence records to Core.
- [ ] Add append-only consent, exclusion, list-membership, import, and guard-decision events.
- [ ] Apply the same immediately-before-send guard to Campaigns, Inbox marketing sends,
  automations, APIs, and customer-facing Agent actions.
- [ ] Normalize supported inbound opt-out signals and retain safe evidence references.
- [ ] Reconcile canonical state, list projections, Campaign recipients, send attempts, and provider
  delivery observations.
- [ ] Backfill only evidence-supported state and mark the earlier historical range unavailable.
- [ ] Register consent distribution, acquisition, opt-out, unsubscribe, exclusion, audience,
  import-quality, suppression, and guard metrics with explicit denominators.
- [ ] Add per-channel, purpose, source, list, segment, Campaign, and Agent-safe breakdowns.
- [ ] Add ordering, precedence, duplicate, deletion, privacy, freshness, and organization-isolation
  tests.

## Section 9 — Connections and platform-health analytics data contract

**Status:** Approved

Current connection models provide useful snapshots such as status, credential health, webhook
health, quality rating, capability state, and last synchronization time. They do not preserve
enough transition, incident, or synchronization history to calculate availability or explain when
a feature was unable to collect data.

This section covers customer-visible provider and product connection health. KasiTek service CPU,
database health, cross-customer failure totals, and internal infrastructure incidents belong to the
separate KasiTek internal analytics and observability plan.

### Connection categories

Use one common connection contract with typed provider and category dimensions:

- Messaging and calling connections, including WhatsApp and future voice providers
- Social publishing and social-insight connections
- Agent communication channels such as Telegram, Website Chat, and future adapters
- Calendar, CRM, billing, storage, email, automation, and other future external services
- Tenant-owned equivalents linked to a workspace or tenant client

A provider that supports multiple accounts or capabilities creates separate connection and
capability identities. Do not collapse unrelated provider accounts into one health state.

### Required connection lifecycle facts

Collect append-only facts for:

- Connection created, setup started, authorization completed, verified, connected, paused,
  disconnected, revoked, reauthorized, and deleted
- Credential added, rotated, expired, revoked, invalid, or recovered without storing the credential
- Capability enabled, disabled, granted, removed, degraded, unsupported, or blocked by entitlement
- Webhook configured, verified, subscribed, delivery failed, signature rejected, retried, recovered,
  or removed
- Provider permission added, missing, changed, or revoked
- Customer action, Agent action, system action, provider action, and expiry attribution
- Previous and next normalized state, reason code, effective time, observed time, and safe provider
  reference

Current connection rows remain operational projections. Analytics availability comes from the
append-only transitions and observations.

### Health observations and synchronization runs

Every supported collector records a versioned health observation containing connection,
capability, provider, normalized health state, provider state, reason code, observation method,
observed time, expiry time, and coverage interval.

Record every provider or reconciliation synchronization run with:

- Run and collector version
- Requested and completed range or cursor
- Start, finish, duration, and terminal status
- Objects requested, received, accepted, duplicated, revised, rejected, and quarantined
- Provider request count, retry count, normalized rate-limit state, and safe error class
- Coverage start/end, next cursor, and whether the result is complete or partial
- Connection, capability, organization/workspace/client, and correlation references

Never store access tokens, refresh tokens, authorization codes, webhook secrets, raw credentials,
or unrestricted provider error bodies in Analytics.

### Incident and availability history

Derive customer-visible connection incidents from consecutive observations and explicit provider
events. Preserve incident opened, acknowledged, state changed, mitigated, resolved, and reopened
facts with affected capabilities, start/end, severity, source, and reason.

Availability intervals use one of `available`, `degraded`, `unavailable`, `unknown`, or
`unsupported`. `Unknown` and `unsupported` are not counted as successful availability. Planned
customer disconnection and credential revocation are reported separately from unexpected provider
or product failures.

### Connection metrics enabled by this contract

- Connected, degraded, needs-attention, disconnected, and unsupported connections over time
- Availability percentage and unavailable duration by provider, account, capability, and period
- Incident count, affected duration, mean time to detect, acknowledge, and recover
- Credential expiry/revocation frequency and time to recovery
- Webhook success, retry, duplicate, signature rejection, failure, and recovery rates
- Synchronization success, partial, failure, retry, throughput, revision, and freshness rates
- Provider-data coverage by feature and period
- Rate-limit encounters, throttled duration, and collection delay
- Delivery health by connection when the feature domain supplies delivery observations
- Feature unavailability attributable to a connection or capability

Availability denominators include only intervals where the provider/capability contract claims
support and an observation was expected. Responses disclose unknown and excluded interval duration.

### Connection analytics display rules

- Show current status with its last observation and evidence source.
- Show health history separately from current configuration.
- Link feature gaps to the responsible connection without exposing internal credentials or payloads.
- Distinguish provider outage, missing permission, invalid credential, customer pause, unsupported
  capability, incomplete collection, and KasiTek processing failure.
- Do not claim provider uptime when the platform did not observe the connection.
- Do not mix customer connection health with global KasiTek infrastructure health.
- Apply connection visibility through the owning Core organization, tenant workspace, or tenant
  client and its approved descendant grants.

### Connection implementation checklist

- [ ] Add lifecycle, credential, permission, webhook, and capability history to Core, Agent, and
  Tenant connection owners.
- [ ] Add normalized health observations, expected-observation schedules, incidents, and coverage
  intervals.
- [ ] Add synchronization-run manifests for every provider collector.
- [ ] Publish connection and capability scope definitions without credentials or customer PII.
- [ ] Register availability, incident, recovery, webhook, sync, coverage, throttle, and feature-gap
  metrics.
- [ ] Backfill only current state and evidence-supported history; mark prior uptime unavailable.
- [ ] Add provider-specific adapters without changing common reporting contracts.
- [ ] Add stale observation, partial sync, revision, outage, deletion, and scope-isolation tests.

## Section 10 — Cross-feature attribution and agent-readable analytics

**Status:** Approved

The current code contains isolated links such as Campaign-to-recipient, Call-to-conversation,
Agent-run-to-conversation, and Booking-to-customer. These references support direct drilldown but do
not form one versioned attribution model. Analytics owns the cross-feature model after source
domains emit stable typed references.

### Attribution touchpoints to collect

- Campaign audience, recipient, send, delivery, read, reply, tracked-link, opt-out, and failure
  touchpoints
- Content post, platform variant, publish, impression, engagement, tracked-link, and inbound
  conversation touchpoints when the provider supplies them
- Conversation origin, channel, referrer class, campaign/content reference, first response,
  resolution, and handoff touchpoints
- Call origin, answer, handler, conversation, Campaign, Agent, Booking, and outcome touchpoints
- Booking source, service, customer, conversation, Campaign, content, Call, Agent, completion,
  cancellation, and no-show touchpoints
- Contact acquisition, consent, list, segment, and Campaign membership touchpoints
- Agent definition/version/installation/run, tool/effect, generated content, reply, handoff, and
  declared outcome touchpoints
- Tenant lead source, qualification, conversion, client, conversation, Campaign, content, Call,
  Booking, and Agent touchpoints

Tracked links and public entrypoints use signed, opaque attribution tokens that resolve to typed
operational references. Analytics receives the safe resolved references, not customer identifiers
or arbitrary URL query values.

### Typed attribution edge

Every edge records:

- Source entity type and pseudonymous reference
- Outcome entity type and pseudonymous reference
- Owning reporting scope and optional customer reference
- Direct or assisted relationship
- Attribution model and version
- Touchpoint time, outcome time, configured window, and evaluation time
- Confidence category and evidence category
- Source event IDs and deduplication identity
- Optional registered value components, currency, and value-source reference
- Active, superseded, deleted-source, or outside-window status

Source domains emit touchpoints and explicit references. The Analytics attribution projection owns
window evaluation, model calculation, deduplication, late-data recalculation, and deletion effects.

### Approved attribution models

- **Direct:** an explicit typed source reference is carried into the outcome-producing operation.
- **First eligible touch:** the earliest qualifying touchpoint inside the registered window.
- **Last eligible touch:** the latest qualifying touchpoint before the outcome.
- **Linear assisted:** equal contribution across qualifying touchpoints inside the registered
  window.

Every metric names its model and version. Direct attribution remains separate from modeled
attribution. AI-generated guesses, text similarity, and temporal proximity alone must not be
presented as causal attribution. A future model requires a new registered version, parity data,
and explainable evidence.

Windows are registered per outcome and source category. A Booking, qualified lead, conversation,
purchase, and opt-out do not inherit one global window. Recalculation preserves prior projection
generations so reports remain reproducible.

### Outcome ownership and value

- The domain that owns the authoritative outcome emits its terminal outcome fact.
- Agent completion, message delivery, Campaign completion, and content publication are not
  automatically business conversions.
- Duplicate provider callbacks and repeated touchpoints cannot duplicate an outcome.
- Cancelled or reversed outcomes emit their own state and update the active attribution projection.
- Revenue, pipeline value, or saved cost is reported only when a registered billing or value source
  exists. User-entered estimates are labeled separately.
- One outcome may have one direct source and multiple assisted sources, but each model's total
  contribution cannot exceed the registered outcome value.

### Attribution metrics enabled by this contract

- Direct and assisted outcomes by Campaign, content item, channel, connection, Agent, workflow,
  Call, conversation source, audience, and tenant client
- First-touch, last-touch, and linear contribution totals
- Conversion rate using registered eligible-source and outcome denominators
- Time and touch count from first/last source to outcome
- Agent-influenced versus Agent-completed outcomes
- Handoff-assisted human outcomes without crediting every human wait as takeover
- Cost per attributed outcome and return metrics only when cost and value coverage are valid
- Attribution coverage, unresolved references, outside-window outcomes, revisions, and confidence
  distribution

### Agent-readable analytics contract

Authorized Agents query the same metric registry and reporting APIs as dashboards through a
separate `agent_read` grant. The response contains:

- Metric key, label, formula version, value components, interval, comparison, and dimensions
- Scope, authorized descendant mode, applied filters, timezone, and requested period
- Freshness, availability, coverage, estimation method, and reliable-history boundary
- Attribution model/version when attribution is included
- Source-domain provenance and report generation time
- A bounded list of safe drilldown references only when explicitly granted

Agents cannot access raw facts, message bodies, contact details, credentials, unrestricted
customer-level rows, private test chats belonging to another user, or metrics outside their
reporting grant. Agent-generated narrative is separated from the returned data and cites metric
keys and periods. An Agent cannot register metrics, widen its scope, or feed its own narrative back
as an analytic fact.

### Attribution and agent implementation checklist

- [ ] Add signed attribution tokens and typed source/outcome references to supported entrypoints.
- [ ] Add domain touchpoint contracts and explicit outcome ownership.
- [ ] Implement direct, first-touch, last-touch, and linear versioned projections.
- [ ] Add configurable registered windows, confidence/evidence categories, deduplication, reversal,
  late-data, and deletion behavior.
- [ ] Register attribution conversion, contribution, timing, cost, value, and coverage metrics.
- [ ] Add the bounded agent-reporting API and separate `agent_read` grants.
- [ ] Require provenance, coverage, and model version in every agent-readable response.
- [ ] Add cross-scope, prompt-injection, raw-data, self-attribution, replay, and formula tests.

## Section 11 — Main Overview dashboard

**Status:** Approved

The Main Overview is derived from approved feature contracts; it does not decide what feature data
must exist. The current Core overview, tenant summaries, client overview, and social analytics page
read operational rows or calculate totals in the browser. Keep them as legacy operational views
until Analytics parity, then replace their calculations with registered reporting APIs.

### Overview variants and scope

- **Core organization:** organization-wide business and operational analytics.
- **Tenant workspace:** authorized workspace totals plus permitted tenant-client contributions.
- **Tenant client:** only that independently administered client's analytics.
- **Per-agent:** the applicable common and conditional metrics for one Agent.

The reporting principal, current grant, and hierarchy mode determine visible modules and
drilldowns. A tenant-client administrator never sees workspace-wide totals merely because the same
frontend component renders both scopes.

### Global controls

Every overview supports:

- Default 30-day range, plus 7-day, 90-day, and bounded custom ranges
- Previous equal-period comparison
- Scope reporting timezone and disclosed calendar boundaries
- Registered hourly, daily, or monthly interval selected within query bounds
- Feature, channel, connection, Agent, Campaign, content, service, and tenant-client filters only
  where authorized and supported
- Freshness, coverage, partial, estimated, and reliable-history indicators

Filters and range are reflected in a shareable application URL without embedding grants or private
identifiers that the recipient is not authorized to resolve.

### Overview information hierarchy

#### 1. Attention

Show actionable registered conditions such as stale or unhealthy connections, unread or aging
conversations, response-SLO risk, takeover requests, failed Campaign recipients, consent guard
violations, failed content jobs, failed or waiting Agent runs, missed schedules, Calls requiring
follow-up, Booking conflicts, and stale provider collection.

Each item has a count, severity, affected period, freshness, and authorized drilldown. This replaces
hard-coded attention counts only after parity.

#### 2. Key outcomes

Select a small scope-appropriate set from conversations resolved, Campaign delivery and response,
audience growth and consent health, content reach/engagement, qualified leads, completed Bookings,
answered Calls, declared Agent outcomes, and attributed outcomes. Show current value, comparison,
trend, numerator/denominator for rates, and coverage.

Unavailable features are omitted or marked unavailable; they are never shown as zero merely to
fill a card grid.

#### 3. Trends and funnels

- Time-series trends for selected key metrics
- Inbox response and resolution funnel
- Campaign target-to-send-to-deliver-to-read-to-response/outcome funnel
- Contact acquisition-to-consent-to-send funnel
- Content publish-to-observation-to-engagement/outcome funnel where provider coverage exists
- Call ring-to-answer-to-outcome funnel
- Booking request-to-confirm-to-complete funnel
- Agent run-to-declared-outcome funnel

Funnels use one registered cohort and denominator definition. Stages from unrelated populations
cannot be placed in one funnel.

#### 4. Agents and automation

Show active and paused Agents, runs, declared outcomes, success/failure, latency, cost coverage,
tool/effect failures, schedules, conversations for conversational Agents, and customer handoff only
for capable customer-facing Agents. Link to per-agent analytics.

#### 5. Channels and connections

Show active capabilities, connection availability, provider coverage, sync freshness, incidents,
delivery health, and affected feature gaps. Keep KasiTek internal infrastructure incidents out of
the customer overview.

#### 6. Breakdown and drilldown

Use ranked tables, compact distributions, time heatmaps, and comparisons only when supported by the
metric contract. Common breakdowns include channel, Campaign, content item, Agent, outcome,
connection, service, source, and authorized tenant client. Every chart links to its source feature
or a bounded analytics drilldown.

### Tenant workspace overview

In addition to permitted shared metrics, a tenant workspace may show:

- Active, new, suspended, and analytics-ready clients
- Client feature adoption and data coverage
- Aggregate conversations, leads, Agents, outcomes, and usage
- Clients requiring attention, respecting staff assignments
- Authorized client comparison and contribution to workspace totals

Workspace aggregation uses the approved ancestor-contribution model. It does not query every
client's operational database at page load or expose client users and customer identifiers.

### Tenant-client overview

Show the client's enabled features, conversations, response/resolution performance, leads,
Bookings, Calls, Campaigns, content, Agents, outcomes, connections, and attention items only when
those services exist and are owned by that client scope. Replace current lifetime row counts with
range-aware metrics and preserve direct navigation to operational work.

### Insights

Start with deterministic registered insight rules: meaningful change, threshold breach, unusual
failure mix, stale collection, conversion drop, backlog growth, cost increase with coverage, or an
outperforming channel/Agent. Each insight includes evidence metrics, period, comparison, scope,
coverage, severity, and drilldown.

An authorized Agent may summarize these evidence records, but the generated wording is not stored
as the metric or accepted as a new fact. Do not generate an insight when data is stale, partial
beyond its rule threshold, below minimum sample size, or missing its denominator.

### Main Overview implementation checklist

- [ ] Define role- and scope-aware module manifests for Core, workspace, client, and per-agent
  overviews.
- [ ] Register attention, KPI, trend, funnel, breakdown, and deterministic insight queries.
- [ ] Replace browser aggregation and direct operational-table totals only after metric parity.
- [ ] Add range, comparison, timezone, interval, filters, and shareable authorized URL state.
- [ ] Add coverage, freshness, partial, estimated, unsupported, and reliable-history UI states.
- [ ] Add responsive cards, charts, tables, funnels, heatmaps, and drilldowns using shared
  visualization components.
- [ ] Add tenant assignment, descendant, client-admin, revoked-grant, cache, and export isolation
  tests.
- [ ] Add accessibility, desktop, tablet, mobile, loading, empty, partial, and failure verification.

## Section 12 — Rollups, exports, alerts, and scheduled reports

**Status:** Approved

These products use the same metric registry, reporting scopes, projections, availability rules,
and authorization as interactive dashboards. They do not create separate formulas or bypass
current grants.

### Saved report definition

A saved report records:

- Owner, reporting scope, authorized descendant mode, and optional shared-with grants
- Name, description, report type, and version
- Metric keys and formula versions
- Dimensions, filters, ranking, and visualization specification
- Relative or fixed period, comparison period, interval, and scope timezone
- Coverage, freshness, and minimum-sample requirements
- Created, updated, last run, revision, and disabled timestamps

Saved reports reference registry definitions rather than copying SQL or formulas. Opening,
scheduling, exporting, or alerting from a report reauthorizes the current principal and recompiles
the bounded query plan.

### Product rollups

- Use the approved hourly, daily, and monthly component rollups.
- Calculate rates from mergeable numerator and denominator components.
- Preserve currency, histogram, distinct strategy, generation, registry version, timezone, and
  coverage metadata.
- Recompute affected windows after late data, provider revisions, scope reparenting, deletion, or
  metric-version changes.
- Select the coarsest interval that preserves the requested meaning within interactive and export
  bounds.
- Never sum precomputed percentages, percentiles, distinct counts, or averages across incompatible
  groups.

### Exports

Support asynchronous:

- CSV for one normalized table
- XLSX for multiple bounded metric and breakdown sheets
- PDF for the rendered report summary with definitions, period, scope, freshness, and coverage

Every export stores the requesting principal, scope grant revision, report/query revision, metric
registry version, projection generation, filters, period, timezone, format, status, row/byte count,
checksum, expiry, and download audit. Files use encrypted storage and short-lived signed download
links, expire after the approved 24-hour period, and are deleted when their scope or subject
requires invalidation.

Exports contain aggregate or explicitly authorized bounded drilldown data only. They exclude
message bodies, contact details, credentials, raw provider payloads, and unrestricted child-scope
rows. Large requests are split into bounded parts or rejected with an explicit limit; they never
run as unbounded database scans.

### Analytics alerts

An alert definition records metric, scope, dimensions/filters, comparison, operator, threshold,
minimum sample, minimum coverage, evaluation interval, consecutive evaluation count, hysteresis,
cooldown, severity, recipients, delivery channels, owner, grant revision, and active period.

Supported conditions are:

- Absolute value above or below a threshold
- Rate or ratio above or below a threshold
- Relative or absolute change against a registered comparison
- Freshness or coverage below a threshold
- Registered attention or incident condition
- No eligible data when the metric contract explicitly expects data

Do not fire ordinary threshold alerts from stale, partial-beyond-policy, unavailable, unsupported,
or below-sample data. Fire a separate freshness/coverage alert where configured. Deduplicate alerts
by definition, scope, dimension tuple, metric window, and state. Preserve opened, acknowledged,
resolved, suppressed, expired, and delivery history.

Alert recipients and channels are reauthorized at evaluation and delivery. Role revocation,
client-assignment removal, scope deletion, or expired grants stop future deliveries.

### Scheduled reports

Schedules support daily, weekly, and monthly delivery in the reporting scope's timezone with an
explicit local time and daylight-saving policy. Each schedule records saved report, owner,
recipients, format, period rule, timezone, next run, last run, status, retry policy, and grant
revision.

At execution time:

1. Reauthorize owner, recipients, scope, and descendant mode.
2. Resolve the report and metric-registry versions.
3. Wait only within the allowed freshness policy.
4. Generate an immutable report run with coverage and freshness.
5. Deliver through approved channels and record the outcome.

If authorization is revoked, required data is unavailable, or coverage is below the report's
policy, skip delivery or send a concise unavailable notice according to the schedule definition;
never substitute zeros. Retries are idempotent and cannot deliver the same run twice to one
recipient.

### Sharing and tenant boundaries

- Core reports stay inside their organization.
- Tenant-workspace reports may include only authorized descendant contributions.
- Tenant-client reports stay inside that client unless an explicit workspace grant permits a
  workspace recipient.
- Shared links require authentication and current authorization; possession of a URL is not a
  grant.
- Agents receive report data only through `agent_read`; they cannot become scheduled human
  recipients or forward exports unless a separate approved action exists.
- Cache, generated file, notification, and delivery records include complete scope and grant
  identity.

### Reporting-product metrics and audit

Track report runs, generation time, failures, cancellations, rows/bytes, alert evaluations,
triggers, acknowledgements, schedule executions, delivery attempts, expiry, downloads, and access
denials as operational records. Customer-facing usage metrics may expose report activity inside the
same scope; cross-customer operational totals belong to KasiTek internal analytics.

### Rollup and reporting implementation checklist

- [ ] Add saved report, revision, share grant, export, alert, schedule, report-run, and delivery
  contracts.
- [ ] Build all products on registered reporting queries and component rollups.
- [ ] Add asynchronous CSV, XLSX, and PDF generation with bounded plans and 24-hour expiry.
- [ ] Add threshold, comparison, freshness, coverage, incident, hysteresis, cooldown, and
  deduplication alert evaluation.
- [ ] Add timezone-safe daily, weekly, and monthly schedules with idempotent delivery.
- [ ] Reauthorize every open, evaluation, generation, download, share, and delivery operation.
- [ ] Invalidate caches and artifacts after grant revision, scope change, deletion, erasure, metric
  revision, or projection promotion.
- [ ] Add export-size, formula, timezone/DST, stale/partial, duplicate-delivery, revoked-access,
  tenant-boundary, deletion, retention, and audit tests.
