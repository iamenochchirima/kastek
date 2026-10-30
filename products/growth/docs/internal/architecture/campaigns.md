---
owner: engineering
last_reviewed: 2026-10-30
---

# Campaign creation and delivery

Growth owns WhatsApp marketing campaigns, recipient snapshots and queue processing. The Vite
client uses the same-origin Growth API. The shared Agents platform remains an authenticated
HTTP integration; Campaigns' Ask agent action retains the selected campaign context.

## Browser workflow

`/campaigns` lists actual campaign records with search, status views and optional reporting.
Request failures remain visible and retryable rather than becoming an empty campaign list.
`/campaigns/create` has Details, Audience, Message and Review steps. The audience loader reads
all pages of the selected list. Contact list row IDs identify memberships; exclusion requests use
canonical `contactId` values. Template variables can resolve contact fields, metadata or static text.
The preview identifies missing values without inventing replacements.

The review presents three distinct actions:

- **Save draft** creates a DRAFT with recipient snapshots and does not queue delivery.
- **Send now** creates the draft, then explicitly launches its selected batch.
- **Schedule** creates the draft, then explicitly launches its batch for the reviewed instant.

A failed launch retains the created ID. Retry launches that record rather than creating another
campaign. Browser submissions and detail mutations reject overlapping local attempts. This does
not replace server authorization or transaction guards.

`/campaigns/:id` shows delivery counts, recipient status and dates, template previews, failures
and selected contact facts. Pause, resume, retry failed, send more, repair, cancel and delete remain
subject to actual server state and permissions. Cancel and delete require custom confirmations.
Manually excluding a recipient in Send more permanently skips that pending campaign recipient;
it does not alter their global contact consent. A refresh failure marks displayed data stale and
offers retry. Terminal summary transitions reconcile the final recipient rows.

## API behavior

`POST /api/whatsapp/campaigns/preflight` accepts the same camelCase audience input as creation.
It returns `totalContacts`, `eligibleRecipients` and `skipped` counts for `notOptedIn`, `excluded`
and `cooldown`. It reads the same organization-scoped audience and eligibility rules as creation
without inserting campaigns, recipient rows or queue work. `eligibleRecipients` describes the
whole eligible audience before the requested batch is applied. It is a point-in-time result;
creation and delivery still enforce current eligibility.

`POST /api/whatsapp/campaigns` always creates a DRAFT, including when a preferred future
`scheduledAt` is supplied. `createdRecipients` is the authoritative persisted count. Creation
alone never proves that messages are queued.

`POST /api/whatsapp/campaigns/:id/launch` validates the campaign state and queues the initial
batch with the status change under a transaction and campaign row lock. Active repeated launches
are refused. The existing recovery path remains for pristine COMPLETED/FAILED records with only
unsent pending recipients. Subsequent batches use the explicit `send_more` action.

Launch and resume distinguish an omitted `scheduledAt` from explicit null:

| Input | Meaning |
| --- | --- |
| Omitted | Retain the saved preferred schedule |
| `null` | Clear the schedule and send immediately |
| Future timestamp | Use that instant |
| Invalid or past explicit timestamp | Reject without queue mutation |

The UI resolves a selected wall-clock date/time and IANA time zone into an ISO instant. It rejects
nonexistent local times and requires an occurrence when a clock change repeats a local time.
The reviewed date, time and zone remain visible before scheduling.

Campaign management requires `feature.campaigns.manage`. Initial launch requires
`feature.campaigns.send`. Resume, retry failed and send more also require the send capability in
addition to the PATCH route's management scope. Product entitlements, metering, consent,
cooldown, ownership and worker delivery guards remain authoritative on the server.

## Verification and release

Controlled browser verification uses `playwright.campaigns.config.ts`, the existing migration
fixture and an in-memory Campaigns provider boundary. It never calls Meta. The existing migration
campaign-create test verifies draft persistence and the absence of a launch request. Focused API
verification uses `whatsapp.test.ts`, `whatsapp-campaign-recovery.test.ts` and
`whatsapp-worker-recovery.test.ts` against an owned PostgreSQL fixture seeded from repository
migrations. These prove engineering behavior, not live provider delivery or model quality.

No database migration or new provider is required. Existing registered campaign analytics and
worker lifecycle signals remain unchanged. New cosmetic analytics, Collector configuration and
logging infrastructure are not applicable. New read-only preflight failures use existing API
error handling. Never log message bodies, contact lists or credentials.

Identify the release by its actual commit and tested artifact during a separately authorized
release. No production tag is assigned by this local change. Rollback restores the prior web/API
artifact pair; no sends are replayed as rollback. Post-release review is owner-scheduled after
release. Owner acceptance covers the final visuals and a consenting test audience's real
connection/template, scheduling, callbacks and safe retries. Model evaluations remain owner-run.
