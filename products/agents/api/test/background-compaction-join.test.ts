import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { awaitBackgroundCompaction } from "../src/execution/business/business";

describe("background compaction join", () => {
  it("waits for the original job if a reused job also rejects the new send", async () => {
    const duplicate = new restate.TerminalError("the workflow method was already invoked", { errorCode: 409 });
    const seen:string[] = []; let reads=0;
    const ctx = {
      workflowClient: () => ({ run: async () => { seen.push("call"); throw duplicate; } }),
      invocation: () => ({ attach: async () => { seen.push("attach duplicate"); throw duplicate; } }),
      run: async (_name:string, operation:()=>Promise<unknown>) => operation(),
      sleep: async () => { seen.push("wait"); },
    } as unknown as restate.WorkflowContext;
    const pool = { query: async () => ({ rows: [{ id:"original-job", task_id:"original-task", source_groups:[],
      state: ++reads===1 ? "prepared" : "uncertain", error_code: reads===1 ? null : "MODEL_OUTCOME_UNKNOWN" }] }) } as unknown as Pool;
    const invocation = { invocationId: Promise.resolve("duplicate-invocation" as restate.InvocationId) };
    const result = await awaitBackgroundCompaction(ctx,pool,{ id:"original-job",taskId:"original-task",invocation },"join");
    expect(result).toMatchObject({ jobId:"original-job",taskId:"original-task",state:"uncertain",code:"MODEL_OUTCOME_UNKNOWN" });
    expect(reads).toBe(2);
    expect(seen).toEqual(["call","attach duplicate","wait"]);
  });
});
