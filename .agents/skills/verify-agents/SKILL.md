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
