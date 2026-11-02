import test from "node:test";
import assert from "node:assert/strict";
import { streamGrowthObservation, streamGrowthTask } from "../src/lib/growth-agent-stream";
const encoder=new TextEncoder();
const frame=(event:string,data:unknown)=>`event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
function response(text:string,fragments=false){const bytes=encoder.encode(text);return new Response(new ReadableStream<Uint8Array>({start(controller){if(fragments){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));}else controller.enqueue(bytes);controller.close();}}),{headers:{"content-type":"text/event-stream"}});}
function callbacks(){const tasks:unknown[]=[],events:unknown[]=[],errors:Error[]=[];return{tasks,events,errors,onTask:(task:unknown)=>{tasks.push(task)},onEvents:(items:unknown,cursor:unknown)=>{events.push({items,cursor})},onError:(error:Error)=>{errors.push(error)}};}
test("stream parsing handles fragmented UTF8, CRLF and final events",async t=>{
  t.mock.method(globalThis,"fetch",async()=>response(frame("task",{task:{id:"task",input:"Café 🚲"}})+frame("events",{events:[{taskId:"task",id:"1"}],nextCursor:"scope-cursor"})+frame("end",{terminal:true}),true));
  const c=callbacks();await streamGrowthTask("task",c,new AbortController().signal);assert.equal(c.errors.length,0);assert.deepEqual(c.tasks,[{id:"task",input:"Café 🚲"}]);assert.equal(c.events.length,1);
});
test("a normal lease reconnects from the last event cursor",async t=>{
  const urls:string[]=[];t.mock.method(globalThis,"fetch",async(url:unknown)=>{urls.push(String(url));return response(frame("task",{task:{id:"task"}})+frame("events",{events:[],nextCursor:"next-scope"})+frame("end",{terminal:urls.length===2}));});
  const c=callbacks();await streamGrowthTask("task",c,new AbortController().signal,"original");assert.deepEqual(urls,["/api/agents/tasks/task/live?cursor=original","/api/agents/tasks/task/live?cursor=next-scope"]);assert.equal(c.errors.length,0);
});
test("coalesced frames enforce the cap per frame rather than per network chunk",async t=>{
  const task={id:"task",input:"🚲".repeat(300000)};
  t.mock.method(globalThis,"fetch",async()=>response(frame("task",{task})+frame("task",{task})+frame("end",{terminal:true})));
  const c=callbacks();await streamGrowthTask("task",c,new AbortController().signal);assert.equal(c.errors.length,0);assert.equal(c.tasks.length,2);
});
test("oversized UTF8 frames are rejected using bytes",async t=>{
  t.mock.method(globalThis,"fetch",async()=>response(frame("task",{task:{id:"task",input:"🚲".repeat(600000)}})+frame("end",{terminal:true})));
  const c=callbacks();await streamGrowthTask("task",c,new AbortController().signal);assert.equal(c.errors.length,1);assert.equal(c.tasks.length,0);
});
test("foreign task observations are rejected before callbacks",async t=>{
  t.mock.method(globalThis,"fetch",async()=>response(frame("task",{task:{id:"foreign"}})+frame("end",{terminal:true})));
  const c=callbacks();await streamGrowthTask("task",c,new AbortController().signal);assert.equal(c.errors.length,1);assert.equal(c.tasks.length,0);
});
test("access loss retains a typed status and premature EOF reports interruption",async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>++calls===1?new Response("denied",{status:403}):response(frame("task",{task:{id:"task"}})));
  const a=callbacks();await streamGrowthTask("task",a,new AbortController().signal);assert.equal((a.errors[0]as Error&{status:number}).status,403);
  const b=callbacks();await streamGrowthTask("task",b,new AbortController().signal);assert.equal(b.errors.length,1);assert.match(b.errors[0].message,/closed/);
});


const observation=(patch:Record<string,unknown>={})=>({rootTaskId:"root",parentTaskId:"root",agentName:"Content",
  task:{id:"child",state:"working",input:"Café 🚲",output:null,observedAt:"2026-11-02T10:00:00Z"},
  events:[{taskId:"child",id:"1"}],nextCursor:"child-cursor",operations:[{id:"tool-1",taskId:"child",state:"started",label:"Reading context"}],nextOperationCursor:null,
  updates:[{id:"public-1",text:"Checking the brief 🚲"}],updatesTruncated:false,...patch});

test("child observations preserve fragmented UTF8 and authorized public activity",async t=>{
  const expected=observation();t.mock.method(globalThis,"fetch",async()=>response(frame("observation",expected)+frame("end",{terminal:true}),true));
  const values:unknown[]=[],errors:Error[]=[];await streamGrowthObservation("root","child",value=>values.push(value),error=>errors.push(error),new AbortController().signal);
  assert.deepEqual(values,[expected]);assert.deepEqual(errors,[]);
});
test("child observation leases reconnect with both child scope and durable event cursor",async t=>{
  const urls:string[]=[];t.mock.method(globalThis,"fetch",async(url:unknown,init:RequestInit|undefined)=>{
    assert.equal(init?.credentials,"include");assert.equal(init?.cache,"no-store");urls.push(String(url));
    return response(frame("observation",observation({nextCursor:"child / é"}))+frame("end",{terminal:urls.length===2}));
  });
  const errors:Error[]=[];await streamGrowthObservation("root","child",()=>{},error=>errors.push(error),new AbortController().signal);
  assert.deepEqual(urls,["/api/agents/tasks/root/activity/live?childTaskId=child","/api/agents/tasks/root/activity/live?cursor=child+%2F+%C3%A9&childTaskId=child"]);assert.deepEqual(errors,[]);
});
for(const [label,patch] of [
  ["foreign root",{rootTaskId:"foreign"}],
  ["foreign child",{task:{id:"foreign"}}],
  ["foreign event",{events:[{id:"1",taskId:"foreign"}]}],
  ["foreign operation",{operations:[{id:"tool",taskId:"foreign"}]}],
  ["invalid resume cursor",{nextCursor:{foreign:"cursor"}}],
] as const)test(`child observation rejects ${label} before publication`,async t=>{
  t.mock.method(globalThis,"fetch",async()=>response(frame("observation",observation(patch))+frame("end",{terminal:true})));
  const values:unknown[]=[],errors:Error[]=[];await streamGrowthObservation("root","child",value=>values.push(value),error=>errors.push(error),new AbortController().signal);
  assert.equal(values.length,0);assert.equal(errors.length,1);assert.match(errors[0].message,/scope|invalid/i);
});
test("oversized UTF8 child observations are rejected before any protected content callback",async t=>{
  t.mock.method(globalThis,"fetch",async()=>response(frame("observation",observation({task:{id:"child",input:"🚲".repeat(600000)}}))+frame("end",{terminal:true})));
  const values:unknown[]=[],errors:Error[]=[];await streamGrowthObservation("root","child",value=>values.push(value),error=>errors.push(error),new AbortController().signal);
  assert.equal(values.length,0);assert.equal(errors.length,1);assert.match(errors[0].message,/size limit/);
});
test("child access withdrawal retains typed status and cannot publish later coalesced observations",async t=>{
  t.mock.method(globalThis,"fetch",async()=>response(frame("observation",observation())+frame("unavailable",{status:403})+frame("observation",observation({updates:[{id:"later",text:"MUST_NOT_PUBLISH"}]}))));
  const values:unknown[]=[],errors:Error[]=[];await streamGrowthObservation("root","child",value=>values.push(value),error=>errors.push(error),new AbortController().signal);
  assert.equal(values.length,1);assert.equal(errors.length,1);assert.equal((errors[0]as Error&{status:number}).status,403);assert(!JSON.stringify(values).includes("MUST_NOT_PUBLISH"));
});
test("closing a child observer suppresses later callbacks and reconnects without issuing an execution command",async t=>{
  const calls:string[]=[];t.mock.method(globalThis,"fetch",async(url:unknown)=>{calls.push(String(url));return response(frame("observation",observation())+frame("observation",observation({updates:[{id:"later",text:"MUST_NOT_PUBLISH"}]}))+frame("end",{terminal:false}));});
  const controller=new AbortController(),values:unknown[]=[],errors:Error[]=[];
  await streamGrowthObservation("root","child",value=>{values.push(value);controller.abort();},error=>errors.push(error),controller.signal);
  assert.equal(values.length,1);assert.equal(errors.length,0);assert.equal(calls.length,1);assert(calls.every(url=>url.includes("/activity/live")));assert(!calls.some(url=>/cancel|continue|messages/.test(url)));
});
