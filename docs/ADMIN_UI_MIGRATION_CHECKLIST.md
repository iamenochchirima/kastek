# Admin UI Migration Checklist

## Purpose

Rebuild `client/apps/admin` as one coherent internal operations application. The target is the same visual and implementation discipline used by the direct Kasitek client workspace: semantic design tokens, a small reusable component layer, one responsive shell, and repeatable page patterns.

This work changes presentation and interaction consistency. It must not change admin authorization, API contracts, business rules, or the separate white-label architecture.

## Sources of direction

- Visual reference: [`design-concepts/workspace-ui-concept.html`](../design-concepts/workspace-ui-concept.html)
- Direct-client design system reference: `client/apps/client/src/app/globals.css`, `client/apps/client/src/components/ui`, and `client/apps/client/src/components/dashboard/layout-shell.tsx`
- Product boundary: [`PROJECT_PLAN.md`](../PROJECT_PLAN.md)

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

- [ ] Replace the current admin theme tokens with the same semantic vocabulary used by the client workspace: background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, sidebar, overlay, and status tokens.
- [ ] Add dark-theme equivalents for every visual token; no component should rely on a light-only hard-coded colour.
- [ ] Set shared typography, compact operational spacing, radii, focus treatment, selection state, disabled state, and motion timing in the global layer.
- [ ] Add token aliases only as temporary compatibility bridges, with a named removal pass after the route migration.
- [ ] Reuse the client’s theme behaviour where appropriate, while keeping admin theme code and imports owned by the admin app.
- [ ] Add a short token reference section to this document or adjacent admin UI documentation when the final values are chosen.

### 2. Create the reusable primitive layer

- [ ] Add a consistent `Button` with primary, secondary, ghost, destructive, icon-only, loading, and disabled variants.
- [ ] Add `Input`, `Textarea`, `Select`, `Checkbox`, and `FormField` conventions with label, hint, required, and error treatment.
- [ ] Add `Card`/`Panel`, `Badge`/`StatusBadge`, `Avatar`, `Tooltip`, `Tabs`, `Progress`, and `Skeleton` primitives.
- [ ] Add `Dialog`/confirmation and `Sheet` primitives with focus management, escape handling, and clear destructive-action wording.
- [ ] Add a responsive `DataTable` foundation: header, row, compact cell styles, selection state, overflow handling, empty state, and loading state.
- [ ] Keep the existing pagination and filters functional while moving their presentation onto the shared primitives.
- [ ] Standardize icon size, button height, form-control height, table density, and status dot/badge treatment.

### 3. Rebuild the application shell

- [ ] Replace the current emoji sidebar with an icon-based, grouped internal-operations navigation.
- [ ] Group navigation according to admin work rather than direct-client product areas; validate final labels with the actual routes, for example Operations, Commercial, Outreach, and Platform.
- [ ] Provide active route, nested-route, hover, keyboard-focus, collapsed, and mobile states from the same navigation component.
- [ ] Use a responsive mobile sheet/drawer rather than relying on a permanently visible desktop sidebar.
- [ ] Build one top bar with page context, theme toggle, notifications when available, account menu, password access, and sign-out.
- [ ] Keep sidebar collapse preference and theme preference isolated and documented as admin application preferences.
- [ ] Establish a single content width, page padding scale, and scrolling responsibility so all pages align.

### 4. Add repeatable admin page patterns

- [ ] Create `AdminPageHeader` for eyebrow/breadcrumb, title, supporting text, primary action, and secondary actions.
- [ ] Create `AdminSectionHeader` and metric-card patterns for dashboards and detail pages.
- [ ] Create a `DataToolbar` pattern for search, filters, active-filter count, clear filters, density, and route actions.
- [ ] Create `EmptyState`, `ErrorState`, and `LoadingState` components with route-appropriate recovery actions.
- [ ] Centralize status-to-appearance mapping for lead, quotation, invoice, outreach, service, conversation, and agency statuses. Do not encode status colours independently in each page.
- [ ] Standardize date, currency, number, truncation, copy-to-clipboard, and external-link presentation helpers.
- [ ] Define a detail-page pattern for metadata, activity/notes, related records, sidebar actions, and destructive controls.
- [ ] Define a form-page pattern for sections, validation summaries, sticky save/cancel actions, unsaved-change behaviour, and responsive field grids.

### 5. Migrate route families in coherent batches

#### Dashboard and navigation

- [ ] Apply the shell and page-header patterns to `/dashboard` first as the visual reference route.
- [ ] Rebuild dashboard metrics, queues, and summary tables using shared cards, status components, and data-table styles.
- [ ] Verify that dashboard content reflects real data and does not receive placeholder values as part of the redesign.

#### Leads and conversations

- [ ] Migrate `/leads`, lead create/edit/detail, notes, status updates, filters, and quotation handoff.
- [ ] Migrate `/conversations` and conversation detail with consistent channel/status metadata, message spacing, and reply/error states.
- [ ] Preserve lead deletion confirmation and all lead/conversation authorization paths.

#### Commercial operations

- [ ] Migrate quotations list, create, detail, preview, and PDF actions.
- [ ] Migrate invoices list, create, detail, operations panel, preview, PDF actions, and run actions.
- [ ] Move quotation and invoice builders to shared form, table, summary, and confirmation patterns without changing calculation or lifecycle logic.
- [ ] Migrate `/billing` using the shared catalog, entitlement, and usage presentation patterns.

#### Outreach and services

- [ ] Migrate outreach list, detail, import, drafts, delivery log, recipient filters, browser, and send controls.
- [ ] Migrate web-services list, import, filters, and destructive bulk controls.
- [ ] Retain import validation, export, test-email, sync, send, and delete failure feedback while replacing only their visual presentation.

#### Platform administration

- [ ] Migrate agencies list, creation, detail, staff, domains, API keys, status controls, and client management.
- [ ] Use the shared detail-page and confirmation patterns for revoke, remove, verify, set-primary, and status-change actions.
- [ ] Make sensitive values and irreversible actions visibly distinct without relying only on colour.

#### Authentication and account settings

- [ ] Restyle login, forgot-password, reset-password, and password-change screens with the same token and form system.
- [ ] Keep the auth experience intentionally simpler than the dashboard shell; do not mount authenticated navigation on public routes.
- [ ] Verify redirect, validation, rate/error messages, and password visibility controls after the restyle.

### 6. Remove duplication and enforce the system

- [ ] Replace `confirm-modal.tsx`, `edit-field-modal.tsx`, and duplicated form controls only after their shared replacements cover their current behaviour.
- [ ] Consolidate the existing table and filter components onto the data-table and toolbar contracts without forcing unrelated domain logic into one component.
- [ ] Remove temporary compatibility token aliases and obsolete component styles after all consumers have migrated.
- [ ] Search for hard-coded colours, inline emoji icons, duplicated modal markup, and repeated button/input class strings; resolve or explicitly justify each remaining case.
- [ ] Add short component usage notes beside non-obvious shared admin components so new routes extend the system instead of bypassing it.

### 7. Accessibility, responsiveness, and verification

- [ ] Check keyboard navigation, visible focus, tab order, escape-to-close dialogs, and focus return for every modal and mobile sheet.
- [ ] Verify semantic labels for icon-only controls, form errors, status changes, destructive actions, and loading states.
- [ ] Check contrast in light and dark themes, including muted text, badges, disabled controls, table headers, and error states.
- [ ] Test at narrow mobile, tablet, standard desktop, and wide desktop widths; tables must remain usable through responsive prioritization or horizontal scrolling.
- [ ] Test long names, empty lists, many filters, slow loading, API errors, and permission-denied states.
- [ ] Run `pnpm --dir client --filter admin exec eslint` for changed TypeScript/TSX files.
- [ ] Run `pnpm --dir client --filter admin exec tsc --noEmit`.
- [ ] Run `pnpm --dir client --filter admin build` before the final UI migration handoff.
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
