import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = new URL("../../../", import.meta.url);
const source = path => readFile(new URL(path, repository), "utf8");

test("agent presentation consumers use the shared public module", async () => {
  const consumers = [
    "products/growth/web/src/components/dashboard/agents/agent-conversation.tsx",
    "products/growth/web/src/components/dashboard/agents/agent-subagent.tsx",
    "products/growth/web/src/components/dashboard/agents/agent-execution.tsx",
    "products/agents/web/src/platform/chat.tsx",
    "products/agents/web/src/platform/execution-view.tsx",
    "products/agents/web/src/platform/message-content.tsx",
    "products/agency/web/src/screens/client-conversation-detail.tsx",
    "products/agency/web/src/screens/client-agent.tsx",
    "apps/admin-site/src/app/(dashboard)/conversations/[id]/page.tsx",
  ];
  for (const path of consumers) assert.match(await source(path), /from ["']@kasitek-labs\/ui\/agent["']/, `${path} must consume the shared agent UI export`);
});

test("page, dock and task hosts delegate to the established shared adapters", async () => {
  for (const path of [
    "products/growth/web/src/components/dashboard/agents/conversation-page.tsx",
    "products/growth/web/src/components/dashboard/agents/assistant-dock.tsx",
  ]) assert.match(await source(path), /from ["']\.\/agent-conversation["']/);
  assert.match(await source("products/agents/web/src/platform/task.tsx"), /from ["']\.\/execution-view["']/);
});
