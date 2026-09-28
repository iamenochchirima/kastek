# Issue tracker

## Selected tracker

Use GitHub Issues in [`Kasitek-Labs/kasitek-growth`](https://github.com/Kasitek-Labs/kasitek-growth)
for specs, implementation issues, and bugs. Do not create a second Markdown issue/spec store or
mirror work in another tracker.

The repository currently has one open issue, [#2, Implement provider-neutral OpenTelemetry
infrastructure](https://github.com/Kasitek-Labs/kasitek-growth/issues/2). It is not evidence that
the issue has owner approval to start.

## GitHub Project

The organization-owned [Kasitek Growth Project](https://github.com/orgs/Kasitek-Labs/projects/1)
is private and linked to `Kasitek-Labs/kasitek-growth`. It is the board for this repository; do
not create another tracker. Its job is to show proposed work, owner-approved work, ownership,
blockers, and review progress. Issues hold requirements; pull requests hold code and verification.
The Project does not duplicate either. While this is a solo project, assign every issue card to
`iamenochchirima`. Agents do not change the assignee to themselves.

The owner, `iamenochchirima`, explicitly approves an implementation issue and moves it to
`Ready`. A spec issue, a `ready-for-agent` label, a cleared dependency, or an agent's own judgment
is not approval. This is an instruction, not a GitHub-enforced permission gate. Issue
[#2](https://github.com/Kasitek-Labs/kasitek-growth/issues/2) is assigned to the owner in
`Backlog` and was not approved to start by this setup.

The saved [Backlog table](https://github.com/orgs/Kasitek-Labs/projects/1) is filtered to
`Backlog`. The `Work board` uses Status columns. Intake and status changes are manual; no
auto-add or PR-card workflow was enabled. Do not add a separate PR card for the same work.

The Project's `Status` field means:

| Status | Meaning |
| --- | --- |
| `Backlog` | Tracked, but not approved to start. |
| `Ready` | Owner-approved implementation issue; an agent may claim it. |
| `In progress` | Implementation underway. |
| `In review` | Pull request submitted for review. |
| `Done` | Merged and verified; deployment is tracked separately. |

Only the owner moves an implementation issue to `Ready`. Move it to
`In progress` when work starts and `In review` when its pull request is ready for review. Close the issue and
move it to `Done` only when the change is merged and verification is recorded. GitHub's linked
pull requests field shows PR associations; use `Closes #<issue-number>` in the PR body to link the
implementation PR to its issue. Status changes are manual until an automation is deliberately
configured and verified.

Record blockers on the issue while leaving its Project card visible. The agent must give the
`code-review` skill the implementation issue or parent spec explicitly; a linked PR alone may
not supply that review input.

Use `gh project item-list 1 --owner Kasitek-Labs --format json` to read items and
`gh project field-list 1 --owner Kasitek-Labs --format json` to inspect the current field option
IDs. Add a repository issue with
`gh project item-add 1 --owner Kasitek-Labs --url <issue-url>`. To change its status, use
`gh project item-edit --project-id <project-id> --id <item-id> --field-id <status-field-id> --single-select-option-id <option-id>`.
Get the item ID from `item-list` and the project, field, and option IDs from `project view` and
`field-list`. Verify the result with `item-list`; do not assume a successful command means the
desired status was applied.
Assign the issue to the owner with
`gh issue edit <number> --repo Kasitek-Labs/kasitek-growth --add-assignee iamenochchirima`.

## Agent operations

The repo-specific command-line interface is GitHub CLI (`gh`). Confirm authentication with
`gh auth status` before writing. Use the repository explicitly in each command:

```sh
gh issue list --repo Kasitek-Labs/kasitek-growth --state open
gh issue view <number> --repo Kasitek-Labs/kasitek-growth
gh issue create --repo Kasitek-Labs/kasitek-growth --title "..." --body-file <path>
gh issue edit <number> --repo Kasitek-Labs/kasitek-growth --body-file <path>
gh issue close <number> --repo Kasitek-Labs/kasitek-growth
```

Link an implementation pull request to its issue with GitHub's closing syntax in the PR body
(for example, `Closes #123`). Keep requirements and acceptance criteria on the issue, implementation
and verification evidence in the PR, and shipped behavior in the feature map.

## Work states and approval

For substantial multi-session work, use `to-spec` to publish a parent spec issue after the owner
settles the requirements. Use `to-tickets` to propose smaller implementation issues, then get the
split approved before publishing. Small changes can use one issue without a parent.

An agent may start only an implementation issue explicitly approved by the owner and marked
`Ready` in the configured Project. A parent spec, being present on the board, or carrying a label
does not by itself approve implementation. Project read and write access was verified using the
GitHub CLI after granting its `project` scope.

The repository has the exact [`ready-for-agent` label](https://github.com/Kasitek-Labs/kasitek-growth/labels/ready-for-agent)
used by `to-spec` and `to-tickets`. A parent spec may carry it too, so it does not authorize
implementation. No existing issue was relabeled during setup. Do not install or use `triage`
unless the owner separately opts into an incoming-report triage flow.
