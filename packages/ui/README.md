# Shared workspace UI

`@kasitek-labs/ui` owns the common light and charcoal dark theme, appearance definitions and generic React controls used by Growth and Agents. Product navigation, data loading, sessions and business permissions stay in each product.

```tsx
import { Button } from "@kasitek-labs/ui/button";
import { Dialog, DialogContent } from "@kasitek-labs/ui/dialog";
import { ACCENTS, WORKSPACE_PALETTE } from "@kasitek-labs/ui/appearance";
```

Import the theme after Tailwind in the consumer stylesheet:

```css
@import "tailwindcss";
@import "@kasitek-labs/ui/theme.css";
```

The theme explicitly registers this package's source with Tailwind. Consumers also register `packages/ui/src` relative to their stylesheet, so scanning works in workspace and Docker builds. Keep the package source in the frontend build context. The shared CSS does not load Tailwind or product layout styles itself.

Run `pnpm --filter @kasitek-labs/ui build` before a consumer build or typecheck. Growth's and Agents' dev, build and typecheck commands chain this build explicitly. They do not rely on pnpm's optional pre/post script hooks. Root `build:shared` includes this package. JavaScript and declaration exports live in ignored `dist/`; do not commit build output. Rebuild the package after changing a React control or appearance definitions during development.

Controls retain existing props, `asChild`, refs and `data-slot` hooks. Product-local UI modules may re-export these public modules so existing imports keep working. Do not copy shared implementations back into a product or import another product's private UI source.

Theme mode, density and accent definitions are shared. Storage remains browser-origin local; using the same keys does not synchronize preferences across separate production domains. Products retain their own preference lifecycle. A valid saved accent remains explicit; an unset Growth preference uses blue. Agents may normalize its former implicit Indigo default because it has no accent picker. Neither policy changes product authorization.

Shared styles use Geist through each application's existing font loading. Shared controls use the regular Phosphor icons from react-icons. Keep provider logos separate from UI line icons. Public landing pages and embedded website widgets retain their own scoped visual treatment.

For rollback, revert the package and consumer imports together and rebuild each affected frontend artifact. There is no API or database migration. The package is private and is bundled into independently deployed clients.

## Agent conversations

`@kasitek-labs/ui/agent` owns the shared conversation presentation used by product adapters:

- `AgentMessage` and `AgentMessageContent` render user/public assistant messages. Markdown blocks
  reject raw HTML, executable links and remote images. Customer/staff histories use `format="plain"`
  to preserve literal message semantics. Product source policies can supply `resolveLink` and
  citation transforms through `remarkPlugins`.
- `AgentComposer` owns the controlled input, Enter/Shift+Enter and IME behavior, and neutral
  composer layout. Product context and authorized action controls occupy slots; submissions and
  stable request keys remain in the adapter.
- `AgentExecutionView` presents public updates, a revisable Approach, compact tool activity,
  clickable specialists and output. `AgentContextUsage` exposes capacity and optional diagnostics
  separately; context is hidden inside execution views unless `showContext` is requested. Activity
  shows only the generic `Generating response` label for active model work; it never renders model
  request/response details or historical model-call rows. Model counts and timing remain in
  measurements. Supply `errorCode` to render the shared failure label alongside the
  terminal state; explicit provider unavailability stays distinct from an uncertain result.
  Product adapters retain the native operations without their own presentation filter.
  Supply catalogue-backed `label`/`category` and typed `activityKind` for capability discovery or
  schema loading. Consecutive calls in the same task are grouped as an expandable Capability lookup,
  retaining each real call, failure state and measured elapsed span. Public updates, other operations
  and different task identities break a group. Missing duration is omitted. `technicalName` appears
  only inside an explicit Technical details disclosure and is suppressed for restricted/unavailable
  rows. Connection-sourced titles carry a Connected service label; supply `source` from accepted
  catalogue metadata. A technical name must contain only an accepted tool identity, never arguments or response bodies.
- `AgentSubagentModal` uses the same conversation body supplied by its host. The modal owns one
  scrolling area and becomes full screen on mobile. Opening/closing it does not execute commands.
- `AgentConversationScroll` follows new output only while already at the latest content. It offers
  Jump to latest when someone reads earlier content. Give `resetKey`/modal `viewKey` a unique
  product, principal, organization and task identity to preserve the correct reading position.

The shared module has no product APIs, router, sessions or permission logic. Adapters must supply
currently authorized public content, scoped stable identities, explicit lifecycle states and
capability callbacks. Tool detail availability must be explicit; restricted details are never
rendered even if a stale adapter value is present. Use a new scoped component key on account or
organization changes, and clear protected content when access is withdrawn. Review and delivery
actions remain in the owning product's slots.

Do not copy this renderer into a product or create host-specific timeline/modals. Shared changes
require rebuilding and releasing each independently deployed consumer. Run
`pnpm --filter @kasitek-labs/ui test` for safe-rendering, ordering and required-consumer checks.
Growth's focused `playwright.shared-agent-ui.config.ts` suite verifies nested mobile modals,
viewport resize, disclosure Escape behavior and scroll restoration through root completion.
The consuming applications' broader browser suites retain their own admission, authority,
review, delivery and responsive checks.

Execution status includes a compact duration when the product supplies `elapsedMs`, for example `Finished · 2m 34s`. Subagent modal headers use the same formatter. Duration covers acceptance through the recorded outcome, including queue/waiting and specialist work; it is separate from model latency. Missing or invalid timing is omitted. Active durations advance locally between authoritative observations; terminal observations freeze the value. Supply `observedAt` with `elapsedMs` and a scoped execution identity. A new task or observation resets the local clock without inventing a starting value.

`agentRuntimePresentation` maps the safe runtime scalar envelope to the shared context/diagnostic
fields used by Growth, standalone and Agency. Model latency, observed/accounted usage, compaction
state and input/output reserves keep the same labels. Missing measurements stay unavailable.
Optional `workElapsedMs` measures original-request acceptance through this task's current/final
endpoint and appears separately when it differs from the task's own elapsed time.

Specialist modals share their styling from `agent.css`, imported by `theme.css` or the host stylesheet and scoped to `data-agent-subagent-modal`. Pass the current authorized task input as `assignment`; it appears as an expandable assignment above the transcript. Do not also render that input as a duplicate user message. Clear it when evidence access is withdrawn. The header, response typography, activity grouping and active-state footer adapt to the shared light/dark theme and mobile full-screen layout.

`@kasitek-labs/ui/agent-memory` exports `AgentMemoryPanel`. The host supplies a product/actor/client
`scopeKey`, current selection, and authorized load/mutation callbacks. The panel supports suggested
memory review, exact acceptance, correction, Forget confirmation, pagination and optional selection
toggle. The visible panel rechecks its displayed pages every five seconds and when the tab becomes
visible. A failed read clears cached memory and the open review; a changed or withdrawn record
closes its stale review. Fresh authorized reads can restore the list. Pending mutations pause this
refresh; a failed mutation rechecks the record before leaving an unchanged authorized edit open.
Stable request keys survive such retries. A scope change clears protected state and fences old
responses. The component never accepts a suggestion
autonomously, installs a capability, chooses a memory namespace or claims provider unlearning.

`@kasitek-labs/ui/agent-model-picker` supplies the shared responsive model-selection trigger and dialog. Product adapters own authorized catalogue loading, saved selection, request identity, revisions and scope changes. The renderer accepts disabled options/reasons and a footer slot for product-specific configuration links or notices.
