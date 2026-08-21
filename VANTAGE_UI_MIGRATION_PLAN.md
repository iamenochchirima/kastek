# Vantage UI Migration Plan

**Status:** Active

**Owner:** KasiTek team

**Last updated:** 2026-08-21

## Objective

Replace the current KasiTek client visual system with a consistent Vantage-inspired
system, while preserving all existing product behavior, routes, data flows,
authentication, and accessibility.

Success means that every client surface uses the same semantic design tokens,
shared UI primitives, and responsive patterns in both light and dark themes.

## Scope

### Included

- `client/apps/client` only; it remains a Next.js application.
- Light and dark themes, including persisted user preference and system fallback.
- Shared UI primitives, application shell, dashboard routes, auth/onboarding
  routes, and global/edge UI states.
- Information architecture, content hierarchy, and interaction patterns where
  the existing structure does not support the user's primary task clearly.
- Responsive desktop and mobile behavior, keyboard focus, loading, empty, error,
  disabled, and destructive states.
- Visual QA and regression checks for every migrated surface.

### Excluded

- Migrating the client application from Next.js to Vite.
- Reworking product behavior, API contracts, authentication, or data models unless
  a UI defect requires a narrowly scoped fix.
- Restyling the separate `admin`, `labs`, or `tenant-portal` applications.

## Design-system rules

1. Pages use semantic tokens and shared primitives; they do not introduce their
   own colors, spacing scales, radii, shadows, or button treatments.
2. The token system is the source of truth. Product-specific visual data, such
   as charts or channel colours, is documented as an explicit exception.
3. Components expose intentional variants and sizes. Callers do not override a
   primitive into a new visual component with ad hoc utility classes.
4. Every reusable component is designed and checked in both themes before it is
   adopted by feature pages.
5. Existing functionality is retained while appearance is changed. Functional
   changes require an explicit decision in this document.
6. Every UI element has intentional desktop, tablet, and mobile behavior and
   density. A component that only works at one viewport is incomplete.
7. A completed migration wave replaces its old visual implementation. Do not
   leave parallel old/new component paths, legacy styling fallbacks, unused
   tokens, compatibility aliases, or dead UI code behind.

## Vantage fidelity contract

`/home/enoch/aworkspace/kasitek-labs/dashboard-new` is the visual source of
truth for this migration. It is not an inspiration board.

- [x] Port Vantage token values exactly from its `src/index.css` and
  `tailwind.config.js`: light/dark colours, surfaces, borders, text tiers,
  brand/status/chart colours, shadows, radius, typography, focus treatment,
  motion, and responsive dimensions.
- [ ] Port component measurements and behavior exactly where applicable from
  the reference shell and UI primitives: sidebar widths, top-bar height,
  content limits, control heights, padding, gaps, icon sizes, states, and
  breakpoints.
- [ ] Translate the reference implementation into KasiTek's Next.js and
  Tailwind 4 architecture without changing the rendered design values.
- [ ] Do not introduce approximate colours, spacing, typography, radii, shadows,
  variants, or interaction treatments.
- [ ] Record every required KasiTek-specific adaptation in the Decisions and
  open questions table before implementing it. Accepted adaptations must be
  behavior- or product-specific, never a styling shortcut.
- [ ] Compare each shared primitive and shell surface with the reference in the
  same theme and viewport before marking it verified.

Vantage specifies Inter as its primary UI font. KasiTek will retain Geist as an
approved product-specific typography adaptation. The migration must still port
the Vantage type scale, weights, line heights, tracking, hierarchy, and density
exactly; Geist must not be made heavier or looser as a substitute for those
decisions.

## Required design review

Before migrating a page, shared pattern, or meaningful interaction, answer the
following questions and record any material decision in the migration matrix or
decision log:

1. What is the user's primary task on this surface?
2. What must be visible immediately, and what can be progressively disclosed?
3. Which actions are primary, contextual, or secondary?
4. Does each action belong in the page, a side panel, an overflow menu, or a
   focused dialog?
5. Does the information hierarchy make the next action obvious without
   explanatory UI copy?
6. How does the same task work at desktop, tablet, and mobile widths?
7. Does the pattern already exist in the shared component system? If not, should
   it become a shared pattern rather than a one-off implementation?
8. Which loading, empty, error, permission, and destructive states apply?
9. Does the result preserve the existing product behavior, or does it require an
   explicit functional decision?

Do not treat the existing layout as fixed. Preserve product behavior by default,
but redesign hierarchy, grouping, disclosure, and interaction placement when
that produces a clearer and more scalable interface.

## Theme contract

The theme system must meet all of the following conditions:

- [ ] Semantic tokens cover canvas, surfaces, borders, text tiers, brand,
  statuses, chart colours, focus, overlays, radius, shadows, and motion.
- [ ] Light and dark token values are designed as complete systems, rather than
  light colours mechanically inverted for dark mode.
- [ ] Existing stored theme preference, `ThemeScript`, and `ThemeScope` behavior
  remain compatible and do not produce a visible theme flash on load.
- [ ] Interactive states (hover, active, focus-visible, disabled, selected, and
  invalid) are defined for both themes.
- [ ] Text, icons, controls, and status treatments meet accessible contrast in
  both themes.
- [ ] Toast surfaces, icons, actions, and progress/loading states use semantic
  tokens and remain legible in both themes.
- [ ] Every primitive and migrated route receives a light and dark visual check.

## Responsive and density contract

The following rules apply to every shared primitive, page pattern, and route:

- **Mobile:** below `768px` — navigation is an overlay drawer; controls stack or
  move into menus; touch targets stay at least `36px`.
- **Tablet:** `768px` through `1279px` — sidebar becomes the `68px` icon rail;
  the full Vantage top bar remains visible; dense layouts reduce columns or
  horizontally scroll only when that is the documented treatment.
- **Desktop:** `1280px` and above — sidebar honours its persisted `264px` /
  `68px` expanded/collapsed state and page layouts use their documented full
  density.

- [ ] Approved desktop, tablet, and mobile breakpoints are defined before
  migration work begins.
- [ ] Layout, spacing, type scale, wrapping, and hit areas are intentional at
  every supported breakpoint.
- [ ] Controls intentionally remain visible, collapse, scroll, stack, move into
  a menu, or use a mobile-specific affordance; none are left to overflow by
  accident.
- [ ] Tables and other dense data layouts have an explicit small-screen
  treatment.
- [ ] The application shell, navigation, panels, dialogs, menus, and overlays
  work together at desktop, tablet, and mobile widths.
- [ ] Each component is reviewed at the full set of approved breakpoints before
  it is marked verified.

## Cross-cutting UI contracts

### Accessibility

- [ ] Define semantic HTML, keyboard interaction, focus order, accessible names,
  contrast, and reduced-motion requirements for shared primitives.
- [ ] Verify these requirements for each migration wave, not only at the end.

### Data visualization

- [ ] Define chart colours, legends, tooltips, loading/empty states, and
  colour-blind-safe status and chart combinations.

### Motion

- [ ] Define permitted motion, duration, and easing tokens.
- [ ] Ensure motion never blocks work and respects reduced-motion preferences.

### Overlays and layering

- [ ] Define central z-index layers for the sticky top bar, menus, tooltips,
  sheets, dialogs, toasts, product tour, and KasiAi.
- [ ] Verify that overlays do not obscure or trap one another incorrectly.

### Error, offline, and interrupted states

- [ ] Add Vantage-styled route error, not-found, offline, and recoverable
  background-action states where applicable.

### Performance

- [ ] Define a performance baseline for representative dashboard routes before
  migration.
- [ ] Do not increase critical route load, interaction, or rendering cost without
  a documented reason and mitigation.

### Component catalogue and regression checks

- [ ] Decide and implement a component preview and visual-regression approach
  for shared primitives, themes, and responsive states.

### Command palette

- [ ] Define the first release as real route navigation and global actions;
  defer product-data search until its API and interaction scope are agreed.

## Implementation checklist

### 1. Foundation and governance

- [x] Record the approved Vantage visual decisions: token names, colour values,
  type scale, spacing scale, radius, shadows, density, and motion.
- [x] Extract and record exact Vantage values from the reference source before
  translating the token layer to Tailwind 4.
- [ ] Apply the Required design review to every migration wave; redesign
  information hierarchy and interaction placement where needed.
- [x] Implement the semantic token layer in `client/apps/client/src/app/globals.css`
  for Tailwind 4.
- [ ] Replace temporary compatibility aliases in a controlled way and remove
  them when no longer needed.
- [ ] Remove superseded styles, components, imports, dependencies, and obsolete
  code paths as each migration wave completes; do not defer this cleanup to an
  unspecified later pass.
- [ ] Define a no-new-hard-coded-styles review rule and document allowed
  exceptions.
- [ ] Add a route and shared-surface migration matrix with status tracking.

### 2. Shared UI primitives

- [ ] Button and button variants.
  - [x] Ported from the reference implementation.
- [ ] Inputs, textareas, selects, checkboxes, and field feedback.
  - [x] Input, textarea, checkbox, and select ported from the reference implementation.
- [ ] Cards, surfaces, dividers, badges, status indicators, and progress.
  - [x] Card, badge, skeleton, and progress ported from the reference implementation.
- [ ] Tables, tabs, scroll areas, skeletons, and empty states.
  - [x] Table, tabs, scroll area, and skeleton ported from the reference implementation.
- [ ] Dropdown menus, tooltips, sheets, dialogs, and popovers.
  - [x] Sheet, dialog, and destructive confirmation dialog ported from the reference implementation.
  - [x] Replaced all `window.confirm()` and `window.prompt()` calls in the client source with the shared confirmation/input-dialog provider.
- [ ] A single application-wide toast provider and toast API for success, error,
  warning, information, loading, and optional action/undo feedback.
  - [x] Mounted one Vantage-styled Sonner provider at the application root; feature migrations must now replace browser-native feedback with its shared API.
- [ ] Shared page header, toolbar/filter, confirmation, and feedback patterns.
  - [x] Added the Vantage page-header pattern from the reference reports surface; it is now adopted by Templates.
- [ ] Document each primitive's variants, states, and intended use.

### 3. Application shell

- [ ] Desktop sidebar, grouped navigation, selected states, collapse behaviour,
  organisation switcher, and account controls.
- [ ] Desktop top bar and responsive mobile header/drawer.
  - [x] Add a sticky desktop top bar with route-aware breadcrumbs, a functional
    command/search entry point with `Ctrl+K` / `⌘K`, notifications, theme
    control, and a compact account menu.
  - [ ] Keep workspace context and primary navigation in the sidebar; use the
    top bar for page context and global actions so controls are not duplicated.
  - [ ] Do not add non-functional decoration such as a live clock. Every top-bar
    control must support a real KasiTek workflow.
- [ ] Notifications, PWA update message, product tour, KasiAi trigger/chat, and
  other global overlays.
- [ ] Verify shell behavior in light/dark and collapsed/mobile forms.

### 4. Product-area migration

- [ ] Workspace: overview, profile, team, settings, and notifications.
- [ ] Customer: inbox, calls, contacts, and bookings.
- [ ] Content: posts, calendar, analytics, history, and post detail.
- [ ] Campaigns: list, create, detail, templates, and related loading states.
- [ ] Agents: list, create, detail, workflow, appearance, connect, templates,
  activity, analytics, and loading states.
- [ ] Connections and WhatsApp onboarding.
- [ ] Developers: overview, API, API keys, CLI, MCP, and resources.
- [ ] Billing, generic dashboard loading, and all nested detail/create states.

### 5. Entry and edge surfaces

- [ ] Login, sign-up, set password, verification, and authentication errors.
- [ ] Onboarding and invitation acceptance.
- [ ] Offline page, PWA states, and no-data/error fallbacks.

### 6. Completion and verification

- [ ] All matrix entries are marked verified; no client route is left on the old
  visual system.
- [ ] Light and dark screenshots/reviews completed for desktop and mobile
  breakpoints.
- [ ] Keyboard navigation, focus visibility, and reduced-motion behavior checked.
- [ ] Relevant lint, type, build, and targeted runtime checks pass.
- [ ] Obsolete tokens, compatibility aliases, and duplicate styling are removed.

## Route and shared-surface matrix

Use this matrix as the source of completion status. A surface only moves to
**Verified** after its responsive, light/dark, loading, empty, error, and
interactive states have been checked where applicable.

| Area | Surface group | Status | Evidence / notes |
| --- | --- | --- | --- |
| Foundation | tokens and global styles | Implemented | Exact Vantage light/dark tokens, radius scale, shadows, base density, focus, transitions, scrollbars, and Tailwind 4 mappings are in `globals.css`. Obsolete `theme-*` compatibility aliases have been removed; lint and Webpack build passed. Visual QA follows primitive work. |
| Foundation | shared UI primitives | In progress | Button, card, input, badge, checkbox, progress, skeleton, table, tabs, scroll area, sheet, dialog, destructive confirmation dialog, and global Sonner toaster are centralized. All native browser confirm/prompt calls have been replaced by the shared provider. Reference styles and Radix behavior are used where the reference does. Lint and Webpack build passed; remaining form/overlay primitives and visual QA are pending. |
| Shell | sidebar, top bar, mobile drawer, global overlays | In progress | Desktop top bar and command palette now use the reference layout and interactions: route-aware breadcrumbs, Ctrl+K / ⌘K navigation, theme action, notifications route, and account menu. Shell breakpoints now follow the reference: mobile drawer below 768px, forced 68px tablet rail through 1279px, and persisted 264px/68px desktop sidebar state. Visual QA remains pending because no browser is available in this environment. |
| Workspace | Overview, profile, settings, team, notifications | In progress | Workspace routes now use the central Vantage header and `1440px` content limit. Profile, Settings, and Team use shared controls and toast feedback; Team destructive actions require the shared confirmation dialog. Notification actions and reminder use shared Vantage buttons rather than legacy pills. Remaining visual review is pending. |
| Customer | inbox, Calls, Contacts, and Bookings | In progress | Inbox now uses central page context, shared textarea, Vantage alert controls, and an accessible shared dialog for attachment preview while retaining its intentionally responsive three-pane conversation workspace. Calls adopted the central Vantage page header, `1440px` content density, shared Select control, and accessible call dialog. Contacts list and detail use the same header/density, shared form controls, central accessible dialogs, and Vantage card radius. Bookings uses the shared header, forms, dialogs, and toast feedback. Visual review remains pending. |
| Content | calendar, analytics, posts, and post detail | In progress | Calendar and Analytics now use the central page-header, concise content hierarchy, `1440px` content density, and shared controls/tabs. Posts and post detail use the same header/density and shared actions. The ideas generator, AI text generator, activity view, and two-scope post deletion all use the shared accessible dialog; the stepped composer uses the shared Sheet primitive. Visual review remains pending. |
| Campaigns | WhatsApp templates and campaign detail | In progress | Replaced the legacy rounded primary and ad-hoc action buttons with shared Vantage button variants; template create/sync feedback now uses the global toast API. The template form uses shared input, textarea, and accessible select primitives, while both bespoke overlays now use the shared dialog implementation. Campaign detail's template preview, delivery failure, and send-more flows also use the shared dialog. Full campaign-area hierarchy and visual review remain pending. |
| Agents | list, detail, activity, analytics, templates, workflow, and appearance | In progress | The list now uses the central header, `1440px` content density, concise copy, and shared accessible dialogs for creation and template selection. Agent Detail's permanent deletion, knowledge-source editor, knowledge-save feedback, Website Chat deployment, and test-chat clearing use the shared dialog; typed deletion confirmation remains intact. Activity, run detail, Analytics, Templates, Workflow, and Website Chat Appearance now use the central Vantage header and concise hierarchy; Appearance ordinary fields use shared Input, Textarea, Checkbox, and Select primitives. Identity, connect, color controls, and visual review remain pending. |
| Connections | connections | In progress | The Connections page uses the central header and `1440px` content density. The Threads sign-in reminder now uses the shared accessible dialog. WhatsApp embedded and manual connection actions now use the shared Vantage button, removing legacy pill treatments; the manual setup and maintenance flow also uses shared Vantage inputs and textareas. The WhatsApp onboarding result uses the central header and action primitive. Visual review remains pending. |
| Developers | portal, Resources, MCP, CLI, API, and API keys | In progress | The full Developers route group uses the central header, concise copy, and `1440px` density. Shared tab/feedback and visual checks remain pending. |
| Billing | billing and usage | In progress | Billing uses the central header, concise hierarchy, `1440px` density, and shared checkout/subscription action buttons. Payment, loading/error, responsive and visual checks remain pending. |
| Entry surfaces | login, sign-up, password setup, onboarding, verification, invitations, and offline | In progress | Login, sign-up, password setup, onboarding, invitation activation, email verification, auth-error recovery, and offline use the Vantage type scale, concise copy, and shared controls where applicable. Responsive and visual checks remain pending. |
| Quality | visual, accessibility, and runtime verification | In progress | Native browser-dialog audit finds no `window.alert`, `window.confirm`, or `window.prompt` use. Lint now passes with no warnings or errors after dynamic application media and organization logo rendering moved to `next/image` with deliberate unoptimized handling for authenticated/dynamic sources. Production Webpack build passes. Visual and breakpoint review remain pending because no browser is available in this environment. |

## Verification standard per migration wave

- [ ] Review the route at desktop and mobile widths.
- [ ] Review the route at the approved tablet width and its intended density.
- [ ] Review the route in light and dark themes.
- [ ] Check normal, loading, empty, error, disabled, and destructive states that
  apply to the route.
- [ ] Use the shared toast API for transient feedback; do not add page-specific
  toast implementations or browser dialogs.
- [ ] Check keyboard focus, menus/dialogs, and relevant async interactions.
- [ ] Review UI copy against the root `AGENTS.md` UI Copy & Content Rules.
- [ ] Run the most relevant lint/type/build or targeted runtime check.
- [ ] Add the verification evidence to the migration matrix.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Framework | Keep the main client on Next.js. | KasiTek team | Decided |
| Visual reference | Use `/home/enoch/aworkspace/kasitek-labs/dashboard-new` as the Vantage visual reference; translate it to the current Next.js and Tailwind 4 architecture. | KasiTek team | Decided |
| Fidelity | Treat the Vantage source as the exact visual specification. Required KasiTek-specific adaptations must be recorded; styling approximations are not permitted. | KasiTek team | Decided |
| Typography | Retain Geist as KasiTek's primary UI font. Port Vantage's type scale, weights, line heights, tracking, hierarchy, and density exactly. | KasiTek team | Decided |
| Soft status backgrounds | Derive KasiTek-only soft status surfaces directly from Vantage status colours with `color-mix`: 10% light and 12% dark, matching Vantage's accent-soft opacity. | KasiTek team | Decided |
| Theme | Light and dark themes are first-class acceptance criteria for the migration. | KasiTek team | Decided |
| Design-system location | Use the existing client global styles and `components/ui` primitives as the central system; do not create a parallel styling stack. | KasiTek team | Decided |
| Desktop top bar | Add breadcrumbs, a functional command/search entry point, notifications, theme control, and account menu. Sidebar retains workspace context and primary navigation. | KasiTek team | Decided |
| Toasts | Introduce one global Vantage-styled toast provider and shared API. Use it for concise transient feedback across auth and dashboard surfaces; do not use native browser dialogs. | KasiTek team | Decided |
| Toast theme bridge | Read the existing `data-theme` attribute instead of adding a second theme provider. This preserves the current no-flash theme contract while rendering the reference Sonner styles exactly. | KasiTek team | Decided |
| Confirmation bridge | Use one application confirmation/input-dialog provider backed by the Vantage dialog primitives. It replaces native browser dialogs without duplicating confirmation logic across routes. | KasiTek team | Decided |
| Responsive design | Every UI element must have intentional approved desktop, tablet, and mobile behavior and density before it is complete. | KasiTek team | Decided |
| Cross-cutting UX | Accessibility, data visualization, motion, layering, errors, performance, and visual regression are migration contracts, not later polish. | KasiTek team | Decided |
| Design review | Every migrated surface must be reassessed around the user's primary task, hierarchy, disclosure, actions, responsive behavior, shared patterns, and non-happy-path states. | KasiTek team | Decided |
| Migration cleanup | Each completed wave fully replaces the previous visual implementation. Do not retain legacy styling fallbacks, duplicate primitives, aliases, imports, dependencies, or dead UI code. | KasiTek team | Decided |
| Component catalogue | Decide whether a dedicated component preview/visual-regression setup is needed after foundation work begins. | KasiTek team | Open |

## Change log

| Date | Change |
| --- | --- |
| 2026-08-21 | Created the living plan and checklist. |
| 2026-08-21 | Added the approved desktop top-bar scope and responsibility boundaries. |
| 2026-08-21 | Added the global toast-system decision and verification requirements. |
| 2026-08-21 | Added responsive/density and cross-cutting UI architecture contracts. |
| 2026-08-21 | Added required task-focused design review for every migration surface. |
| 2026-08-21 | Added the exact Vantage fidelity contract and retained Geist as the approved typography adaptation. |
| 2026-08-21 | Added the replacement-based migration and cleanup rule. |
| 2026-08-21 | Ported the exact Vantage token foundation to Tailwind 4 while retaining Geist; lint and Webpack build passed. |
| 2026-08-21 | Ported the first shared primitive wave and installed the global Vantage-styled toast, dialog, and destructive confirmation foundations; lint and Webpack build passed. |
| 2026-08-21 | Added the first shell milestone: functional command palette and desktop Vantage top bar; lint and Webpack build passed. |
| 2026-08-21 | Replaced every native browser confirmation and prompt in the client with a shared Vantage-styled confirmation/input-dialog provider; lint and Webpack build passed. |
| 2026-08-21 | Applied the approved Vantage shell breakpoints and sidebar widths; lint and Webpack build passed. |
| 2026-08-21 | Began the Campaign templates migration by replacing legacy button treatments and inline success banners with shared Vantage primitives and the global toast API; lint and Webpack build passed. |
| 2026-08-21 | Added the reference Select primitive and adopted it, with the shared text controls, on the Templates form; lint and Webpack build passed. |
| 2026-08-21 | Replaced the Templates route's bespoke detail and create overlays with shared accessible dialogs; Webpack build passed. |
| 2026-08-21 | Added the reference page-header primitive and adopted it on Templates; lint and Webpack build passed. |
| 2026-08-21 | Began the Workspace migration with the Overview page-header, action, density, and empty-state treatment; lint and Webpack build passed. |
| 2026-08-21 | Migrated Workspace Profile and Settings to the central header and shared control/feedback primitives; lint and Webpack build passed. |
| 2026-08-21 | Migrated Workspace Team and Notifications to the central header and shared controls; Team destructive actions now require confirmation and invitations use a toast; lint and Webpack build passed. |
| 2026-08-21 | Began the Customer migration with Calls: central header, responsive density, shared Select, and accessible call dialog; lint and Webpack build passed. |
| 2026-08-21 | Migrated Contacts to the central header, `1440px` content density, shared form controls, and accessible dialogs for import, search, list viewing, rename, and removal; lint and Webpack build passed. |
| 2026-08-21 | Migrated Bookings to the shared header, form controls, dialog, and toast patterns; lint and Webpack build passed. |
| 2026-08-21 | Began Inbox migration with central page context, shared composer control, and Vantage alert-control buttons; its responsive conversation workspace remains intentionally three-pane. Lint and Webpack build passed. |
| 2026-08-21 | Began Content migration with Calendar and Analytics: central page headers, concise hierarchy, reference density, and shared tab controls; lint and Webpack build passed. |
| 2026-08-21 | Moved the Posts workspace onto the central page header and reference content density; lint and Webpack build passed. |
| 2026-08-21 | Migrated Post Detail to the central header/density and shared destructive dialog; lint and Webpack build passed. |
| 2026-08-21 | Began Agents migration with the list: central page header and shared accessible create/template dialogs; lint and Webpack build passed. |
| 2026-08-21 | Migrated Agent Detail's permanent deletion workflow to the shared dialog and input primitives while retaining typed confirmation; lint and Webpack build passed. |
| 2026-08-21 | Began Connections migration with the central page header and the shared Threads pre-connection dialog; lint and Webpack build passed. |
| 2026-08-21 | Began Developers migration with MCP, CLI, API Reference, and API Keys: central headers, concise hierarchy, and reference density; lint and Webpack build passed. |
| 2026-08-21 | Migrated the Developers portal and Resources page to the central header, concise hierarchy, and reference density; lint and Webpack build passed. |
| 2026-08-21 | Began Billing migration with the central header, concise hierarchy, and reference density; lint and Webpack build passed. |
| 2026-08-21 | Began entry-surface migration with Login and Sign-up: Vantage auth typography and concise UI copy; lint and Webpack build passed. |
| 2026-08-21 | Migrated Login and Sign-up actions and fields to the shared Vantage Button and Input primitives; lint and Webpack build passed. |
| 2026-08-21 | Migrated password setup fields and actions to shared Vantage controls; lint and Webpack build passed. |
| 2026-08-21 | Migrated onboarding navigation and business fields to shared Vantage Button and Input controls; lint and Webpack build passed. |
| 2026-08-21 | Migrated invitation activation fields to shared Vantage Inputs and simplified its activation copy; lint and Webpack build passed. |
| 2026-08-21 | Replaced the Posts workspace ideas, AI text, activity, and scoped deletion overlays with the shared Vantage dialog primitives; lint and Webpack build passed. |
| 2026-08-21 | Moved Agent Detail knowledge-source editing and save feedback to shared Vantage dialog and textarea primitives; lint and Webpack build passed. |
| 2026-08-21 | Migrated the Agent Website Chat deployment overlay to the shared Vantage dialog; lint and Webpack build passed. |
| 2026-08-21 | Migrated campaign recipient preview, delivery failure, and send-more overlays to shared Vantage dialogs; lint and Webpack build passed. |
| 2026-08-21 | Moved Inbox attachment preview to the shared Vantage dialog while retaining zoom and drag interactions; lint and Webpack build passed. |
| 2026-08-21 | Migrated Agent Detail test-chat clearing to the shared destructive dialog; lint and Webpack build passed. |
| 2026-08-21 | Replaced WhatsApp embedded and manual connection action pills with the shared Vantage button; lint and Webpack build passed. |
| 2026-08-21 | Replaced notification setting action pills with shared Vantage button variants; lint and Webpack build passed. |
| 2026-08-21 | Migrated email verification and authentication-error recovery to shared Vantage buttons and inputs with concise copy; lint and Webpack build passed. |
| 2026-08-21 | Migrated Profile settings fields and actions to shared Vantage input and button primitives; lint and Webpack build passed. |
| 2026-08-21 | Migrated Agent Activity, Analytics, and Templates to the central Vantage page-header and concise UI copy; lint and Webpack build passed. |
| 2026-08-21 | Migrated Agent run detail to the central Vantage page-header; lint and Webpack build passed. |
| 2026-08-21 | Migrated Agent Workflow and Website Chat Appearance to the central Vantage page-header and concise UI copy; lint and Webpack build passed. |
| 2026-08-21 | Migrated the WhatsApp manual connection setup and maintenance flow to shared Vantage inputs, textareas, and button variants; lint and Webpack build passed. |
| 2026-08-21 | Migrated Meta Embedded Signup connection management actions to shared Vantage button variants; lint and Webpack build passed. |
| 2026-08-21 | Migrated the WhatsApp onboarding result header and finish action to shared Vantage primitives; lint and Webpack build passed. |
| 2026-08-21 | Simplified the offline surface to the Vantage density and concise copy contract; lint passed. |
| 2026-08-21 | Migrated Website Chat Appearance ordinary fields to shared Vantage Input, Textarea, and Checkbox primitives; lint and Webpack build passed. |
| 2026-08-21 | Replaced the Posts stepped composer’s bespoke overlay with the shared Vantage Sheet primitive; lint and Webpack build passed. |
| 2026-08-21 | Migrated Website Chat Appearance deployment and position selectors to the shared Vantage Select primitive; lint and Webpack build passed. |
| 2026-08-21 | Migrated standalone billing, sign-out, and notification-reminder actions to shared Vantage buttons; lint and Webpack build passed. |
| 2026-08-21 | Replaced all client `<img>` use with `next/image`; authenticated/dynamic media paths use deliberate unoptimized rendering, lint is clean, and the Webpack build passed. |
| 2026-08-21 | Removed unused legacy theme compatibility aliases and the final direct dependency on them; lint and Webpack build passed. |
| 2026-08-21 | Migrated Contacts detail to the shared Vantage page-header and standard card radius; lint and Webpack build passed. |
