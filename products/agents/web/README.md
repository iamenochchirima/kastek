# Agents interface

React 19, Vite and React Router provide a small standalone Agents product. Reused
UI controls, appearance definitions and light/dark tokens come from the public
`@kasitek-labs/ui` package. Local UI modules re-export those controls. Font loading
and product layouts remain in `src/styles/`.
The active product code is `src/platform/`; the router is `src/routes/router.tsx`.

## Run

Start the API, database, identity provider and Restate worker using the
[product setup](../README.md), then run from the repository root:

```sh
pnpm dev:agents
```

Dev, build and typecheck commands first compile the shared UI package. Rebuild
`@kasitek-labs/ui` after changing a shared React control during development. Theme
CSS is consumed directly from source. The overview and workspace navigation use
Hugeicons free icons; shared controls use Phosphor icons. Product state and theme
preference handling remain local. See the
[shared package guide](../../../packages/ui/README.md).

Open http://localhost:3100. Vite proxies `/api` to `127.0.0.1:4100`; set
`AGENTS_API_PROXY_TARGET` to change that server target. The browser receives an
opaque HTTP-only product session, never a service or model credential.

## Product paths

- `/login`: provider sign-in.
- `/app/overview`: customer conversation activity, current handoffs, enquiries and channel totals for the selected workspace.
- `/app/agents`: agent directory and guided customer-service setup.
- `/app/agents/:agentId`: chat, activity and configuration, including tools, skills and website setup.
- `/app/agents/:agentId/conversations/:conversationId`: authorized conversation history and chat.
- `/app/inbox`: customer conversations, assignment, human replies and handoff.
- `/app/customers`: enquiry and contact records, follow-up and activity.
- `/app/knowledge`: private imports, candidate review, revision approval and withdrawal.
- `/app/connections`: customer channels, provider accounts and selected API/MCP tools.
- `/app/automations`: pinned UTC/event occurrences and report reviewer controls.
- `/app/tasks`: authorized tasks, filters and conversation or review links.
- `/app/tasks/:taskId`: operation activity, citations, child/resource state and exact report review.
- `/app/settings`: account, workspace, model providers and theme preferences.
- `/chat/:deploymentId`: anonymous chat for an explicitly published version.

Saving a draft and testing a version never change a publication. Website
publication accepts only public knowledge. The embed script calls the published
API under its configured allowed origin. Unavailable runtime capabilities are
not exposed as working controls.

## Verify

```sh
pnpm --filter @kasitek/agent-platform typecheck
pnpm --filter @kasitek/agent-platform lint
pnpm --filter @kasitek/agent-platform build
pnpm --filter @kasitek/agent-platform test:browser
```

The default browser test uses mocked HTTP transport and labels that boundary.
The opt-in live-service test uses `AGENTS_BROWSER_SESSION_COOKIE` from a private
local fixture and checks real APIs, reconnect, publication and the external
widget. `api/test/browser-fixture.ts` can run the full local service fixture;
its identity is seeded and its default model transport is deterministic.
Set `AGENTS_BROWSER_REAL_MODEL=1` with the approved OpenRouter key to verify the
real free model; there is no paid fallback. Provider login/logout is checked
separately by `infra/agents-runtime/verify-identity.sh`.

Production hosting must serve `dist`, fall back to `index.html` for frontend
paths, and proxy `/api` before that fallback. The supplied Nginx container uses
`AGENTS_API_UPSTREAM=http://api:4100`. Preserve Origin and cookie headers. No
production deployment is part of this implementation.
