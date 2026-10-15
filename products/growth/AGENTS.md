# Agent Working Guide

This file defines the default working structure for implementation tasks in this repository.

## Project Direction

For a multi-PR program that needs one shared execution sequence,
[`docs/plans/templates/PROJECT_PLAN.md`](docs/plans/templates/PROJECT_PLAN.md) is an optional
starting point. It contains no active product decisions.

## Documentation and Release Impact

For feature, API, data, integration, observability, deployment, or user-workflow changes:

- Read [`docs/internal/operations/release-process.md`](docs/internal/operations/release-process.md)
  and include its release-record decisions in the plan or pull request.
- Update current technical documentation in `docs/internal/` or supported user/API documentation
  in `docs/public/docs/` in the same change when behavior or contracts change.
- Do not create routine task plans in `docs/plans/active/`. Former plans are preserved in
  [`docs/plans/parked/`](docs/plans/parked/README.md) and are not an active work queue.
- Do not add roadmaps, go-to-market material, strategy, or historical execution notes to live
  documentation navigation.
- Add or update analytics, logging, metrics, runbook, version, migration, and rollback evidence
  when the change affects those areas. Record `not applicable` explicitly when it does not.

## Planning and execution

Before editing, inspect the relevant code and name the intended outcome, scope, and verification.
For ordinary work, keep a short checklist in the current session. Do not create a committed plan
file merely because a change spans files or layers.

Use a settled spec issue for substantial requirements, then split multi-session work into
independently verifiable implementation issues. Each issue should be understandable to a fresh
agent. Keep its acceptance criteria in the issue, its code and verification evidence in the pull
request, and current shipped behavior in the feature map.

A separate program plan is warranted only when several dependent changes need one shared
sequence, ownership boundary, and verification rule. Link it to the tracker items and agree its
location before creating it. Do not use `docs/plans/active/` or the uninstalled
`long-running-work` skill as a default workflow.

## Execution Order

Preferred working order:

1. Understand the current implementation.
2. State the outcome and verification; write a short in-session checklist when needed.
3. Implement in small coherent steps.
4. Update the checklist or linked issue as steps complete.
5. Verify with lint, tests, or build checks where appropriate.
6. Report what changed, what was verified, and what still remains.

## Parallel agent usage

When implementation work can be decomposed into independent workstreams,
use subagents to execute those workstreams in parallel.

If parallel delegation could meaningfully reduce wall-clock time, prefer
delegation over doing the work sequentially.

Keep architectural decisions and integration with the primary agent.
Avoid delegating trivial tasks where coordination overhead exceeds the benefit.

## Implementation Discipline

- Do not invent structure unnecessarily when an existing flow can be reused.
- Prefer extending the real implementation over building parallel placeholder logic.
- Keep styling and functionality migrations separate when possible.
- When restoring broken work, first re-establish the correct architecture, then polish.
- Avoid silent scope creep; reflect meaningful scope changes in the issue or approved spec.

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

## PROJECT FOUNDATION

Use the current repository map in [`ARCHITECTURE.md`](ARCHITECTURE.md), the user-facing route
inventory in [`docs/features/README.md`](docs/features/README.md), and the commands in
[`docs/internal/development/local-development.md`](docs/internal/development/local-development.md).
Read [`CODING_STANDARDS.md`](CODING_STANDARDS.md) for project-specific review rules and
[`docs/adr/README.md`](docs/adr/README.md) before recording a product-level architecture decision.
The project-local skill revisions and notices are in
[`docs/agents/skill-sources.md`](docs/agents/skill-sources.md).
The root [`CONTEXT.md`](CONTEXT.md) is intentionally empty at the owner's direction. Do not fill
it with guessed or generic terms; add domain language only after it is agreed.

## KEEP PROJECT RECORDS CURRENT

Treat the code and verified product behavior as evidence. Before changing a feature, read its
implementation issue when one exists, Project status, feature-map entry, and relevant technical
docs. If they disagree, identify the discrepancy before proceeding; do not copy an unverified
claim forward.

Update affected records in the same pull request:

- Keep requirements, acceptance criteria, dependencies, and blockers on the GitHub Issue.
- Keep approval, assignee, and work status in the Growth Project linked below.
  Only the owner moves an implementation issue to `Ready`. Agents must not infer approval from
  a label, a parent spec, or an unblocked dependency.
- Update [the feature map](docs/features/README.md) when shipped user behavior, entry points,
  or verification paths change. It describes what exists, not planned features.
- Update architecture, contracts, development instructions, and runbooks when the change makes
  their current descriptions inaccurate. Follow
  [documentation maintenance](docs/internal/operations/documentation-maintenance.md).
- Record a new ADR only for a qualifying architecture decision, not every implementation choice.

Before requesting review, state in the pull request which records changed, link the changes,
and explain which records were unaffected. Include evidence for claims about the running product.
Do not mark an issue `Done` until its change is merged and verified. After merge, confirm the
issue and Project status agree with what landed.

If a record cannot be verified or updated, report the gap in the pull request. Do not silently
declare the work complete.

## SPECS AND ISSUES

Store specs, tasks, and bugs in [GitHub Issues](https://github.com/Kasitek-Labs/kasitek-growth/issues).
The [Kasitek Growth Project](https://github.com/orgs/Kasitek-Labs/projects/1) owns approval,
assignee, and work status; pull requests hold changes and review evidence. Query the live issue
list and Project before choosing work. Do not copy their current contents into repository docs.
Use `gh issue list --repo Kasitek-Labs/kasitek-growth --state open` and
`gh project item-list 1 --owner Kasitek-Labs --format json` to inspect them.

Use `to-spec` for settled multi-session work and `to-tickets` when a split is useful. Get owner
approval before publishing the split. Do not create multiple tickets for a small change. Begin
an implementation issue only after the owner approves it and sets Project status to `Ready`;
a parent spec or `ready-for-agent` label is not approval. Keep issue cards assigned to
`iamenochchirima` while the owner works solo. After an issue is closed as `not planned`, archive
its Project card rather than counting it as `Done`; verify the resulting status.

## AGENT WORKFLOW

For an owner-approved pilot task, use the project-installed `enoch-mode` skill and read only the
playbook for the current task. Follow this repository's issue approval, verification, and release
rules first. The pilot does not authorize unrelated backlog work, pushing, opening a pull request,
merging, or deploying.

## PULL REQUESTS

For substantial, multi-phase, or unattended work that will lead to a pull request, use the
project-installed `show-me-your-work` skill. Keep its local decision trail at
`.audit/<task-slug>.tsv`; `.audit/` is ignored by git. A pull request must say why and what changed,
what was actually verified, and any known risk or unfinished work. Link a committed decision
trail only when the reviewer needs it. Never claim a check passed without evidence.

## CODE REVIEWS

When reviewing a branch or pull request, use the project-installed `code-review` skill and compare
the change with its base branch. Read `CODING_STANDARDS.md` and its linked standards before the
Standards review. Supply the originating issue or spec for the Spec review. Report Standards and
Spec findings separately. If no issue or spec exists, say the Spec review was skipped.
