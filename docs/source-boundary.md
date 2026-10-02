# Agents client integration status

Updated: 2026-10-02.

The client lives in client/apps/agent-platform and now uses React/TypeScript, Vite and React Router. Next.js routing, server cookie helpers, font/image imports and dependencies have been replaced. Existing agent, Studio, workflow and activity components remain product-local source, adapted to browser route loaders.

## Preserved UI

Growth's Vantage design tokens, authored Geist fonts, theme/accent/density preferences and existing UI primitives remain. The Agents shell uses Growth-style grouped navigation, collapse behavior, a mobile navigation dialog and a workspace header. Marketing pages have a separate cream/green layout and scoped styles.

## Remaining dependencies

The backend implements standalone /api/auth routes, with its own workspace/session records, OIDC callback, HttpOnly cookie and bounded provider checks. Independent local clients are registered. Password sign-in, workspace onboarding, dashboard access, provider rechecking and browser logout were verified with a dedicated local test account. An explicit browser route manifest now connects the initial /api/agents creation/Studio/playground contracts to the existing scoped handlers. Other inherited agent/integration screens still need endpoint review. No fake session or browser service-secret injection has been introduced.

The dev/preview proxy points /api to the configured Agents endpoint. It does not forward to Growth by default. Shared login belongs to Labs; the Agents integration must register its own client and enforce its own memberships.

Account settings provide current account/workspace information and logout. Workspace creation, selection and activity reporting use the real backend. Invitations and role management remain planned. Inbox, knowledge, connections and usage pages are pending integration. Personal runtime deployments are a later platform capability.

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
