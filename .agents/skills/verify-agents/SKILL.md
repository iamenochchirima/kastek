---
name: verify-agents
description: Verify the Agents web interface and authenticated API using owned PostgreSQL, Restate and browser fixtures. Use for model-provider setup, model selection, configured chat and purpose-specific execution changes.
---

# Verify Agents

Use [source-boundary.md](../../../products/agents/docs/source-boundary.md) as the canonical
feature map. Its model-provider sections name the implemented routes, evidence and limitations.
Do not create a second feature map or infer live-provider support from controlled tests.

## Launch

Run commands from the repository root with Node24, pnpm dependencies, Docker and Playwright
Chromium installed. Supply `AGENTS_TEST_DATABASE_URL` through the local environment. It must
identify an authorized PostgreSQL administrator that can create disposable databases.

The browser command under **Drive** launches its own API, worker, frontend, controlled provider
and pinned Restate container. It chooses ports and creates a database and authenticated owner.
It waits for Restate health and the frontend before driving the UI. It does not require the
owner's app session or Keycloak account. Never apply setup to an existing shared database.

The evidence directory is fixed. Run only one provider-browser fixture at a time, even though
its runtime ports and database names are isolated. The fixture tears down its owned resources
in `finally` after either success or failure.

## Doctor

Before launching, check prerequisites without printing credentials:

```sh
node --version
docker info --format '{{.ServerVersion}}'
pnpm --filter @kasitek/agent-platform exec node -e '(async()=>{const b=await require("@playwright/test").chromium.launch();try{console.log("Headless Chromium ready");}finally{await b.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;})'
pnpm --filter @kasitek/agents exec node --input-type=module -e 'import {Pool} from "pg"; if(!process.env.AGENTS_TEST_DATABASE_URL) throw Error("AGENTS_TEST_DATABASE_URL is required"); const p=new Pool({connectionString:process.env.AGENTS_TEST_DATABASE_URL}); try {await p.query("SELECT 1"); console.log("PostgreSQL reachable");} finally {await p.end();}'
```

Stop if a prerequisite fails. The launcher checks application readiness and drives a fresh
authenticated owner session. After an unexpected browser or HTTP failure, inspect its failure
artifact and rerun this doctor check before another drive.

## Drive

For the controlled provider journey:

```sh
pnpm --filter @kasitek/agents exec node --import tsx test/model-provider-browser.ts
```

The existing Playwright driver opens provider settings, adds an account, runs a tool probe,
selects and saves a model, chats, switches models, rotates the key and revokes access. It uses
actual UI controls, including the **Message** textbox and **Send message** button. It asserts
native completed tasks and tool receipts, and refuses a further physical request after revocation.
The model and discovery boundaries are controlled. PostgreSQL, Restate, HTTP and the browser run.

For purpose-specific authenticated execution and authoritative outcome checks:

```sh
pnpm --filter @kasitek/agents exec vitest run test/model-purpose-acceptance.test.ts
```

Live calls need explicit approval for the account and exact model. They use the same browser
launcher with `AGENTS_LIVE_MODEL_ACCEPTANCE=1`, `AGENTS_LIVE_MODEL_ID` and an approved
`OPENROUTER_API_KEY` supplied locally. Never paste the key into commands or chat. The live path
verifies configured chat and a knowledge-tool round; it does not run the full controlled settings
journey or certify other providers. Do not substitute a model after an unavailable-model failure.

## Evidence

For five-channel engineering changes, use focused deterministic checks rather than the
provider/model drive above. The API files `channel-store`, `channel-provider-adapters`,
`channel-meta-adapters`, `telegram-setup`, `channel-meta-setup`, `channel-customer-admission`,
`channel-delivery`, `channel-policy-attachments`, `channel-lifecycle`, `channel-media-replies`
and `channel-routes` test protocols and owned database authority without inference or live
accounts. Select only files affected by a change. The `pauses website grants` test in
`customer-inbox-execution.test.ts` checks native pause authority without model execution.

Controlled browser cases are `customer-channels.spec.ts`, `website-appearance.spec.ts` and
`channel-support.spec.ts`. They exercise connection selection, Inbox drafts, mobile layout,
appearance, templates, attachment links and stable retry identity. Their mocked provider
boundaries do not establish live channel acceptance. Retain ignored screenshots/results under
`.artifacts/browser/` and inspect the relevant image before reporting interface verification.

The external runner remains Harbor. Its channel ports, isolated receipt suite and five
owner case manifests live in `products/agents/evaluation-adapters/harbor/`. Running those
evaluations, model-purpose suites or live account acceptance is owner work for this block.
Creating adapters/manifests or compiling their source does not count as running an evaluation.
The schema/runtime identities and enablement limits are in the canonical feature map and
`products/agents/README.md#customer-channels`.

Keep these ignored artifacts after cleanup:

- `.audit/model-provider-actual-browser/acceptance.json` and `revoked-model.png` for the controlled journey.
- `.audit/model-provider-actual-browser/live-acceptance.json` and `live-configured-chat.png` for approved live execution.
- `.audit/model-purpose-acceptance.json` for supported and unsupported purposes and native outcome evidence.

Record the reviewed commit, command, mode and exit status with the relevant artifact. Inspect
the receipt and native side effects rather than treating a screenshot or zero exit alone as proof.
Keep failed artifacts distinct from later passes. Do not export keys, private reasoning or raw
provider bodies. Existing receipts prove their recorded runs, not a later checkout automatically.

## Cleanup

The fixtures close their browser and owned processes, remove their named Restate container,
close database clients and delete only their generated database. Never kill by process name or
delete a shared database. After interruption, identify the exact owned container, process and
database from the run before removing anything. Preserve the evidence files.

## Helpers

This skill adds no helper scripts. Its launchers and assertions are the existing API test files
named above. Keep those commands and the canonical feature map aligned when behavior changes.

## Private organization assistant

For schema094/095 lifecycle, verified member identity, reviews and shared delivery, run controlled
checks against an owned PostgreSQL fixture with exact pgvector0.8.7. No inference or live channel
account is used by these tests:

```sh
pnpm --filter @kasitek/agents exec vitest run --no-file-parallelism test/organization-assistant.test.ts test/member-channels.test.ts test/member-channel-composition.test.ts test/task-control.test.ts
```

For actual coordinator → Content specialist execution, set `AGENTS_TEST_RESTATE_BINARY` to an
owned native Restate 1.7.13 executable. The test creates its own loopback runtime, worker, temporary
data and disposable database, then tears them down. This path does not require Docker:

```sh
pnpm --filter @kasitek/agents exec vitest run test/organization-assistant-runtime.test.ts
```

The deterministic model boundary verifies app/Telegram/WhatsApp delegation, app continuation,
revocation during child work, cancellation, duplicate requests, handler restart replay and child
failure. It is not a model evaluation or live provider trial. API runtime fixtures must never use
the owner's shared application database or credentials. Without both database and executable,
the runtime suite skips; report that explicitly.

`AGENTS_ASSISTANT_BROWSER=1` also drives the actual Vite/API/PostgreSQL/Restate path with Playwright
and fixture authentication. Keep one browser fixture at a time, inspect its ignored screenshot
artifacts and report actual browser execution separately from route-mocked web scenarios.
The web `test/assistant.spec.ts` suite covers responsive light/dark linking, lifecycle, delivery
states and specialist controls with mocked HTTP. Preserve and inspect its screenshots under
`.artifacts/assistant-browser/` or the explicitly selected output directory. The private assistant
[reference](../../../products/agents/docs/operations/private-assistant.md) records rollout and owner
acceptance limits. Passing controlled checks does not enable private phone access automatically.


## Adaptive specialist orchestration

Programv4 uses schema096, `product-capabilities-v13` and `AgentsBusinessRunV23`; retain older
handlers for accepted tasks. The [operation reference](../../../products/agents/docs/operations/adaptive-orchestration.md)
is authoritative for policy, tool semantics, permissions and rollout. Select focused checks from:

```sh
pnpm --filter @kasitek/agents exec vitest run --no-file-parallelism test/orchestration-contracts.test.ts test/orchestration-discovery-progress.test.ts test/adaptive-orchestration.test.ts test/continuation.test.ts test/platform-delegation-provenance.test.ts test/adaptive-specialist-skills.test.ts test/orchestration-routes.test.ts test/schema-upgrade-096.test.ts
```

Database suites require the owned PostgreSQL prerequisite above. Continue using the existing
organization-assistant runtime fixture for real Restate execution and distinguish deterministic
provider behavior from autonomous model judgment. Verify selected result provenance, UTF-8 paging,
same-specialist immutable follow-ups, source/member revocation, bounded repeated operations,
compaction, queued instructions, replay, cancellation and root-owned child settlement. Inspect the
actual operation/result records; a progress step marked completed is model-authored data.

The runtime suite accepts `AGENTS_TEST_RESTATE_BINARY` for the official Restate 1.7.13 native
binary when Docker is unavailable. It starts owned loopback services and removes its database
on completion. Set `AGENTS_ASSISTANT_COMPUTER_USE=1` and select the test named
`holds the real app for computer-use verification` to keep the actual API, worker, database and
frontend running for computer use. Read the disposable login URL from
`.audit/adaptive-computer-use.json`, then drive the app through the computer-use tool. The
fixture does not drive browser actions. Capture the visible final result and inspect persisted
root/child/operation records before stopping it with `.audit/adaptive-computer-use.stop`.
This mode uses controlled local provider responses and expires after 15 minutes; it does not
contact a live provider or prove model quality. Keep session cookies and model fixture keys out
of exported evidence. For phone updates also run `member-channels.test.ts` and the joined
Telegram/WhatsApp native cases; distinguish normalized ingress and controlled physical sends
from live-provider delivery.

For app changes run the affected assistant browser cases at desktop/tablet/mobile widths and
light/dark themes, including keyboard controls and active-root updates. Mocked routes are not a
real runtime check. Preserve screenshot evidence before reporting layout validation.

The owner-run cases and quality rubric are
`products/agents/evaluation-adapters/harbor/cases/adaptive-orchestration*.json`. They require an
owner-supplied driver/grader and do not constitute a runnable Harbor suite. Do not run model-purpose
or live-provider acceptance as part of these implementation checks. Compare autonomous quality,
cost and latency against a single-agent baseline only when the owner runs that acceptance.
