# Agents interface

React 19, Vite and React Router provide a small standalone Agents product. Reused
UI primitives, fonts and theme tokens live under `src/components/` and `src/styles/`.
The active product code is `src/platform/`; the router is `src/routes/router.tsx`.

## Run

Start the API, database, identity provider and Restate worker using the
[product setup](../README.md), then run from the repository root:

```sh
pnpm dev:agents
```

Open http://localhost:3100. Vite proxies `/api` to `127.0.0.1:4100`; set
`AGENTS_API_PROXY_TARGET` to change that server target. The browser receives an
opaque HTTP-only product session, never a service or model credential.

## Product paths

- `/login`: provider sign-in.
- `/app/agents`: workspace selection and agent creation.
- `/app/agents/:agentId`: configuration, private Test and explicit Publish.
- `/app/knowledge`: private imports, candidate review, revision approval and withdrawal.
- `/app/connections`: scoped report/GitHub credentials and selected API/MCP tools.
- `/app/automations`: pinned UTC/event occurrences and report reviewer controls.
- `/app/tasks/:taskId`: operation activity, citations, child/resource state and exact report review.
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
