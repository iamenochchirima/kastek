# Vantage Appearance and Settings Plan

**Status:** Implementation pass; public runtime smoke verified; authenticated runtime pending  
**Owner:** KasiTek team  
**Last updated:** 2026-08-21  
**Parent plan:** [`VANTAGE_UI_MIGRATION_PLAN.md`](VANTAGE_UI_MIGRATION_PLAN.md)

## Objective

Deliver the Vantage Settings experience in the KasiTek client, with a scalable
appearance-preference system that changes the entire application immediately.
The initial release must faithfully implement the Vantage reference's theme,
accent, density, and interface preferences while retaining the real KasiTek
workspace settings and existing product behavior.

Success means a user can change an appearance preference in Settings and see it
consistently reflected in the application shell, shared primitives, and all
migrated routes without a reload or a route-specific implementation.

## Scope

### Included

- `client/apps/client` appearance infrastructure and root bootstrap behavior.
- Vantage-faithful Light, Dark, and System theme selection.
- Vantage accent presets: Indigo, Violet, Cyan, Emerald, and Rose.
- Vantage Comfortable and Compact density behavior.
- Vantage interface preferences: reduce motion, live indicators, and Monday
  as the first day of the week.
- A Vantage-style Settings composition at `/workspace/settings`, including
  responsive desktop and mobile navigation.
- Migration of the existing real workspace identity form into Settings >
  General, without changing its API, authorization, or data model.
- Appearance, shell, primitive, and route audit needed to make the preferences
  genuinely application-wide.
- Targeted verification and reconciliation into the parent migration plan after
  this plan is complete.
- Responsive and motion foundations, followed by a route-by-route migration of
  every KasiTek client surface against the Vantage reference.

### Excluded

- Backend- or account-synchronised appearance preferences in this wave.
- Restyling or modifying `admin`, `labs`, or `tenant-portal`.
- New visual customizations not in the Vantage reference, including a glass
  sidebar. These may be proposed after the foundation is verified.
- Replacing existing API-key, billing, notification, profile, or workspace
  behavior merely to fit a visual layout.

## Reference and current implementation

### Vantage source of truth

The reference behavior is implemented in:

- `dashboard-new/src/components/settings/AppearancePanel.tsx`
- `dashboard-new/src/components/settings/prefs.ts`
- `dashboard-new/src/hooks/useTheme.tsx`
- `dashboard-new/src/pages/Settings.tsx`
- `dashboard-new/src/index.css`

The reference Settings layout is a desktop vertical navigation and mobile
horizontal scrolling navigation. Its Appearance panel contains three theme
mode cards, five accent presets, a density toggle, and the three interface
switches listed in scope.

### Existing KasiTek behavior to preserve

- `client/apps/client/src/lib/theme.ts` currently resolves and persists a
  Light/Dark preference, applies it to the document root, and provides a
  subscription API.
- `client/apps/client/src/components/theme-script.tsx` applies the stored
  theme before hydration and must continue to prevent a visible theme flash.
- `client/apps/client/src/app/globals.css` already contains the Vantage
  semantic light/dark token layer, Tailwind 4 mappings, and sidebar tokens.
- `/workspace/settings` currently owns a real organisation name/logo form and
  role-based permission behavior. These must remain intact in General.
- The dashboard shell, command palette, theme toggle, and Sonner currently
  read the existing theme bridge and must be migrated to the unified one rather
  than duplicated.

## Decisions

| Topic | Decision | Status |
| --- | --- | --- |
| Fidelity | Match the Vantage settings composition and rendered preference behavior before adding KasiTek-only controls. | Decided |
| Preference scope | Initial appearance preferences are browser-local and personal, matching the Vantage reference. They are not organisation settings. | Decided |
| Persistence boundary | Keep persistence behind the central appearance store so an explicit future server-sync decision can add an adapter without changing consumers. | Decided |
| Root application | Resolve preferences once at `<html>` before hydration, then update the same root state at runtime. | Decided |
| Token consumption | Pages and primitives consume semantic tokens only; they must not branch on theme, accent, or density themselves. | Decided |
| Settings route | Retain `/workspace/settings` and its real General behavior; replace its layout with the Vantage Settings composition. | Decided |
| Existing settings panels | Keep Notifications, API Keys, and Billing on their existing functional routes for this wave; expose them from the Vantage Settings navigation until their panels are migrated deliberately. | Decided |
| Future customizations | Add a customisation only through a typed preference, root application rule, semantic-token contract, Settings control, and verification case. | Decided |
| Glass sidebar | Defer until after this plan. It is a KasiTek-specific extension, not a Vantage behavior. | Deferred |
| Reference implementation | Vantage is the canonical source for responsive measurements, breakpoints, motion timing, easing, and interaction patterns. Copy its implementation pattern first; document a KasiTek adaptation before diverging. | Decided |
| Responsive completion | A route is not complete merely because desktop looks correct. It must pass its documented mobile, tablet, and desktop treatment, including interactive and non-happy-path states. | Decided |
| Motion completion | Motion is a shared system, not a page-by-page decoration. It uses the Vantage timings and easings, is opt-in by interaction type, and is disabled by the existing Reduce motion preference and OS setting. | Decided |

## Appearance contract

```ts
type AppearancePreferences = {
  theme: "light" | "dark" | "system";
  accent: "indigo" | "violet" | "cyan" | "emerald" | "rose";
  density: "comfortable" | "compact";
  interface: {
    reduceMotion: boolean;
    liveIndicators: boolean;
    weekStartsMonday: boolean;
  };
};
```

The engine owns defaults, storage validation, subscription, preference updates,
OS-theme observation, and document-root application. Root state must include
the resolved theme and stable hooks for preference CSS, for example
`data-theme`, `data-density`, and interface classes or data attributes. Accent
selection must update the light/dark accent token triple: base, strong, and
soft. Its rendered values must match the Vantage presets.

## Implementation checklist

### 1. Foundation and bootstrap

- [x] Read and record the exact Vantage theme, accent, density, motion, and
  Settings interaction behavior before modifying KasiTek code.
- [x] Define the typed appearance preference model, defaults, validation, and
  local-storage keys in one client module.
- [x] Consolidate the current theme API into the appearance engine without
  breaking existing shell, command palette, toggle, or Sonner consumers.
- [x] Support `system` mode and update the resolved theme when the operating
  system preference changes.
- [x] Extend the root pre-hydration script to apply theme, accent, density, and
  interface state before the first paint.
- [x] Keep root updates accessible to React through one external-store
  subscription API; do not introduce route-level preference stores.
- [x] Define invalid, missing, and older storage-value fallback behavior.

### 2. Token and primitive adoption

- [x] Map each Vantage accent preset to exact light/dark base, strong, and soft
  token values.
- [x] Ensure accent selection changes semantic brand, primary, focus, selected
  navigation, sidebar, toast, and applicable chart tokens consistently.
- [x] Define Comfortable and Compact density variables for shared card padding,
  table row/cell sizing, controls, list spacing, and shell density where the
  Vantage contract requires it.
- [x] Update shared primitives to consume density variables instead of keeping
  conflicting hard-coded dimensions.
- [x] Implement global reduced-motion behavior, while also respecting the OS
  reduced-motion preference.
- [x] Implement live-indicator visibility through the shared live-dot pattern;
  do not hide arbitrary status information.
- [x] Ensure calendar and weekly-report consumers read the Monday preference
  through the central engine.
- [x] Audit and replace styling that prevents a semantic preference from
  reaching a shared surface.

### 3. Settings composition and real panels

- [x] Rebuild `/workspace/settings` around the Vantage Settings header and
  responsive section navigation: vertical desktop navigation and horizontal
  mobile navigation.
- [x] Preserve the existing organisation form, API call, permissions, inline
  error handling, and toast feedback in Settings > General.
- [x] Port the Vantage Appearance panel exactly: preview cards, selected-state
  behavior, accent picker, density sample, and interface switches.
- [x] Wire every Appearance control to the central engine so it applies live
  and persists automatically.
- [x] Decide and record how existing real Notifications, API Keys, and Billing
  surfaces enter the Settings composition before implementing those sections.
- [x] Keep settings navigation accessible: semantic navigation, active state,
  keyboard operation, focus-visible treatment, and intentional mobile scroll
  behavior.

### 4. Responsive and motion foundation

The Vantage shell establishes the non-negotiable behavior to port before
individual feature pages are adjusted. The implementation must reuse the same
values and interaction patterns, translated into the existing Next.js shared
primitives rather than re-created as ad-hoc page CSS.

#### Responsive contract

- **Mobile: below `768px`.** Use the Vantage overlay drawer, not a squeezed
  desktop sidebar. The top bar keeps the menu, current page context, search
  affordance, notifications, theme access, and account access through an
  intentional compact arrangement. Controls are at least `36px`; page actions
  stack, collapse into a menu, or become a clearly labelled mobile action.
- **Tablet: `768px`–`1279px`.** Use the Vantage `68px` icon rail and full
  top bar. Preserve content space by reducing grid columns and secondary
  detail before hiding primary data or allowing accidental overflow.
- **Desktop: `1280px` and above.** Use the persisted Vantage `264px` expanded
  sidebar or `68px` collapsed rail, full top bar, and documented page density.
- **Dense content.** Tables, calendar grids, inbox panes, filters, charts,
  editors, and multi-action toolbars require an explicit mobile treatment per
  surface: responsive cards, a selected subset of columns, a documented
  scroll region, or a drill-in view. Never rely on viewport clipping.
- **Overlays.** Drawers, dialogs, menus, command palette, product tour, and
  KasiAi must have defined width, placement, focus, scroll-lock, and stacking
  behavior at all three breakpoints.

#### Motion contract

- Define central motion tokens from Vantage: `150ms` control feedback,
  `220ms` token/theme transitions, `250ms` shell/page transitions, standard
  `ease`, Vantage page easing `[0.16, 1, 0.3, 1]`, and the sidebar/drawer
  spring (`stiffness: 300`, `damping: 30`). Do not introduce arbitrary values.
- Port the Vantage shell effects: sidebar-width transition, animated selected
  navigation state, mobile backdrop and drawer entrance/exit, and a restrained
  route-content entrance.
- Port shared interaction effects where they communicate state: segmented
  control selection, theme icon swap, menu/list entrance, skeleton shimmer,
  live pulse, and selected-card feedback.
- Use Framer Motion only through shared variants/helpers for presence, layout,
  and transform animation. Use the token layer for ordinary colour/border
  transitions. Do not animate large data tables, continuous layout changes,
  or arbitrary page content solely for decoration.
- Every new effect must respect both `html.v-reduce-motion` and
  `prefers-reduced-motion`; reduced motion preserves state changes without
  transform, entrance, or looping animation.

#### Foundation checklist

- [x] Extract the exact Vantage shell breakpoints, widths, top-bar controls,
  content padding/limits, overlay behavior, durations, easings, and spring
  values into a KasiTek responsive-and-motion contract module/CSS token layer.
- [x] Rebuild the shared dashboard shell from the Vantage `Layout`, `Navbar`,
  and `Topbar` patterns while retaining KasiTek's real navigation, workspace,
  notifications, command palette, PWA, product-tour, and KasiAi behavior.
- [x] Add the Vantage mobile top-bar pattern: menu, page context, mobile
  search action, real notification access, theme access, and account access.
- [x] Add the Vantage sidebar width and selected-navigation transitions,
  including its mobile backdrop/drawer motion and accessible close behavior.
- [x] Add one client-safe route-content transition boundary that preserves
  navigation, focus, scroll, loading, and reduced-motion behavior.
- [x] Create shared motion variants for drawer, backdrop, page entrance,
  list entrance, menu content, and selected controls; remove one-off variants
  when each consumer is migrated.
- [x] Reuse Vantage shimmer/live-pulse/selection patterns through shared
  primitives, then remove conflicting legacy animation definitions.
- [ ] Verify the foundation with keyboard navigation, Escape, focus return,
  touch scrolling, light/dark themes, all accents, both densities, and reduced
  motion before migrating product routes.

### 5. Route-by-route responsive and motion migration

Do not batch-copy visual classes across the application. For each route,
compare the Vantage pattern at the same breakpoint, migrate it through shared
primitives, and record its mobile treatment before marking it complete.

- [ ] Create a route checklist covering Dashboard Overview, Inbox, Calls,
  Contacts, Bookings, Calendar, Analytics, Posts, Campaigns, Templates,
  Agents, Connections, Developers, Billing, Workspace settings/profile/team,
  and every auth/onboarding entry route.
- [ ] For every route, classify each grid, table, pane, filter bar, chart,
  editor, form, dialog, and destructive flow at mobile, tablet, and desktop;
  implement the matching Vantage pattern or record a deliberate KasiTek
  adaptation.
- [ ] Migrate the highest-risk dense surfaces first: Inbox, Calendar,
  Analytics, contacts/tables, campaign creation, agent builders, and
  developer/API pages.
- [ ] Apply shared Vantage motion patterns only after the route's responsive
  layout and interaction are correct; no route may add custom animation values.
- [ ] Recheck all appearance preferences on each migrated route so theme,
  accent, density, live indicators, Monday-first calendar behavior, and
  reduced motion remain global rather than route-specific.

#### Route audit ledger

Each row stays pending until the route has been reviewed at `360px`, `768px`,
`1024px`, and `1440px` (plus any breakpoint where its layout changes), with
its loading, empty, error, disabled, permission, destructive, overlay, and
reduced-motion states checked where applicable.

| Product area | Routes / surfaces | Status |
| --- | --- | --- |
| Workspace | Overview, profile, settings, team, notifications | Implementation pass; runtime pending |
| Customer | Inbox, Calls, Contacts list/detail, Bookings | Implementation pass; runtime pending |
| Content | Posts, post detail, Calendar, Analytics | Implementation pass; runtime pending |
| Campaigns | Campaign list, create, detail, WhatsApp templates | Implementation pass; runtime pending |
| Automation | Agents list/detail/create, workflow, activity, run detail, analytics, templates, Website Chat appearance | Implementation pass; runtime pending |
| Connections | Connections list, WhatsApp setup/maintenance, provider dialogs | Implementation pass; runtime pending |
| Developers | Portal, Resources, MCP, CLI, API reference, API keys | Implementation pass; runtime pending |
| Billing | Billing and usage, checkout/subscription states | Implementation pass; runtime pending |
| Entry flows | Login, sign-up, password setup, onboarding, invitation activation, email verification, offline | Auth shell/onboarding pass; runtime pending |
| Shared surfaces | Page headers, cards, tables, tabs, forms, menus, sheets, dialogs, toasts, skeletons, command palette, product tour, KasiAi | Implementation pass; runtime pending |

### 6. Application-wide verification and cleanup

- [ ] Verify the dashboard shell: expanded sidebar, tablet icon rail, mobile
  drawer, top bar, command palette, and global overlays.
- [ ] Verify the copied Vantage responsive contract at `360px`, `768px`,
  `1024px`, and `1440px`; check an intermediate width when a component changes
  layout between those points.
- [ ] Verify each route's normal, loading, empty, error, disabled, permission,
  destructive, and overlay states at the breakpoints that apply to it.
- [ ] Verify every shared motion pattern with normal motion, Appearance >
  Reduce motion, and OS reduced-motion settings; no essential feedback may be
  animation-only.
- [ ] Verify shared primitives: buttons, inputs, cards, tables, tabs, menus,
  sheets, dialogs, confirmations, skeletons, and toasts.
- [ ] Verify representative data visualisation, loading, empty, disabled, and
  error surfaces in every preference state where applicable.
- [ ] Remove obsolete theme helpers, duplicate storage keys, and transitional
  styling only after their replacement is verified.

## Verification matrix

- [ ] Direct-load an arbitrary dashboard route with each stored theme, accent,
  density, and interface setting; no incorrect first paint is visible.
- [ ] Change Light, Dark, and System modes while the app is open; System tracks
  an operating-system preference change.
- [ ] Check every accent in light and dark themes for buttons, focus rings,
  selected navigation, charts, toasts, and contrast.
- [ ] Check Comfortable and Compact at mobile, tablet, and desktop widths;
  confirm card padding and table-row density match the Vantage contract.
- [ ] Check reduce-motion and live-indicator settings against both motion and
  non-motion interface states.
- [ ] Check Monday-first behavior in affected calendar/weekly-report flows.
- [ ] Capture comparable Vantage/KasiTek desktop and mobile evidence for each
  migrated shell or route pattern before considering it complete.
- [ ] Check Settings desktop and mobile navigation, keyboard focus, and all
  real General form success/error/permission states.
- [x] Run client lint, relevant targeted tests, production build, and available
  visual/runtime checks.

Public runtime evidence (2026-08-21): production `/login` rendered at 360px,
768px, 1024px, and 1440px; protected `/workspace` redirected to `/login`; a
production 404 rendered the Vantage not-found surface. Authenticated dashboard
interaction, preference switching, and overlay/focus QA still require a real
session.

## Completion and parent-plan reconciliation

Do not update the parent migration plan while this plan is in progress. When
all implementation and verification items above are complete:

1. Mark this plan Complete and add concrete verification evidence.
2. Update the parent plan's Theme contract, Shared UI primitives, Application
   shell, Workspace route matrix entry, and verification matrix only for work
   actually completed here.
3. Add an entry to the parent plan change log linking this plan and recording
   the completion date.
4. Leave unfinished extensions, including glass sidebar and server-synced
   preferences, explicitly pending rather than implying they were delivered.

## Implementation notes

- The appearance engine and root bootstrap are implemented in
  `client/apps/client/src/lib/appearance.ts` and
  `client/apps/client/src/components/theme-script.tsx`.
- The appearance hook now uses `useSyncExternalStore` with the server
  snapshot, so stored preferences (including Reduce motion) are available to
  client consumers on their first render without introducing a hydration-time
  animation mismatch.
- Existing theme consumers continue to use the compatibility surface in
  `client/apps/client/src/lib/theme.ts`.
- Shared cards, table cells, default controls, calendar week ordering, and a
  realtime online indicator now consume the appearance state where applicable.
- The responsive/motion foundation now lives in
  `client/apps/client/src/lib/motion.ts`, the global `--v-motion-*` tokens,
  and the shared dashboard shell. The mobile top bar follows the Vantage
  pattern, the sidebar uses the reference width/selected-state transitions,
  route content has a shared entrance boundary, and Settings uses the
  reference motion variants under `MotionConfig`. The shell now provides one
  reduced-motion-aware `MotionConfig` boundary, shared selected-navigation
  and theme-icon transitions, staggered navigation entrance, and the
  150/220/250/400ms timing contract.
- The Overview route is the first product-route pass: attention rows and
  operational cards use the shared Vantage entrance/card treatment and mobile
  hit-area/truncation rules. Inbox's full-height mobile workspace now accounts
  for the 64px Vantage top bar and its primary mobile controls use the shared
  touch target contract. Calendar keeps its deliberate mobile day-list
  treatment rather than squeezing the desktop grid. Analytics, Calls,
  Contacts, Bookings, Agents, and Campaigns now use the shared card entrance
  treatment on their primary summary surfaces; Analytics and Campaigns also
  stack dense rows/cards intentionally on mobile. Connections now applies the
  same treatment to provider and connected-account cards. Runtime breakpoint
  evidence is still pending. The Agent workflow editor keeps its canvas as an
  explicit touch-scroll/zoom region and now uses the shared entrance boundary;
  it is not forced into an unreadable narrow graph. The developer portal now
  uses a horizontally scrollable mobile section rail, a desktop side rail,
  shared route-card entrances, and Vantage selected-state motion. Billing
  sections, auth cards, and onboarding step transitions also use the shared
  reduced-motion-aware boundary. Invitation activation and the offline screen
  now use the same mobile viewport and entrance treatment. Runtime breakpoint
  evidence is still pending for these surfaces.
- Client lint, TypeScript, canonical-route checks, `git diff --check`, and the
  Webpack production build pass. The default Turbopack build remains blocked in
  the current sandbox by its worker port-binding restriction.
- Shared overlay z-index layers are now named in the semantic token layer and
  consumed by dialogs, sheets, menus, selects, tooltips, toast notifications,
  and shell top bars. Dialog and alert-dialog content preserve a scrollable
  viewport on small screens.
- Developer API keys now use an intentional stacked-card treatment below the
  `768px` shell breakpoint instead of forcing a dense table into a narrow
  viewport. The shell also exposes active notification state and accessible
  labels for collapsed Help and Notifications controls. Lint, TypeScript,
  route checks, Webpack build, and public runtime smoke pass; authenticated
  preference and overlay QA remains pending.
- Social Posts table mode now follows the same rule: phones receive a compact
  tappable list with status, publication, and channel metadata while the full
  table remains a tablet/desktop treatment.
- Settings tab transitions, Developers navigation selection, and Appearance
  accent/selection feedback now consume the shared Vantage motion contract;
  route-level timing literals were removed. Lint, TypeScript, route checks,
  and the Webpack build pass.
- The root pre-hydration script now consumes the server-safe
  `appearance-contract.ts` values for accents and storage keys, keeping first
  paint and runtime application on one source of truth without importing the
  client appearance store into the server layout.
- Large Contacts, WhatsApp template, and Inbox media overlays now use
  small-viewport-safe `svh` sizing so mobile browser chrome cannot hide their
  actions or previews. Their existing scroll and max-width treatments remain
  unchanged; lint, TypeScript, and the Webpack build pass.
- Shared Dialog, AlertDialog, Sheet, shell-sidebar, and Product Tour transitions
  now read the semantic `--v-motion-fast`/`--v-motion-shell` tokens instead of
  embedding duplicate durations.
- Agent knowledge-source editing now uses `svh` sizing, and the embedded test
  chat lowers its minimum height on phones while retaining the desktop height
  from the `sm` breakpoint upward.
- Product Tour now focuses its dialog when opened or advanced, restores the
  invoking control when dismissed, and uses the shared shell motion duration.
  Escape dismissal remains available.
- KasiAi now follows the same focus lifecycle: its panel receives focus on
  open and focus returns to the trigger when the panel closes. The existing
  nested model picker and resize interactions remain unchanged.
- KasiAi settings now use a horizontal navigation rail below 480px and stack
  WhatsApp pairing controls on phone widths; desktop retains the Vantage side
  rail. The selected settings section exposes semantic active state.
- The route implementation pass now covers the remaining workspace, customer,
  content, campaign, automation, and connection surfaces with `100dvh` roots,
  Vantage entrance treatment, mobile stacking/overflow rules, and
  most-specific nested-route navigation state. Runtime breakpoint evidence
  remains intentionally pending.
