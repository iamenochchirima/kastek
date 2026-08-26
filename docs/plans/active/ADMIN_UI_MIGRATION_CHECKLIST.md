# Admin Vantage UI Migration Plan

**Status:** In progress — foundation, shell, and first route waves implemented

**Owner:** KasiTek team

**Last updated:** 2026-08-26

**Reference:** [`VANTAGE_UI_MIGRATION_PLAN.md`](VANTAGE_UI_MIGRATION_PLAN.md)

**Downstream dependency:** [`ADMIN_ANALYTICS_PLAN.md`](ADMIN_ANALYTICS_PLAN.md)

## Current implementation checkpoint

Completed in the current migration wave:

- Admin-owned appearance preferences for theme, accent, density, motion, live indicators, and week start.
- Semantic Vantage tokens, pre-hydration theme application, shared buttons, cards, fields, badges,
  skeletons, tables, and chart-state primitives.
- Responsive icon-based shell with active route state, mobile navigation, appearance settings, and
  password access.
- Dashboard, authentication, leads, conversations, agencies, billing, outreach, web-services, and
  the main commercial list/detail surfaces migrated onto the new token layer.
- Native browser dialogs removed from the migrated Admin workflows and replaced with application UI.

Still in progress: the quotation/invoice builder internals, remaining operator/form controls, route
visual QA at all supported breakpoints, and the final legacy-style cleanup pass. Admin Analytics
remains gated until those items are verified.

## Purpose

Rebuild `client/apps/admin` as the Admin counterpart to the Vantage client workspace. The target is
not merely a visual refresh. Admin must use the same design-system discipline, dynamic appearance
model, responsive behavior, motion rules, reusable primitives, and visual quality bar as
`client/apps/client`, while retaining Admin's separate information architecture and internal
operations workflows.

Admin Analytics, Activity, and Reports are downstream work. Their implementation must not begin
until this migration's Definition of Done has been met and the Admin shell, token layer, primitives,
themes, responsive states, and chart foundation are verified.

This work changes presentation, information hierarchy, and interaction consistency. It must not
change Admin authorization, API contracts, business rules, billing behavior, or the separate
white-label architecture. A functional change needed to make a state accessible or safe must be
recorded explicitly rather than hidden inside a styling migration.

## Decisions

- Admin keeps a separate internal-operations information architecture. The Vantage visual contract
  is shared; customer-facing navigation and product-entitlement behavior are not copied.
- Admin owns its appearance store and storage namespace. The legacy `kasiai-theme` value is read as
  a compatibility fallback, while new preferences use `kasitek-admin-*` keys.
- The Admin shell uses grouped operations navigation, a collapsible desktop rail, and a mobile
  drawer because the route set is broader and more operationally dense than the client workspace.
- Existing domain-specific confirmation and editor components remain in place until a shared
  dialog primitive can cover their current focus, escape, sizing, and validation behavior. Native
  browser dialogs are not permitted.
- Chart primitives are established during this migration, but data-backed Admin Analytics remains
  a separate phase. No synthetic chart data is introduced as part of the visual migration.

## Token reference

The Admin token source is `client/apps/admin/src/app/globals.css`. Components should use the
semantic utilities below; route code should not introduce a second palette.

| Concern | Semantic utilities | Notes |
| --- | --- | --- |
| Canvas and surfaces | `bg-background`, `bg-card`, `bg-popover`, `bg-secondary`, `bg-surface-2`, `bg-surface-3` | Light/dark values are defined at the root. |
| Text and borders | `text-foreground`, `text-muted-foreground`, `text-ink-3`, `border-border`, `border-line-strong` | Use muted tiers for supporting metadata. |
| Actions and focus | `bg-primary`, `text-primary-foreground`, `bg-brand-2`, `ring-ring` | Primary action color follows the selected accent. |
| Status | `text-status-success`, `text-status-attention`, `text-status-info`, `text-status-danger` plus `bg-*`/`border-*` and `-soft` variants | Status color communicates state, not decoration. |
| Charts | `text-chart-1` through `text-chart-6` plus `bg-*` variants | Series colors are resolved from appearance tokens. |
| Layout and motion | `--density-*`, `--v-motion-*`, `--shadow-panel`, `--shadow-pop` | Density and reduced-motion preferences apply globally. |

## Sources of direction

- Visual reference: [`design-concepts/workspace-ui-concept.html`](../design-concepts/workspace-ui-concept.html)
- Vantage visual source of truth: `/home/enoch/aworkspace/kasitek-labs/dashboard-new`
- Direct-client Vantage implementation: `client/apps/client/src/app/globals.css`,
  `client/apps/client/src/lib/appearance-contract.ts`, `client/apps/client/src/lib/appearance.ts`,
  `client/apps/client/src/components/ui`, and
  `client/apps/client/src/components/dashboard/layout-shell.tsx`
- Direct-client migration rules: [`VANTAGE_UI_MIGRATION_PLAN.md`](VANTAGE_UI_MIGRATION_PLAN.md)
- Product boundary: [`docs/plans/templates/PROJECT_PLAN.md`](../templates/PROJECT_PLAN.md)

## Vantage fidelity contract

The direct-client Vantage implementation is the Admin visual specification, not a loose source of
inspiration. Port the rendered values and behavior into the Admin application's architecture.

- [x] Use the same Vantage semantic token vocabulary, light/dark values, typography scale,
      spacing, radii, shadows, chart colors, focus treatment, motion timing, and responsive
      dimensions as the client migration.
- [x] Record every Admin-specific adaptation in the Decisions section before implementation.
      Adaptations may reflect internal operations needs or route behavior; they may not be styling
      approximations.
- [x] Keep Admin-owned code boundaries. Do not import `client/apps/client/src` directly. If both
      applications need identical tokens or primitives, decide whether to extract a genuinely
      shared package; until then, keep the Admin implementation synchronized with the approved
      Vantage contract.
- [ ] Compare each Admin primitive, shell state, and route against the Vantage reference at the
      same theme and viewport before marking it complete.
- [ ] Remove old Admin styling, compatibility aliases, duplicate components, and dead code after
      each migration wave; do not leave two competing visual systems.

## Appearance and dynamic styling contract

Admin must receive the complete appearance behavior already established in the client workspace,
not only a light/dark toggle. The appearance engine owns defaults, validation, persistence,
document-root application, system-theme observation, and subscriptions.

The Admin contract is:

```ts
type AdminAppearancePreferences = {
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

- [x] Port the central appearance-store pattern and full preference model to Admin.
- [x] Apply resolved theme, theme mode, accent, density, reduced-motion, and live-indicator state
      to the document root before hydration and whenever preferences change.
- [x] Make colors, surfaces, borders, text tiers, status states, chart series, focus, overlays,
      shadows, motion, and density semantic CSS variables. Components must consume tokens rather
      than hard-coded colors or route-specific palettes.
- [x] Use an Admin-specific documented storage namespace, with a deliberate compatibility path
      for the current `kasiai-theme` key if existing Admin users need to retain their preference.
- [ ] Verify every accent in both themes, including primary actions, navigation, focus rings,
      status badges, charts, selected states, and disabled states.
- [ ] Ensure reduced motion disables non-essential transitions and chart animation without making
      live operational state unreadable.
- [ ] Ensure live indicators can be hidden without removing the underlying status information.
- [x] Keep authentication routes free of the authenticated shell while still using the same theme,
      typography, form, error, and accessibility contracts.

## Production data-visualization foundation

Admin Analytics is intentionally a later implementation phase, but the Admin Vantage migration
must establish the reusable visual foundation that it will use. The chart layer must be designed
with the same rigor as the rest of the design system.

- [x] Create or adopt shared Admin chart primitives for chart cards, headings, legends, axes,
      gridlines, tooltips, crosshair/hover state, annotations, loading, empty, unavailable,
      partial-coverage, stale, and error states.
- [x] Drive chart colors from semantic appearance tokens. Do not hard-code series colors inside a
      page, and ensure the palette remains distinguishable in light/dark themes and for color-blind
      users.
- [ ] Use real time scales and adaptive tick density: daily labels for short ranges, readable
      multi-day/weekly labels for longer ranges, and month labels for annual ranges.
- [ ] Format axes and tooltips according to the metric unit: count, percentage, currency, credits,
      latency, tokens, or cost. Never display a currency chart with ambiguous `$0` labels.
- [ ] Use bars for discrete daily volume, stacked bars for composition, lines/areas for continuous
      trends, funnels for conversion, and tables when exact ranking is more useful than a shape.
- [ ] Make comparison series opt-in and visually subordinate. A broken/dashed previous-period line
      must never appear without a clear legend and explanation.
- [ ] Never render decorative zero dots, arbitrary joins, fake data, or a chart that hides missing
      instrumentation as zero. A no-data state must be visually distinct from a real zero.
- [ ] Support exact hover values, date/time, dimensions, peak/threshold annotations when useful,
      keyboard access, screen-reader summaries, and touch-friendly interaction.
- [ ] Make chart points, bars, segments, and ranked rows capable of linking to the corresponding
      filtered Activity, Billing, customer, or Operations view when Analytics is implemented.
- [ ] Test chart rendering at 7D, 30D, 90D, 12M, and custom ranges, including long labels, large
      values, multiple series, sparse data, and partial coverage.

## Migration gate before Admin Analytics

The following gate prevents Analytics from becoming another one-off visual system:

- [ ] Admin tokens and appearance state are centralized and dynamically applied.
- [ ] Admin shell and shared primitives are Vantage-aligned in light and dark themes.
- [ ] Desktop, tablet, and mobile navigation, content density, tables, dialogs, and forms are
      verified.
- [ ] Chart primitives and visual states are available for the later Admin Analytics work.
- [ ] The route migration has removed legacy styling fallbacks and duplicate primitives.
- [ ] The Admin UI migration Definition of Done is signed off before
      [`ADMIN_ANALYTICS_PLAN.md`](ADMIN_ANALYTICS_PLAN.md) moves from planning to implementation.

The admin should share the direct client’s design language, not its customer-facing navigation or product-entitlement behaviour. It is the internal Kasitek operations surface.

## Rules for a maintainable UI

- [ ] Keep one semantic token layer in `client/apps/admin/src/app/globals.css`. Page and feature components use semantic utilities; they do not introduce their own palettes.
- [ ] Define light and dark values for canvas, surfaces, text, borders, focus, overlays, primary action, and semantic status states before restyling routes.
- [ ] Expose only those semantic values through Tailwind `@theme inline`; remove the old admin-specific blue/lime presentation tokens once callers have migrated.
- [ ] Use one app-level theme controller and one documented storage key. Theme changes must update the document root and work before and after refresh.
- [ ] Build app-local primitives in `client/apps/admin/src/components/ui`. Do not import files directly from `client/apps/client`; extract a package only if a component is genuinely shared and its ownership is agreed.
- [ ] Keep route components responsible for data loading and business actions. Put repeated layout, visual states, and interaction mechanics in shared components.
- [ ] Use icons from the installed icon library rather than emoji navigation icons.
- [ ] Reserve colour for primary actions and meaningful statuses. Default surfaces, navigation, and tables remain neutral and readable in both themes.
- [ ] Keep visual migration separate from API, data-model, or workflow rewrites unless a small accessibility correction requires a local behaviour change.

## Target component ownership

| Location | Owns | Must not own |
| --- | --- | --- |
| `src/app/globals.css` | tokens, global typography, base element rules, shared utility contracts | route-specific colours or layouts |
| `src/components/ui` | atomic primitives such as buttons, inputs, badges, cards, dialogs, tables, sheets, tabs, skeletons, tooltips | fetching, admin API calls, route copy |
| `src/components/admin` | admin shell, page header, data toolbar, status mapping, empty/error states, domain widgets | duplicate button/table/modal implementations |
| `src/app/(dashboard)` | route composition, server data loading, permissions, page-specific workflows | visual token definitions or a second shell |

## Execution checklist

### 0. Establish the migration guardrails

- [ ] Capture screenshots of the current desktop and mobile admin routes before changes.
- [ ] List every shared visual pattern already in use: buttons, fields, tables, pagination, filters, modal forms, destructive confirmations, metric cards, status labels, loading states, and empty states.
- [ ] Inventory inline colours, one-off border/radius/shadow values, emoji icons, and duplicated modal/table markup so each has a replacement or removal plan.
- [ ] Confirm all admin routes and existing workflows remain in scope:
  - Dashboard
  - Leads: list, create, detail, edit, quotation
  - Quotations: list, create, detail
  - Invoices: list, create, detail
  - Product billing
  - AI services/outreach: list, detail, import, drafts, delivery
  - Web services: list and import
  - Conversations: list and detail
  - Agencies: list, create, detail
  - Password and auth routes
- [ ] Record route-specific risks before visual work begins, especially quotation/invoice builders, import forms, delivery exports, and destructive bulk actions.

### 1. Build the admin foundation

- [x] Replace the current admin theme tokens with the same semantic vocabulary used by the client workspace: background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, sidebar, overlay, and status tokens.
- [x] Add dark-theme equivalents for every visual token; no component should rely on a light-only hard-coded colour.
- [x] Set shared typography, compact operational spacing, radii, focus treatment, selection state, disabled state, and motion timing in the global layer.
- [x] Add token aliases only as temporary compatibility bridges, with a named removal pass after the route migration.
- [x] Reuse the client’s theme behaviour where appropriate, while keeping admin theme code and imports owned by the admin app.
- [x] Add a short token reference section to this document or adjacent admin UI documentation when the final values are chosen.

### 2. Create the reusable primitive layer

- [x] Add a consistent `Button` with primary, secondary, ghost, destructive, icon-only, loading, and disabled variants.
- [x] Add `Input`, `Textarea`, and `Select` conventions with label, hint, required, and error treatment.
- [ ] Add remaining `Checkbox` and `FormField` conventions, plus `Avatar`, `Tooltip`, `Tabs`, and
      `Progress` primitives where Admin routes need them.
- [ ] Add a generic `Dialog`/confirmation and `Sheet` primitive with focus management, escape
      handling, and clear destructive-action wording; existing domain modals remain functional
      while this is completed.
- [x] Add a responsive `DataTable` foundation: header, row, compact cell styles, selection state, overflow handling, empty state, and loading state.
- [x] Keep the existing pagination and filters functional while moving their presentation onto the shared primitives.
- [ ] Standardize icon size, button height, form-control height, table density, and status dot/badge treatment.

### 3. Rebuild the application shell

- [x] Replace the current emoji sidebar with an icon-based, grouped internal-operations navigation.
- [ ] Group navigation according to admin work rather than direct-client product areas; validate final labels with the actual routes, for example Operations, Commercial, Outreach, and Platform.
- [x] Provide active route, nested-route, hover, keyboard-focus, collapsed, and mobile states from the same navigation component.
- [x] Use a responsive mobile sheet/drawer rather than relying on a permanently visible desktop sidebar.
- [x] Build one top bar with page context, theme toggle, notifications when available, account menu, password access, and sign-out.
- [ ] Keep sidebar collapse preference and theme preference isolated and documented as admin application preferences.
- [x] Establish a single content width, page padding scale, and scrolling responsibility so all pages align.

### 4. Add repeatable admin page patterns

- [x] Create `AdminPageHeader` for eyebrow/breadcrumb, title, supporting text, primary action, and secondary actions.
- [ ] Create `AdminSectionHeader` and metric-card patterns for dashboards and detail pages.
- [ ] Create a `DataToolbar` pattern for search, filters, active-filter count, clear filters, density, and route actions.
- [ ] Create `EmptyState`, `ErrorState`, and `LoadingState` components with route-appropriate recovery actions.
- [x] Centralize status-to-appearance mapping for lead, quotation, invoice, outreach, service, conversation, and agency statuses. Do not encode status colours independently in each page.
- [ ] Standardize date, currency, number, truncation, copy-to-clipboard, and external-link presentation helpers.
- [ ] Define a detail-page pattern for metadata, activity/notes, related records, sidebar actions, and destructive controls.
- [ ] Define a form-page pattern for sections, validation summaries, sticky save/cancel actions, unsaved-change behaviour, and responsive field grids.

### 5. Migrate route families in coherent batches

#### Dashboard and navigation

- [x] Apply the shell and page-header patterns to `/dashboard` first as the visual reference route.
- [x] Rebuild dashboard metrics, queues, and summary tables using shared cards, status components, and data-table styles.
- [x] Verify that dashboard content reflects real data and does not receive placeholder values as part of the redesign.

#### Leads and conversations

- [x] Migrate `/leads`, lead create/edit/detail, notes, status updates, filters, and quotation handoff.
- [x] Migrate `/conversations` and conversation detail with consistent channel/status metadata, message spacing, and reply/error states.
- [ ] Preserve lead deletion confirmation and all lead/conversation authorization paths.

#### Commercial operations

- [x] Migrate quotations list, create, detail, preview, and PDF actions.
- [x] Migrate invoices list, create, detail, operations panel, preview, PDF actions, and run actions.
- [x] Move quotation and invoice builders to shared form, table, summary, and confirmation patterns without changing calculation or lifecycle logic.
- [x] Migrate `/billing` using the shared catalog, entitlement, and usage presentation patterns.

#### Outreach and services

- [x] Migrate outreach list, detail, import, drafts, delivery log, recipient filters, browser, and send controls.
- [x] Migrate web-services list, import, filters, and destructive bulk controls.
- [ ] Retain import validation, export, test-email, sync, send, and delete failure feedback while replacing only their visual presentation.

#### Platform administration

- [x] Migrate agencies list, creation, detail, staff, domains, API keys, status controls, and client management.
- [x] Use the shared detail-page and confirmation patterns for revoke, remove, verify, set-primary, and status-change actions.
- [ ] Make sensitive values and irreversible actions visibly distinct without relying only on colour.

#### Authentication and account settings

- [x] Restyle login, forgot-password, reset-password, and password-change screens with the same token and form system.
- [x] Keep the auth experience intentionally simpler than the dashboard shell; do not mount authenticated navigation on public routes.
- [ ] Verify redirect, validation, rate/error messages, and password visibility controls after the restyle.

### 6. Remove duplication and enforce the system

- [ ] Replace `confirm-modal.tsx`, `edit-field-modal.tsx`, and duplicated form controls only after their shared replacements cover their current behaviour.
- [ ] Consolidate the existing table and filter components onto the data-table and toolbar contracts without forcing unrelated domain logic into one component.
- [x] Remove temporary compatibility token aliases and obsolete component styles after all consumers have migrated.
- [x] Search for hard-coded colours, inline emoji icons, duplicated modal markup, and repeated button/input class strings; resolve or explicitly justify each remaining case.
- [ ] Add short component usage notes beside non-obvious shared admin components so new routes extend the system instead of bypassing it.

### 7. Accessibility, responsiveness, and verification

- [ ] Check keyboard navigation, visible focus, tab order, escape-to-close dialogs, and focus return for every modal and mobile sheet.
- [ ] Verify semantic labels for icon-only controls, form errors, status changes, destructive actions, and loading states.
- [ ] Check contrast in light and dark themes, including muted text, badges, disabled controls, table headers, and error states.
- [ ] Test at narrow mobile, tablet, standard desktop, and wide desktop widths; tables must remain usable through responsive prioritization or horizontal scrolling.
- [ ] Test long names, empty lists, many filters, slow loading, API errors, and permission-denied states.
- [x] Run `pnpm --dir client --filter admin exec eslint` for changed TypeScript/TSX files.
- [x] Run `pnpm --dir client --filter admin exec tsc --noEmit`.
- [x] Run `pnpm --dir client --filter admin build` before the final UI migration handoff.
- [ ] Compare each migrated route against the baseline screenshots and confirm real workflows still work.

## Delivery sequence

1. Foundation, primitives, and shell.
2. Dashboard as the reference implementation.
3. Leads and conversations.
4. Quotations, invoices, and billing.
5. Outreach and web services.
6. Agencies, auth, cleanup, and full verification.

Keep each batch independently reviewable. Do not combine a visual migration with unrelated backend or white-label changes, and do not stage unrelated working-tree changes.

## Definition of done

- Every admin route uses the shared shell, token layer, and common page patterns.
- A global token or primitive change updates all relevant admin screens without page-by-page styling edits.
- Light and dark themes are complete, consistent, and accessible.
- The admin navigation is responsive and represents internal operations clearly.
- Existing admin workflows, API routes, permissions, and data behaviour are unchanged unless separately approved.
- Lint, type-check, build, and the route-level visual/interaction checks pass.
