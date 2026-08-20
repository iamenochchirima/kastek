# Agent Working Guide

This file defines the default working structure for implementation tasks in this repository.

## Project Direction

Use [`PROJECT_PLAN.md`](PROJECT_PLAN.md) as the repository's single reusable planning template when
a durable plan is useful. It contains no active product decisions; derive scope, ownership, and
constraints from the current task and codebase.

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
