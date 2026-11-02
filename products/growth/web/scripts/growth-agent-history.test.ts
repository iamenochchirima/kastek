import test from "node:test";
import assert from "node:assert/strict";
import type { GrowthAgentRuntimeOperation } from "@kasitek-labs/contracts";
import { mergeGrowthOperationHistory } from "../src/components/dashboard/agents/agent-execution";
const operation=(id:string,patch:Partial<GrowthAgentRuntimeOperation>={}):GrowthAgentRuntimeOperation=>({id,taskId:"root",agentName:"Assistant",kind:"tool",label:"Read content",state:"started",startedAt:"2026-11-02T10:00:00Z",completedAt:null,durationMs:0,errorCode:null,...patch});
test("history and live metadata share immutable identities and latest settlement wins",()=>{
 const early=operation("read"),settled=operation("read",{state:"completed",completedAt:"2026-11-02T10:00:05Z",durationMs:5000});
 assert.deepEqual(mergeGrowthOperationHistory("root",[early,early],[settled]),[settled]);
 assert.deepEqual(mergeGrowthOperationHistory("root",[settled],[early]),[settled]);
});
test("root history excludes another task's operations and repeated model-call bookkeeping",()=>{
 const own=operation("read"),foreign=operation("foreign",{taskId:"child"}),model=operation("generate",{kind:"model"});
 assert.deepEqual(mergeGrowthOperationHistory("root",[foreign,model],[own,foreign]),[own]);
});
test("earlier history is chronological and duplicate pages do not duplicate actions",()=>{
 const first=operation("first"),later=operation("later",{startedAt:"2026-11-02T10:00:10Z"});
 assert.deepEqual(mergeGrowthOperationHistory("root",[later,first,later],[later]),[first,later]);
});
