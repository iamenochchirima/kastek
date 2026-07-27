---
title: Client-Ready Platform Checklist
slug: /execution/client-ready-platform-checklist
sidebar_position: 4
---

# Client-Ready Platform Checklist

## Purpose

This is the execution checklist for the founding-partner product range. It keeps work additive to the existing Kasitek workspace and prevents Contacts, Inbox, Campaigns, Social, and Agents from becoming separate systems.

The target workflow is:

```text
Lead source → Contact → Pipeline → Inbox / Agent → Booking or Campaign → Outcome
```

## Delivery Rules

- A feature is not launch-ready until it is organisation-scoped, permission-checked, observable, and has a usable empty/error state.
- Use **Contacts** as the user-facing name. A contact may be a lead, prospect, customer, or former customer.
- Keep new launch destinations inside the existing information architecture: **Pipeline** under Customer and **Bookings** under Growth.
- Do not activate a channel until its messages, consent state, identities, and delivery events reach the canonical Contact and activity timeline.
- Build reusable workflow primitives before accepting one-off client customisation.
- Test each release using at least one founding-partner customer journey.

## Status Key

- `[ ]` not started
- `[-]` in progress
- `[x]` verified complete
- `[?]` requires code, provider, or product decision verification

## 0. Launch Programme Readiness

- [ ] Define the founding-partner application and qualification form.
- [ ] Define the 90-day assisted engagement, roles, cadence, and client responsibilities.
- [ ] Define setup, recurring workspace, and managed-optimisation pricing hypotheses.
- [ ] Create an onboarding discovery worksheet for lead source, outcome, channels, consent, staff ownership, and baseline metrics.
- [ ] Create a client success scorecard template.
- [ ] Create a product feedback log with workflow, impact, frequency, workaround, and decision fields.
- [ ] Select the first 5–8 target organisations and record their primary workflow.
- [ ] Define launch support hours, escalation path, and incident communication process.

## 1. Workspace, Access, and Platform Foundation

- [x] Organisation workspace, team membership, invitations, and active-workspace selection exist.
- [x] Product plans, subscriptions, entitlement grants, usage events, and billing foundations exist.
- [ ] Make organisation ownership mandatory for every direct-product customer record and remove remaining user-only or nullable-organisation access paths.
- [ ] Define role permissions for owner, admin, operator, analyst, and future client-viewer use cases.
- [ ] Add an entitlement check and clear unavailable state to each launch capability.
- [ ] Record immutable audit events for privileged configuration, sending, publishing, deletion, and agent approval actions.
- [ ] Define workspace onboarding progress and required connection health checks.
- [ ] Verify isolation tests for organisation, membership, invitations, connections, contacts, conversations, campaigns, and agents.

## 2. Contacts: Canonical Relationship Record

### Existing foundation

- [x] Canonical customer and channel-identity records exist.
- [x] WhatsApp contacts support tags, lists, metadata, notes, opt-in, exclusion, and CSV import/export.
- [x] Customer detail can show identities, consent, conversations, campaign participation, and agent events.

### Required additions

- [ ] Make Contact the shared UI and API record for lead, prospect, customer, and former customer states.
- [ ] Add Contact fields for company, job title, owner, source, lifecycle stage, and structured custom properties.
- [ ] Add reusable contact tags independent of a single channel.
- [ ] Add contact merge and duplicate-review rules with explicit human confirmation.
- [ ] Add channel-neutral consent records: channel, purpose, source, evidence, captured date, status, and withdrawal date.
- [ ] Add contact notes with author and timestamp.
- [ ] Add contact activity timeline entries for messages, campaigns, agent events, tasks, form submissions, bookings, and changes.
- [ ] Add contact search across name, company, identity, phone, email, tags, source, and stage.
- [ ] Add segment builder using contact fields, tags, consent, activity, source, stage, and date conditions.
- [ ] Link every existing WhatsApp contact and conversation to a canonical Contact with safe migration and reconciliation reporting.
- [ ] Add Contact empty states, import validation, duplicate warnings, and import-result reporting.

## 3. Pipeline: The Only New Primary Workspace

- [ ] Add the `Pipeline` navigation item under Customer.
- [ ] Define reusable default lifecycle stages: New, Contacted, Qualified, Booked, Won, Lost, Customer.
- [ ] Support workspace-specific pipeline stages and ordering.
- [ ] Add a contact-to-stage record with source, owner, expected value where relevant, loss reason, and timestamps.
- [ ] Build board and list views with stage, owner, source, date, and overdue filters.
- [ ] Add task creation, due date, assignment, completion, and overdue state.
- [ ] Add follow-up reminders in Overview and Inbox.
- [ ] Add activity from Inbox, agent, campaign, form, and booking events to Pipeline items.
- [ ] Add manual move, bulk move, and explicit lost/won workflows.
- [ ] Add stage conversion and time-in-stage reporting.
- [ ] Verify a staff member can operate the entire lead-to-outcome workflow without leaving Contacts, Pipeline, and Inbox.

## 4. Inbox: Unified Human Operations

### Existing foundation

- [x] WhatsApp connections, templates, conversations, media, reactions, calls, realtime updates, and campaign reply flows exist.
- [x] Inbox now uses horizontal channel navigation and WhatsApp-number switching.
- [x] Channel management is separate from the daily conversation workspace.

### Required additions

- [ ] Add contact summary panel: stage, owner, open tasks, consent, campaign state, booking state, and latest agent outcome.
- [ ] Add conversation assignment and shared team queues.
- [ ] Add internal notes that never reach the provider.
- [ ] Add priority, follow-up date, snooze, archive, and close/reopen state.
- [ ] Add saved replies and reusable response templates.
- [ ] Add visible agent state: active, paused for human, awaiting approval, failed, or resolved.
- [ ] Add agent handoff summary, reason, suggested next action, and handoff owner.
- [ ] Add website chat as the next production Inbox channel.
- [ ] Add Email and SMS adapters only after inbound, outbound, identity, consent, delivery, and opt-out behaviour are verified.
- [ ] Activate Instagram and Facebook Inbox tabs only after Meta ingestion, contact matching, human reply, and policy behaviour are verified.
- [ ] Add Inbox operational reports: first response, queue age, unassigned conversations, overdue follow-up, and resolution time.
- [ ] Verify message sending, attachment handling, retries, provider failures, and realtime state in both themes and mobile layouts.

## 5. Agents: Configured, Safe, and Measurable

### Existing foundation

- [x] Agent configurations, knowledge-base fields, n8n provisioning, deployment state, trusted callbacks, and activity events exist.
- [x] WhatsApp and website-agent workflow templates are defined.

### Required additions

- [ ] Define supported agent roles: qualification, FAQ/support, booking, quote intake, and follow-up.
- [ ] Provide industry workflow templates for clinic, restaurant, transport, professional services, property, retail, and home services.
- [ ] Version knowledge sources and make them reviewable before deployment.
- [ ] Define allowed actions and forbidden actions per agent role.
- [ ] Add approval requirements for sensitive external actions.
- [ ] Require structured agent outcomes: qualified, booked, quote requested, escalated, unresolved, opted out, or failed.
- [ ] Link agent runs and outcomes to Contact, Conversation, Pipeline, and Activity records.
- [ ] Build a human review queue for unresolved, low-confidence, failed, and escalated interactions.
- [ ] Add agent performance metrics: handled conversations, handoff rate, response time, outcome rate, unresolved rate, and failure reasons.
- [ ] Add pause, resume, rollback, and test-conversation controls with audit entries.
- [ ] Verify agents cannot bypass contact scope, channel policy, consent, or human approval rules.

## 6. Campaigns and Follow-up

### Existing foundation

- [x] WhatsApp templates, campaigns, recipient snapshots, send events, delivery/read state, scheduling, and campaign detail exist.
- [x] Contacts have WhatsApp opt-in and exclusion fields.

### Required additions

- [ ] Introduce channel-neutral Campaign, Audience, Campaign Run, and Campaign Outcome concepts while retaining WhatsApp as the first delivery adapter.
- [ ] Replace list-label-only targeting with Contact segments.
- [ ] Add campaign audience preview, consent eligibility, exclusions, and estimated reach before launch.
- [ ] Add campaign draft, review, approval, schedule, pause, cancel, and completion states.
- [ ] Add reusable industry campaign templates.
- [ ] Add follow-up sequence rules for no reply, qualification status, booking status, and campaign engagement.
- [ ] Link campaign sends, replies, opt-outs, and conversions to Contact activities.
- [ ] Add Email and SMS campaign adapters after consent and delivery requirements are complete.
- [ ] Add campaign conversion and revenue/outcome reporting, not only delivery and read counts.
- [ ] Verify idempotent sends, provider retries, send limits, opt-outs, and audit trails.

## 7. Forms, Website Lead Capture, and Bookings

- [ ] Define a channel-neutral lead-capture submission model linked to Contact and Activity.
- [ ] Build reusable form templates: quote request, consultation, callback, booking, intake, and survey.
- [ ] Build an embeddable form and website-chat integration with workspace identification and spam controls.
- [ ] Add lead-source attribution and campaign/landing-page attribution.
- [ ] Route form submissions into Contacts, Pipeline, and Inbox according to configurable rules.
- [x] Add the first booking domain: services, appointment slots, linked Contacts, status, notes, and outcomes.
- [ ] Integrate one calendar provider first and define a provider adapter boundary.
- [ ] Add confirmation, reminder, reschedule, cancellation, no-show, and follow-up workflows.
- [x] Add a standalone Bookings workspace under Growth, distinct from the social Content calendar.
- [-] Link booking activity to Contact, Pipeline, Inbox, Agents, and reporting. Contact history is complete; the remaining destinations require their respective workflow foundations.
- [ ] Add payment-link handoff only after the booking and outcome model is stable.
- [ ] Verify timezone, availability, double-booking, cancellation, reminder, and provider-failure behaviour.

## 8. Content and Social Growth

### Existing foundation

- [x] Social connections, post variants, scheduled publish jobs, calendar, AI drafting, and basic social analytics exist.
- [x] Meta, X, and LinkedIn connection routes exist; Facebook and Instagram are represented in the social workspace.

### Required additions

- [ ] Add workspace brand voice, tone rules, offers, approved claims, and reusable content assets.
- [ ] Add client-review and approval states for content where required.
- [ ] Verify provider publishing workers, scheduled execution, retry, cancellation, and failure visibility.
- [ ] Ingest supported social comments and DMs into Inbox and Contact activity timelines.
- [ ] Add comment-to-DM and comment-to-lead workflows with explicit policy and approval rules.
- [ ] Add post, campaign, landing-page, and form attribution to Contact source data.
- [ ] Replace stored-post counts with verified provider performance metrics where APIs allow it.
- [ ] Add a social performance view that relates content activity to leads and conversations when attribution is available.

## 9. Analytics and Owner Summary

- [ ] Define shared metric definitions for lead, contacted, qualified, booked, won, lost, response time, handoff, opt-out, and conversion.
- [ ] Add lead-source, stage-conversion, time-in-stage, and overdue-follow-up reporting.
- [ ] Add Inbox response, queue, assignment, and resolution reporting.
- [ ] Add agent quality and outcome reporting.
- [ ] Add booking, cancellation, attendance, no-show, and reactivation reporting.
- [ ] Add campaign delivery, reply, opt-out, conversion, and outcome reporting.
- [ ] Add social publishing and provider performance reporting.
- [ ] Build a weekly owner summary: what happened, what needs attention, and recommended actions.
- [ ] Ensure every metric links back to the underlying contacts, conversations, campaigns, or bookings.
- [ ] Document metric definitions and timezone rules for clients.

## 10. Founding Partner Verification

- [ ] Select one primary workflow for each founding partner.
- [ ] Capture pre-launch baseline metrics for every partner.
- [ ] Complete a connected-channel, data-import, team-training, and first-workflow acceptance checklist for every partner.
- [ ] Observe first-day live usage and record failures, workarounds, and requests.
- [ ] Complete weekly operating reviews in month one.
- [ ] Confirm one measurable outcome improvement before expanding the partner to a second workflow.
- [ ] Produce an outcome review and case-study draft by day 90.
- [ ] Review all custom requests against the shared-domain and repeatability rules.

## Current Evidence and Verification Notes

The checked items above are based on the current direct-product schema, routes, and UI. They are not a claim that every production integration has been exercised with a live client. Before marking an item client-ready, record the environment, provider, organisation, test path, and result.

## Relationships

- [Founding Partner Launch Plan](../go-to-market/founding-partner-launch-plan.md) defines the commercial motion and client programme.
- [Product Features](../features/product-features.md) is the customer-facing capability catalogue.
- [Product Roadmap](../roadmap/product-roadmap.md) owns broader timing and future products.
- [Technical Blueprint](../architecture/kasitek-technical-blueprint.md) owns system boundaries and technical decisions.
