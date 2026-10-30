---
id: growth-communications-ui
title: Growth Templates and Calls
owner: engineering
last_reviewed: 2026-10-30
---

# Growth Templates and Calls

Templates and Calls use Growth's shared Geist typography, theme tokens, controls and Hugeicons
adapter. The approved reference boards are in `design/interface-concepts/`. Both pages retain the
same authenticated Growth API boundary. Browser credentials never enter provider SDK configuration.

## Templates

`/templates` lists persisted WhatsApp templates. Search, category, language and source-account
filters define the count scope; status tabs include Approved, Pending, Rejected and Disabled.
The `status`, `starter` and `create=1` query entry points remain supported. Desktop selection opens
a 320px preview inspector; smaller widths use a focus-managed Sheet and compact mobile records.

Creation retains the existing categories, languages and starter library. Accounts are selectable
when at least two exist. Submission retains inputs on failure and displays the provider's returned
review status. Placeholders in previews use sample markers, not resolved customer details. Sync
runs for the explicitly selected account and reports a count only when the API returns one.
Independent read failures show retry actions; previously loaded records remain available within
the current user's organization scope. Permission denial clears cached private data.

The API already exposes each template's source `connectionId`. Storage currently identifies a
template by organization, name and language; this interface does not introduce independent copies
of the same name/language across accounts. Edit, delete and rejection-reason controls are not
present because the current contracts do not supply them.

## Calls

`/calls` filters actual history by status, search, direction and connected number. Tab counts describe
that same filtered history. Provider readiness is separate from history and summary availability;
an outage is not shown as zero calls. Details contain supplied timestamps, duration, handler and
provider errors. Only linked records expose an Inbox conversation action. Recordings, transcripts
and sentiment are not part of this contract.

WhatsApp calling remains in Inbox. Business browser calls require a registered organization-owned
Twilio number and `browserConfigured`; the combined `configured` flag also requires inbound
configuration and is not the browser readiness gate. Registering a number stores it; it does not
verify ownership or establish Twilio readiness.

The calling hook performs microphone preflight, requests the server-side browser token, loads the
SDK and connects with the selected connection ID and destination. An attempt generation and abort
controller invalidate cancelled work. Late asynchronous completion disposes its call/device rather
than reviving a cancelled attempt. Device and call errors clean resources. The timer begins on the
SDK acceptance event; history duration remains API-owned. A minimized ongoing call stays visible.
Leaving the route requires an explicit disconnect choice; unmount also cleans resources.

## Verification and live acceptance

Build the frontend, then run `pnpm --filter client exec playwright test --config
playwright.communications.config.ts`. This isolated configuration provides two WhatsApp accounts,
review statuses and representative call records. The browser SDK chunk and media boundary are
controlled by the tests; they never dial a real number. Existing migration and Calls API checks
cover their respective persisted contracts. Screenshots and local decision evidence live under
ignored `.audit/growth-templates-calls/`.

The owner must still check the real configured environment:

1. Select each authorized WhatsApp account, sync and confirm its actual returned templates.
2. Submit an intentional template and confirm the provider's review result after reload.
3. With a consenting recipient, start a browser call, cancel while connecting, then test acceptance,
   minimize, end and provider failure. Confirm microphone permission and actual history duration.
4. Confirm WhatsApp calling still operates through Inbox.
5. Accept the light and dark layouts at desktop, tablet and mobile widths.

Controlled tests establish engineering behavior, not provider delivery or owner visual acceptance.
