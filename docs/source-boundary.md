# Agents client integration status

Updated: 2026-10-02.

The client lives in client/apps/agent-platform and now uses React/TypeScript, Vite and React Router. Next.js routing, server cookie helpers, font/image imports and dependencies have been replaced. Existing agent, Studio, workflow and activity components remain product-local source, adapted to browser route loaders.

## Preserved UI

Growth's Vantage design tokens, authored Geist fonts, theme/accent/density preferences and existing UI primitives remain. The Agents shell uses Growth-style grouped navigation, collapse behavior, a mobile navigation dialog and a workspace header. Marketing pages have a separate cream/green layout and scoped styles.

## Remaining dependencies

The backend now implements standalone /api/auth routes, with its own workspace/session records, OIDC callback, HttpOnly cookie and bounded provider checks. Actual local provider registration and browser login still need verification. Existing screens use /api/agents commands inherited from the Growth-facing contract; the Agents backend currently exposes scoped /v1 interfaces. A proper authenticated browser facade is still required. No fake session or browser service-secret injection has been introduced.

The dev/preview proxy points /api to the configured Agents endpoint. It does not forward to Growth by default. Shared login belongs to Labs; the Agents integration must register its own client and enforce its own memberships.

Inbox, knowledge, connections, usage and account-management pages are pending integration. Personal runtime deployments are a later platform capability. The public landing describes availability honestly.

## Evidence

The migration passed frontend typecheck, production build and existing Studio event/reducer checks. Landing and signup navigation were inspected in the browser; the protected route reports the unavailable backend. Actual login, dashboard access, creation and model execution remain unverified.

Follow the [frontend checklist](plans/agents/FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md). Growth's styling is reference material; no Growth files were modified by this frontend migration.
