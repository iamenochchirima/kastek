import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessageContent, AgentExecutionView, AgentResultFiles, AgentToolRow, AgentSubagentRow, AgentComposer, agentRuntimePresentation, agentIsActive, agentFailureLabel, agentStateLabel, formatAgentDuration, mergeAgentEntries, safeAgentLink, orderAgentEntries } from "../dist/agent.js";

test("safe message rendering rejects executable URLs, embedded HTML and remote image loads", () => {
  const html = renderToStaticMarkup(createElement(AgentMessageContent, { text: "[bad](javascript:alert(1)) <script>secret()</script> ![alt](https://tracker.example/pixel) [source](https://example.org/source)" }));
  assert.doesNotMatch(html, /<script|<img|javascript:/);
  assert.match(html, /href="https:\/\/example.org\/source"/);
  assert.match(html, /rel="noreferrer"/);
  assert.match(html, /alt/);
});

test("customer message plain mode retains literal Markdown and escapes HTML", () => {
  const html = renderToStaticMarkup(createElement(AgentMessageContent, { text: "**literal** <img src=x>", format: "plain" }));
  assert.match(html, /\*\*literal\*\*/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<strong>|<img/);
});

test("product link policy can deny sources and cannot introduce executable links", () => {
  for (const resolved of [null, "javascript:alert(1)", "//evil.example/path", "/\\evil.example"]) {
    const html = renderToStaticMarkup(createElement(AgentMessageContent, { text: "[record](https://example.org)", resolveLink: () => resolved }));
    assert.doesNotMatch(html, /<a /);
  }
  assert.equal(safeAgentLink("https://user:password@example.org"), null);
  assert.equal(safeAgentLink("/content/123"), "/content/123");
});

test("entry replay replaces by identity without allowing an older decimal revision", () => {
  const previous = [{ id: "tool", revision: "9007199254740994", state: "completed" }];
  const merged = mergeAgentEntries(previous, [{ id: "tool", revision: "9007199254740993", state: "running" }, { id: "other", revision: "1", state: "running" }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].state, "completed");
  assert.equal(mergeAgentEntries(previous, [{ id: "tool", revision: "9007199254740995", state: "failed" }])[0].state, "failed");
});

test("tool details obey explicit restricted availability even when an adapter has stale data", () => {
  const html = renderToStaticMarkup(createElement(AgentToolRow, { operation: { id: "op", label: "Read source", state: "completed", details: "stale-private-detail", detailAvailability: "redacted" } }));
  assert.match(html, /Details are restricted/);
  assert.doesNotMatch(html, /stale-private-detail/);
});

test("running subagents are actionable and identical names retain separate task identity", () => {
  const render = id => renderToStaticMarkup(createElement(AgentSubagentRow, { child: { id, name: "Research", state: "running", assignment: "Check the brief" }, onOpen() {} }));
  assert.match(render("a"), /data-subagent-id="a"/);
  assert.match(render("b"), /data-subagent-id="b"/);
  assert.match(render("a"), /aria-label="Open Research activity"/);
  assert.match(render("a"), /<button/);
});

test("file results expose names, in-flight state and errors through the shared controls", () => {
  const files=[{id:"one",title:"notes.md"},{id:"two",title:"report.json"}];
  const html=renderToStaticMarkup(createElement(AgentResultFiles,{files,busyId:"one",error:"File unavailable",onSelect() {}}));
  assert.match(html,/notes\.md/);assert.match(html,/report\.json/);
  assert.match(html,/aria-busy="true"/);assert.match(html,/disabled=""/);
  assert.match(html,/role="alert"/);assert.match(html,/File unavailable/);
  assert.equal(renderToStaticMarkup(createElement(AgentResultFiles,{files:[],onSelect() {}})),"");
});

test("completed output remains primary and context is an explicit secondary control", () => {
  const execution = { id: "root", state: "completed", output: "Drafts ready", context: { utilizationPercent: 11, windowTokens: 1000 } };
  const html = renderToStaticMarkup(createElement(AgentExecutionView, { execution }));
  assert.match(html, /Drafts ready/);
  assert.doesNotMatch(html, /Context|Verified/);
  const detailed = renderToStaticMarkup(createElement(AgentExecutionView, { execution, showContext: true }));
  assert.match(detailed, /Context · 11%/);
  assert.match(detailed, /Context capacity/);
  assert.match(detailed, /Input limit/);
  assert.equal(agentIsActive("waiting_review"), true);
  assert.equal(agentIsActive("cancel_requested"), true);
  assert.equal(agentIsActive("failed"), false);
});

test("a finished response exposes incomplete and uncertain specialist work without hiding the answer", () => {
  const render = (state, children) => renderToStaticMarkup(createElement(AgentExecutionView, { execution: { id: "root", state, output: "Drafts ready", children } }));
  for (const state of ["incomplete", "failed", "refused", "cancelled"]) {
    const html = render("completed", [{ id: "child", name: "Research", state }]);
    assert.match(html, /Some specialist work did not finish/);
    assert.match(html, /Drafts ready/);
    assert.match(html, /Activity/);
  }
  assert.match(render("completed", [{ id: "child", name: "Research", state: "uncertain" }]), /Some specialist outcomes are unknown/);
  const externalOutput = renderToStaticMarkup(createElement(AgentExecutionView, { execution: { id: "root", state: "completed", children: [{ id: "child", name: "Research", state: "incomplete" }] } }));
  assert.match(externalOutput, /Some specialist work did not finish/);
  assert.doesNotMatch(render("completed", [{ id: "child", name: "Research", state: "completed" }]), /Some specialist/);
  assert.doesNotMatch(render("running", [{ id: "child", name: "Research", state: "incomplete" }]), /Some specialist work did not finish/);
});

test("shared measurements distinguish task, work, model latency and observed versus accounted usage",()=>{
  const runtime={observedAt:"2026-11-02T10:00:00Z",elapsedMs:2000,workElapsedMs:9000,
    model:{id:"fixture/model",latencyMs:null,firstTokenMs:null},context:{estimatedInputTokens:300,windowTokens:1000,utilizationPercent:30,compactionCount:1,decision:"compacted"},
    usage:{accountedTokens:100,inputTokens:40,outputTokens:10,modelCalls:2,toolCalls:1,observedModelCalls:1}};
  const fields=agentRuntimePresentation(runtime),byLabel=new Map(fields.diagnostics.map(row=>[row.label,row.value]));
  assert.equal(byLabel.get("Elapsed"),"2.0 s");assert.equal(byLabel.get("Work elapsed"),"9.0 s");
  assert.equal(byLabel.get("Model latency"),null);assert.equal(byLabel.get("Accounted tokens"),"100");
  assert.equal(byLabel.get("Observed input / output"),"40 / 10");assert.equal(byLabel.get("Compaction state"),"Compacted");
  const html=renderToStaticMarkup(createElement(AgentExecutionView,{execution:{id:"child",state:"completed",...fields},showContext:true}));
  assert.match(html,/Context · 30%/);assert.match(html,/Work elapsed/);assert.match(html,/Unavailable/);
  assert.equal(agentRuntimePresentation({...runtime,workElapsedMs:null}).diagnostics.some(row=>row.label==="Work elapsed"),false);
});

test("shared composer preserves controlled text and host actions without unsupported features", () => {
  const html = renderToStaticMarkup(createElement(AgentComposer, { value: "A correction", onChange() {}, onSubmit() {}, maxLength: 4000, sending: true, actions: createElement("button", { type: "button" }, "Stop"), context: "Context" }));
  assert.match(html, /A correction/);
  assert.match(html, /maxLength="4000"/);
  assert.match(html, /aria-label="Send message"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(html, />Stop<\/button>/);
  assert.doesNotMatch(html, /type="file"|Voice|Microphone/);
});

test("public updates and operations retain recorded chronology without inventing missing timestamps", () => {
  const ordered = orderAgentEntries([{ id: "late", createdAt: "2026-11-02T10:00:02Z" }, { id: "unknown" }, { id: "early", startedAt: "2026-11-02T10:00:01Z" }, { id: "unknown2", createdAt: "invalid" }]);
  assert.deepEqual(ordered.map(item => item.id), ["early", "late", "unknown", "unknown2"]);
  const html = renderToStaticMarkup(createElement(AgentExecutionView, { execution: {
    id: "task", state: "running", updates: [{ id: "update", text: "Found the brief", createdAt: "2026-11-02T10:00:02Z" }], operations: [{ id: "read", label: "Read brief", state: "completed", startedAt: "2026-11-02T10:00:01Z" }],
  } }));
  assert.ok(html.indexOf("Read brief") < html.indexOf("Found the brief"));
  assert.equal((html.match(/Found the brief/g) ?? []).length, 1);
});

test("activity shows a safe label for active model work while hiding model request details", () => {
  const html = renderToStaticMarkup(createElement(AgentExecutionView, { execution: {
    id: "shared", state: "running", updates: [{ id: "update", text: "Checking the launch details" }],
    operations: [{ id: "model-active-private-id", label: "PROMPT_SECRET private generation label", kind: "model", state: "started", details: "RESPONSE_SECRET model response", errorCode: "MODEL_PRIVATE_ERROR" },
      { id: "model-complete-private-id", label: "COMPLETED_MODEL_SECRET", kind: "model", state: "completed", details: "OLD_RESPONSE_SECRET" },
      { id: "tool", label: "Read approved source", kind: "tool", state: "completed" }],
    children: [{ id: "child", name: "Research", state: "running" }],
  } }));
  assert.match(html, /Generating response/);
  assert.doesNotMatch(html, /PROMPT_SECRET|RESPONSE_SECRET|MODEL_PRIVATE_ERROR|COMPLETED_MODEL_SECRET|OLD_RESPONSE_SECRET|model-active-private-id|model-complete-private-id/);
  assert.doesNotMatch(html, /data-operation-id="model/);
  assert.match(html, /Read approved source/); assert.match(html, /Research/); assert.match(html, /Checking the launch details/);
});


test("execution duration is readable and remains separate from model timings", () => {
  assert.equal(formatAgentDuration(0), "<1s");
  assert.equal(formatAgentDuration(59000), "59s");
  assert.equal(formatAgentDuration(154000), "2m 34s");
  assert.equal(formatAgentDuration(3660000), "1h 1m");
  for (const invalid of [undefined, null, -1, Infinity, NaN]) assert.equal(formatAgentDuration(invalid), null);
  const html = renderToStaticMarkup(createElement(AgentExecutionView, { execution: { id: "turn", state: "completed", elapsedMs: 154000 } }));
  assert.match(html, /aria-label="Execution time"/);
  assert.match(html, /2m 34s/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(AgentExecutionView, { execution: { id: "turn", state: "completed" } })), /Execution time/);
});

test("provider unavailable failures are distinct from unknown model outcomes", () => {
  assert.equal(agentStateLabel("failed"), "Failed");
  assert.equal(agentFailureLabel("failed", "MODEL_PROVIDER_UNAVAILABLE"), "The model is unavailable. Try again later.");
  assert.equal(agentStateLabel("uncertain"), "Outcome unknown");
  assert.equal(agentFailureLabel("uncertain", "MODEL_STREAM_FAILED"), "The model response was interrupted. Review completed work before continuing.");
  const html = renderToStaticMarkup(createElement(AgentExecutionView, { execution: { id: "turn", state: "failed", errorCode: "MODEL_PROVIDER_UNAVAILABLE", elapsedMs: 3000 } }));
  assert.match(html, /The model is unavailable\. Try again later\./);
  assert.doesNotMatch(html, /Outcome unknown/);
  assert.match(html, /3s/);
});


test("consecutive capability calls group real attempts without crossing updates or task scope", () => {
  const call = (id, activityKind, taskId, state = "completed", second = 0) => ({id, taskId, label: activityKind === "capability_loading" ? "Load tools" : "Find tools", activityKind, kind:"tool", state,
    startedAt:`2026-11-03T10:00:0${second}Z`, durationMs:1000, technicalName:activityKind === "capability_loading" ? "tools.load" : "tools.discover"});
  const html = renderToStaticMarkup(createElement(AgentExecutionView, {execution:{id:"root",state:"running",operations:[
    call("a","capability_discovery","root","completed",0),call("b","capability_loading","root","failed",1),
    call("c","capability_discovery","root","completed",3),call("d","capability_loading","other","completed",4),
  ],updates:[{id:"public",text:"Checking the available sources",createdAt:"2026-11-03T10:00:02Z"}]}}));
  assert.equal((html.match(/data-capability-lookup/g)??[]).length,1);
  assert.match(html,/Capability lookup/);assert.match(html,/2 calls/);assert.match(html,/1 failed/);assert.match(html,/2s/);
  assert.match(html,/data-operation-id="a"/);assert.match(html,/data-operation-id="b"/);assert.match(html,/Failed/);
  assert.match(html,/Technical details/);assert.ok(html.indexOf("Capability lookup")<html.indexOf("Checking the available sources"));
  const connected=renderToStaticMarkup(createElement(AgentToolRow,{operation:{...call("connected","capability_discovery","root"),source:"connection",activityKind:undefined}}));
  assert.match(connected,/Connected service/);
  const restricted=renderToStaticMarkup(createElement(AgentToolRow,{operation:{...call("secret-id","capability_discovery","root"),detailAvailability:"redacted"}}));
  assert.doesNotMatch(restricted,/tools\.discover|Technical details|secret-id<\/dd>/);
});
