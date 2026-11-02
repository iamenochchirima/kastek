import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { streamGrowthTask } from "../src/agents/live.js";
import { ApiError } from "../src/error.js";
import type { GrowthAgentClient } from "../src/agents/client.js";

const scope = {tenantId: "org", actor: {issuer: "https://issuer.test", subject: "member"}};
async function fixture(options: {revoked?: boolean; changeScope?: boolean; pages?: number} = {}) {
  const app = Fastify({logger: false});
  let reads = 0, pages = 0, checks = 0;
  const cursors: unknown[] = [];
  const client = {command: async (auth: unknown, operation: string, input: {cursor?: string}) => {
    assert.deepEqual(auth, scope);
    if (operation === "tasks.get") return {task: {id: "task", state: ++reads > 1 || options.pages ? "completed" : "working"}};
    assert.equal(operation, "tasks.events"); cursors.push(input.cursor);
    const count = options.pages && ++pages < options.pages ? 100 : 1;
    return {events: Array.from({length: count},(_,i) => ({id: `${pages}-${i}`,taskId: "task", type: reads > 1 ? "completed" : "operation.started"})), nextCursor: `cursor-${reads}`};
  }} as unknown as Pick<GrowthAgentClient,"command">;
  app.get("/live", (request,reply) => streamGrowthTask(request,reply,{taskId:"task",cursor:"resume", client,scope: async () => {
    checks++;
    if (checks > 2 && options.revoked) throw new ApiError(403,"denied","private internal detail");
    return checks > 2 && options.changeScope ? {...scope,tenantId:"other"} : scope;
  }}));
  const url = await app.listen({host:"127.0.0.1",port:0});
  return {app,url,cursors,get reads(){return reads;}};
}
test("live task snapshots and terminal events arrive over actual HTTP and retain the cursor", async () => {
  const f=await fixture();
  try {
    const response=await fetch(f.url+"/live");assert.match(response.headers.get("content-type")??"",/text\/event-stream/);
    assert.match(response.headers.get("cache-control")??"",/no-store/);
    const reader=response.body!.getReader(),decoder=new TextDecoder();
    const first=decoder.decode((await reader.read()).value);
    assert.match(first,/"working"/);assert(!first.includes('"terminal":true'));
    let rest="";for(;;){const next=await reader.read();if(next.done)break;rest+=decoder.decode(next.value);}
    assert.match(rest,/"completed"/);assert.match(rest,/event: end\ndata: {"terminal":true}/);
    assert.deepEqual(f.cursors,["resume","cursor-1"]);
  } finally {await f.app.close();}
});
for(const option of ["revoked","changeScope"] as const)test(`live observations stop on ${option} without leaking internal errors`,async()=>{
  const f=await fixture({[option]:true});
  try {const text=await(await fetch(f.url+"/live")).text();assert.match(text,/event: unavailable/);assert.match(text,/"status":403/);assert(!text.includes("private internal detail"));assert.equal(f.reads,1);}finally{await f.app.close();}
});
test("a terminal run drains its event backlog before closing",async()=>{
  const f=await fixture({pages:3});
  try {const text=await(await fetch(f.url+"/live")).text();assert.equal((text.match(/event: events/g)??[]).length,3);assert.match(text,/event: end/);assert.equal(f.cursors.length,3);}finally{await f.app.close();}
});
test("disconnecting the observer stops further reads without cancelling execution",async()=>{
  const f=await fixture();const controller=new AbortController();
  try {const response=await fetch(f.url+"/live",{signal:controller.signal});await response.body!.getReader().read();controller.abort();await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(f.reads,1);}finally{await f.app.close();}
});

class ObserverResponse extends EventTarget {
  destroyed = false;
  headers = false;
  onWrite?: () => void;
  once(name: string, listener: () => void) { this.addEventListener(name, listener, {once:true}); return this; }
  off(name: string, listener: () => void) { this.removeEventListener(name,listener); return this; }
  writeHead() {this.headers=true;return this;}
  flushHeaders() {}
  write() {this.onWrite?.();return false;}
  end() {this.dispatchEvent(new Event("close"));}
  destroy() {this.destroyed=true;this.dispatchEvent(new Event("close"));return this;}
}
test("a non-draining observer is released by the independent hard lease",async t=>{
  t.mock.timers.enable({apis:["setTimeout","Date"]});
  const raw=new ObserverResponse();let written!:()=>void;const writing=new Promise<void>(resolve=>{written=resolve;});raw.onWrite=written;
  const client={command:async(_scope:unknown,operation:string)=>operation==="tasks.get"?{task:{id:"task",state:"working"}}:{events:[],nextCursor:null}} as unknown as Pick<GrowthAgentClient,"command">;
  const pending=streamGrowthTask({}as Parameters<typeof streamGrowthTask>[0],{raw,hijack(){}} as unknown as Parameters<typeof streamGrowthTask>[1],{taskId:"task",client,scope:async()=>scope});
  await writing;t.mock.timers.tick(60001);await pending;
  assert.equal(raw.destroyed,true);
});
test("disconnect during the initial task read does not start an event read",async()=>{
  const raw=new ObserverResponse();let release!:()=>void,started!:()=>void;let eventReads=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),reading=new Promise<void>(resolve=>{started=resolve;});
  const client={command:async(_scope:unknown,operation:string)=>{if(operation==="tasks.get"){started();await gate;return {task:{id:"task",state:"working"}};}eventReads++;return {events:[],nextCursor:null};}}as unknown as Pick<GrowthAgentClient,"command">;
  const pending=streamGrowthTask({}as Parameters<typeof streamGrowthTask>[0],{raw,hijack(){}}as unknown as Parameters<typeof streamGrowthTask>[1],{taskId:"task",client,scope:async()=>scope});
  await reading;raw.destroy();release();await pending;assert.equal(eventReads,0);assert.equal(raw.headers,false);
});

test("public observation stream binds the requested running child and drains terminal event pages",async()=>{
  const {streamGrowthObservation}=await import("../src/agents/live.js");
  const app=Fastify({logger:false});let reads=0;const inputs:unknown[]=[];
  const client={command:async(_auth:unknown,operation:string,input:unknown)=>{
    assert.equal(operation,"tasks.observe");inputs.push(input);reads++;
    return {task:{id:"child",state:"completed"},rootTaskId:"root",parentTaskId:"root",agentName:"Content",operations:[{id:"tool",taskId:"child",label:"Reading context",state:"completed"}],updates:[],updatesTruncated:false,
      events:Array.from({length:reads===1?100:1},(_,i)=>({id:String(i),taskId:"child",type:"operation.completed"})),nextCursor:"cursor-"+reads};
  }} as unknown as Pick<GrowthAgentClient,"command">;
  app.get("/observe",(request,reply)=>streamGrowthObservation(request,reply,{taskId:"root",childTaskId:"child",cursor:"resume",client,scope:async()=>scope}));
  const url=await app.listen({host:"127.0.0.1",port:0});
  try {const text=await(await fetch(url+"/observe")).text();assert.equal((text.match(/event: observation/g)??[]).length,2);assert.match(text,/"rootTaskId":"root"/);assert.match(text,/"parentTaskId":"root"/);assert.match(text,/event: end\ndata: {"terminal":true}/);assert.deepEqual(inputs,[{taskId:"root",childTaskId:"child",cursor:"resume",limit:100},{taskId:"root",childTaskId:"child",cursor:"cursor-1",limit:100}]);}
  finally {await app.close();}
});
