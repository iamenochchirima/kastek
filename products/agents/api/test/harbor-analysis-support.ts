/** Actual gVisor analysis support for Harbor's normal external trial fixture. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Pool } from "pg";
import type { AgentConfiguration } from "../src/contracts/contracts";
import type { PrivateObjectStore } from "../src/infrastructure/object-store";

export async function prepareHarborAnalysis(input:{pool:Pool;configuration:AgentConfiguration;objects:PrivateObjectStore;directory:string;gateway:string;load:(name:string)=>unknown}) {
  const {sandboxManagerFromEnvironment}=input.load("capabilities/sandbox/sandbox.js") as typeof import("../src/capabilities/sandbox/sandbox");
  const {createSandboxExecutor}=input.load("capabilities/sandbox/sandbox-executor.js") as typeof import("../src/capabilities/sandbox/sandbox-executor");
  Object.assign(process.env,{AGENTS_SANDBOX_ENABLED:"1",AGENTS_SANDBOX_DIRECTORY:join(input.directory,"analysis-allocations")});
  const manager=sandboxManagerFromEnvironment(input.pool)!;assert.ok(await manager.available(),"Actual pinned gVisor analysis profile is required");
  input.configuration.sourceRevisionIds=[];input.configuration.tools=["sandbox.analyze"];
  input.configuration.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};
  input.configuration.instructions="Analyze the supplied values using isolated Python. Save analysis.json and report the computed total.";
  const verifierKey=randomBytes(32).toString("base64url");
  const server=createServer(async(request,response)=>{
    if(request.method!=="GET"||request.url!=="/verification/analysis"||request.headers.authorization!==`Bearer ${verifierKey}`){response.writeHead(403).end();return;}
    try{
      const rows=(await input.pool.query(`SELECT a.id,a.task_id,a.operation_id,a.state,a.profile_id,c.id command_id,c.state command_state,c.exit_code,c.export_receipt
        FROM agents_platform.sandbox_allocations a JOIN agents_platform.sandbox_commands c ON c.allocation_id=a.id ORDER BY a.created_at`)).rows;
      response.setHeader("content-type","application/json");response.end(JSON.stringify({allocations:rows}));
    }catch{response.writeHead(503).end();}
  });
  await new Promise<void>(resolve=>server.listen(0,input.gateway,resolve));
  const code="import json\nvalues=[7,11,24]\nresult={'values':values,'total':sum(values)}\nwith open('/scratch/output/analysis.json','w') as f: json.dump(result,f,sort_keys=True)\nprint(result['total'])";
  return {
    executeSandbox:createSandboxExecutor(input.pool,manager,input.objects),
    verifierEnvironment:{KASITEK_VERIFIER_ANALYSIS_URL:`http://${input.gateway}:${(server.address() as {port:number}).port}/verification/analysis`,KASITEK_VERIFIER_ANALYSIS_KEY:verifierKey},
    reply(body:{messages:{role:string;content?:string|null}[]},call:number){
      if(call===1)return Response.json({id:"actual-analysis-planning",choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"isolated-analysis-call",type:"function",function:{name:"sandbox_analyze",arguments:JSON.stringify({code})}}]}}],usage:{prompt_tokens:100,completion_tokens:30}});
      assert.equal(call,2,"Analysis fixture permits one tool round");
      const tool=body.messages.find(message=>message.role==="tool");assert.ok(tool?.content,"The next model call must observe the actual sandbox receipt");
      const observed=JSON.parse(tool.content);assert.equal(observed.state,"completed");assert.equal(observed.exitCode,0);assert.equal(observed.stdout.trim(),"42");assert.equal(observed.artifacts[0].name,"analysis.json");
      return Response.json({id:"actual-analysis-answer",choices:[{finish_reason:"stop",message:{role:"assistant",content:"The computed total is 42. The analysis is saved in analysis.json."}}],usage:{prompt_tokens:100,completion_tokens:20}});
    },
    async verify(){
      const allocations=(await input.pool.query("SELECT state FROM agents_platform.sandbox_allocations")).rows;
      assert.equal(allocations.length,1);assert.equal(allocations[0].state,"destroyed");
      assert.equal((await input.pool.query("SELECT count(*)::int count FROM agents_platform.sandbox_commands")).rows[0].count,1);
      const operation=(await input.pool.query("SELECT id,attempt_id FROM agents_platform.operations WHERE name='sandbox.analyze'")).rows[0];
      const observation=(await input.pool.query("SELECT observation FROM agents_platform.task_events WHERE kind='resource.cleanup'")).rows[0].observation;
      assert.equal(observation.metadata.outcome,"completed");assert.equal(observation.identity.operationId,operation.id);assert.equal(observation.identity.attemptId,operation.attempt_id);
      const {collectNativeMetrics,createNativeMetrics}=input.load("observability/metrics.js") as typeof import("../src/observability/metrics");
      assert.equal((await collectNativeMetrics(input.pool,"worker")).find(point=>point.name==="agents.resources.cleanup"&&point.attributes.kind==="sandbox"&&point.attributes.state==="destroyed")?.value,1);
      if(process.env.AGENTS_TEST_OTEL_ENDPOINT){
        const {createObservationTelemetry,publishObservationBatch}=input.load("observability/telemetry.js") as typeof import("../src/observability/telemetry");
        const telemetry=createObservationTelemetry("agents-harbor-analysis",{OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:process.env.AGENTS_TEST_OTEL_ENDPOINT})!;
        try{assert.ok(await publishObservationBatch(input.pool,telemetry)>0);}finally{await telemetry.shutdown();}
        const metrics=createNativeMetrics(input.pool,"worker",{OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:process.env.AGENTS_TEST_OTEL_METRICS_ENDPOINT})!;
        try{await metrics.forceFlush();}finally{await metrics.shutdown();}
      }

    },
    async cleanup(){
      for(const row of(await input.pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE state<>'destroyed'")).rows)await manager.destroy({organizationId:row.organization_id,rootTaskId:row.root_task_id,taskId:row.task_id,deadlineAt:new Date(row.lease_expires_at)},row.id);
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    },
  };
}
