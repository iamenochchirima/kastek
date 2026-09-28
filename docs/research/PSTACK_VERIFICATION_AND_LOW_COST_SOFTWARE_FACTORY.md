# pstack verification and a low-cost software factory for KasiTek

**Status:** Research and proposed approach, not an implementation plan or a claim that these checks already exist.

**Scope:** Lauren Tan's *The Complete Guide to pstack Pt. 1*, read with *Loops You Can Trust*, pstack's published skills, Cursor's cloud-agent documentation, and a limited inspection of this repository on 2026-09-26. The two articles were supplied in full in the conversation. [Part 1 original post](https://x.com/poteto/status/2094457600259842065); [Loops You Can Trust original post](https://x.com/poteto/status/2069824386283319343). The repository inspection below is a snapshot, not an exhaustive audit.

## The point of the article

Tan's central claim is that an agent must be able to *verify its own work in the real product*. Otherwise the developer remains the verification bottleneck, and more coding agents create more unproven changes to review. She treats the verification skill as maintained project infrastructure: a way to launch the app, drive user paths, inspect its state, collect proof, and clean up. In the earlier article, the same principle appears as a production line where triage, reproduction, fixing, and review each have evidence requirements and can stop bad work before it moves downstream. [Part 1](https://x.com/poteto/status/2094457600259842065); [Loops You Can Trust](https://x.com/poteto/status/2069824386283319343); [pstack verification guide](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/06-verify-and-ship.md).

The reported 2,000 PRs per month and 100-1000x output are Tan's account of her setting. They are not independently validated benchmarks, targets for KasiTek, or a basis for a cost estimate. The transferable idea is the method, not the volume.

## What she describes, and the smaller equivalent

| In Tan's account | What it does | Cost-conscious KasiTek equivalent |
| --- | --- | --- |
| A project-specific verification skill created with `/create-verification-skill` | Records how to launch, health-check, drive, observe, and clean up the actual app. The published generator requires a live end-to-end proof before handoff. | Start with one product and one critical user journey. Write a small repo-local verification guide around existing commands; execute it once before declaring it usable. |
| An agent-friendly control CLI, not a prose-only skill | Reuses reliable commands to navigate and inspect the app, reducing repeated exploratory tool calls. | Wrap only repeated steps such as `doctor`, `open`, `snapshot`, `send`, and `evidence`. Reuse Playwright and existing scripts; do not build a general automation platform. |
| A Feature Map | Gives agents short, user-facing directions to features and observable success states without loading the whole codebase. | Keep a small README index and one concise file per critical journey. Read one file per task, not the entire map. |
| Isolated cloud agents and environment snapshots | Each agent has its own computer, build, state, and proof artifacts; warm builds reduce startup cost. | Run one local verification session at a time first. Add isolated test data and process ownership. Use a second worktree or a cloud runner only when collision or wait time is measured and worth the cost. |
| `/maintain-verification-skill`, suggested daily in her high-volume setting | Checks the map and control instructions against source and the running app. The published skill distinguishes doc drift, harness gaps, and product regressions. | Update the affected feature file with each behavior-changing PR. Run a scheduled whole-map audit weekly or after notable UI churn; shorten that interval if drift becomes common. |
| `/poteto-mode`, specialist agents, and `/swarm` | Coordinates development and fans out independent verification, such as repeated performance trials or broad regression sweeps. | Use one implementer and one independent review pass for risky changes. Prefer deterministic test matrices over multiple model calls. Fan out only bounded, independent work whose extra cost answers a real uncertainty. |
| Screenshots, recordings, traces, and before/after comparisons | Let the reviewer challenge the claimed outcome without replaying the whole agent session. | Require the smallest proof that fits the claim: command output for a CLI, request/response and state read-back for an API, screenshot or short recording plus an assertion for UI, trace for performance. |
| A gardener who turns recurring failures into skills, lint rules, and architecture changes | Prevents the same error from reappearing across high-volume contributions. | Keep a short recurring-failures log. On the second or third repeat, prefer a test, lint rule, safer interface, or CLI command over another paragraph in `AGENTS.md`. |

The first four rows follow [the article](https://x.com/poteto/status/2094457600259842065), [the published generator](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md), [the maintenance skill](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-verification-skill/SKILL.md), and [the fictional example map](https://github.com/poteto/verification-skill-example). The cloud isolation and snapshot behavior is described in [Cursor's cloud-agent documentation](https://cursor.com/docs/cloud-agent). The right-hand column is a proposal for KasiTek, not something Tan prescribes or something already implemented here.

### Details worth keeping, even at small scale

The published `/create-verification-skill` does not accept a plausible Markdown file as proof. It first interviews the repo for its actual run commands, ports, authentication, seed data, existing harnesses, and isolation. Its generated instructions must cover Launch, Doctor, Drive, Evidence, and Cleanup. It seeds the top three to five user-facing features, but the initial handoff proof is deliberately narrower: launch the app, health-check it, drive **one** mapped feature end to end, save evidence, clean up, and confirm that the evidence survived. It prefers stable selectors over coordinates and requires the real user path and observable side effect. The remaining map entries are directions for later verification, not automatically verified coverage. This is a useful acceptance test for our first skill. [Generator source, steps 1-4](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md).

Tan's CLI example includes `doctor`, `new-session`, `send`, `snapshot`, `screenshot`, `wait-settle`, and feature flags. That is an example command vocabulary, not a command list to copy wholesale. The economic value comes from making frequent actions cheap and deterministic. The published example repository intentionally omits the driver script; it demonstrates the *shape* of the skill and map, not a ready-to-run control utility. [Part 1](https://x.com/poteto/status/2094457600259842065); [example repository](https://github.com/poteto/verification-skill-example).

Her Feature Map is operational memory. Each entry says what the user sees, how to reach it, how the control tool drives it, what success looks like, and what can mislead verification. The map does not replace the code as the source of truth. Its job is to prevent an agent from spending tokens rediscovering the same route and selectors on every task. The generator starts with three to five features; the maintenance skill checks the map against source and a live pass. [Generator source](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md); [maintenance source](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-verification-skill/SKILL.md).

Her parallelism advice is conditional. She discourages scaling local worktrees for her workload because of resource and state costs, then recommends Cursor cloud agents with isolated machines and saved builds. That does **not** establish that cloud execution is cheaper for a solo developer, or that worktrees are inherently wrong. Cursor's own documentation confirms that cloud agents run in separate VMs and that prepared builds can start subsequent agents faster. Those are capability facts; price, token usage, and review load still need measurement for this project. [Part 1](https://x.com/poteto/status/2094457600259842065); [Cursor cloud agents](https://cursor.com/docs/cloud-agent); [cloud-agent builds](https://cursor.com/docs/cloud-agent/builds).

## What this repository shows today

This is an inspected subset of the current repository, not a claim that no other tooling exists:

- [`client/apps/client/playwright.config.ts`](../../client/apps/client/playwright.config.ts) defines analytics-specific anonymous and authenticated projects, one worker, and traces and screenshots on failure. [`client/apps/client/package.json`](../../client/apps/client/package.json) has Playwright 1.62.1 and `test:e2e:analytics`. The inspected [`client/apps/client/e2e/`](../../client/apps/client/e2e/) files cover analytics, analytics auth, auth setup, and fixtures. This is reusable browser-test infrastructure, not evidence of Studio, calendar, or approval journey coverage.
- [`agents/package.json`](../../agents/package.json) exposes `test:e2e:local`. [`agents/scripts/local-e2e-smoke.ts`](../../agents/scripts/local-e2e-smoke.ts) checks REST and MCP credential exchange, discovery, idempotency, and durable `platform.current_time` execution, then removes its fixture. It is API/runtime verification, not a browser interaction test.
- [`scripts/run_local_stack.sh`](../../scripts/run_local_stack.sh) starts a local service set including Temporal and uses `gnome-terminal`, local environment files, and process-local configuration. It is a developer launcher, not yet an isolated headless verification environment. Its configured external credentials and shared local ports make accidental cross-run interference a design concern for future automation.
- The inspected [`.github/workflows/observability.yml`](../../.github/workflows/observability.yml), [`.github/workflows/analytics.yml`](../../.github/workflows/analytics.yml), [`.github/workflows/release-version.yml`](../../.github/workflows/release-version.yml), and [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml) contain targeted checks, including Rust checks and agents tests/build in observability. I did not find broad Studio/browser end-to-end gating in these workflows. External CI or uninspected workflows may add coverage.
- A repository text search did not reveal an obvious repo-wide Feature Map or app-control verification CLI. That is a search result, not proof of absence. Before implementing either, inspect any project-local skills and undocumented scripts in the chosen product.

The useful gap is narrower than "we have no tests." We have several lower-level checks. We have not established one reproducible, evidence-producing path from a Studio user action through the browser, agents API, Core, worker/Temporal, and visible result. A first verification effort should join the existing layers for *one* journey, not rebuild them.

## Minimum viable verification setup

**Choose one product and journey.** The current Agents Studio is a plausible first candidate because recent failures span browser state, model selection, API admission, Temporal execution, approvals, and UI reporting. That is a recommendation, not a settled product priority. Pick a fixture account and a safe operation such as a read-only calendar query or a staged approval path. Never make production calendar deletion the first automated proof.

**Make the local environment reproducible.** Document exact startup commands, required services, health endpoints, migrations, seed/reset procedure, test account, and fixture data. Use dedicated test credentials with least privilege. A verification command should refuse to run if it sees a non-test account, wrong database, unexpected port owner, wrong app revision, or missing Temporal worker. Reserve a unique data namespace per run even when execution is sequential. The current desktop launcher can remain useful for humans; the first scripted verifier may need a separate headless path. Do not silently repurpose the human's running processes. [Published generator's launch, doctor, isolation, and cleanup contract](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md).

**Build a small control command around existing tools.** This is a proposed interface, not an existing command:

```text
verify-kasitek doctor --json
verify-kasitek start --profile agents-studio-test --json
verify-kasitek run studio.read-calendar --fixture sample-user --evidence-dir <path> --json
verify-kasitek snapshot --json
verify-kasitek stop --run-id <id> --json
```

The first version can be a thin wrapper over Playwright, HTTP health checks, and existing local-stack scripts. Each command needs `--help`, structured output, useful failure messages, and an explicit timeout. Only add `--dry-run` to a destructive command if it actually guarantees no effects; verify that guarantee. `stop` must clean up only resources that `start` created, while leaving proof files intact. Avoid arbitrary browser evaluation or shell execution in the public command interface unless a specific verification task requires it. [Part 1](https://x.com/poteto/status/2094457600259842065); [published generator](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md).

**Write a short feature map.** Start with an index and three entries, for example Studio message send, model selection, and approval decision. Each entry needs prerequisites and account/entitlement, user route, stable browser handles, action, expected UI result, backend state read-back where applicable, cleanup, and known pitfalls. Mark any untested path `unverified`; do not let a generated map imply coverage it has not earned. Use one file per journey so a task need only load the relevant entry. [Feature-map example](https://github.com/poteto/verification-skill-example); [generator requirements](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md).

**Define proof by claim.** A browser screenshot alone cannot prove that a calendar event was deleted, and a 200 response alone cannot prove that the Studio displayed the right model. For a UI change, capture the interaction and visible result; for a durable workflow, correlate the UI run with the API/Temporal result; for an external effect, read back the fixture state from the test boundary. Capture console/network failures and traces on failure. Redact tokens, personal information, and third-party payloads before storing or attaching artifacts. Keep a small, bounded artifact set per run; a short video or trace is useful only when it answers a reviewer question. [Published evidence contract](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md); [Loops You Can Trust](https://x.com/poteto/status/2069824386283319343).

## The low-cost operating model

1. **One active implementation run per product.** Parallelize only independent reading or deterministic checks until isolated data, ports, and browser profiles are reliable. This avoids paying for agents that interfere with each other.
2. **Use cheap deterministic checks first.** Run targeted formatting, type checks, tests, and a smoke command before asking another model to review. A script can assert a model selection persisted or a run reached a terminal state more cheaply and consistently than a second agent guessing from a screenshot.
3. **Set a budget before each task.** Record a maximum number of model turns or tool calls, a wall-clock limit, and a maximum retry count. Stop on a missing fixture or broken environment instead of spending tokens repeatedly rediscovering the same problem. Track cost per *verified* change, not cost per generated PR. The numeric limits should come from observed runs; this document does not invent prices.
4. **Load narrow context.** Give the agent the relevant feature-map entry, task acceptance criteria, and affected code, not every plan and research document in the repo. Prefer a deterministic command's compact JSON result over a full browser transcript. Keep raw artifacts available for inspection.
5. **Reserve strong-model review for uncertainty.** Use an independent reviewer on permissions, external effects, schema changes, concurrency, or opaque failure modes. Do not pay for a panel of agents to re-run a deterministic test. Human review remains mandatory for a risky action and for merging.
6. **Use a PR as the handoff.** A modest PR includes the problem and scope, the exact test command, a concise proof link or artifact, the result, and known limits. Branch protection and focused CI can reject missing checks. Do not automate merge because an agent says a change is safe.
7. **Improve the factory from actual failures.** If three tasks fail because auth setup is fragile, fix auth setup. If agents misread the same flow, fix the feature entry. If they repeatedly introduce the same code defect, add a test, lint rule, or safer module boundary. Tan's earlier article explicitly prefers a deterministic script when the decision is not fuzzy. [Loops You Can Trust](https://x.com/poteto/status/2069824386283319343); [Build the Lever skill](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-build-the-lever/SKILL.md).

**When cloud parallelism might pay:** local verification is reliable; independent tasks queue behind machine capacity; each remote job can use an isolated fixture; startup is fast enough; and measured extra throughput outweighs model, compute, storage, and review costs. Cursor cloud agents can provide isolated VMs and warm builds, but they introduce remote code, secrets, and artifact retention decisions. If those conditions are not met, sequential local execution is the better default. [Cursor cloud agents](https://cursor.com/docs/cloud-agent); [builds](https://cursor.com/docs/cloud-agent/builds); [security and retention](https://prod.cursor.com/docs/cloud-agent/security).

## Maintenance without a daily swarm

The high-volume practice Tan describes in the article is to run `/maintain-verification-skill` at least daily. That is her recommendation for her workload, not a requirement of the current generator, which says to suggest a cadence only if the user asks. The published maintenance skill performs source comparison and a live pass, then reports `clean`, `changed`, or `blocked`; it does not rewrite product code to make an outdated map seem correct. [Part 1](https://x.com/poteto/status/2094457600259842065); [generator, step 5](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md); [maintenance skill](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-verification-skill/SKILL.md).

For one developer, use a cheaper cadence until evidence says otherwise:

- Update the affected map entry and verifier in the same PR as a behavior change.
- Run a quick `doctor` and one affected journey for every relevant PR.
- Run a full map pass weekly, after major navigation/auth changes, or when two runs encounter stale instructions.
- Record whether each failure is product regression, map drift, harness defect, fixture failure, or environment outage. Fix the correct layer.
- Increase frequency only if drift escapes into merged changes. Do not run a daily model-heavy audit just because Tan does.

## Phased checklist, not an authorization to implement

- [ ] Select one product and one safe, high-value journey. State its observable success and failure conditions.
- [ ] Inventory its existing start, test, auth, fixture, and cleanup paths. Confirm which services and data it actually touches.
- [ ] Make an isolated test profile with health checks and strict refusal of production accounts or endpoints.
- [ ] Add a thin, documented control command by reusing existing Playwright and scripts. Prove `doctor`, one drive, evidence preservation, and cleanup end to end.
- [ ] Seed a three-entry Feature Map. Label each entry `verified` only after a real drive.
- [ ] Add the smallest targeted browser/API check to existing CI without making every PR boot the full local stack. Use broader end-to-end checks on affected changes or a scheduled job first.
- [ ] Require a proof artifact and test result in PRs that change user behavior. Keep human review and merge control.
- [ ] Measure three to five runs: setup time, agent/tool use, verification time, false passes, rework, and reviewer time. Set actual budgets from those numbers.
- [ ] Add a second product only after the first verifier survives a cold run by an agent with little context.
- [ ] Consider cloud isolation or autonomous triage only after the local proof path is trustworthy and the economics justify it.

## Open decisions

The article cannot settle these for KasiTek: which product gets the first verification skill; whether a safe seeded account can exercise Studio, Core, Agents, and local Temporal together; whether the existing Playwright setup should gain a separate Studio project or a distinct config; where redacted proof artifacts live and for how long; which CI job can afford the full stack; and what budget ceiling is acceptable per verified change. Resolve these through one measured pilot, not by copying Tan's cloud setup or claimed scale.

**Release impact of this document:** not applicable. It changes no API, runtime behavior, analytics, deployment, or verification gate. Any future implementation should follow the repository's [release process](../internal/operations/release-process.md) and record its own validation, rollout, and rollback decisions.
