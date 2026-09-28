# Solo agent development workflow proposal

**Status:** Proposal. This document does not enable a GitHub rule, CI job, deployment, or agent permission.

**Decision owner:** KasiTek founder. **Scope:** A repeatable development workflow for separate Agents, Business Growth, white-label, and central-services product repositories. Start with one repository; copy a proven minimum to the others.

## The operating rule

An agent may investigate, implement, test, commit, and prepare a pull request within an assigned task. It may not decide that its own proof is sufficient to merge, deploy, or use production credentials. The human owner makes those decisions after reading the evidence. An independent agent review is useful, but it is not an independent human approval.

The goal is a small number of *verified* changes that reach users safely. PR count is not the target. Lauren Tan's [Loops You Can Trust](https://x.com/poteto/status/2069824386283319343) describes a line where triage, reproduction, fixing, and verification can each stop weak work. Her [pstack Part 1](https://x.com/poteto/status/2094457600259842065) treats a maintained app-control skill and feature map as shared infrastructure. The [KasiTek verification study](PSTACK_VERIFICATION_AND_LOW_COST_SOFTWARE_FACTORY.md) translates that approach to a lower-cost local starting point. This proposal adds the Git and release workflow around it.

## What exists in this checkout, and what does not

This is a historical repository snapshot, not an audit of current GitHub settings or running infrastructure. The checked-out branch was `rewrite`; `main` also existed locally. The PR template present when this proposal was written has since been removed. The inspected [release-version](../../.github/workflows/release-version.yml), [observability](../../.github/workflows/observability.yml), [docs](../../.github/workflows/docs.yml), and [analytics](../../.github/workflows/analytics.yml) workflows ran focused checks on PRs and pushes to `main`, with read-only `contents` permission. They did not constitute a general PR gate.

The canonical [release process](../internal/operations/release-process.md) explicitly says general CI, staging deployment, production promotion, and rollback automation are incomplete. The [CI/CD plan](../archive/deferred-plans/CI_CD_RELEASE_PLAN.md) is marked **Draft / Not started**. Its target is task branch → PR → protected `main` → staging → promotion of the *same artifact* to production. It does not call for a permanent `develop` or `staging` branch. This proposal follows that target without pretending it is already enforced. GitHub-hosted branch rules and account permissions still need a separate configuration check.

## The proposed flow

One issue or written task owns one outcome. A single implementation agent owns its branch. Other agents can research or review, but should not edit the same worktree. At first, run only one implementation task per product at a time. Increase parallel work after builds, data, ports, and browser state are isolated and measured.

```text
Task → plan → baseline/reproduce → implement → verify → commit → draft PR
                                                              ↓
                               agent critique → human review → merge
                                                              ↓
                              staging → human release decision → production → monitor
```

At any arrow, weak evidence or a failed check stops the task. The agent-review step advises the human; it does not approve the PR on GitHub.

| Stage | Owner | Input | Required output or proof | Stop when |
| --- | --- | --- | --- | --- |
| Intake | Human | User report, idea, or maintenance signal | Problem, product, affected user path, expected outcome, priority, risk guess | The desired behavior or product owner is unclear |
| Scope and plan | Implementer agent; human approves material tradeoffs | Task plus relevant code, feature-map entry, release process | Small checklist, acceptance test, affected files/services, side effects, rollback idea | Work requires a new product decision, credential, or broader scope |
| Reproduce or baseline | Implementer agent | Current branch and safe fixture | Failing test or recorded current behavior; for a feature, a baseline user path | The environment is broken or the reported defect cannot be reproduced |
| Implement | Implementer agent | Approved scope and isolated task branch | Small, coherent code and documentation changes; tests proportional to risk | Change crosses an unapproved data, permission, or product boundary |
| Verify | Implementer agent, using deterministic tools first | Changed code and a real product path | Exact commands and results; for UI or integration work, before/after product evidence and state read-back where needed | Required check fails, evidence is missing, or the task still fails in the app |
| Commit and draft PR | Implementer agent | Verified branch | Reviewable commits, a draft PR with scope, proof, known limits, and the existing release record | The branch contains unrelated edits, secrets, or unexplained failures |
| Review | Separate reviewer agent, then human | PR diff, plan, tests, proof, affected contracts | Findings by severity; human checks the behavior claim, diff, risk, and release plan | A blocking finding is unresolved or proof does not match the claim |
| Merge | Human | Current PR head with passing required checks | Deliberate merge into protected `main`; record SHA | Head changed after review, checks regressed, or rollout is unclear |
| Release and close | Human release owner with automation where available | Merged SHA and tested artifact | Staging result, production decision, release identity, smoke result, monitoring, rollback record | Staging fails, artifact differs, or health signals cross the rollback threshold |

The human can ask for a tighter fix, close a false report, or park a risky change at any stage. A failed reproduction is useful evidence, not a reason for an agent to guess at a fix.

## Intake and task contract

Keep the intake small enough to read in a minute:

```text
Product/repo:
User or operational problem:
Current behavior and evidence:
Expected behavior and acceptance check:
Risk: low | standard | high
In scope / out of scope:
Known dependencies or open decisions:
```

A bug starts with reproduction. A feature starts with a user path and observable result. A refactor starts with the behavior that must remain unchanged. Do not ask an agent to "improve reliability" without a specific failure mode or measurable boundary. For non-trivial work, keep a short checklist in the task or `docs/plans/active/`, as [AGENTS.md](../../AGENTS.md) requires. A plan does not authorize unrelated changes.

## Branches, isolation, and commits

- Proposed branch names: `feat/<task-id>-<slug>`, `fix/<task-id>-<slug>`, or `chore/<task-id>-<slug>`, created from the current `main`. There is no permanent integration branch. The current local `rewrite` branch is not automatically a release branch or a reason to move ongoing work.
- Give each implementation agent its own checkout or worktree and task-scoped test data. Preserve pre-existing changes. Separate ports, browser profiles, app processes, and fixture namespaces when two runs may overlap. A worktree alone does not isolate runtime state.
- Commit after a coherent, verified slice, not after every tool call. Split commits when they clarify review or permit a safe revert, such as schema, backend, UI, and test changes. Do not manufacture many commits for a tiny change.
- Inspect `git diff --check`, status, and staged diff before each commit. Commit only task-owned paths. Never sweep in another agent's work or use destructive reset to clean a shared checkout.
- Push the task branch and open a **draft** PR when a coherent change exists. A draft is visible to CI and discussion but cannot be merged until marked ready. [GitHub's draft PR documentation](https://docs.github.com/en/pull-requests/reference/pull-requests) describes that behavior.
- Prefer a readable commit history. Choose squash merge for a single logical change; retain multiple commits only where their boundaries aid audit or revert. The human decides merge strategy per PR.

## PR proof packet and review

The proposal called for the following PR proof packet. It does not define a current repository template:

```text
Task and expected user outcome:
What changed, and what intentionally did not:
Risk and affected services/data:
Baseline or reproduction:
Checks run, exact commands, and results:
Real-product proof and artifact links, if applicable:
Known limits and untested cases:
Release record and rollback/disable action:
```

Evidence must match the claim. A screenshot can prove visible UI state, not a completed external effect. A `200` response cannot prove the UI selected the intended model. Use a safe fixture and read back state when the task changes data. Store small, redacted artifacts. Do not attach credentials, customer messages, full tokens, or unneeded personal data.

The implementer reviews its own diff first, including neighboring callers, failure paths, and deleted code. An independent reviewer agent then receives the task, plan, diff, and proof packet. It should report concrete findings with file locations, likely impact, and how to reproduce them; "looks good" is not evidence. The implementer resolves findings or records a reasoned disagreement. The human reviews the final changed head, not an earlier version of the PR.

The solo constraint matters: [GitHub says a PR author cannot approve their own PR](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request). Do not configure a mandatory second human approval if no authorized second human exists, and do not create a bot identity to pretend one does. For a one-person repo, use required PRs and status checks, a recorded self-review by the human, and an independent agent critique. For high-risk work that genuinely needs independent human approval, recruit a real qualified reviewer or defer the change. Check plan and repository visibility before relying on a particular GitHub ruleset feature. [GitHub's protected-branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches) describes what branch protection can enforce.

| Risk | Examples | Minimum review and proof | Release decision |
| --- | --- | --- | --- |
| Low | Copy, local styling, narrow internal docs | Relevant lint/build or doc check; visual proof only if appearance changed; human diff read | Merge after checks; release concerns marked `not applicable` where true |
| Standard | User workflow, API behavior, non-destructive integration | Targeted tests, affected real journey, independent agent review, human review, release record | Staging or equivalent isolated validation before production |
| High | Auth/permissions, payments, secret handling, destructive effects, schema/data migration, concurrency/durable execution | Failure-path and rollback tests, isolated end-to-end proof, compatibility/security review, independent agent critique, human decision; second human when needed | Explicit staging signoff and controlled production rollout; no autonomous merge or deploy |

Risk is about possible harm, not file count. A one-line authorization change may be high risk.

## CI and branch rules: the first enforcement layer

**Proposed, not installed:** configure `main` to require a PR, block direct pushes and force pushes, and require a small set of stable checks that always report a conclusion. Start with the current focused workflows plus a general `ci.yml` for lint, typecheck, unit tests, and build of affected packages. Add migration and browser checks according to risk and available runner time. Do not mark a check "required" before it exists and succeeds reliably. GitHub supports PR and status-check requirements through [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) or branch protection. [Required checks must pass](https://docs.github.com/en/pull-requests/reference/status-checks), but a required workflow skipped by path filtering can remain pending and block a PR; design the required job to report consistently. [GitHub troubleshooting guide](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

Do not copy the same exhaustive suite into every product repo on day one. Give each repo the same *contract* (PR, deterministic checks, proof, release record), then choose checks that run its actual product. Keep a slow full-stack smoke on affected PRs or a scheduled run until it is reliable and affordable. A red check stops the merge; "flaky" is a defect to investigate, not a standing waiver. Any emergency bypass needs a written reason, owner, follow-up, and manual validation.

For Actions, keep PR test jobs on `pull_request` with the minimum `GITHUB_TOKEN` permissions and no deployment secrets. The inspected workflows already use `contents: read`. GitHub warns that `pull_request_target` has elevated trust and becomes dangerous when it checks out and executes untrusted PR code. Do not use it as a shortcut to expose secrets to tests. [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use); [GitHub's `pull_request_target` guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

## Merge, release, and aftercare

Before merging, the human confirms: current-head checks are green; the proof answers the original task; agent-review findings are settled; no unrelated code or secrets entered the diff; and the [release record](../internal/operations/release-process.md) names owner, risk, affected services, version/release ID, contract/migration effect, rollout, analytics, logs/metrics, docs, validation, rollback, and post-release review date. Write `not applicable` where a field truly does not apply.

Merge is not deployment. The existing CI/CD plan proposes building immutable artifacts from `main`, testing them in isolated staging, then promoting the same artifacts to production after approval. Until that automation exists, the human must record the deployed commit/artifact and manually verify the equivalent gates; do not describe a manual rebuild as same-artifact promotion. Deployment credentials belong in scoped environment or host secret stores, never in PR CI or an agent's default environment. [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) can gate jobs and secrets, subject to plan and repo-visibility limits. If the sole operator triggers a deployment, enabling "prevent self-review" without another reviewer would deadlock the job; choose the setting deliberately.

After release, check the declared success and failure signals, record the outcome, and revert or disable when the rollback condition is met. Put repeated agent mistakes into a test, CLI command, lint rule, safer module boundary, or the relevant feature-map entry. Do not respond to every failure by lengthening `AGENTS.md`.

## A cheap first rollout

- [ ] Pick one product repo and one safe, high-value user journey. Confirm its current startup, auth, fixture, and cleanup procedure.
- [ ] Make its verification path reproducible with existing tests and a thin app-control command. Prove one journey end to end and preserve redacted evidence. Use the [verification study](PSTACK_VERIFICATION_AND_LOW_COST_SOFTWARE_FACTORY.md) as the design reference.
- [ ] Adopt the intake contract, one-agent branch ownership, existing PR release template, and human merge decision. Run a few PRs manually before automating triage.
- [ ] Add reliable general PR CI; then inspect GitHub settings and protect `main` with PR and required-check rules. Test a deliberately failing PR to prove the gate blocks it.
- [ ] Add an independent agent review for standard/high-risk PRs. Measure whether its findings save human review time; do not treat a review comment as approval.
- [ ] Implement staging and same-artifact promotion as a separate release workstream under the existing draft CI/CD plan. Do not claim those gates are live early.
- [ ] After three to five verified changes, record setup time, model/tool cost, CI time, reviewer time, defects caught, and rework. Use those numbers to choose budgets and whether a second agent or cloud runner pays for itself.
- [ ] Replicate the working minimum in the next product repo. Share templates or scripts only after two repos demonstrate the same need; keep product-specific feature maps and tests in their owning repos.

Weekly, the human reviews merged PRs, failed checks, escaped bugs, dependency alerts, and stale feature-map entries. Spend maintenance time on the failure that recurred, not a quota of new skills. Daily model-heavy audits and large agent swarms are not the default for a solo budget.

## Choices to settle during the pilot

1. Which product repository and user journey should go first?
2. What GitHub plan and repository visibility apply? These affect which protections and deployment reviewers are available.
3. Is there a second qualified human for high-risk reviews, or must those changes wait until one is available?
4. Where should redacted proof artifacts live, for how long, and who can access them?
5. Which checks are fast and stable enough to require on every PR, and which belong on affected paths or a schedule?
6. What is the maximum acceptable cost and elapsed time per **verified** change? Set numeric limits after the first measured PRs.

**Release impact of this document:** Not applicable. This proposal changes no runtime, API, analytics, deployment, or repository setting. Any implementation of these gates needs its own plan, validation, rollout, and rollback record under the [release process](../internal/operations/release-process.md).
