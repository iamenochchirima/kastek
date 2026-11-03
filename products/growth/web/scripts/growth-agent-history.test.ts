import test from "node:test";
import assert from "node:assert/strict";
import type { GrowthAgentRuntimeOperation, GrowthAgentTask } from "@kasitek-labs/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentExecutionView } from "@kasitek-labs/ui/agent";
import { mergeGrowthOperationHistory } from "../src/components/dashboard/agents/agent-execution";
import { growthExecution } from "../src/lib/growth-agent-presentation";
const operation=(id:string,patch:Partial<GrowthAgentRuntimeOperation>={}):GrowthAgentRuntimeOperation=>({id,taskId:"root",agentName:"Assistant",kind:"tool",label:"Read content",state:"started",startedAt:"2026-11-02T10:00:00Z",completedAt:null,durationMs:0,errorCode:null,...patch});
test("history and live metadata share immutable identities and latest settlement wins",()=>{
 const early=operation("read"),settled=operation("read",{state:"completed",completedAt:"2026-11-02T10:00:05Z",durationMs:5000});
 assert.deepEqual(mergeGrowthOperationHistory("root",[early,early],[settled]),[settled]);
 assert.deepEqual(mergeGrowthOperationHistory("root",[settled],[early]),[settled]);
});
test("root history excludes another task's operations and retains model measurements for shared presentation",()=>{
 const own=operation("read"),foreign=operation("foreign",{taskId:"child"}),model=operation("generate",{kind:"model"});
 assert.deepEqual(mergeGrowthOperationHistory("root",[foreign,model],[own,foreign,model]),[model,own]);
});
test("earlier history is chronological and duplicate pages do not duplicate actions",()=>{
 const first=operation("first"),later=operation("later",{startedAt:"2026-11-02T10:00:10Z"});
 assert.deepEqual(mergeGrowthOperationHistory("root",[later,first,later],[later]),[first,later]);
});
test("Growth preserves a rejected provider 503 and measured duration in shared task presentation",()=>{
 const task={id:"task-503",conversationId:"conversation",featureId:"content",state:"failed",input:"Improve this draft",output:null,
  errorCode:"MODEL_PROVIDER_UNAVAILABLE",createdAt:"2026-11-03T00:00:00Z",updatedAt:"2026-11-03T00:00:03Z",
  runtime:{version:1,observedAt:"2026-11-03T00:00:03Z",elapsedMs:3000,model:{id:"fixture-model",provider:"fixture",latencyMs:null,firstTokenMs:null,outputTokensPerSecond:null},
   context:{estimatedInputTokens:null,inputLimitTokens:null,windowTokens:null,reservedOutputTokens:null,safetyTokens:null,utilizationPercent:null,compactionCount:0,lastCompactedAt:null,historyGroups:null,sourceCount:null},
   usage:{accountedTokens:0,inputTokens:null,outputTokens:null,modelCalls:1,toolCalls:0,observedModelCalls:0},operations:[],operationsTruncated:false},
 } as GrowthAgentTask;
 const execution=growthExecution(task),html=renderToStaticMarkup(createElement(AgentExecutionView,{execution}));
 assert.equal(execution.errorCode,"MODEL_PROVIDER_UNAVAILABLE");
 assert.equal(execution.elapsedMs,3000);
 assert.match(html,/The model is unavailable\. Try again later\./);
 assert.doesNotMatch(html,/Outcome unknown/);
 assert.match(html,/3s/);
});
