import { describe, expect, it } from "vitest";
import {
  agentLoopOperationKeyPrefix,
  workflowAgentLoopOperationKeyPrefix,
  workflowModelOperationKey,
} from "../src/runtime/operation-keys";

describe("durable model operation keys", () => {
  it("keeps independent hosted runs in separate operation-key scopes", () => {
    expect(agentLoopOperationKeyPrefix("run-a")).not.toBe(agentLoopOperationKeyPrefix("run-b"));
    expect(`${agentLoopOperationKeyPrefix("run-a")}:1:0`).toBe("activity:loop:run-a:1:0");
  });

  it("keeps workflow loop and node calls scoped to their run", () => {
    expect(workflowAgentLoopOperationKeyPrefix("run-a", "node-1")).toBe("workflow:agent-loop:run-a:node-1");
    expect(workflowModelOperationKey("run-a", "node-1")).toBe("workflow:model:run-a:node-1");
    expect(workflowModelOperationKey("run-a", "node-1")).not.toBe(workflowModelOperationKey("run-b", "node-1"));
  });
});
