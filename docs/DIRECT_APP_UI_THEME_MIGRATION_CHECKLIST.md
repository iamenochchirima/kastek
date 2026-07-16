# Direct App UI Theme Migration Checklist

Status: **approved — implementation in progress**

## Goal

Rebuild the authenticated KasiTek product UI as one restrained operational design system. The implementation includes the visual patterns themselves—navigation, page hierarchy, cards, tables, forms, status treatment, and empty/loading states—not only a token swap. It must support complete light and dark themes from central semantic tokens, with no leftover page-level colours or theme-specific styling that can conflict with a future visual change.

The approved visual direction is represented by [`design-concepts/workspace-ui-concept.html`](../design-concepts/workspace-ui-concept.html): neutral surfaces, graphite primary actions, colour used only for meaningful state, compact readable type, low-elevation components, and a sidebar that follows the active theme.

## Scope Boundary

### Included

- `client/apps/client` authenticated workspace and product areas
- Auth, onboarding, invitation, offline, and account-management surfaces that belong to the application experience
- Shared application primitives in `client/apps/client/src/components/ui`
- Shared application shell, navigation, theme controls, notifications, loading states, forms, tables, and empty/error states
- The direct app’s global CSS, visual tokens, font loading, and theme initialization

### Explicitly excluded

- All routes and components under `client/apps/client/src/app/(marketing)`
- `client/apps/client/src/components/landing/*`
- Existing marketing/landing typography, imagery, animations, colours, and layout

The marketing surface must remain visually unchanged. Its CSS must be isolated below a marketing root class or marketing layout boundary so changes to the application design system cannot alter it. The application shell must not import marketing-only fonts, tokens, or generic selectors.

## Audit Baseline (2026-07-16)

- The direct client application contains dashboard, Inbox, Reach, Social, Agents, Connections, Billing, Workspace/Team, auth, onboarding, invitation, and offline route families.
- Theme state is currently set through `ThemeScript`, `ThemeScope`, `ThemeToggle`, and a second theme toggle embedded in `dashboard/layout-shell.tsx`. This needs one owner.
- `globals.css` mixes semantic tokens with legacy warm/lime aliases, marketing-oriented fonts, app-level theme rules, and broad component styling.
- Roughly 70 direct-client source files contain hard-coded colours, generic colour utilities, or theme-specific Tailwind variants. Existing frequently used visual utilities include raw white/black, gray/zinc, red/green, hard-coded lime, gold, and dashboard gradient/shadow values.
- `LayoutShell` has direct gradient and gold active-navigation styling that must be replaced by semantic component variants.
- The existing reusable primitives use a mix of semantic tokens and `dark:` overrides. New primitives must be token-driven rather than contain their own theme palettes.

## Non-negotiable Design Rules

- Application components use semantic tokens only. No hex values, raw Tailwind colour families (`gray`, `zinc`, `white`, `black`, `amber`, `green`, etc.), arbitrary colour utilities, or `dark:` colour overrides in application components.
- One central token file defines both themes. A visual colour change must require editing token values, not hunting through pages.
- The `data-theme` attribute is the only source of theme styling. The `dark` class may be retained temporarily for framework compatibility, but cannot be independently managed.
- Theme choice is persisted once, respected before hydration, available to all application routes, and does not flash the wrong theme.
- The sidebar is a themed surface, not a permanently dark product element.
- Graphite is the primary action colour. Amber is reserved for warning/attention signals. Red is reserved for destructive/error states. Success and informational colours appear only with a state icon, label, or text; colour cannot be the sole signal.
- Cards, inputs, menus, tables, and panels use subtle borders and restrained radius/elevation. The interface must not use decorative gradients for routine application UI.
- Every interactive state has visible hover, focus-visible, disabled, loading, selected, and destructive/error treatment in both themes.
- All application UI must meet WCAG 2.2 AA contrast requirements; text, focus rings, icons, badges, charts, and inactive navigation are included.

## Implementation Checklist

### 1. Architecture and Theme Ownership

- [x] Create one application design-token source with semantic names for canvas, surface levels, text hierarchy, border hierarchy, primary action, focus, and semantic status colours.
- [x] Define light and dark token values in one location; avoid duplicated colour definitions in components.
- [x] Separate product-app global CSS from marketing CSS and marketing font imports.
- [x] Keep the marketing layout and its scoped stylesheet responsible for the landing-page appearance only.
- [x] Replace the current root-level marketing font imports with application typography appropriate for the approved operational direction.
- [ ] Define one spacing scale, type scale, border-radius scale, shadow/elevation scale, and motion-duration scale.
- [ ] Replace legacy aliases (`--theme-*`, lime, warm, hero aura, chat-specific palette) with semantic app tokens or explicitly move them into the marketing scope.
- [x] Remove duplicate theme-state readers/writers and expose one theme provider/controller and one storage key.
- [x] Ensure server-rendered markup, initial theme script, provider state, and UI controls resolve the same theme with no hydration mismatch or flash.
- [ ] Update PWA/browser colour metadata when the active theme changes, including supported light/dark `theme-color` values.

### 2. Foundation and Primitive Components

- [x] Rebuild `Button` variants: graphite primary, neutral secondary, ghost/tertiary, destructive, icon-only, disabled, loading, and compact sizes.
- [x] Rebuild `Input`, textarea, select, checkbox, and form field states with centrally defined hover/focus/error/disabled tokens.
- [ ] Rebuild `Card`, `Badge`, `Table`, `Tabs`, `DropdownMenu`, `Sheet`, `Tooltip`, `Avatar`, `Progress`, `ScrollArea`, and `Skeleton` from semantic tokens.
- [ ] Add missing shared primitives as needed: page header, section header, empty state, inline status, alert, confirmation dialog, data toolbar, pagination, and loading button.
- [ ] Replace raw status pills with a deliberate status component that has neutral, attention, success, info, and destructive variants.
- [ ] Ensure no primitive includes a hard-coded theme palette or an application-specific route assumption.
- [ ] Document primitive variant contracts in code so pages do not recreate buttons, badges, cards, or alerts ad hoc.

### 3. Application Shell and Navigation

- [x] Rebuild `LayoutShell` to match the approved concept: plain overview/header hierarchy, themed sidebar, restrained selected state, graphite primary action, and no decorative active gradients.
- [ ] Make collapsed desktop sidebar, expanded desktop sidebar, mobile drawer, and keyboard navigation visually and behaviorally equivalent.
- [ ] Centralize navigation item variants, unread indicators, locked-product treatment, account menu, organisation switcher, and theme switcher.
- [ ] Ensure inactive navigation is legible in both themes and does not read as disabled.
- [x] Use the same theme-aware sidebar surface in light and dark mode.
- [x] Implement a single accessible theme control with text/icon state, keyboard support, correct `aria-pressed`, and persistence.
- [ ] Define page-level max widths, gutters, responsive breakpoints, and desktop/mobile header behavior centrally.

### 4. Dashboard and Shared Workspace Views

- [x] Rebuild `/workspace` overview around actionable work: attention queue, operational summary, recent activity, campaign performance, and usage.
- [x] Replace decorative welcome/hero treatment with the standard page header.
- [ ] Use compact metric cards only where a metric has an operational purpose; preserve a consistent metric-card component.
- [ ] Rebuild workspace profile, notifications, team list, team creation, connections, and billing/usage surfaces with shared patterns.
- [ ] Audit loading, empty, permission-limited, network-error, and no-organisation states for every workspace view.

### 5. Product Areas

#### Inbox and contacts

- [x] Rebuild Inbox information architecture: horizontal connected-channel navigation, compact conversation filters, a two-pane work area, and on-demand channel management.
- [ ] Complete Inbox visual QA for conversation panel, composer, message states, media, unread indicators, alerts, and realtime/loading states in both themes.
- [ ] Rebuild Contacts list, filters, import/export controls, forms, bulk actions, and empty states.
- [ ] Verify readable message bubbles, timestamps, attachments, and sender identity in both themes.

#### Campaigns and templates

- [ ] Rebuild campaign list, detail, create/edit flow, analytics, active/archived states, recipient tables, actions, and confirmation/error states.
- [ ] Rebuild templates list, create flow, approved/pending variants, preview, submission/review states, and template-management controls.
- [ ] Replace product-specific raw colours with shared status, data-table, and form components.

#### Social

- [ ] Rebuild social overview, posts, planner, calendar, analytics, and channel-connection surfaces using the shared application system.
- [ ] Standardize post status, platform metadata, calendar event, metrics, chart, and compose-preview styles.
- [ ] Audit chart palettes for light/dark contrast and non-colour status recognition.

#### Agents and integrations

- [ ] Rebuild Agents list/detail/create states, deployment status, action controls, and empty/loading/error views.
- [ ] Rebuild WhatsApp onboarding cards, manual connection, embedded signup, result/error states, and connection health.
- [ ] Rebuild Connections as a shared workspace surface instead of allowing product-specific visual treatments to leak through.

### 6. Entry, Account, and Utility Surfaces

- [ ] Rebuild login, signup, password setup, auth error, verification/request states, and sign-out controls with the application theme.
- [ ] Rebuild onboarding, invitation acceptance, offline, push-notification settings, and permission prompts.
- [ ] Decide and document whether the site-wide chat widget belongs to the marketing surface, the product surface, or has two scoped variants; prevent it from inheriting the wrong theme.
- [ ] Keep all marketing forms and landing CTAs unchanged and isolated from application form primitives unless explicitly migrated in a separate decision.

### 7. Removal of Legacy Styling

- [ ] Remove direct colour literals, generic colour utility classes, arbitrary shadow values, and `dark:` colour overrides from included application routes/components.
- [ ] Remove old warm/lime variables and dashboard gradient treatments after all callers have been migrated.
- [ ] Delete duplicate local theme helpers and stale compatibility styles once their callers are gone.
- [ ] Confirm no application component imports marketing-only styles, fonts, or visual assets.
- [ ] Search the included scope for prohibited styling patterns and resolve every remaining occurrence before sign-off.

### 8. Theme Completeness and Accessibility Verification

- [ ] Check every included route at desktop, tablet, and mobile widths in both light and dark themes.
- [ ] Check every primitive and every interactive state in both themes.
- [ ] Check standard, hover, focus-visible, active, disabled, loading, selected, empty, error, success, warning, and locked states.
- [ ] Verify keyboard traversal, focus visibility, dialog/menu focus management, and screen-reader labels.
- [ ] Run automated accessibility checks on representative route families and manually inspect contrast exceptions.
- [ ] Test persisted theme across refresh, route change, sign-in/out, mobile navigation, and new browser sessions.
- [ ] Test without JavaScript long enough to confirm the initial theme script does not create a disruptive flash.
- [ ] Verify PWA, browser chrome, and native form controls use appropriate light/dark appearance.

### 9. Code Quality and Completion Gates

- [ ] Add an enforceable lint/check rule or CI search that rejects hard-coded visual colours and `dark:` colour overrides in the included application scope.
- [ ] Document permitted exceptions, if any, such as brand artwork or data visualisation libraries that require token adapters.
- [ ] Add visual regression coverage for app shell, dashboard, Inbox, campaigns, Social, auth, and mobile sidebar in both themes.
- [ ] Run `pnpm --filter client lint`, production build, and relevant type checks.
- [ ] Perform a manual route-by-route design review against this checklist.
- [ ] Record any consciously deferred route or exception with owner and reason; no silent styling debt is acceptable.

## Definition of Done

The work is complete only when the authenticated direct application presents one coherent operational UI in both themes; all included elements draw their appearance from central semantic tokens; the marketing/landing experience is unchanged and isolated; no hard-coded or orphaned legacy theme colours remain in scope; and automated plus manual verification confirms the system is accessible, responsive, and easy to change centrally.

## Proposed Execution Order After Approval

1. Theme architecture and marketing/application isolation.
2. Reusable primitives and application shell.
3. Dashboard/workspace and account surfaces.
4. Inbox, Reach, Social, Agents, and integration surfaces.
5. Auth/onboarding/utility surfaces.
6. Legacy-style removal, responsive/accessibility checks, visual regression, lint, and production build.
