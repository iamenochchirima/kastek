# Feature map

This is the index of user-facing routes currently present in the repository. It is a map of the
checkout, not a final product-boundary decision. The repository is being refocused on Growth, but
Agent Platform and the white-label business product still have code here. Do not treat their
presence as approval to move or delete them.

For local startup, environment, and test commands, use [Local Development](../internal/development/local-development.md).
The main client runs on port `3000`; the other app ports and service prerequisites are listed in
that guide.

## Main client

Routes below are under `client/apps/client/src/app/`.

| Feature area | User entry point | Source route | Verification starting point |
| --- | --- | --- | --- |
| Campaigns | `/campaigns` | `(dashboard)/campaigns/page.tsx` | Run the client locally, open the route, then follow the task's real campaign path and inspect its visible/API result. |
| Contacts | `/contacts` | `(dashboard)/contacts/page.tsx` | Run the client locally, open the list and a contact detail, and verify the requested change in the UI and its backing API. |
| Inbox | `/inbox` | `(dashboard)/inbox/page.tsx` | Run the required local services, open the inbox, and verify the conversation action and resulting state. |
| Calendar and bookings | `/calendar`, `/bookings` | `(dashboard)/calendar/page.tsx`, `(dashboard)/bookings/page.tsx` | Open the route with the required service and test data available; verify the visible event or booking and its persisted result. |
| Content | `/content`, `/content/posts`, `/content/calendar`, `/content/history` | `(dashboard)/content/` | Open the relevant route and verify the content state plus the API side effect for the task. |
| Analytics | `/analytics` | `(dashboard)/analytics/page.tsx` | Run the client and required Analytics services; use the existing Analytics Playwright suite when the change affects its coverage. |
| Workspace | `/workspace`, `/workspace/team`, `/workspace/settings`, `/workspace/profile` | `(dashboard)/workspace/` | Open the relevant route with an authorized local account and verify the saved state after navigation or reload. |
| Billing | `/billing`, `/upgrade` | `(dashboard)/billing/page.tsx`, `(dashboard)/upgrade/page.tsx` | Use a test account and the configured billing test environment; do not use live payment credentials for local verification. |
| Agent surfaces | `/agents`, `/studio`, `/playground`, `/agents/activity`, `/agents/conversations` | `(dashboard)/agents/`, `(dashboard)/studio/`, `(dashboard)/playground/` | Use the Agent Platform local service group in the development guide. The owner intends Agents to be a separate product; extraction has not happened. |
| Developer surfaces | `/developers`, `/developers/api`, `/developers/cli`, `/developers/mcp` | `(dashboard)/developers/` | Verify against the documented local service and credentials for the specific developer workflow. Product ownership remains to be confirmed. |

## Admin app

Routes are under `client/apps/admin/src/app/(dashboard)/`. The current app includes dashboard,
agencies, leads, outreach, quotations, invoices, billing, access, operations, analytics, and
reports routes. Start the Admin app using the command in Local Development, then follow its route
and API calls for the task being changed. The existence of these routes does not settle whether
Admin belongs in Growth or another product/repository.

## Other apps

- `client/apps/tenant-portal/` is a separate app package. Its routes and workflows are not
  included in the Growth feature list above.

## Map rules

- Add or change a feature entry in the same pull request as shipped user behavior.
- Describe current behavior only. Specs and planned work live in the selected issue tracker.
- For a feature without a runnable local path, name the missing service, credential, or test data
  instead of claiming it was verified.
