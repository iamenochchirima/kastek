# Agent Working Guide

This file defines the default working structure for implementation tasks in this repository.

## Project Direction

Use [`docs/plans/templates/PROJECT_PLAN.md`](docs/plans/templates/PROJECT_PLAN.md) as the repository's single reusable planning template when
a durable plan is useful. It contains no active product decisions; derive scope, ownership, and
constraints from the current task and codebase.

## Documentation and Release Impact

For feature, API, data, integration, observability, deployment, or user-workflow changes:

- Read [`docs/internal/operations/release-process.md`](docs/internal/operations/release-process.md)
  and include its release-record decisions in the plan or pull request.
- Update current technical documentation in `docs/internal/` or supported user/API documentation
  in `docs/public/docs/` in the same change when behavior or contracts change.
- Keep temporary implementation plans and checklists in `docs/plans/active/`; move finished work
  to `docs/plans/completed/`.
- Do not add roadmaps, go-to-market material, strategy, or historical execution notes to live
  documentation navigation.
- Add or update analytics, logging, metrics, runbook, version, migration, and rollback evidence
  when the change affects those areas. Record `not applicable` explicitly when it does not.

## Default Rule

When implementing anything non-trivial, always start with a plan.

Do not jump straight into edits unless the task is genuinely tiny and isolated.

## Planning Standard

Before making meaningful code changes:

1. Build enough context from the relevant files.
2. Write an explicit plan.
3. Keep the plan visible and updated while working.

The plan should be the default execution structure, not an exception.

## Plan Format

Use a short structured checklist similar to:

- Restore or update the required backend/data layer pieces first
- Rebuild the relevant UI flow on top of the real functionality
- Reconnect integrations, validation, and edge cases
- Run verification and report any remaining gaps

Or, when helpful, use status markers such as:

- `in_progress`
- `pending`
- `completed`

## When a Plan Is Required

Use a plan by default for:

- feature work
- refactors
- route migrations
- styling migrations
- data model changes
- API changes
- debugging that spans multiple layers
- anything involving more than one file

## When You May Skip a Plan

You may skip a written plan only when the task is extremely small, for example:

- changing one line of copy
- fixing a single obvious class name
- adjusting one import

If there is any real implementation uncertainty, use a plan.

## Execution Order

Preferred working order:

1. Understand the current implementation.
2. Publish a plan.
3. Implement in small coherent steps.
4. Update the plan as steps complete.
5. Verify with lint, tests, or build checks where appropriate.
6. Report what changed, what was verified, and what still remains.

## Implementation Discipline

- Do not invent structure unnecessarily when an existing flow can be reused.
- Prefer extending the real implementation over building parallel placeholder logic.
- Keep styling and functionality migrations separate when possible.
- When restoring broken work, first re-establish the correct architecture, then polish.
- Avoid silent scope creep; reflect meaningful scope changes in the plan.

## Technical Documentation Style

- Write in a normal human, direct technical tone.
- State what the system does, what a decision means, and what remains unknown without promotional framing.
- Prefer concrete nouns, active language, and short explanations over slogans, broad claims, or "vision" language.
- Do not use generic AI-marketing phrases such as "powerful," "seamless," "transformative," "unlock," or "the future of" unless they are technically necessary and supported by a specific explanation.
- Treat architecture documents as engineering references, not sales material. Explain tradeoffs, ownership, constraints, and open decisions plainly.

## UI Copy & Content Rules

Keep interface copy extremely concise.

### Never explain the interface to the user

Do not add instructional or conversational UI text unless it is genuinely necessary for completing the task.

Bad:

> Connect your agents here and manage them without leaving this page.

Good:

> Connect agent

Bad:

> View all your conversations and respond to customers from one place.

Good:

> Conversations

Bad:

> You haven't created any campaigns yet. Create your first campaign to start reaching your customers.

Good:

> No campaigns yet
>
> [Create campaign]

### Do not narrate product design decisions

Never expose implementation, navigation, or design decisions in UI copy.

Bad:

> Manage connections here instead of from the sidebar.

Bad:

> We've made it easier to access your agents.

Bad:

> Use this section to manage your integrations.

The UI should communicate these things through its design.

### Empty states

Use:

- Short title
- Optional one-sentence description only when clarification is necessary
- Primary action

Prefer:

> No agents yet
>
> [Create agent]

Instead of:

> You haven't created any AI agents yet. Agents can help automate your business processes. Click the button below to get started.
>
> [Create your first agent]

### General tone

- Product UI, not marketing copy.
- Concise and functional.
- No unnecessary explanations.
- No conversational filler.
- No feature narration.
- No congratulatory text unless meaningful.
- Avoid "Here you can...", "Use this to...", "This allows you to...", "From here...", and similar phrasing.
- Prefer labels over sentences.
- Prefer 2–5 word headings.
- Buttons should normally be 1–3 words.
- Descriptions should normally be one short sentence or omitted.

## Frontend / UX Rules

### Native Browser UI — Forbidden

Never use native browser dialogs in application UI:

- `alert()`
- `confirm()`
- `prompt()`
- `window.alert()`
- `window.confirm()`
- `window.prompt()`

Always use application UI instead.

| Need | Use |
| --- | --- |
| Confirmation | Custom confirmation dialog |
| Destructive confirmation | Destructive-action dialog |
| Input request | Form or modal |
| Information | Toast, banner, inline feedback, or modal |
| Success | Toast or inline state |
| Error | Toast or inline error state |

Bad:

```ts
if (confirm("Delete this agent?")) {
  deleteAgent();
}
```

Good:

```tsx
<ConfirmDialog
  title="Delete agent?"
  description="This action cannot be undone."
  confirmLabel="Delete"
  variant="destructive"
  onConfirm={deleteAgent}
/>
```

Reuse the project's existing modal and dialog components before creating new ones.

### Modals and dialogs

Use custom application dialogs for confirmations and focused actions. Dialogs must:

- Match the application's design system.
- Support light and dark themes.
- Have clear primary and secondary actions.
- Close on Escape where appropriate.
- Handle focus correctly.
- Have accessible labels.
- Prevent accidental destructive actions.

Destructive actions should clearly distinguish **Cancel** from **Delete**. Never
use a generic browser confirmation as a shortcut.

### Toasts

Use toasts for transient feedback, including saved, copied, updated, deleted,
successful connections, and failed background actions. Do not use modals for
simple success messages.

Bad: a modal stating that settings were saved.

Good: a toast stating **Settings saved**.

### Destructive actions

Never immediately execute significant destructive actions from a single click.
For actions such as deleting an agent or campaign, disconnecting an integration,
removing a team member, or deleting an API key, require an appropriate custom
confirmation. Require stronger confirmation for particularly destructive actions
when justified.

### Loading states

Never leave the UI appearing frozen during asynchronous operations. Use the
appropriate skeleton, spinner, progress state, or disabled button with a loading
indicator. Prefer skeletons for initial content loading.

Do not replace an entire page with a large centred spinner when a skeleton can
preserve the page structure.

### Responsive design and density

Every UI element must have intentional responsive behavior and an appropriate
density at the approved desktop, tablet, and mobile breakpoints. Do not treat
mobile as a desktop layout squeezed into a narrower viewport.

Before a UI change is complete, verify:

- The element's layout, spacing, text wrapping, and hit area at each supported
  breakpoint.
- Whether controls should remain visible, collapse, scroll, stack, move into a
  menu, or be replaced by a mobile-specific affordance.
- That tables and dense data layouts have an intentional small-screen treatment.
- That the application shell, navigation, panels, dialogs, and overlays work
  together at desktop, tablet, and mobile widths.

Use the central responsive and density rules in the active project plan. A
component that only works at one viewport is incomplete.

### Empty states

Keep empty states minimal and follow the existing UI Copy & Content Rules.

Prefer:

> No campaigns yet
>
> [Create campaign]

Avoid paragraphs explaining the page unless the information is necessary.

### Forms

- Validate inline.
- Show errors near the relevant field.
- Preserve user input after validation errors.
- Disable submission while submitting when duplicate requests are possible.
- Never use `alert()` for validation.
- Do not show validation errors before the user has interacted with a field,
  unless submission was attempted.

### Components

Before creating a new UI primitive:

1. Search the existing component library.
2. Reuse an existing component where appropriate.
3. Extend existing variants if necessary.
4. Create a new primitive only when no suitable one exists.

Do not create slightly different versions of a modal, button, input, select,
dropdown, toast, tooltip, card, or badge. Maintain visual consistency.

### UX philosophy

Prefer:

- Obvious UI over explanatory text.
- Direct manipulation over instructions.
- Visual hierarchy over descriptions.
- Progressive disclosure over showing everything.
- Contextual actions over duplicated actions.
- Concise labels over sentences.
- Application UI over browser-native UI.

The interface should explain itself through good design. If it requires a
paragraph explaining how to use it, first consider whether the UI itself should
be improved.

## Release completeness

For any non-trivial feature, API, data, integration, background-worker, or operational change,
read [`docs/internal/operations/release-process.md`](docs/internal/operations/release-process.md)
and account for release impact in the written plan. Before considering the work complete, record
the decisions for documentation, analytics, structured logging, version/release identity,
validation, rollout, and rollback. Use `not applicable` explicitly when a concern does not apply.

The release-process document is canonical. Keep this file to enforcement rules and links; do not
copy the full release checklist into `AGENTS.md`.

## Verification Rule

After implementation, always run the most relevant verification available:

- lint for local file changes
- build for integration-sensitive changes
- targeted runtime checks for flows like auth, inbox, campaigns, or PWA behavior

If verification cannot be completed, state that clearly.

## Expected Outcome

The default behavior in this repo should be:

- inspect
- plan
- implement
- verify

Not:

- improvise
- patch blindly
- explain later
