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

Agent chat, Activity and task detail use the shared conversation, execution and composer
components from `@kasitek-labs/ui/agent`. `platform/execution-view.tsx` maps authorized
product task records to those components and observes selected subagents through the normal
task-detail API. A running specialist opens its own read-only conversation in a responsive
modal. Closing or navigating within that modal does not send execution commands.
Tool details contain recorded safe metadata; raw arguments and results are not exposed.
Public model updates remain separate from native operation status and final output.
Current-policy and evidence withdrawal clear protected output, including in an open modal.

Customer website and staff Inbox messages share the plain-text message primitive only.
Their attachment, delivery, ownership and takeover controls retain their existing contracts;
internal tools, specialists and execution diagnostics are not added to customer timelines.

The desktop workspace sidebar can be collapsed to icon navigation. Its state is
stored in the browser; mobile uses the navigation drawer.

Open http://localhost:3100. Vite proxies `/api` to `127.0.0.1:4100`; set
`AGENTS_API_PROXY_TARGET` to change that server target. The browser receives an
opaque HTTP-only product session, never a service or model credential.

## Product paths

- `/landingv2`: public alternate landing design with an animated blue hero, business-agent laptop artwork, knowledge and tools, human handoff, website preview and personal-agent device artwork. Sign-in and creation actions use existing login/signup routes. Examples are illustrative, do not call models or connect providers, and do not establish availability of personal-agent execution. The route is marked `noindex`; `/` keeps the current homepage.
- `/login`: provider sign-in.
- `/app/overview`: customer conversation activity, current handoffs, enquiries and channel totals for the selected workspace.
- `/app/agents`: searchable agent directory with configuration filters, selected-agent details, chat and configuration links, and guided customer-service setup.
- `/app/agents/:agentId`: agent home with a job-based menu: Overview (conversation metrics, setup progress and recent activity), Conversations, Capabilities, Training data, Behaviour, Chat widget, Deploy and Settings. The workspace assistant is configured here after setup; it is excluded from the agent directory and catalogue and is reached from the floating assistant launcher instead. Assistant replies address the signed-in member by name when their account provides one.
- Agent **Capabilities** shows the four customer responsibilities selected during setup and lets an owner add or remove one. Removing the last capability is blocked. Capability changes update derived tools and setup without replacing instructions the owner has edited.
- Agent **Training data** attaches approved sources, imports documents and imports website content. **Behaviour** holds instructions, model selection, memory, support hours, tools and skills. **Chat widget** holds website installation, widget appearance, allowed origins and pause. **Deploy** holds Facebook, Instagram and WhatsApp channels. **Settings** holds name, avatar and deletion.
- In an agent's Settings, Delete agent stops its deployments and automations and retains conversation history and customer records. Deletion waits for active tasks and message delivery to finish.
- `/app/agents/:agentId/conversations/:conversationId`: authorized conversation history and chat.
- `/app/inbox`: customer conversations, assignment, human replies and handoff.
- `/app/customers`: enquiry and contact records, follow-up and activity.
- `/app/knowledge`: private imports (PDF, HTML, Markdown, text, JSON and CSV), candidate review, revision approval and withdrawal.
- `/app/connections`: connected provider accounts and selected API/MCP tools. Start or manage an agent's customer-channel connection in that agent's Deploy section.
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
pnpm --filter @kasitek/agent-platform exec playwright test --config playwright.activity.config.ts
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

## Alternate landing release

The 29 October 2026 `/landingv2` update implements the owner-approved business-first
blue/Geist design. The hero shows a customer-service laptop; a later section shows
one illustrative personal agent across laptop, tablet and phone. Knowledge, handoff,
permissions and website widget fragments use HTML and Hugeicons. The repeated outcomes
section and category labels are removed. Product examples are illustrations, not
interactive execution or evidence that personal-agent deployment is available.
The personal link opens its availability FAQ. Create actions retain the existing signup
return destination; sign-in uses the existing login route.

Owner: Agents web. Risk: low. Affected surface: the isolated public preview route.
Rollout is direct navigation to `/landingv2`; promoting it to `/` is a separate decision.
The Git commit identifies the source change; production release version and deployment
are not applicable to this local preview. API, schema, migrations, analytics events,
structured logs, worker metrics, dashboards and alerts are not applicable. Authentication,
provider, execution and permission contracts are unchanged. The Growth feature map and
platform architecture are unaffected by this illustrative frontend update.

Device artwork and the studio photo are generated, locally encoded WebP assets; see
[artwork provenance](public/images/landing-v2/ASSETS.md). The 1600px device renders have
800px alternatives; non-hero images load lazily. Fonts and channel logos use existing
local assets. No external image, font, analytics or model request runs in the page.
CSS transforms animate the blue light. Pause/resume controls both backgrounds; invisible
sections and hidden tabs stop their animations. Reduced-motion preference disables motion.

Verify the public route at desktop 1440px, tablet 768px and mobile 390px/360px. Inspect
loaded device artwork and complete-page screenshots, check navigation, FAQ, keyboard focus,
signup destination, pause/resume and reduced motion, then run affected frontend lint/build
and `pnpm verify:boundaries`. Screenshots are local review evidence under
`.audit/landing-v2-blue/`, not shipped assets. Browser acceptance covers the landing page;
model evals and provider acceptance remain with the owner.

Rollback reverts this focused commit, restoring the previous page and assets. No data
rollback is needed. Review before promoting the homepage. Production monitoring and a
post-release review date are not applicable until deployment is authorized.
